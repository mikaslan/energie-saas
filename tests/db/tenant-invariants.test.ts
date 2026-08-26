import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import {
  tenantFixtures,
  crossWriteOverrides,
  isExempt,
  TENANT_EXEMPT,
  TENANT_EXEMPT_AUTH,
  MATVIEW_ALLOWLIST,
} from "../setup/tenant-fixtures";

interface Relation {
  name: string;
  relkind: string;
}

interface RlsFlagsRow {
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

interface NullableRow {
  is_nullable: string;
}

interface PolicyRow {
  policyname: string;
  cmd: string;
  permissive: string;
  qual: string | null;
  with_check: string | null;
}

interface CountRow {
  n: number;
  [key: string]: unknown;
}

// allRelations = ALLE public-Relationen (inkl. exemptierter und Matviews);
// tables = nur die nicht-exemptierten gewöhnlichen/partitionierten Tabellen,
// gegen die die Haupt-Invarianten laufen.
let allRelations: Relation[] = [];
let tables: Relation[] = [];
const wsA = randomUUID();
const wsB = randomUUID();

// Der kanonische with-check-/using-Ausdruck, den JEDE Tenant-Policy tragen
// muss. Verglichen wird whitespace-normalisiert und EXAKT — nicht per
// Substring (Codex-Review #3: ein korrektes `using` mit `with check (true)`
// bestand die alte Substring-Prüfung anstandslos).
function canonicalPredicate(tenantKey: string): string {
  return `(${tenantKey} = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)`;
}

function normalize(expr: string): string {
  return expr.replace(/\s+/g, "");
}

// workspace trägt den Mandanten in "id", alle anderen in "workspace_id".
function tenantKeyOf(table: string): string {
  return table === "workspace" ? "id" : "workspace_id";
}

async function policiesOf(table: string): Promise<PolicyRow[]> {
  const { rows } = await testPool.query<PolicyRow>(
    `select policyname, cmd, permissive, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = $1
      order by policyname`,
    [table],
  );
  return rows;
}

beforeAll(async () => {
  const res = await testPool.query<Relation>(`
    select c.relname as name, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'm')`);
  // relkind: 'r' = gewöhnliche Tabelle, 'p' = partitionierte Elterntabelle
  // (trägt RLS-Policy und NOT-NULL-Constraint — ohne 'p' bliebe eine künftige
  // partitionierte Mandantentabelle unsichtbar, solange noch keine Partition
  // existiert), 'm' = materialisierte View (Codex-Review #5, siehe eigener
  // Test unten).
  allRelations = res.rows;
  tables = allRelations.filter((t) => (t.relkind === "r" || t.relkind === "p") && !isExempt(t.name));
  for (const ws of [wsA, wsB]) {
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'inv-test')`));
  }
});

describe("Tenant-Invarianten über ALLE Tabellen", () => {
  it("jede Mandantentabelle hat workspace_id NOT NULL (workspace: id als Tenant-Key)", async () => {
    for (const t of tables) {
      if (t.name === "workspace") continue;
      const col = await testPool.query<NullableRow>(
        `select is_nullable from information_schema.columns where table_name = $1 and column_name = 'workspace_id'`,
        [t.name]);
      expect(col.rows, `${t.name}: workspace_id fehlt`).toHaveLength(1);
      expect(col.rows[0].is_nullable, `${t.name}: workspace_id nullable`).toBe("NO");
    }
  });

  it("jede Mandantentabelle hat RLS enabled + forced", async () => {
    for (const t of tables) {
      const rls = await testPool.query<RlsFlagsRow>(
        `select relrowsecurity, relforcerowsecurity from pg_class where relname = $1`, [t.name]);
      expect(rls.rows[0].relrowsecurity, `${t.name}: RLS aus`).toBe(true);
      expect(rls.rows[0].relforcerowsecurity, `${t.name}: RLS nicht forced`).toBe(true);
    }
  });

  it("jede Mandantentabelle hat eine Fixture-Factory registriert", () => {
    for (const t of tables) {
      expect(tenantFixtures[t.name], `${t.name}: Fixture fehlt in tenant-fixtures.ts`).toBeDefined();
    }
  });

  it("keine exemptierte Tabelle versteckt eine echte Mandantentabelle", async () => {
    // Guard: TENANT_EXEMPT/TENANT_EXEMPT_AUTH machen eine Tabelle für die
    // Haupt-Invarianten unsichtbar — das ist beabsichtigt für global-eigene
    // (user_identity) und fremdverwaltete Tabellen (better-auth). Es darf aber
    // NIE dazu führen, dass eine echte Mandantentabelle (mit workspace_id)
    // sich hinter einem Exempt-Namen versteckt.
    const exempted = allRelations.filter((t) => isExempt(t.name));
    for (const t of exempted) {
      const col = await testPool.query<NullableRow>(
        `select is_nullable from information_schema.columns where table_name = $1 and column_name = 'workspace_id'`,
        [t.name]);
      const label = TENANT_EXEMPT.has(t.name) ? "TENANT_EXEMPT" : "TENANT_EXEMPT_AUTH";
      expect(col.rows, `Tenant-Tabelle versteckt sich unter ${label}: ${t.name}`).toHaveLength(0);
    }
  });

  it("Zeilen aus Workspace A sind in Workspace B unsichtbar", async () => {
    for (const t of tables) {
      await withTenantOn(testPool, wsA, (tx) => tenantFixtures[t.name](tx, wsA));
      const inA = await withTenantOn(testPool, wsA, (tx) =>
        tx.execute<CountRow>(sql.raw(`select count(*)::int as n from ${t.name}`)));
      const inB = await withTenantOn(testPool, wsB, (tx) =>
        tx.execute<CountRow>(sql.raw(`select count(*)::int as n from ${t.name}`)));
      expect(inA.rows[0].n, `${t.name}: Fixture hat nichts angelegt`).toBeGreaterThan(0);
      const bBaseline = t.name === "workspace" ? 1 : 0; // B sieht nur die eigene workspace-Zeile
      expect(inB.rows[0].n, `${t.name}: LECK — B sieht Daten von A`).toBe(bBaseline);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #3: die Suite akzeptierte schreibseitig fail-open Policies.
// Geprüft wurden nur Substrings in qual/with_check und A→B-LESEN. Ein
// korrektes `using` kombiniert mit `with check (true)` hätte Cross-Tenant-
// Inserts und Workspace-Transfers weiterhin erlaubt und wäre grün geblieben.
// Deckt zugleich die geforderten Membership-Spiegeltests generisch ab.
// ═══════════════════════════════════════════════════════════════════════
describe("Schreibseitige Tenant-Invarianten", () => {
  it("(a) Insert mit FREMDEM workspace_id scheitert an with check", async () => {
    for (const t of tables) {
      const write = crossWriteOverrides[t.name]
        ? (tx: Parameters<typeof tenantFixtures.workspace>[0]) => crossWriteOverrides[t.name](tx)
        : (tx: Parameters<typeof tenantFixtures.workspace>[0]) => tenantFixtures[t.name](tx, wsA);

      let caught: unknown;
      try {
        // Transaktion läuft auf wsB, geschrieben wird aber für wsA.
        await withTenantOn(testPool, wsB, (tx) => write(tx));
      } catch (error) {
        caught = error;
      }
      expect(caught, `${t.name}: Cross-Tenant-Insert wurde NICHT abgelehnt`).toBeInstanceOf(Error);
      // Drizzle wrapt Postgres-Fehler in DrizzleQueryError; die echte Meldung
      // steckt in .cause. Es MUSS die RLS sein — nicht PK, FK oder CHECK,
      // sonst wäre der Test vacuum-grün.
      const cause = String((caught as { cause?: unknown }).cause);
      expect(cause, `${t.name}: abgelehnt, aber NICHT durch RLS (${cause})`).toMatch(/row-level security/);
    }
  });

  it("(b) ohne Tenant-Kontext ist jede Mandantentabelle leer (frische Verbindung)", async () => {
    // Bewusst ein EIGENER Pool: eine Verbindung aus testPool hat womöglich
    // schon in einer withTenant-Transaktion gelegen. current_setting fällt
    // danach auf den Platzhalter '' zurück (nicht auf NULL) — genau dafür
    // steht nullif(..., '') in den Policies. Eine fabrikfrische Verbindung
    // prüft zusätzlich den Fall "Parameter nie referenziert" (NULL).
    const fresh = new Pool({ connectionString: process.env.POSTGRES_URL_TEST, max: 1 });
    try {
      for (const t of tables) {
        const { rows } = await fresh.query<CountRow>(`select count(*)::int as n from ${t.name}`);
        expect(rows[0].n, `${t.name}: LECK — ohne app.workspace_id sichtbar`).toBe(0);
      }
    } finally {
      await fresh.end();
    }
  });

  it("(c) jede Tenant-Policy trägt einen ECHTEN with-check-Ausdruck (nicht NULL, nicht true)", async () => {
    for (const t of tables) {
      const policies = await policiesOf(t.name);
      const permissive = policies.filter((p) => p.permissive === "PERMISSIVE");
      const expected = normalize(canonicalPredicate(tenantKeyOf(t.name)));

      for (const p of permissive) {
        expect(p.with_check, `${t.name}/${p.policyname}: with_check ist NULL (fail-open beim Schreiben)`).not.toBeNull();
        expect(
          normalize(p.with_check!),
          `${t.name}/${p.policyname}: with_check ist "true" — Cross-Tenant-Insert wäre erlaubt`,
        ).not.toBe("true");
        // Exakter Vergleich statt Substring: jede Abweichung vom kanonischen
        // Prädikat (zusätzliches OR, anderer Spaltenbezug, fehlendes nullif)
        // ist ein Fehler, auch wenn "app.workspace_id" darin vorkommt.
        expect(
          normalize(p.with_check!),
          `${t.name}/${p.policyname}: with_check weicht vom kanonischen Prädikat ab`,
        ).toBe(expected);
        expect(p.qual, `${t.name}/${p.policyname}: using fehlt`).not.toBeNull();
        expect(
          normalize(p.qual!),
          `${t.name}/${p.policyname}: using weicht vom kanonischen Prädikat ab`,
        ).toBe(expected);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #6: PostgreSQL verknüpft mehrere PERMISSIVE Policies mit OR.
// Eine zweite permissive Policy neben tenant_isolation würde die Grenze also
// ÖFFNEN statt verengen — der geplante external_only-Filter wäre wirkungslos
// oder gäbe sogar fremde Zeilen frei. Vertrag: genau EINE permissive Policy,
// jeder Zusatzfilter MUSS `as restrictive` sein (siehe modules/README.md und
// den Kommentar in drizzle/0013_rls_policy_contract.sql).
// ═══════════════════════════════════════════════════════════════════════
describe("Policy-Vertrag: genau eine permissive Policy pro Tenant-Tabelle", () => {
  it("keine Tenant-Tabelle hat mehr als eine PERMISSIVE Policy", async () => {
    for (const t of tables) {
      const policies = await policiesOf(t.name);
      const permissive = policies.filter((p) => p.permissive === "PERMISSIVE");
      expect(
        permissive.map((p) => p.policyname),
        `${t.name}: mehrere permissive Policies werden mit OR verknüpft — ` +
          `Zusatzfilter MÜSSEN "as restrictive" sein`,
      ).toHaveLength(1);
    }
  });

  it("die eine permissive Policy heißt tenant_isolation und gilt FOR ALL", async () => {
    for (const t of tables) {
      const [policy] = (await policiesOf(t.name)).filter((p) => p.permissive === "PERMISSIVE");
      expect(policy.policyname, `${t.name}: unerwarteter Policy-Name`).toBe("tenant_isolation");
      expect(policy.cmd, `${t.name}: Tenant-Policy muss FOR ALL gelten`).toBe("ALL");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #4: unbekannte auth_*-Tabellen dürfen sich nicht still hinter
// einer Ausnahme verstecken. Die Allowlist ist jetzt EXAKT (keine Präfixe).
// ═══════════════════════════════════════════════════════════════════════
describe("Auth-Allowlist ist exakt", () => {
  it("jede public-Tabelle mit auth_-Präfix steht in TENANT_EXEMPT_AUTH", () => {
    const unbekannt = allRelations
      .filter((r) => r.name.startsWith("auth_") && !TENANT_EXEMPT_AUTH.has(r.name))
      .map((r) => r.name);
    expect(
      unbekannt,
      `unbekannte Auth-Tabelle(n): ${unbekannt.join(", ")} — bewusst allowlisten ` +
        `(tests/setup/tenant-fixtures.ts) oder die Tenant-Regeln erfüllen lassen`,
    ).toEqual([]);
  });

  it("die Allowlist enthält keine Karteileichen", () => {
    const vorhanden = new Set(allRelations.map((r) => r.name));
    const fehlend = [...TENANT_EXEMPT_AUTH].filter((n) => !vorhanden.has(n));
    expect(fehlend, `allowlistet, existiert aber nicht: ${fehlend.join(", ")}`).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review #5: materialisierte Views speichern Cross-Tenant-Ergebnisse
// physisch und erben KEINE RLS ihrer Basistabellen.
// ═══════════════════════════════════════════════════════════════════════
describe("Materialisierte Views", () => {
  it("keine unbeaufsichtigte Matview in public", () => {
    const matviews = allRelations.filter((r) => r.relkind === "m" && !MATVIEW_ALLOWLIST.has(r.name));
    expect(
      matviews.map((m) => m.name),
      "Matview braucht explizites tenantgeschütztes Cache-Muster " +
        "(Allowlist MATVIEW_ALLOWLIST + eigener Schutznachweis) — sie erbt die " +
        "RLS ihrer Basistabellen NICHT",
    ).toEqual([]);
  });
});
