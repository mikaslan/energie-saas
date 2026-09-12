import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  completeInstallation,
  createInstallation,
  InstallationNotFoundError,
  InstallationValidationError,
  listInstallationHandovers,
  recordHandover,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; projectId: string; editorId: string; viewerId: string };

async function seedFixture(suffix: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${`F7-14 ${suffix}`})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f714.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f714.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F714-CUSTOMER', 'Fixture', 'Contact', 'c@f714.test', 'c@f714.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F714 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F714 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId, viewerId };
}

async function seedCompleted(fixture: Fixture): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
  );
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
  );
}

describe("F7-14 Abnahme-Historie (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("Abnahme");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F714-DB-01: Abnahme + Korrektur → Verlauf mit beiden Einträgen, Kopf zeigt Korrektur", async () => {
    await seedCompleted(fixture);

    // Vor der ersten Abnahme ist der Verlauf leer (Installation existiert).
    const empty = await asEditor(fixture, (tx, ctx) => listInstallationHandovers(tx, ctx, { projectId: fixture.projectId }));
    expect(empty).toEqual([]);

    await asEditor(fixture, (tx, ctx) => recordHandover(tx, ctx, {
      projectId: fixture.projectId,
      byName: "Familie Berger",
      note: "Zähler läuft, App erklärt.",
    }));
    const corrected = await asEditor(fixture, (tx, ctx) => recordHandover(tx, ctx, {
      projectId: fixture.projectId,
      byName: "Familie Berger",
      note: null,
    }));
    expect(corrected.handoverNote).toBeNull();

    const history = await asEditor(fixture, (tx, ctx) => listInstallationHandovers(tx, ctx, { projectId: fixture.projectId }));
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ byName: "Familie Berger", note: "Zähler läuft, App erklärt." });
    expect(history[1]).toMatchObject({ byName: "Familie Berger", note: null });
    expect(typeof history[0]?.id).toBe("string");
    expect(history[0]?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Aufsteigend, keine Actor-IDs im Verlauf.
    expect(Object.keys(history[0] ?? {}).sort()).toEqual(["byName", "id", "note", "recordedAt"]);
    expect(new Date(history[0]?.recordedAt ?? 0).getTime())
      .toBeLessThanOrEqual(new Date(history[1]?.recordedAt ?? 0).getTime());
  });

  it("F714-DB-02: Guards, Mandantentrennung, RBAC", async () => {
    // Aktive Installation: Abnahme fail-closed, kein Verlaufseintrag.
    await asEditor(fixture, (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }));
    await expect(asEditor(fixture, (tx, ctx) => recordHandover(tx, ctx, {
      projectId: fixture.projectId, byName: "Zu früh",
    }))).rejects.toBeInstanceOf(InstallationValidationError);
    const noneAfterFailed = await asEditor(fixture, (tx, ctx) => listInstallationHandovers(tx, ctx, { projectId: fixture.projectId }));
    expect(noneAfterFailed).toEqual([]);

    // Unbekanntes Projekt → NotFound ohne Orakel (Anlage + Liste).
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(asEditor(fixture, (tx, ctx) => recordHandover(tx, ctx, {
      projectId: missing, byName: "Niemand",
    }))).rejects.toBeInstanceOf(InstallationNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) => listInstallationHandovers(tx, ctx, { projectId: missing }))).rejects
      .toBeInstanceOf(InstallationNotFoundError);

    // Fremdmandant sieht weder Kopf noch Verlauf.
    const other = await seedFixture("Fremd");
    await expect(
      withAuthorizedTenantOn(testPool, other.editorId, other.workspaceId, ((tx: never, ctx: never) =>
        listInstallationHandovers(tx, ctx, { projectId: fixture.projectId })) as never) as Promise<unknown>,
    ).rejects.toBeInstanceOf(InstallationNotFoundError);

    // Viewer liest den Verlauf, darf aber keine Abnahme festhalten.
    await seedCompleted(other);
    await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      ((tx: never, ctx: never) => recordHandover(tx, ctx, {
        projectId: other.projectId, byName: "Sichtbar",
      })) as never,
    );
    const viewerHistory = await asViewer(other, (tx, ctx) => listInstallationHandovers(tx, ctx, { projectId: other.projectId }));
    expect(viewerHistory).toHaveLength(1);
    await expect(asViewer(other, (tx, ctx) => recordHandover(tx, ctx, {
      projectId: other.projectId, byName: "Verboten",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
