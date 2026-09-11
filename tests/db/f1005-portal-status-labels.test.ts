// F10-05 Portal-Statusmapping (PostgreSQL): Upsert/Liste/Reset +
// Portal-Projektion der Overrides.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  InstallationValidationError,
  listInstallationStatusLabels,
  resetInstallationStatusLabel,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1005 Statusmapping')`);
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1005', 'F', 'X', 'c@f1005.test', 'c@f1005.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1005 Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F1005 Project', 'manual'
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

describe("F10-05 Portal-Statusmapping (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f1005.test");
  });

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  const asViewer = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.viewerId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditorIn = (fx: Fixture) =>
    <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F1005-DB-01: Upsert-Roundtrip, Reset, ungemappt = null", async () => {
    expect(await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx))).toEqual({
      active: null,
      completed: null,
      handover: null,
    });
    const afterSet = await asEditor((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "active", label: "Wird montiert" }));
    expect(afterSet).toEqual({ active: "Wird montiert", completed: null, handover: null });
    // Gleicher Schlüssel überschreibt (kein Duplikat).
    await asEditor((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "active", label: "Montage läuft" }));
    const again = await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx));
    expect(again.active).toBe("Montage läuft");
    const count = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from portal_status_label
         where workspace_id = ${fixture.workspaceId}::uuid`);
      return Number(rows.rows[0]?.n ?? "0");
    });
    expect(count).toBe(1);
    const afterReset = await asEditor((tx, ctx) =>
      resetInstallationStatusLabel(tx, ctx, { key: "active" }));
    expect(afterReset).toEqual({ active: null, completed: null, handover: null });
  });

  it("F1005-DB-02: Validierung fail-closed, Viewer read-only, Mandantentrennung", async () => {
    // Unbekannter Schlüssel, Leertext, zu lang, Steuerzeichen.
    for (const input of [
      { key: "flying", label: "X" },
      { key: "active", label: "   " },
      { key: "active", label: "A".repeat(81) },
      { key: "active", label: "Bau\tmorgen" },
    ]) {
      await expect(asEditor((tx, ctx) =>
        upsertInstallationStatusLabel(tx, ctx, input))).rejects.toBeInstanceOf(InstallationValidationError);
    }
    await expect(asEditor((tx, ctx) =>
      resetInstallationStatusLabel(tx, ctx, { key: "flying" }))).rejects.toBeInstanceOf(
      InstallationValidationError,
    );
    // Viewer liest, schreibt nicht.
    expect(await asViewer((tx, ctx) => listInstallationStatusLabels(tx, ctx))).toEqual({
      active: null,
      completed: null,
      handover: null,
    });
    await expect(asViewer((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "active", label: "X" }))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    // Fremdmandant sieht nichts und schreibt getrennt.
    const foreign = await seedFixture("f1005-foreign.test");
    const runForeign = asEditorIn(foreign);
    expect(await runForeign((tx, ctx) => listInstallationStatusLabels(tx, ctx))).toEqual({
      active: null,
      completed: null,
      handover: null,
    });
    await runForeign((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "active", label: "Fremd montiert" }));
    expect(await asEditor((tx, ctx) => listInstallationStatusLabels(tx, ctx))).toEqual({
      active: null,
      completed: null,
      handover: null,
    });
  });

  it("F1005-DB-03: Resolver projiziert Overrides, ohne Mapping leeres Objekt", async () => {
    const invite = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        ttlDays: 14,
      }),
    );
    const empty = await resolvePortalByToken(testPool, { token: invite.token });
    expect(empty.installation?.statusLabels).toEqual({});

    await asEditor((tx, ctx) =>
      upsertInstallationStatusLabel(tx, ctx, { key: "active", label: "Wird montiert" }));
    const mapped = await resolvePortalByToken(testPool, { token: invite.token });
    expect(mapped.installation?.statusLabels).toEqual({ active: "Wird montiert" });
  });
});
