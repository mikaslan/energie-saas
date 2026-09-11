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
  createTimeEventType,
  exportTimeEntries,
  listTimeEntries,
  TimeTrackingValidationError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  typeAnfahrt: string;
  typeMontage: string;
};

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F9.09 Filter')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f909.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f909.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.09 Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f909.test`}, ${`${contactId}@f909.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.09 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9.09 Projekt', 'fixture'
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
  const typeAnfahrt = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEventType(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      name: "Anfahrt",
    }).then((created) => created.id),
  );
  const typeMontage = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEventType(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      name: "Montage",
    }).then((created) => created.id),
  );
  return { workspaceId, editorId, viewerId, projectId, typeAnfahrt, typeMontage };
}

function entryCommand(
  projectId: string,
  typeId: string | null,
  startAt: string,
  endAt: string,
  minutes: number,
  comment: string,
): CreateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields: {
      typeId,
      startAt,
      endAt,
      workingTimeMinutes: minutes,
      breakDurationMinutes: 0,
      comment,
    },
  };
}

describe("F9.09 Listen-/Export-Filter (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace();
    // A: Berlin 2026-09-04 10:00 (UTC 08:00), Typ Anfahrt, 60 Min.
    // B: Berlin 2026-09-04 00:30 (UTC 2026-09-03 22:30 — UTC-Datum kippt),
    //    Typ Montage, 90 Min.
    // C: Berlin 2026-09-05 08:00 (UTC 06:00), ohne Typ, 30 Min.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(
        fixture.projectId, fixture.typeAnfahrt,
        "2026-09-04T08:00:00.000Z", "2026-09-04T09:00:00.000Z", 60, "A Anfahrt",
      )),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(
        fixture.projectId, fixture.typeMontage,
        "2026-09-03T22:30:00.000Z", "2026-09-04T00:00:00.000Z", 90, "B Montage",
      )),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(
        fixture.projectId, null,
        "2026-09-05T06:00:00.000Z", "2026-09-05T06:30:00.000Z", 30, "C ohne Typ",
      )),
    );
  });

  it("F909-DB-01: Datumsfilter zählt Berlin-Kalendertage auf Beginn, Summe folgt", async () => {
    const day = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        startDate: "2026-09-04",
        endDate: "2026-09-04",
      }),
    );
    // B startet in UTC am 03.09., in Berlin aber am 04.09. → dabei.
    expect(day.entries.map((entry) => entry.comment).sort()).toEqual(["A Anfahrt", "B Montage"]);
    expect(day.totalWorkingMinutes).toBe(150);

    const next = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        startDate: "2026-09-05",
      }),
    );
    expect(next.entries.map((entry) => entry.comment)).toEqual(["C ohne Typ"]);
    expect(next.totalWorkingMinutes).toBe(30);
  });

  it("F909-DB-02: Typfilter trifft nur gesetzte Typen, ohne Filter alles", async () => {
    const filtered = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        eventTypeIds: [fixture.typeMontage],
      }),
    );
    expect(filtered.entries.map((entry) => entry.comment)).toEqual(["B Montage"]);
    expect(filtered.totalWorkingMinutes).toBe(90);

    const all = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(all.entries).toHaveLength(3);
    expect(all.totalWorkingMinutes).toBe(180);
  });

  it("F909-DB-03: Export ist WYSIWYG zur gefilterten Liste", async () => {
    const query = {
      projectId: fixture.projectId,
      startDate: "2026-09-04",
      endDate: "2026-09-04",
      eventTypeIds: [fixture.typeAnfahrt],
    };
    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, query),
    );
    const csv = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, query),
    );
    expect(list.entries.map((entry) => entry.comment)).toEqual(["A Anfahrt"]);
    const rows = csv.content.split("\r\n").filter((line) => line.length > 0);
    expect(rows.length).toBe(list.entries.length + 1);
    expect(csv.content).toContain("A Anfahrt");
    expect(csv.content).not.toContain("B Montage");
  });

  it("F909-DB-04: ungültiger Zeitraum und Kalenderdatum werfen Validation", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        startDate: "2026-09-05",
        endDate: "2026-09-04",
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        startDate: "2026-02-30",
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => exportTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        startDate: "kein-datum",
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });
});
