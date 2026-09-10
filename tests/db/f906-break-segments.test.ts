import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
} from "@/lib/integrations/time-tracking/contract";
import {
  approveTimeEntry,
  breakMinutesTotal,
  createTimeEntry,
  createTimeEventType,
  endBreak,
  listBreaks,
  startBreak,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
  typeId: string;
  entryId: string;
};

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F9-06 Pausen')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f906.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f906.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f906.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-06 Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f906.test`}, ${`${contactId}@f906.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-06 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9-06 Projekt', 'fixture'
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
  const typeId = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEventType(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      name: "Montage",
    }).then((created) => created.id),
  );
  const entryId = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEntry(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      projectId,
      fields: {
        typeId,
        startAt: "2026-09-04T08:00:00.000Z",
        endAt: "2026-09-04T10:00:00.000Z",
        workingTimeMinutes: 120,
        breakDurationMinutes: 0,
        comment: "Pausen-Kandidat",
      },
    }).then((created) => created.id),
  );
  return { workspaceId, editorId, viewerId, externalId, projectId, typeId, entryId };
}

describe("F9-06 Pausen-Segmente (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace();
  });

  it("F906-DB-01: Start/Liste/Ende plus deterministische Summe", async () => {
    const started = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(started.entryId).toBe(fixture.entryId);
    expect(started.endedAt).toBeNull();

    const open = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => breakMinutesTotal(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(open.openBreak).toBe(true);

    const listed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listBreaks(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(listed.map((segment) => segment.id)).toContain(started.id);

    const ended = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => endBreak(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(ended.id).toBe(started.id);
    expect(ended.endedAt).not.toBeNull();

    // Deterministische 30-Minuten-Summe ueber direkt gelegtes Segment.
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into time_break_segment (workspace_id, entry_id, started_at, ended_at, created_by)
        values (${fixture.workspaceId}::uuid, ${fixture.entryId}::uuid,
          '2026-09-04T08:10:00.000Z'::timestamptz, '2026-09-04T08:40:00.000Z'::timestamptz,
          ${fixture.editorId}::uuid)
      `);
    });
    const total = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => breakMinutesTotal(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(total.openBreak).toBe(false);
    expect(total.breakMinutes).toBeGreaterThanOrEqual(30);

    const chronological = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listBreaks(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(chronological).toHaveLength(2);
    expect(chronological[0]!.startedAt <= chronological[1]!.startedAt).toBe(true);
  });

  it("F906-DB-02: Doppel-Start und Ende-ohne-offen fail-closed", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => endBreak(tx, ctx, { entryId: fixture.entryId }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => endBreak(tx, ctx, { entryId: fixture.entryId }),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);
  });

  it("F906-DB-03: Freigegebener und unbekannter Eintrag fail-closed", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, fixture.entryId),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: "00000000-0000-4000-8000-000000000000" }),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => endBreak(tx, ctx, { entryId: "00000000-0000-4000-8000-000000000000" }),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });

  it("F906-RBAC-01: Viewer liest; Schreiben nur mit time.write", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    );
    const seen = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listBreaks(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(seen).toHaveLength(1);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    )).rejects.toBeInstanceOf(Error);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => startBreak(tx, ctx, { entryId: fixture.entryId }),
    )).rejects.toBeInstanceOf(Error);
  });
});
