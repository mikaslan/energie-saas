// F9-15 R1c Offline-Replay projektlos (PostgreSQL): clientKey-Idempotenz
// projektlos + Key-gewinnt-Semantik über Projektzweige hinweg.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEntry,
  listProjectlessTimeEntries,
  listTimeEntries,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
};

// F902/F913/F914-Stil: frischer Workspace je Test, eigenes Projekt, kein W3-Recycling.
async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f915c.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f915c.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-15c Projekt', 'F9', 'Fuenfzehn',
        ${`${contactId}@f915c.test`}, ${`${contactId}@f915c.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-15c Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F9-15c Projekt', 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
        and intake_column.board_id = board.id
        and intake_column.is_intake = true
        and intake_column.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
  });
  return { workspaceId, editorId, viewerId, projectId };
}

function entryCommand(projectId: string | null, clientKey?: string): CreateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields: {
      typeId: null,
      startAt: "2026-09-05T08:00:00.000Z",
      endAt: "2026-09-05T10:00:00.000Z",
      workingTimeMinutes: 120,
      breakDurationMinutes: 0,
      comment: "Projektlose Offline-Arbeit",
    },
    ...(clientKey === undefined ? {} : { clientKey }),
  };
}

describe("F9-15 R1c Projektloses Offline-Replay (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9-15c Projektlos-Offline");
  });

  const run = (fx: Fixture, command: CreateTimeEntryCommand) =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      createTimeEntry(tx, ctx, command));

  const createdEventCount = async (fx: Fixture): Promise<number> => {
    const found = await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from domain_events
         where workspace_id = ${fx.workspaceId}::uuid
           and event_type = 'time_entry.created'
      `);
      return rows.rows[0]?.n ?? "0";
    });
    return Number(found);
  };

  it("F915c-DB-01: doppeltes Replay desselben projektlosen Keys → 1 Eintrag, 1 Event", async () => {
    const clientKey = randomUUID();

    const first = await run(fixture, entryCommand(null, clientKey));
    expect(first.projectId).toBeNull();
    const replay = await run(fixture, entryCommand(null, clientKey));
    expect(replay.id).toBe(first.id);

    const list = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, {}),
    );
    expect(list.entries.filter((entry) => entry.id === first.id)).toHaveLength(1);
    expect(list.entries).toHaveLength(1);
    expect(await createdEventCount(fixture)).toBe(1);
  });

  it("F915c-DB-02: derselbe Key mit anderem Projekt → dieselbe Zeile (Key-gewinnt, kein Duplikat)", async () => {
    // client_key ist per time_entry_ws_client_key_uq workspace-weit eindeutig:
    // Ein Replay mit abweichendem Projektzweig liefert die Bestandszeile
    // zurück (Idempotenz), statt zu kollidieren oder zu duplizieren.
    const projectlessKey = randomUUID();
    const projectKey = randomUUID();

    const projectless = await run(fixture, entryCommand(null, projectlessKey));
    const replayAsProject = await run(
      fixture,
      entryCommand(fixture.projectId, projectlessKey),
    );
    expect(replayAsProject.id).toBe(projectless.id);
    expect(replayAsProject.projectId).toBeNull();

    const projectBound = await run(fixture, entryCommand(fixture.projectId, projectKey));
    const replayAsProjectless = await run(fixture, entryCommand(null, projectKey));
    expect(replayAsProjectless.id).toBe(projectBound.id);
    expect(replayAsProjectless.projectId).toBe(fixture.projectId);

    const withoutProject = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, {}),
    );
    expect(withoutProject.entries.map((e) => e.id)).toEqual([projectless.id]);

    const withProject = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(withProject.entries.map((e) => e.id)).toEqual([projectBound.id]);
    expect(await createdEventCount(fixture)).toBe(2);
  });
});
