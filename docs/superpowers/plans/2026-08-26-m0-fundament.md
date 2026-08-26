# M0 Fundament — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das nicht nachrüstbare Fundament des energie-saas-Produkts: Multi-Tenant-Next.js-Skeleton mit doppelter Mandantentrennung (RLS + `withTenant`), Event-Outbox + Audit-Log, Statusmaschinen-Konvention, zentraler Rechteprüfung, passwortloser Auth, Site-Entität, Storage-Abstraktion mit WORM-Vorbereitung, Worker-Host und CI, die die Architektur-Invarianten erzwingt.

**Architecture:** Modularer Monolith (Next.js 16 App Router auf Vercel), Neon Postgres + Drizzle, alle Mutationen durch Service-Funktionen in `withTenant`-Transaktionen, die im selben Commit `domain_events` schreiben. Ein Hetzner-Worker (pg-boss) für Jobs. Modulgrenzen und Tenant-Isolation werden von CI erzwungen, nicht von Disziplin.

**Tech Stack:** Next.js 16, TypeScript strict, Tailwind + shadcn, Drizzle ORM + `pg` Pool gegen Neon, better-auth (Magic Link + E-Mail-OTP), pg-boss, @aws-sdk/client-s3, Vitest, dependency-cruiser, Docker Compose (Worker).

**Spec:** `docs/PLAN.md` (Abschnitte Architektur + Roadmap M0), `docs/blaupause/04-architektur.md`, `docs/blaupause/05-roadmap.md` (M0).

## Global Constraints

- Jede mandantenbezogene Tabelle: `workspace_id uuid NOT NULL`, RLS **enabled + forced**, Policy gegen `current_setting('app.workspace_id', true)::uuid`.
- Schreibzugriffe nur über Service-Funktionen; Server Actions/Routen sind dünne Wrapper. In M0 gibt es noch keine UI — die Konvention wird in `CONTRIBUTING.md` §Architektur-Invarianten dokumentiert und ab M1 gelebt.
- `domain_events`-Emission in derselben Transaktion wie die Mutation; `domain_events` und `audit_log` sind per DB-Trigger append-only.
- Migrationen immer `npm run db:generate` **und** `npm run db:migrate` (bekannte Falle: generate ohne migrate).
- Zwei Datenbanken: `POSTGRES_URL` (dev), `POSTGRES_URL_TEST` (Tests). Niemals Tests gegen dev/prod.
- TypeScript `strict: true`; keine `any` in Fundament-Code.
- Node 22, npm. Code/Bezeichner Englisch, Doku Deutsch.
- Clean-Room (CONTRIBUTING.md): keine Reonic-Texte/-UI/-Daten, nirgends.
- Commits: kleine, task-bezogene Commits mit `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Next.js-Skeleton, Testinfrastruktur, ADR-Prozess

**Files:**
- Create: Next.js-App im Repo-Root (create-next-app), `vitest.config.ts`, `tests/setup/global-setup.ts`, `docs/adr/0001-architekturentscheidungen-als-adr.md`, `docs/adr/template.md`, `.env.example`
- Modify: `package.json` (Scripts), `tsconfig.json` (strict prüfen)

**Interfaces:**
- Produces: `npm run check` (lint + typecheck + test) als einziger Qualitäts-Einstiegspunkt; `tests/setup/global-setup.ts` als Ort, an dem später Migrationen für die Test-DB laufen (Task 2 erweitert ihn).

- [ ] **Step 1: App scaffolden (im bestehenden Repo-Root, das docs/ bereits enthält)**

```bash
cd ~/Downloads/Projects/energie-saas/repo
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir=false --import-alias "@/*" --use-npm --yes
npm i -D vitest @vitest/coverage-v8
```

Falls create-next-app das nicht-leere Verzeichnis ablehnt: in `/tmp/scaffold` scaffolden und Inhalte (ohne `.git`, ohne README-Überschreibung — unsere README.md behalten) ins Repo kopieren.

- [ ] **Step 2: `tsconfig.json` prüfen — `"strict": true` muss gesetzt sein** (create-next-app-Default; falls nicht, setzen).

- [ ] **Step 3: Vitest-Konfiguration schreiben**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    globalSetup: ["./tests/setup/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // eine Test-DB, sequenzielle Suiten
  },
});
```

```ts
// tests/setup/global-setup.ts
export default async function globalSetup() {
  if (!process.env.POSTGRES_URL_TEST) {
    throw new Error("POSTGRES_URL_TEST ist nicht gesetzt — Tests laufen NIE gegen die Dev-DB.");
  }
  // Task 2 ergänzt hier: Migrationen gegen die Test-DB ausführen.
}
```

- [ ] **Step 4: Scripts in `package.json` ergänzen**

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "npm run lint && npm run typecheck && npm run test"
  }
}
```

- [ ] **Step 5: `.env.example` anlegen**

```bash
# .env.example — echte Werte in .env.local (gitignored)
POSTGRES_URL=postgres://...
POSTGRES_URL_TEST=postgres://...
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
RESEND_API_KEY=
S3_ENDPOINT=
S3_REGION=eu-central-1
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

- [ ] **Step 6: ADR-Prozess anlegen**

```markdown
<!-- docs/adr/template.md -->
# ADR NNNN: <Titel>
Datum: JJJJ-MM-TT · Status: vorgeschlagen | akzeptiert | abgelöst durch NNNN
## Kontext
## Entscheidung
## Konsequenzen
```

```markdown
<!-- docs/adr/0001-architekturentscheidungen-als-adr.md -->
# ADR 0001: Architekturentscheidungen als ADR
Datum: 2026-08-26 · Status: akzeptiert
## Kontext
Solo-Entwicklung mit KI-Unterstützung: Entscheidungen ohne externes Gedächtnis erodieren.
## Entscheidung
Jede Architektur-/Modulentscheidung wird als nummeriertes ADR in docs/adr/ festgehalten
(Vorlage: template.md). Die Blaupause-Dokumente in docs/blaupause/ sind die Quell-Specs.
## Konsequenzen
PRs/Commits, die eine Grundsatzentscheidung ändern, referenzieren oder ergänzen ein ADR.
```

- [ ] **Step 7: Verifizieren**

Run: `npm run lint && npm run typecheck` → beides grün. `npm run test` → schlägt fehl mit der POSTGRES_URL_TEST-Fehlermeldung (erwarteter Beweis, dass der Guard greift; danach `POSTGRES_URL_TEST=… npm run test` → „no test files found" ist ok).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: Next.js-Skeleton, Vitest, ADR-Prozess"
```

---

### Task 2: Drizzle + Neon, Kern-Schema, Migrationen

**Files:**
- Create: `drizzle.config.ts`, `lib/db/schema/core.ts`, `lib/db/schema/index.ts`, `lib/db/client.ts`, `tests/db/connection.test.ts`
- Modify: `package.json` (db-Scripts), `tests/setup/global-setup.ts` (Migrationen)

**Interfaces:**
- Produces: `db` (Drizzle-Instanz, `lib/db/client.ts`), Tabellen `workspace { id uuid pk, name text, feature_flags jsonb, created_at }`, `user_identity { id uuid pk, email text unique, created_at }`, `membership { id uuid pk, workspace_id fk, user_id fk, role 'viewer'|'editor'|'admin', capabilities jsonb, created_at }`. Spätere Tasks importieren aus `@/lib/db/schema`.

- [ ] **Step 1: Pakete installieren**

```bash
npm i drizzle-orm pg && npm i -D drizzle-kit @types/pg tsx
```

- [ ] **Step 2: Failing Test schreiben**

```ts
// tests/db/connection.test.ts
import { describe, it, expect } from "vitest";
import { testDb } from "../setup/test-db";
import { workspace } from "@/lib/db/schema";

describe("db + schema", () => {
  it("verbindet sich und sieht die workspace-Tabelle", async () => {
    const rows = await testDb.select().from(workspace).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

```ts
// tests/setup/test-db.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";

export const testPool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST });
export const testDb = drizzle(testPool, { schema });
```

- [ ] **Step 3: Test laufen lassen — erwartet FAIL** (Schema-Module existieren nicht).

- [ ] **Step 4: Schema + Client implementieren**

```ts
// lib/db/schema/core.ts
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type Role = "viewer" | "editor" | "admin";

export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  featureFlags: jsonb("feature_flags").$type<Record<string, boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userIdentity = pgTable("user_identity", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(), // E-Mail = unveränderlicher Schlüssel (Blaupause Querschnitt/Auth)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membership = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    userId: uuid("user_id").notNull().references(() => userIdentity.id),
    role: text("role").$type<Role>().notNull().default("viewer"),
    // ~8 Einzelrechte lt. Architektur §5; Bereichs-Toggles/Teams später als ADDITIVE Spalten
    capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("membership_ws_user_uq").on(t.workspaceId, t.userId)],
);
```

```ts
// lib/db/schema/index.ts
export * from "./core";
```

```ts
// lib/db/client.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const url = process.env.POSTGRES_URL;
if (!url) throw new Error("POSTGRES_URL ist nicht gesetzt");
export const pool = new Pool({ connectionString: url, max: 5 });
export const db = drizzle(pool, { schema });
```

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.POSTGRES_URL! },
});
```

- [ ] **Step 5: db-Scripts + Test-Migration verdrahten**

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx scripts/migrate.ts",
    "db:migrate:test": "cross-env-shell \"POSTGRES_URL=$POSTGRES_URL_TEST tsx scripts/migrate.ts\""
  }
}
```

(`npm i -D cross-env`.)

```ts
// scripts/migrate.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.POSTGRES_URL;
if (!url) throw new Error("POSTGRES_URL ist nicht gesetzt");
const pool = new Pool({ connectionString: url, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrationen angewendet:", url.replace(/:[^:@/]+@/, ":***@"));
```

```ts
// tests/setup/global-setup.ts — Migrationsschritt ergänzen
import { execSync } from "node:child_process";

export default async function globalSetup() {
  const url = process.env.POSTGRES_URL_TEST;
  if (!url) throw new Error("POSTGRES_URL_TEST ist nicht gesetzt — Tests laufen NIE gegen die Dev-DB.");
  execSync("npx tsx scripts/migrate.ts", { env: { ...process.env, POSTGRES_URL: url }, stdio: "inherit" });
}
```

- [ ] **Step 6: Neon-Test-Branch/DB anlegen** (Neon-Konsole oder CLI: eigene Datenbank `energie_saas_test` im Projekt; Werte in `.env.local` als `POSTGRES_URL` + `POSTGRES_URL_TEST` eintragen — strikt getrennt).

- [ ] **Step 7: Migration erzeugen und anwenden**

Run: `npm run db:generate && npm run db:migrate` → SQL-Datei in `drizzle/`, Migration grün.

- [ ] **Step 8: Test laufen lassen — erwartet PASS.** Run: `npm run test`

- [ ] **Step 9: Commit** (`feat: Kern-Schema workspace/user_identity/membership + Migrationspfad`)

---

### Task 3: `withTenant` + RLS auf allen Mandantentabellen

**Files:**
- Create: `lib/db/tenant.ts`, `drizzle/NNNN_rls_core.sql` (Custom-Migration), `tests/db/rls.test.ts`

**Interfaces:**
- Produces: `withTenant<T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>` und Typ `TenantTx` — **der einzige legale Weg zu Mandantendaten**; alle Service-Funktionen ab M1 nehmen `TenantTx` als erstes Argument.

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/db/rls.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";

// withTenantOn(pool, wsId, fn): Testvariante gegen die Test-DB; withTenant nutzt den App-Pool.
let wsA: string, wsB: string;

beforeAll(async () => {
  wsA = randomUUID(); wsB = randomUUID();
  // Anlage über eine withTenant-Transaktion des jeweiligen Workspace (RLS with check erlaubt nur die eigene Zeile)
  await withTenantOn(testPool, wsA, (tx) => tx.execute(`insert into workspace (id, name) values ('${wsA}', 'A')`));
  await withTenantOn(testPool, wsB, (tx) => tx.execute(`insert into workspace (id, name) values ('${wsB}', 'B')`));
});

describe("RLS-Mandantentrennung", () => {
  it("sieht nur den eigenen Workspace", async () => {
    const rows = await withTenantOn(testPool, wsA, (tx) => tx.execute("select id from workspace"));
    expect(rows.rows.map((r: any) => r.id)).toEqual([wsA]);
  });

  it("ohne withTenant ist nichts sichtbar", async () => {
    const { rows } = await testPool.query("select count(*)::int as n from workspace");
    expect(rows[0].n).toBe(0);
  });

  it("Cross-Tenant-Insert wird abgelehnt", async () => {
    await expect(
      withTenantOn(testPool, wsA, (tx) =>
        tx.execute(`insert into workspace (id, name) values ('${wsB}', 'boese')`),
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL** (`withTenantOn` existiert nicht, RLS fehlt).

- [ ] **Step 3: `withTenant` implementieren**

```ts
// lib/db/tenant.ts
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool } from "./client";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function run<T>(d: Db, workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return d.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

export function withTenant<T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return run(db, workspaceId, fn);
}

// Für Tests: gleiche Semantik gegen einen beliebigen Pool (Test-DB).
export function withTenantOn<T>(p: Pool, workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return run(drizzle(p, { schema }), workspaceId, fn);
}
```

- [ ] **Step 4: RLS-Migration als Custom-SQL anlegen**

`npx drizzle-kit generate --custom --name rls_core`, dann in die erzeugte Datei:

```sql
-- RLS: enable + FORCE (auch der Tabellen-Owner unterliegt den Policies)
alter table workspace enable row level security;
alter table workspace force row level security;
create policy tenant_isolation on workspace
  using (id = current_setting('app.workspace_id', true)::uuid)
  with check (id = current_setting('app.workspace_id', true)::uuid);

alter table membership enable row level security;
alter table membership force row level security;
create policy tenant_isolation on membership
  using (workspace_id = current_setting('app.workspace_id', true)::uuid)
  with check (workspace_id = current_setting('app.workspace_id', true)::uuid);

-- user_identity ist bewusst global (Blaupause: eine Identität in n Workspaces) — keine Tenant-Policy.
```

- [ ] **Step 5: Migration anwenden** (`npm run db:migrate` für dev; Test-DB migriert der globalSetup).

- [ ] **Step 6: Test laufen lassen — erwartet PASS.**

- [ ] **Step 7: Commit** (`feat: withTenant + forced RLS auf workspace/membership`)

---

### Task 4: Generische Tenant-Isolations-Suite (Fehlerklasse statt Einzelfall)

**Files:**
- Create: `tests/db/tenant-invariants.test.ts`, `tests/setup/tenant-fixtures.ts`

**Interfaces:**
- Consumes: `withTenantOn` (Task 3).
- Produces: `tenantFixtures: Record<string, (tx: TenantTx, workspaceId: string) => Promise<void>>` — **jede neue Mandantentabelle MUSS hier eine Factory registrieren**, sonst wird die Suite rot. Das ist der Mechanismus, der die Invariante über alle künftigen Module (M1–M8) trägt.

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/setup/tenant-fixtures.ts
import type { TenantTx } from "@/lib/db/tenant";
import { sql } from "drizzle-orm";

// Factory legt GENAU EINE Zeile im gegebenen Workspace an (workspace-Zeile existiert bereits).
export const tenantFixtures: Record<string, (tx: TenantTx, wsId: string) => Promise<void>> = {
  workspace: async () => {}, // Zeile wird vom Suite-Setup selbst angelegt
  membership: async (tx, wsId) => {
    await tx.execute(sql`insert into user_identity (email) values (${wsId + "@test.local"})`);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      select ${wsId}::uuid, id, 'viewer' from user_identity where email = ${wsId + "@test.local"}`);
  },
};

// Globale Tabellen ohne workspace_id — jede Ausnahme ist hier begründet:
export const TENANT_EXEMPT = new Set<string>([
  "user_identity",        // globale Identität (eine Person, n Workspaces)
  "__drizzle_migrations", // Migrations-Buchhaltung
]);
export const TENANT_EXEMPT_PREFIXES = ["auth_", "pgboss_"]; // better-auth (Task 8), pg-boss (Task 11)
```

```ts
// tests/db/tenant-invariants.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { tenantFixtures, TENANT_EXEMPT, TENANT_EXEMPT_PREFIXES } from "../setup/tenant-fixtures";
import { sql } from "drizzle-orm";

let tables: { name: string }[] = [];
const wsA = randomUUID(), wsB = randomUUID();

beforeAll(async () => {
  const res = await testPool.query(`
    select c.relname as name, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`);
  tables = res.rows.filter(
    (t: any) => !TENANT_EXEMPT.has(t.name) && !TENANT_EXEMPT_PREFIXES.some((p) => t.name.startsWith(p)),
  );
  for (const ws of [wsA, wsB]) {
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'inv-test')`));
  }
});

describe("Tenant-Invarianten über ALLE Tabellen", () => {
  it("jede Mandantentabelle hat workspace_id NOT NULL (workspace: id als Tenant-Key)", async () => {
    for (const t of tables) {
      if (t.name === "workspace") continue;
      const col = await testPool.query(
        `select is_nullable from information_schema.columns where table_name = $1 and column_name = 'workspace_id'`,
        [t.name]);
      expect(col.rows, `${t.name}: workspace_id fehlt`).toHaveLength(1);
      expect(col.rows[0].is_nullable, `${t.name}: workspace_id nullable`).toBe("NO");
    }
  });

  it("jede Mandantentabelle hat RLS enabled + forced und eine app.workspace_id-Policy", async () => {
    for (const t of tables) {
      const rls = await testPool.query(
        `select relrowsecurity, relforcerowsecurity from pg_class where relname = $1`, [t.name]);
      expect(rls.rows[0].relrowsecurity, `${t.name}: RLS aus`).toBe(true);
      expect(rls.rows[0].relforcerowsecurity, `${t.name}: RLS nicht forced`).toBe(true);
      const pol = await testPool.query(
        `select 1 from pg_policies where tablename = $1 and (qual like '%app.workspace_id%' or with_check like '%app.workspace_id%')`,
        [t.name]);
      expect(pol.rows.length, `${t.name}: keine app.workspace_id-Policy`).toBeGreaterThan(0);
    }
  });

  it("jede Mandantentabelle hat eine Fixture-Factory registriert", () => {
    for (const t of tables) expect(tenantFixtures[t.name], `${t.name}: Fixture fehlt in tenant-fixtures.ts`).toBeDefined();
  });

  it("Zeilen aus Workspace A sind in Workspace B unsichtbar", async () => {
    for (const t of tables) {
      await withTenantOn(testPool, wsA, (tx) => tenantFixtures[t.name](tx, wsA));
      const inA = await withTenantOn(testPool, wsA, (tx) => tx.execute(sql.raw(`select count(*)::int as n from ${t.name}`)));
      const inB = await withTenantOn(testPool, wsB, (tx) => tx.execute(sql.raw(`select count(*)::int as n from ${t.name}`)));
      expect((inA.rows[0] as any).n, `${t.name}: Fixture hat nichts angelegt`).toBeGreaterThan(0);
      const bBaseline = t.name === "workspace" ? 1 : 0; // B sieht nur die eigene workspace-Zeile
      expect((inB.rows[0] as any).n, `${t.name}: LECK — B sieht Daten von A`).toBe(bBaseline);
    }
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet PASS** (workspace/membership erfüllen die Invarianten bereits; die Suite beweist sich, indem sie ab jetzt bei jeder neuen Tabelle ohne RLS/Fixture rot wird — Task 9 demonstriert das).

- [ ] **Step 3: Commit** (`test: generische Tenant-Isolations-Suite + Fixture-Registry`)

---

### Task 5: `domain_events`-Outbox + `audit_log`, append-only per Trigger

**Files:**
- Create: `lib/db/schema/events.ts`, `lib/events.ts`, `lib/audit.ts`, Custom-Migration `drizzle/NNNN_append_only.sql`, `tests/db/events.test.ts`
- Modify: `lib/db/schema/index.ts` (Re-Export), `tests/setup/tenant-fixtures.ts` (Fixtures für beide Tabellen)

**Interfaces:**
- Consumes: `TenantTx` (Task 3).
- Produces: `emitEvent(tx: TenantTx, e: { workspaceId: string; aggregateType: string; aggregateId: string; eventType: string; actor: string; payload?: unknown }): Promise<void>` und `writeAudit(tx: TenantTx, a: { workspaceId: string; actor: string; action: string; resource: string; allowed: boolean; details?: unknown }): Promise<void>`. Ab M1 ruft **jede** Service-Funktion `emitEvent` in ihrer Transaktion auf.

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/db/events.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { emitEvent } from "@/lib/events";

const ws = randomUUID();

beforeAll(async () => {
  await withTenantOn(testPool, ws, (tx) => tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'ev')`));
});

describe("domain_events", () => {
  it("emitEvent schreibt in derselben Transaktion", async () => {
    const aggId = randomUUID();
    await withTenantOn(testPool, ws, async (tx) => {
      await emitEvent(tx, { workspaceId: ws, aggregateType: "workspace", aggregateId: aggId, eventType: "test.created", actor: "system" });
    });
    const rows = await withTenantOn(testPool, ws, (tx) => tx.execute(sql`select event_type from domain_events where aggregate_id = ${aggId}::uuid`));
    expect((rows.rows[0] as any).event_type).toBe("test.created");
  });

  it("Transaktions-Rollback nimmt das Event mit (Outbox-Garantie)", async () => {
    const aggId = randomUUID();
    await expect(withTenantOn(testPool, ws, async (tx) => {
      await emitEvent(tx, { workspaceId: ws, aggregateType: "workspace", aggregateId: aggId, eventType: "test.rollback", actor: "system" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const rows = await withTenantOn(testPool, ws, (tx) => tx.execute(sql`select 1 from domain_events where aggregate_id = ${aggId}::uuid`));
    expect(rows.rows).toHaveLength(0);
  });

  it("UPDATE und DELETE auf domain_events schlagen fehl (append-only)", async () => {
    await expect(withTenantOn(testPool, ws, (tx) => tx.execute(sql`update domain_events set event_type = 'x'`))).rejects.toThrow(/append-only/);
    await expect(withTenantOn(testPool, ws, (tx) => tx.execute(sql`delete from domain_events`))).rejects.toThrow(/append-only/);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL.**

- [ ] **Step 3: Schema + Helfer implementieren**

```ts
// lib/db/schema/events.ts
import { pgTable, uuid, text, jsonb, timestamp, boolean, index } from "drizzle-orm/pg-core";

export const domainEvents = pgTable("domain_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  actor: text("actor").notNull(), // user_identity.id oder "system"/"api:<key>"
  payload: jsonb("payload").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("domain_events_aggregate_idx").on(t.workspaceId, t.aggregateType, t.aggregateId)]);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  allowed: boolean("allowed").notNull(), // auch ABGELEHNTE Zugriffe landen hier (Architektur §4)
  details: jsonb("details").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// lib/events.ts
import { domainEvents } from "./db/schema";
import type { TenantTx } from "./db/tenant";

export async function emitEvent(tx: TenantTx, e: {
  workspaceId: string; aggregateType: string; aggregateId: string;
  eventType: string; actor: string; payload?: unknown;
}): Promise<void> {
  await tx.insert(domainEvents).values({ ...e, payload: e.payload ?? {} });
}
```

```ts
// lib/audit.ts
import { auditLog } from "./db/schema";
import type { TenantTx } from "./db/tenant";

export async function writeAudit(tx: TenantTx, a: {
  workspaceId: string; actor: string; action: string; resource: string;
  allowed: boolean; details?: unknown;
}): Promise<void> {
  await tx.insert(auditLog).values({ ...a, details: a.details ?? {} });
}
```

- [ ] **Step 4: Migration generieren + append-only/RLS-Custom-Migration**

`npm run db:generate`, dann `npx drizzle-kit generate --custom --name append_only`:

```sql
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger domain_events_append_only before update or delete on domain_events
  for each row execute function forbid_mutation();
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function forbid_mutation();

alter table domain_events enable row level security;
alter table domain_events force row level security;
create policy tenant_isolation on domain_events
  using (workspace_id = current_setting('app.workspace_id', true)::uuid)
  with check (workspace_id = current_setting('app.workspace_id', true)::uuid);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation on audit_log
  using (workspace_id = current_setting('app.workspace_id', true)::uuid)
  with check (workspace_id = current_setting('app.workspace_id', true)::uuid);
```

- [ ] **Step 5: Fixtures registrieren** (in `tests/setup/tenant-fixtures.ts`):

```ts
domain_events: async (tx, wsId) => {
  await tx.execute(sql`insert into domain_events (workspace_id, aggregate_type, aggregate_id, event_type, actor)
    values (${wsId}::uuid, 'workspace', ${wsId}::uuid, 'fixture', 'system')`);
},
audit_log: async (tx, wsId) => {
  await tx.execute(sql`insert into audit_log (workspace_id, actor, action, resource, allowed)
    values (${wsId}::uuid, 'system', 'fixture', 'none', true)`);
},
```

- [ ] **Step 6: Migrieren, Tests laufen lassen — erwartet PASS** (inkl. Invarianten-Suite aus Task 4, die die zwei neuen Tabellen automatisch mitprüft).

- [ ] **Step 7: Commit** (`feat: domain_events-Outbox + audit_log, append-only, RLS`)

---

### Task 6: Statusmaschinen-Konvention

**Files:**
- Create: `lib/state-machine.ts`, `tests/unit/state-machine.test.ts`

**Interfaces:**
- Produces: `createStateMachine<S extends string>(transitions: Record<S, readonly S[]>)` mit `canTransition(from, to): boolean` und `assertTransition(from, to): void` (wirft `IllegalTransitionError`). Ab M1 definiert jedes Modul seine Maschinen damit (Projekt-Phase, Outcome; später Rechnung, Signatur, Filing).

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/unit/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { createStateMachine, IllegalTransitionError } from "@/lib/state-machine";

const phase = createStateMachine({
  request: ["offer"],
  offer: ["installation", "request"],
  installation: [],
} as const);

describe("state machine", () => {
  it("erlaubt definierte Übergänge", () => {
    expect(phase.canTransition("request", "offer")).toBe(true);
  });
  it("verbietet undefinierte Übergänge", () => {
    expect(phase.canTransition("request", "installation")).toBe(false);
    expect(() => phase.assertTransition("installation", "request")).toThrow(IllegalTransitionError);
  });
  it("Fehler nennt beide Zustände", () => {
    try { phase.assertTransition("request", "installation"); } catch (e) {
      expect((e as Error).message).toContain("request");
      expect((e as Error).message).toContain("installation");
    }
  });
});
```

- [ ] **Step 2: FAIL verifizieren, dann implementieren**

```ts
// lib/state-machine.ts
export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function createStateMachine<S extends string>(transitions: Record<S, readonly S[]>) {
  return {
    states: Object.keys(transitions) as S[],
    canTransition(from: S, to: S): boolean {
      return (transitions[from] ?? []).includes(to);
    },
    assertTransition(from: S, to: S): void {
      if (!this.canTransition(from, to)) throw new IllegalTransitionError(from, to);
    },
  };
}
```

- [ ] **Step 3: PASS verifizieren, Commit** (`feat: Statusmaschinen-Helper`)

---

### Task 7: Zentrale Rechteprüfung `can()` + Rechte-Matrix-Test

**Files:**
- Create: `lib/permissions.ts`, `tests/unit/permissions.test.ts`

**Interfaces:**
- Consumes: `Role` (Task 2).
- Produces: `can(ctx: PermissionCtx, action: Action): boolean` mit `PermissionCtx = { role: Role; capabilities: Record<string, boolean>; featureFlags: Record<string, boolean> }`; `Action`-Union und `ACTION_REQUIREMENTS`-Tabelle. **Jede Service-Funktion ab M1 ruft `can()` auf und schreibt bei Ablehnung `writeAudit(allowed: false)`.**

- [ ] **Step 1: Failing Test — die Matrix IST der Test**

```ts
// tests/unit/permissions.test.ts
import { describe, it, expect } from "vitest";
import { can, ACTION_REQUIREMENTS, type Action } from "@/lib/permissions";
import type { Role } from "@/lib/db/schema";

const ROLES: Role[] = ["viewer", "editor", "admin"];
const ctx = (role: Role, caps: Record<string, boolean> = {}, flags: Record<string, boolean> = { invoicing: true }) =>
  ({ role, capabilities: caps, featureFlags: flags });

describe("Rechte-Matrix: Action × Rolle × Capability", () => {
  it("viewer darf nie schreiben", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      if (ACTION_REQUIREMENTS[a].minRole !== "viewer") expect(can(ctx("viewer"), a), a).toBe(false);
    }
  });
  it("editor braucht die jeweilige Capability", () => {
    expect(can(ctx("editor"), "invoice.issue")).toBe(false);
    expect(can(ctx("editor", { invoicing: true }), "invoice.issue")).toBe(true);
    expect(can(ctx("editor"), "price.read_purchase")).toBe(false);
    expect(can(ctx("editor", { see_purchase_prices: true }), "price.read_purchase")).toBe(true);
  });
  it("admin impliziert alle Capabilities", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) expect(can(ctx("admin"), a), a).toBe(true);
  });
  it("deaktiviertes Workspace-Feature schlägt alles", () => {
    expect(can(ctx("admin", {}, { invoicing: false }), "invoice.issue")).toBe(false);
  });
  it("jede Action hat einen Eintrag (Vollständigkeit)", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      expect(ACTION_REQUIREMENTS[a].minRole).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: FAIL verifizieren, dann implementieren**

```ts
// lib/permissions.ts
import type { Role } from "./db/schema";

export type Capability =
  | "see_purchase_prices" | "edit_prices" | "discounts" | "invoicing"
  | "convert_phase" | "manage_catalog" | "manage_settings" | "external_only";

export type Action =
  | "project.read" | "project.write" | "phase.convert"
  | "price.read_purchase" | "price.edit" | "discount.apply"
  | "invoice.issue" | "catalog.manage" | "settings.manage";

export type PermissionCtx = {
  role: Role;
  capabilities: Partial<Record<Capability, boolean>>;
  featureFlags: Record<string, boolean>;
};

// Schicht 1: Workspace-Feature · Schicht 2: Mindestrolle · Schicht 3: Einzelrecht
export const ACTION_REQUIREMENTS: Record<Action, { minRole: Role; capability?: Capability; feature?: string }> = {
  "project.read":        { minRole: "viewer" },
  "project.write":       { minRole: "editor" },
  "phase.convert":       { minRole: "editor", capability: "convert_phase" },
  "price.read_purchase": { minRole: "editor", capability: "see_purchase_prices" },
  "price.edit":          { minRole: "editor", capability: "edit_prices" },
  "discount.apply":      { minRole: "editor", capability: "discounts" },
  "invoice.issue":       { minRole: "editor", capability: "invoicing", feature: "invoicing" },
  "catalog.manage":      { minRole: "editor", capability: "manage_catalog" },
  "settings.manage":     { minRole: "admin" },
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function can(ctx: PermissionCtx, action: Action): boolean {
  const req = ACTION_REQUIREMENTS[action];
  if (req.feature && !ctx.featureFlags[req.feature]) return false;
  if (RANK[ctx.role] < RANK[req.minRole]) return false;
  if (req.capability && ctx.role !== "admin" && !ctx.capabilities[req.capability]) return false;
  return true;
}
```

- [ ] **Step 3: PASS verifizieren, Commit** (`feat: zentrale can()-Rechteprüfung mit Matrix-Test`)

---

### Task 8: Passwortlose Auth (better-auth: Magic Link + E-Mail-OTP)

**Files:**
- Create: `lib/auth.ts`, `app/api/auth/[...all]/route.ts`, `lib/db/schema/auth.ts` (generiert), `lib/mail.ts`, `tests/db/auth.test.ts`
- Modify: `lib/db/schema/index.ts`, `tests/setup/tenant-fixtures.ts` (Exempt-Präfix ggf. anpassen)

**Interfaces:**
- Consumes: `db` (Task 2), `userIdentity` (Task 2).
- Produces: `auth` (better-auth-Instanz) mit Session-Lookup für spätere Server Actions; Hook, der bei Erst-Login eine `user_identity`-Zeile per E-Mail anlegt.

- [ ] **Step 1: Aktuelle better-auth-Doku prüfen (Pflicht, API bewegt sich):** Über context7 (`resolve-library-id: better-auth`, dann `query-docs`) die aktuellen Snippets für: Drizzle-Adapter, `magicLink`-Plugin, `emailOTP`-Plugin, Next.js-Route-Handler, CLI-Schema-Generierung. Abweichungen zu den Snippets unten übernehmen — die Doku gewinnt.

- [ ] **Step 2: Failing Test schreiben**

```ts
// tests/db/auth.test.ts
import { describe, it, expect } from "vitest";
import { testPool } from "../setup/test-db";

describe("auth-Schema", () => {
  it("better-auth-Tabellen existieren nach Migration", async () => {
    const { rows } = await testPool.query(
      `select table_name from information_schema.tables where table_schema='public' and table_name like 'auth_%'`);
    expect(rows.length).toBeGreaterThanOrEqual(3); // user, session, verification
  });
  it("auth-Instanz bootet", async () => {
    const { auth } = await import("@/lib/auth");
    expect(auth.handler).toBeDefined();
  });
});
```

- [ ] **Step 3: FAIL verifizieren, dann implementieren**

```bash
npm i better-auth resend
```

```ts
// lib/mail.ts
import { Resend } from "resend";

export async function sendAuthMail(to: string, subject: string, text: string) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[dev-mail] an ${to}: ${subject}\n${text}`); // lokal ohne Key: Link in der Konsole
    return;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({ from: "login@transactional.example.invalid", to, subject, text });
  // Absender-Domain wird beim Go-Live-Setup konfiguriert; bis dahin nur dev-Logging nutzen.
}
```

```ts
// lib/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, emailOTP } from "better-auth/plugins";
import { db } from "./db/client";
import { userIdentity } from "./db/schema";
import { sendAuthMail } from "./mail";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  // Tabellen-Präfix so konfigurieren, dass alle better-auth-Tabellen "auth_" tragen
  // (exakte Option lt. Doku-Check in Step 1; Ziel: TENANT_EXEMPT_PREFIXES greift).
  emailAndPassword: { enabled: false },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => sendAuthMail(email, "Dein Login-Link", url),
    }),
    emailOTP({
      sendVerificationOTP: async ({ email, otp }) => sendAuthMail(email, "Dein Login-Code", `Code: ${otp}`),
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await db.insert(userIdentity).values({ email: user.email }).onConflictDoNothing();
        },
      },
    },
  },
});
```

```ts
// app/api/auth/[...all]/route.ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 4: Schema generieren + migrieren:** `npx @better-auth/cli generate` → Ausgabe nach `lib/db/schema/auth.ts` übernehmen, aus `lib/db/schema/index.ts` re-exportieren, `npm run db:generate && npm run db:migrate`. Prüfen, dass die Tabellennamen mit `auth_` beginnen (sonst Prefix-Option bzw. `TENANT_EXEMPT` konkret pflegen).

- [ ] **Step 5: Tests laufen lassen — erwartet PASS** (inkl. Invarianten-Suite: auth-Tabellen sind exempt und begründet).

- [ ] **Step 6: `BETTER_AUTH_SECRET` erzeugen** (`openssl rand -base64 32`) und in `.env.local` eintragen; `.env.example` aktuell halten.

- [ ] **Step 7: Commit** (`feat: passwortlose Auth (Magic Link + OTP) mit user_identity-Hook`)

---

### Task 9: Site-Entität (schmal) — und Beweis, dass die Invarianten-Suite greift

**Files:**
- Create: `lib/db/schema/site.ts`, `modules/sites/service.ts`, `modules/sites/index.ts`, `tests/db/site.test.ts`
- Modify: `lib/db/schema/index.ts`, `tests/setup/tenant-fixtures.ts`

**Interfaces:**
- Consumes: `withTenant`/`TenantTx`, `emitEvent`, `can` — dieses Modul ist die **Referenz-Implementierung des Service-Funktions-Musters** für alle M1+-Module.
- Produces: Tabelle `site { id, workspace_id, label, street, house_number, postal_code, city, country, lat, lng, pin_confirmed, created_at }`; `createSite(tx, ctx, input): Promise<{ id: string }>`. Contact-FK kommt in M1 (Contact-Tabelle existiert noch nicht) — additive Spalte, im M1-Plan.

- [ ] **Step 1: Failing Tests schreiben — bewusst in dieser Reihenfolge:** Erst NUR die Schema-Datei anlegen (ohne RLS, ohne Fixture), dann `npm run db:generate && npm run test` laufen lassen. **Erwartet: die Invarianten-Suite aus Task 4 wird ROT** (fehlende Policy, fehlende Fixture). Das ist der Beweis, dass der Schutzmechanismus funktioniert — als Kommentar im Commit festhalten.

```ts
// lib/db/schema/site.ts
import { pgTable, uuid, text, doublePrecision, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const site = pgTable("site", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  label: text("label"),
  street: text("street"),
  houseNumber: text("house_number"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country").notNull().default("DE"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  pinConfirmed: boolean("pin_confirmed").notNull().default(false), // Blaupause F1.3: Pin zählt fürs Planen
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("site_ws_idx").on(t.workspaceId)]);
```

```ts
// tests/db/site.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { createSite } from "@/modules/sites";

const ws = randomUUID();
const editorCtx = { workspaceId: ws, actor: "test-user", role: "editor" as const, capabilities: {}, featureFlags: {} };
const viewerCtx = { ...editorCtx, role: "viewer" as const };

beforeAll(async () => {
  await withTenantOn(testPool, ws, (tx) => tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'site')`));
});

describe("sites-Service (Referenzmuster)", () => {
  it("legt Site an und emittiert site.created", async () => {
    const { id } = await withTenantOn(testPool, ws, (tx) => createSite(tx, editorCtx, { city: "Heidelberg", lat: 49.4, lng: 8.7, pinConfirmed: true }));
    const ev = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select 1 from domain_events where aggregate_id = ${id}::uuid and event_type = 'site.created'`));
    expect(ev.rows).toHaveLength(1);
  });
  it("viewer wird abgelehnt und die Ablehnung landet im audit_log", async () => {
    await expect(withTenantOn(testPool, ws, (tx) => createSite(tx, viewerCtx, { city: "X" }))).rejects.toThrow(/permission/i);
    const audit = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select 1 from audit_log where action = 'project.write' and allowed = false`));
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: RLS-Custom-Migration für `site`** (Muster aus Task 3: enable + force + `tenant_isolation`-Policy auf `workspace_id`), Fixture registrieren:

```ts
site: async (tx, wsId) => {
  await tx.execute(sql`insert into site (workspace_id, city) values (${wsId}::uuid, 'fixture')`);
},
```

- [ ] **Step 3: Service implementieren (das Muster für alle Module)**

```ts
// modules/sites/service.ts
import { site } from "@/lib/db/schema";
import type { TenantTx } from "@/lib/db/tenant";
import { can, type PermissionCtx } from "@/lib/permissions";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";

export class PermissionDeniedError extends Error {
  constructor(action: string) { super(`permission denied: ${action}`); }
}

export type ServiceCtx = PermissionCtx & { workspaceId: string; actor: string };

export type CreateSiteInput = {
  label?: string; street?: string; houseNumber?: string; postalCode?: string;
  city?: string; country?: string; lat?: number; lng?: number; pinConfirmed?: boolean;
};

export async function createSite(tx: TenantTx, ctx: ServiceCtx, input: CreateSiteInput): Promise<{ id: string }> {
  if (!can(ctx, "project.write")) {
    await writeAudit(tx, { workspaceId: ctx.workspaceId, actor: ctx.actor, action: "project.write", resource: "site", allowed: false });
    throw new PermissionDeniedError("project.write");
  }
  const [row] = await tx.insert(site).values({ workspaceId: ctx.workspaceId, ...input }).returning({ id: site.id });
  await emitEvent(tx, { workspaceId: ctx.workspaceId, aggregateType: "site", aggregateId: row.id, eventType: "site.created", actor: ctx.actor, payload: input });
  return row;
}
```

```ts
// modules/sites/index.ts — die EINZIGE öffentliche Schnittstelle des Moduls (dependency-cruiser erzwingt das ab Task 11)
export { createSite, PermissionDeniedError, type ServiceCtx, type CreateSiteInput } from "./service";
```

- [ ] **Step 4: Migrieren, alle Tests laufen lassen — erwartet PASS** (Invarianten-Suite wieder grün: site hat RLS + Fixture).

- [ ] **Step 5: Commit** (`feat: site-Entität + Referenz-Service-Muster (can + emitEvent + audit)`)

---

### Task 10: Storage-Abstraktion mit WORM-Vorbereitung

**Files:**
- Create: `lib/storage/types.ts`, `lib/storage/s3.ts`, `lib/storage/index.ts`, `tests/unit/storage.test.ts`

**Interfaces:**
- Produces: `ObjectStorage`-Interface: `put(key, body, contentType)`, `putImmutable(key, body, contentType) → { key, sha256 }` (verweigert Überschreiben), `getSignedReadUrl(key, ttl?)`, `getSignedUploadUrl(key, contentType, ttl?)`; `sha256Hex(buf): string`. M2/M3 legen signierte PDFs und issued-Belege ausschließlich über `putImmutable` ab; der Hash wandert in die DB.

- [ ] **Step 1: Failing Test schreiben**

```ts
// tests/unit/storage.test.ts
import { describe, it, expect } from "vitest";
import { sha256Hex, immutableKey, S3Storage } from "@/lib/storage";

describe("storage", () => {
  it("sha256Hex ist deterministisch und korrekt", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("immutableKey erzwingt das immutable/-Präfix", () => {
    expect(immutableKey("ws1", "offers", "abc.pdf")).toBe("immutable/ws1/offers/abc.pdf");
    expect(() => immutableKey("../x", "offers", "a.pdf")).toThrow();
  });
  it("putImmutable verweigert Überschreiben (Client gemockt)", async () => {
    const calls: string[] = [];
    const fakeClient = {
      send: async (cmd: any) => {
        calls.push(cmd.constructor.name);
        if (cmd.constructor.name === "HeadObjectCommand") return {}; // Objekt existiert bereits
        return {};
      },
    };
    const storage = new S3Storage({ bucket: "b" }, fakeClient as any);
    await expect(storage.putImmutable("immutable/ws1/offers/a.pdf", Buffer.from("x"), "application/pdf"))
      .rejects.toThrow(/existiert bereits/);
  });
});
```

- [ ] **Step 2: FAIL verifizieren, dann implementieren**

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```ts
// lib/storage/types.ts
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string }>;
  putImmutable(key: string, body: Buffer, contentType: string): Promise<{ key: string; sha256: string }>;
  getSignedReadUrl(key: string, ttlSeconds?: number): Promise<string>;
  getSignedUploadUrl(key: string, contentType: string, ttlSeconds?: number): Promise<string>;
}
```

```ts
// lib/storage/s3.ts
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import type { ObjectStorage } from "./types";

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const SAFE = /^[a-zA-Z0-9._-]+$/;
export function immutableKey(workspaceId: string, domain: string, filename: string): string {
  for (const part of [workspaceId, domain, filename]) {
    if (!SAFE.test(part)) throw new Error(`unsicherer Key-Bestandteil: ${part}`);
  }
  return `immutable/${workspaceId}/${domain}/${filename}`;
}

export class S3Storage implements ObjectStorage {
  constructor(
    private cfg: { bucket: string },
    private client: S3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    }),
  ) {}

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
    return { key };
  }

  async putImmutable(key: string, body: Buffer, contentType: string) {
    if (!key.startsWith("immutable/")) throw new Error("putImmutable verlangt immutable/-Key");
    const exists = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }))
      .then(() => true).catch((e: any) => (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound" ? false : Promise.reject(e)));
    if (exists) throw new Error(`Objekt existiert bereits (WORM): ${key}`);
    const sha256 = sha256Hex(body);
    await this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType,
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
    }));
    return { key, sha256 };
  }

  async getSignedReadUrl(key: string, ttlSeconds = 300) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSeconds });
  }

  async getSignedUploadUrl(key: string, contentType: string, ttlSeconds = 600) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType }), { expiresIn: ttlSeconds });
  }
}
```

```ts
// lib/storage/index.ts
export * from "./types";
export * from "./s3";
```

- [ ] **Step 3: PASS verifizieren.**

- [ ] **Step 4: Provider-Entscheidung als ADR 0002 anlegen** (`docs/adr/0002-object-storage-provider.md`): Anforderung EU-Region + S3-API + **echter Object-Lock für das GoBD-Vollarchiv ab M2/M3**. Vor dem M2-Start per Anbieter-Doku verifizieren, ob Hetzner Object Storage Object-Lock unterstützt (WebFetch auf docs.hetzner.com); falls nein → AWS S3 eu-central-1 nur für den `immutable/`-Bucket. Status in M0: „vorgeschlagen" mit dieser offenen Prüfung — die App-seitige WORM-Semantik (dieser Task) ist davon unabhängig.

- [ ] **Step 5: Commit** (`feat: Storage-Abstraktion mit App-seitiger WORM-Semantik + Hash`)

---

### Task 11: Worker-Host (pg-boss, Healthcheck, Docker Compose)

**Files:**
- Create: `worker/index.ts`, `worker/Dockerfile`, `worker/compose.yaml`, `docs/runbooks/worker.md`, `tests/db/worker-queue.test.ts`

**Interfaces:**
- Consumes: `POSTGRES_URL` (pg-boss legt eigenes Schema `pgboss` an — in `TENANT_EXEMPT_PREFIXES` bereits berücksichtigt; die Invarianten-Suite prüft nur `public`).
- Produces: Job-Namenskonvention `"<modul>.<aufgabe>"`; M2 registriert hier `pdf.render`, M4 `simulation.run`. Healthcheck auf `:8080/health`.

- [ ] **Step 1: Aktuelle pg-boss-Doku prüfen** (context7: `pg-boss`; v10-API: `work`-Handler erhält ein Job-**Array**). Snippets unten ggf. anpassen.

- [ ] **Step 2: Failing Test schreiben (Queue-Roundtrip gegen Test-DB)**

```ts
// tests/db/worker-queue.test.ts
import { describe, it, expect } from "vitest";
import PgBoss from "pg-boss";

describe("pg-boss Roundtrip", () => {
  it("sendet und empfängt einen Job", async () => {
    const boss = new PgBoss(process.env.POSTGRES_URL_TEST!);
    await boss.start();
    await boss.createQueue("health.echo");
    await boss.send("health.echo", { ping: 1 });
    const [job] = await boss.fetch("health.echo");
    expect((job!.data as any).ping).toBe(1);
    await boss.complete("health.echo", [job!.id]);
    await boss.stop({ graceful: false });
  }, 30_000);
});
```

- [ ] **Step 3: FAIL verifizieren (`npm i pg-boss`), dann Worker implementieren**

```ts
// worker/index.ts
import PgBoss from "pg-boss";
import { createServer } from "node:http";

const STARTED = new Date().toISOString();
const boss = new PgBoss(process.env.POSTGRES_URL!);
boss.on("error", (err) => console.error("[pg-boss]", err));

await boss.start();
await boss.createQueue("health.echo");
await boss.work("health.echo", async (jobs) => {
  for (const job of jobs) console.log("[health.echo]", job.id, job.data);
});
// M2 registriert hier pdf.render (Playwright/Chrome), M4 simulation.run (pvlib-Sidecar).

createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, startedAt: STARTED }));
}).listen(8080, () => console.log("worker health on :8080"));
```

```dockerfile
# worker/Dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i tsx
COPY . .
CMD ["npx", "tsx", "worker/index.ts"]
```

```yaml
# worker/compose.yaml — läuft auf dem Hetzner-Host
services:
  worker:
    build: { context: .., dockerfile: worker/Dockerfile }
    restart: always
    environment:
      - POSTGRES_URL=${POSTGRES_URL}
    ports: ["127.0.0.1:8080:8080"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

```markdown
<!-- docs/runbooks/worker.md -->
# Runbook Worker-Host
- Deploy: auf dem Hetzner-Host `docker compose -f worker/compose.yaml up -d --build`
- Health: `curl -s localhost:8080/health` → `{ ok: true }`
- Degradation: Worker-Ausfall verzögert Jobs (PDF/Simulation), blockiert NIE das Portal.
- Logs: `docker compose -f worker/compose.yaml logs -f worker`
- Neustart: `docker compose -f worker/compose.yaml restart worker`
- Alarm: Uptime-Check auf /health (z. B. UptimeRobot) → einrichten, sobald der Host produktiv ist.
```

- [ ] **Step 4: Test laufen lassen — erwartet PASS.** Lokal zusätzlich `npx tsx worker/index.ts` starten und `curl localhost:8080/health` prüfen. (Hetzner-Provisionierung selbst ist ein Deploy-Schritt bei M2-Bedarf, kein M0-Blocker — im Runbook dokumentiert.)

- [ ] **Step 5: Commit** (`feat: Worker-Host mit pg-boss, Healthcheck, Compose + Runbook`)

---

### Task 12: Modulgrenzen (dependency-cruiser) + CI

**Files:**
- Create: `.dependency-cruiser.cjs`, `modules/README.md`, `.github/workflows/ci.yml`
- Modify: `package.json` (`depcruise`- und `check`-Script)

**Interfaces:**
- Produces: `npm run check` = lint + typecheck + depcruise + test — **die Definition von „grün"** für alle M1+-Arbeit; CI-Workflow für den Fall eines GitHub-Remotes (aktuell keins — lokal ist `npm run check` der Gate-Keeper).

- [ ] **Step 1: Failing Check bauen:** Testweise in `modules/sites/service.ts` einen Import aus einem (temporären) `modules/other/internal.ts` einfügen — depcruise (Step 3) muss das ablehnen. Nach Verifikation revertieren.

- [ ] **Step 2: Regeln implementieren**

```bash
npm i -D dependency-cruiser
```

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: "module-internals-sind-privat",
      comment: "Module reden nur über ihre index.ts miteinander (Architektur §1).",
      severity: "error",
      from: { path: "^modules/([^/]+)/" },
      to: { path: "^modules/(?!\\1/)([^/]+)/(?!index\\.ts$).+" },
    },
    {
      name: "lib-kennt-keine-module",
      comment: "lib/ ist Fundament und darf nicht von Modulen abhängen.",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^modules/" },
    },
    {
      name: "app-nur-module-public-api",
      comment: "Routen/Actions greifen nie an Modul-Interna vorbei.",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^modules/[^/]+/(?!index\\.ts$).+" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
```

```json
{
  "scripts": {
    "depcruise": "depcruise modules lib app --config .dependency-cruiser.cjs",
    "check": "npm run lint && npm run typecheck && npm run depcruise && npm run test"
  }
}
```

```markdown
<!-- modules/README.md -->
# Modul-Konvention
Jedes Fachmodul (crm, offers, invoicing, …) ist ein Ordner mit genau einer öffentlichen
Schnittstelle: `index.ts`. Interna (service.ts, queries.ts, …) sind privat — der Import
aus fremden Modul-Interna ist per dependency-cruiser CI-rot. Service-Funktionen nehmen
`TenantTx` + `ServiceCtx`, prüfen `can()`, emittieren `domain_events`. Referenz: `modules/sites/`.
```

- [ ] **Step 3: Verletzung aus Step 1 verifizieren (depcruise rot), revertieren, `npm run check` komplett grün laufen lassen.**

- [ ] **Step 4: CI-Workflow anlegen** (wird aktiv, sobald ein GitHub-Remote existiert)

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_PASSWORD: test, POSTGRES_DB: app_test }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      POSTGRES_URL_TEST: postgres://postgres:test@localhost:5432/app_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run check
```

- [ ] **Step 5: Commit** (`chore: lint-erzwungene Modulgrenzen + CI-Workflow; check ist das Quality-Gate`)

---

### Task 13: Konzeptdokumente (Backup/DR, DSGVO-Löschung, Rechts-Checkliste)

**Files:**
- Create: `docs/konzepte/backup-dr.md`, `docs/konzepte/dsgvo-loeschkonzept.md`, `docs/konzepte/rechts-checkliste.md`

**Interfaces:**
- Consumes: Architektur §4 (WORM/append-only), Vollständigkeitskritik §3/§4.
- Produces: verbindliche Konzepte, gegen die M2/M3 (Belege), M1 (Kontakte) implementiert werden; Checkliste der Nutzer-Aktionen (Anwalt, Steuerberater, Markencheck).

- [ ] **Step 1: Backup/DR-Konzept schreiben**

```markdown
<!-- docs/konzepte/backup-dr.md -->
# Backup & Disaster Recovery
## Schutzziele
- RPO ≤ 24 h (Fakturierungsdaten: ≤ 1 h sobald Pilotkunde produktiv), RTO ≤ 4 h.
## Mechanik
- Neon: PITR/Branch-Restore (Point-in-time) — Aufbewahrung auf 7 Tage konfigurieren;
  zusätzlich täglicher logischer Dump (`pg_dump`) vom Worker-Host in den Object Storage
  (Bucket `backups/`, 30 Tage Rotation), damit ein Neon-Konto-Verlust nicht alles kostet.
- Object Storage: `immutable/` ist per WORM selbst der Schutz; `backups/` versioniert.
- Secrets: `.env`-Werte liegen zusätzlich im Passwort-Manager (nicht nur auf dem Rechner).
## Restore-Test (Pflicht, wiederkehrend)
- Vor Pilot-Start und danach quartalsweise: Dump in leere DB einspielen, `npm run check`
  gegen die Restore-DB, ein Beleg-PDF per Hash gegen die DB verifizieren. Ergebnis als
  Notiz in docs/runbooks/restore-log.md.
```

- [ ] **Step 2: DSGVO-Löschkonzept schreiben**

```markdown
<!-- docs/konzepte/dsgvo-loeschkonzept.md -->
# DSGVO-Löschkonzept (Krypto-Shredding + Pseudonymisierung)
## Problem
Append-only (domain_events, audit_log) und WORM-Belege kollidieren mit Art. 17 DSGVO.
Rechnungen sind 8 Jahre aufbewahrungspflichtig (§ 147 AO) — dort geht Aufbewahrung vor
Löschung. Notizen, Events-Payloads, Kontaktdaten außerhalb von Belegen nicht.
## Regeln (ab M1 bindend)
1. Personenbezug in Events/Audit NUR als IDs, nie als Klartext (kein Name/E-Mail im payload).
2. Kontakt-Löschung = Pseudonymisierung der contact-Zeile (Felder überschreiben mit
   "geloescht-<id>") + Löschzeitstempel; referenzielle IDs bleiben, Belege bleiben.
3. Wo Klartext in unveränderlichen Artefakten unvermeidbar ist (Beleg-PDF), gilt die
   gesetzliche Aufbewahrung als Rechtsgrundlage (Art. 17 Abs. 3 b DSGVO) — dokumentiert
   in der Datenschutzerklärung/AVV.
4. Krypto-Shredding als Ausbaustufe (pro Kontakt verschlüsselte Zusatzfelder, Schlüssel
   löschbar) wird erst eingeführt, wenn ein Modul Klartext-Personenbezug in append-only-
   Strukturen braucht — bis dahin verhindert Regel 1 das Problem an der Wurzel.
## Fristen
- Leads ohne Vertrag: Löschprüfung nach 24 Monaten Inaktivität (konfigurierbar pro Workspace).
- Bewerber-/Marketingdaten: nicht Teil des Produkts (Stand M0).
```

- [ ] **Step 3: Rechts-Checkliste schreiben (Nutzer-Aktionen explizit)**

```markdown
<!-- docs/konzepte/rechts-checkliste.md -->
# Rechts-Checkliste bis Pilot
| # | Was | Wer | Status |
|---|-----|-----|--------|
| 1 | Naming festlegen + Markenrecherche DPMA/EUIPO | Mikail | offen |
| 2 | AGB + AVV (Vorlagenbasis) → 1× Fachanwalts-Review | Mikail + Anwalt | offen |
| 3 | eIDAS-Einordnung Eigenbau-E-Signatur (einfache eSig, § 356a-Widerruf) im selben Review | Anwalt | offen |
| 4 | Steuerberater-Review Fakturierung + Verfahrensdoku (vor M3-Abschluss) | Mikail + StB | offen |
| 5 | Impressum, Datenschutzerklärung, Subprozessorenliste (Vercel, Neon, Hetzner, Resend, AWS/Hetzner-S3, Anthropic) | Mikail | offen |
| 6 | Clean-Room-Regeln gelesen + akzeptiert (jede beteiligte Person) | alle | Mikail: 26.08.2026 |
Referenz: CONTRIBUTING.md (Clean-Room), docs/blaupause/03-integrationskarte.md §6.
```

- [ ] **Step 4: Querverweis in `docs/PLAN.md`-Kopie aktualisieren** (Konzepte existieren jetzt) und `npm run check` final laufen lassen — grün.

- [ ] **Step 5: Commit** (`docs: Backup/DR-, DSGVO-Lösch- und Rechts-Konzepte für M0`)

---

## Abnahme M0 (gegen Spec)

- `npm run check` grün: lint, typecheck, depcruise-Grenzen, alle Tests (RLS, Invarianten-Suite, Events append-only, Statusmaschine, Rechte-Matrix, Auth-Schema, Site-Referenzmuster, Storage, Queue-Roundtrip).
- Invarianten-Suite beweist: neue Tabelle ohne RLS/Fixture → rot (in Task 9 demonstriert).
- Roadmap-M0-Punkte ohne Code-Anteil sind als Konzept/Runbook dokumentiert (Backup/DR, Löschkonzept, Rechts-Checkliste, Worker-Runbook, ADRs).
- Bewusst NICHT in M0 (lt. Roadmap): Teams/Bereichs-Toggles (additiv nachrüstbar), OIDC-SSO, Command-Executor, PDF-Rendering (M2), Hetzner-Produktiv-Provisionierung (bei M2-Bedarf), Förder-/VNB-Redaktionsstart (paralleler, nicht-technischer Track).
