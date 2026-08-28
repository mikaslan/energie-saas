import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn, withSessionTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError, WORKSPACE_ACCESS } from "@/lib/permissions";
import { createSite } from "@/modules/sites";

// ═══════════════════════════════════════════════════════════════════════
// Die Autorisierungsgrenze (Spec: docs/spec/M1-00-autorisierungsgrenze.md).
//
// Geprüft wird hier die sicherheitskritische Hälfte: die Auflösung
// Session-Nutzer -> Membership -> ServiceCtx unter RLS. Der Session-Teil
// selbst (next/headers) hat einen eigenen Unit-Test ohne DB.
//
// Der Kern der Zusage: die SELECT-Policy auf user_identity
// (drizzle/0002_rls_user_identity.sql) macht eine Identität nur sichtbar,
// wenn sie im AKTUELLEN Workspace Mitglied ist. Damit ist die Auflösung
// strukturell fail-closed — es gibt keinen Pfad, auf dem eine fremde
// Workspace-UUID mit der eigenen Rolle kombinierbar wäre (Codex-Review #2,
// eine Ebene höher).
// ═══════════════════════════════════════════════════════════════════════

const wsA = randomUUID();
const wsB = randomUUID();

// auth_user.id ist in better-auth ein text-Feld; die Grenze joint darauf,
// ohne die auth_*-Tabellen zu lesen. Für den Test genügen daher freie Strings.
const authAdmin = `auth-admin-${randomUUID()}`;
const authViewer = `auth-viewer-${randomUUID()}`;
const authFremd = `auth-fremd-${randomUUID()}`;
const authNieEingeloggt = `auth-nie-${randomUUID()}`;

let idAdmin: string;
let idViewer: string;
let idFremd: string;

async function anlegenIdentitaet(ws: string, authUserId: string | null, role: string): Promise<string> {
  const id = randomUUID();
  const email = `${randomUUID()}@example.test`;
  return withTenantOn(testPool, ws, async (tx) => {
    // Kein INSERT ... RETURNING: RETURNING unterliegt der SELECT-Policy von
    // user_identity, die erst nach der Membership greift. Deshalb dieselbe
    // clientseitige UUID-Naht wie in den bestehenden RLS-Fixtures.
    await tx.execute(sql`
      insert into user_identity (id, email, auth_user_id)
      values (${id}::uuid, ${email}, ${authUserId})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      values (${ws}::uuid, ${id}::uuid, ${role})
    `);
    return id;
  });
}

beforeAll(async () => {
  await withTenantOn(testPool, wsA, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${wsA}::uuid, 'grenze-a')`));
  await withTenantOn(testPool, wsB, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${wsB}::uuid, 'grenze-b')`));

  idAdmin = await anlegenIdentitaet(wsA, authAdmin, "admin");
  idViewer = await anlegenIdentitaet(wsA, authViewer, "viewer");
  // Mitglied ausschliesslich in Workspace B — fuer den Cross-Tenant-Angriff.
  idFremd = await anlegenIdentitaet(wsB, authFremd, "admin");
  // Eingeladen, nie eingeloggt: auth_user_id bleibt NULL.
  await anlegenIdentitaet(wsA, null, "admin");
});

describe("Autorisierungsgrenze — withSessionTenant", () => {
  it("Mitglied mit ausreichender Rolle: ctx kommt vollstaendig aus der DB", async () => {
    const ctx = await withSessionTenantOn(testPool, authAdmin, wsA, async (_tx, c) => c);
    expect(ctx.workspaceId).toBe(wsA);
    expect(ctx.actor).toBe(idAdmin);
    expect(ctx.role).toBe("admin");
    expect(ctx.capabilities).toEqual({});
    expect(ctx.featureFlags).toEqual({});
  });

  it("der aufgeloeste Actor ist die user_identity.id, NICHT die auth_user.id", async () => {
    const ctx = await withSessionTenantOn(testPool, authViewer, wsA, async (_tx, c) => c);
    expect(ctx.actor).toBe(idViewer);
    expect(ctx.actor).not.toBe(authViewer);
  });

  it("die Grenze traegt den Mandantenkontext in die Transaktion: ein Service laeuft durch", async () => {
    const { id } = await withSessionTenantOn(testPool, authAdmin, wsA, (tx, ctx) =>
      createSite(tx, ctx, { city: "Grenze" }));
    const row = await withTenantOn(testPool, wsA, (tx) =>
      tx.execute(sql`select 1 from site where id = ${id}::uuid and workspace_id = ${wsA}::uuid`));
    expect(row.rows).toHaveLength(1);
  });

  it("keine Membership im angefragten Workspace: PermissionDeniedError(WORKSPACE_ACCESS)", async () => {
    let caught: unknown;
    try {
      await withSessionTenantOn(testPool, `auth-unbekannt-${randomUUID()}`, wsA, async () => "nie");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).action).toBe(WORKSPACE_ACCESS);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Der eigentliche Angriff (Codex-Review #2, eine Ebene hoeher): der
  // Nutzer ist Admin — aber in Workspace B. Ruft er mit workspaceId = A,
  // darf seine Rolle NICHT gelten. Die RLS auf user_identity blendet ihn
  // im Kontext A vollstaendig aus, es gibt also gar keinen Treffer.
  // ═══════════════════════════════════════════════════════════════════
  it("Admin in B darf nicht als Admin in A auftreten", async () => {
    expect(idFremd).toBeDefined();
    await expect(
      withSessionTenantOn(testPool, authFremd, wsA, async (_tx, c) => c),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("in seinem EIGENEN Workspace funktioniert derselbe Nutzer weiterhin", async () => {
    const ctx = await withSessionTenantOn(testPool, authFremd, wsB, async (_tx, c) => c);
    expect(ctx.actor).toBe(idFremd);
    expect(ctx.role).toBe("admin");
  });

  it("eingeladene, nie eingeloggte Identitaet (auth_user_id NULL) loest nicht auf", async () => {
    await expect(
      withSessionTenantOn(testPool, authNieEingeloggt, wsA, async (_tx, c) => c),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  // Ein NULL-auth_user_id darf nicht per SQL-NULL-Semantik zufaellig matchen.
  it("auth_user_id = NULL matcht nicht auf einen leeren String", async () => {
    await expect(
      withSessionTenantOn(testPool, "", wsA, async (_tx, c) => c),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("abgelehnter Zugriff hinterlaesst KEINEN Audit in der abgebrochenen Transaktion", async () => {
    const vorher = await withTenantOn(testPool, wsA, (tx) =>
      tx.execute(sql`select count(*)::int as n from audit_log where workspace_id = ${wsA}::uuid and allowed = false`));

    // viewer darf nicht schreiben -> Service wirft, Transaktion stirbt
    await expect(
      withSessionTenantOn(testPool, authViewer, wsA, (tx, ctx) => createSite(tx, ctx, { city: "Verboten" })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const nachher = await withTenantOn(testPool, wsA, (tx) =>
      tx.execute<{ n: number; [k: string]: unknown }>(
        sql`select count(*)::int as n from audit_log where workspace_id = ${wsA}::uuid and allowed = false`));
    expect(
      nachher.rows[0].n,
      "Denial-Audit gehoert an die Aufrufgrenze (neue Transaktion), nicht in die abgebrochene",
    ).toBe((vorher.rows[0] as { n: number }).n);
  });

  it("der abgelehnte Service hat auch fachlich nichts hinterlassen", async () => {
    await expect(
      withSessionTenantOn(testPool, authViewer, wsA, (tx, ctx) => createSite(tx, ctx, { city: "Spurlos" })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const reste = await withTenantOn(testPool, wsA, (tx) =>
      tx.execute(sql`select 1 from site where workspace_id = ${wsA}::uuid and city = 'Spurlos'`));
    expect(reste.rows).toHaveLength(0);
  });
});
