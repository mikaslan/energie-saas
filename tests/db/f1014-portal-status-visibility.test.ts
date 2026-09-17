// F10-14 Installations-Sichtbarkeit (PostgreSQL): Set/Liste/Reset +
// Portal-Projektion von statusVisibility.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  InstallationValidationError,
  listInstallationStatusLabels,
  listInstallationStatusVisibility,
  resetInstallationStatusLabel,
  setInstallationStatusVisibility,
  upsertInstallationStatusLabel,
} from "@/modules/installations";
import {
  createPortalInvite,
  PORTAL_INVITE_CREATE_VERSION,
  resolvePortalByToken,
} from "@/modules/portal";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  viewerId: string;
};

async function seedFixture(emailDomain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1014 Sichtbarkeit')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@${emailDomain}`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1014', 'F', 'X', 'c@f1014.test', 'c@f1014.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1014 Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F1014 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into installation (workspace_id, project_id, source, status)
      values (${workspaceId}::uuid, ${projectId}::uuid, 'direct', 'active')
    `);
  });
  return { workspaceId, projectId, editorId, viewerId };
}

describe("F10-14 Installations-Sichtbarkeit (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f1014.test");
  });

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  const asViewer = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.viewerId, fixture.workspaceId, fn as never) as Promise<T>;

  async function seedInvite(fx: Fixture): Promise<string> {
    const created = await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        ttlDays: 14,
      }),
    );
    return created.token;
  }

  async function countRows(): Promise<number> {
    return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{ count: string }>(sql`
        select count(*)::text as count
          from portal_status_label
         where workspace_id = ${fixture.workspaceId}::uuid
           and scope = 'installation'
      `);
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  it("F1014-DB-01: Set-Roundtrip je Schluessel, Normalisierung, Label-Erhalt, Reset", async () => {
    // Ohne Zeile: ehrlich sichtbar (Default, kein Orakel-Block).
    expect(await asEditor((tx, ctx) => listInstallationStatusVisibility(tx, ctx))).toEqual({
      active: true,
      completed: true,
      handover: true,
    });
    expect(await countRows()).toBe(0);

    // Voller Roundtrip je Schluessel.
    for (const key of ["active", "completed", "handover"] as const) {
      const hidden = await asEditor((tx, ctx) =>
        setInstallationStatusVisibility(tx, ctx, { key, visible: false }));
      expect(hidden[key]).toBe(false);
      // Reine Sichtbarkeits-Zeile: kein Label-Override (NULL), damit
      // uebersetzte Portal-Fallbacks je Sprache greifen (Review P1-1).
      expect((await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx)))[key])
        .toBeNull();
      const shown = await asEditor((tx, ctx) =>
        setInstallationStatusVisibility(tx, ctx, { key, visible: true }));
      expect(shown[key]).toBe(true);
    }
    // Normalisierung: Einblenden reiner Sichtbarkeits-Zeilen loescht sie.
    expect(await countRows()).toBe(0);

    // Einblenden ohne Zeile = No-Op (keine ueberfluessige Zeile).
    await asEditor((tx, ctx) =>
      setInstallationStatusVisibility(tx, ctx, { key: "active", visible: true }));
    expect(await countRows()).toBe(0);

    // Eigenes Label + Toggle: Label bleibt, nur Sichtbarkeit wechselt.
    await asEditor((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "completed", label: "Fertig!" }));
    await asEditor((tx, ctx) =>
      setInstallationStatusVisibility(tx, ctx, { key: "completed", visible: false }));
    expect((await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx))).completed)
      .toBe("Fertig!");
    expect((await asEditor((tx, ctx) => listInstallationStatusVisibility(tx, ctx))).completed)
      .toBe(false);
    // Label-Upsert nach Hide veraendert die Sichtbarkeit nicht.
    await asEditor((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "completed", label: "Wirklich fertig!" }));
    expect((await asEditor((tx, ctx) => listInstallationStatusVisibility(tx, ctx))).completed)
      .toBe(false);
    // Einblenden mit explizitem Label behaelt die Zeile (Label bleibt).
    await asEditor((tx, ctx) =>
      setInstallationStatusVisibility(tx, ctx, { key: "completed", visible: true }));
    expect((await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx))).completed)
      .toBe("Wirklich fertig!");
    expect(await countRows()).toBe(1);

    // Reset loescht die Zeile ⇒ sichtbar + Standard.
    await asEditor((tx, ctx) => resetInstallationStatusLabel(tx, ctx, { key: "completed" }));
    expect(await asEditor((tx, ctx) => listInstallationStatusVisibility(tx, ctx))).toEqual({
      active: true,
      completed: true,
      handover: true,
    });
    expect((await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx))).completed)
      .toBeNull();
    expect(await countRows()).toBe(0);

    // Reset einer reinen Sichtbarkeits-Zeile (NULL, false) ⇒ weg.
    await asEditor((tx, ctx) =>
      setInstallationStatusVisibility(tx, ctx, { key: "handover", visible: false }));
    expect(await countRows()).toBe(1);
    await asEditor((tx, ctx) => resetInstallationStatusLabel(tx, ctx, { key: "handover" }));
    expect(await asEditor((tx, ctx) => listInstallationStatusVisibility(tx, ctx))).toEqual({
      active: true,
      completed: true,
      handover: true,
    });
    expect(await countRows()).toBe(0);
  });

  it("F1014-DB-02: Validierung fail-closed, Viewer read-only, Mandantentrennung", async () => {
    await expect(
      asEditor((tx, ctx) =>
        setInstallationStatusVisibility(tx, ctx, { key: "geheim", visible: false })),
    ).rejects.toBeInstanceOf(InstallationValidationError);
    await expect(
      asEditor((tx, ctx) =>
        setInstallationStatusVisibility(tx, ctx, { key: "active", visible: "ja" })),
    ).rejects.toBeInstanceOf(InstallationValidationError);

    // Viewer liest, schreibt nicht.
    expect(await asViewer((tx, ctx) => listInstallationStatusVisibility(tx, ctx))).toEqual({
      active: true,
      completed: true,
      handover: true,
    });
    await expect(
      asViewer((tx, ctx) =>
        setInstallationStatusVisibility(tx, ctx, { key: "active", visible: false })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremder Mandant: eigene Sicht, kein Leck aus dem Seed-Workspace.
    await asEditor((tx, ctx) =>
      setInstallationStatusVisibility(tx, ctx, { key: "active", visible: false }));
    const foreign = await seedFixture("f1014-fremd.test");
    const foreignSeen = await withAuthorizedTenantOn(
      testPool,
      foreign.editorId,
      foreign.workspaceId,
      (tx, ctx) => listInstallationStatusVisibility(tx, ctx),
    );
    expect(foreignSeen).toEqual({ active: true, completed: true, handover: true });
  });

  it("F1014-DB-03: Resolver projiziert statusVisibility, ohne Mapping {}", async () => {
    const token = await seedInvite(fixture);
    const plain = await resolvePortalByToken(testPool, { token });
    expect(plain.installation).not.toBeNull();
    expect(plain.installation?.statusVisibility).toEqual({});
    // Minimiert: keine Interna ueber das Boolean-Override hinaus.
    expect(JSON.stringify(plain.installation)).not.toContain("source_key");

    await asEditor((tx, ctx) =>
      setInstallationStatusVisibility(tx, ctx, { key: "active", visible: false }));
    await asEditor((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "completed", label: "Fertig!" }));
    const mapped = await resolvePortalByToken(testPool, { token });
    // Jede Zeile projiziert ehrlich (completed-Zeile ist sichtbar=true).
    expect(mapped.installation?.statusVisibility).toEqual({ active: false, completed: true });
    // Reine Sichtbarkeits-Zeile (NULL-Label) faellt nicht in
    // statusLabels — uebersetzte Fallbacks je Sprache greifen.
    expect(mapped.installation?.statusLabels).toEqual({ completed: "Fertig!" });
  });
});
