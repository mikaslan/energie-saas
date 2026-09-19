import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type StartTimeEntryCommand,
  type StopTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  getMyRunningTimeEntry,
  listTimeEventTypes,
  startTimeEntry,
  stopTimeEntry,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  projectId: string;
};

// F902-Stil: frischer Workspace je Test (Provisionierungs-Trigger feuert),
// eigenes Projekt, kein W3-Recycling.
async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f913.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f913.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f913.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-13 Projekt', 'F9', 'Dreizehn',
        ${`${contactId}@f913.test`}, ${`${contactId}@f913.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-13 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F9-13 Projekt', 'fixture'
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
  return { workspaceId, editorId, viewerId, adminId, projectId };
}

function startCommand(projectId: string, typeId: string | null = null): StartTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    typeId,
    comment: "Floating-Timer",
  };
}

function stopCommand(id: string, minutes = 90): StopTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id,
    workingTimeMinutes: minutes,
    breakDurationMinutes: 0,
    comment: "Floating-Timer",
  };
}

async function travelTypeId(fixture: Fixture): Promise<string> {
  const types = await withAuthorizedTenantOn(
    testPool, fixture.viewerId, fixture.workspaceId,
    (tx, ctx) => listTimeEventTypes(tx, ctx),
  );
  return types.find((t) => t.name === "Travel")!.id;
}

describe("F9-13 Floating-Timer (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9-13 Floating-Timer");
  });

  it("F913-DB-01: laufender Timer wird mit Projekt- und Typ-Name gelesen", async () => {
    const typeId = await travelTypeId(fixture);
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId, typeId)),
    );
    const mine = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getMyRunningTimeEntry(tx, ctx),
    );
    expect(mine).not.toBeNull();
    expect(mine!.id).toBe(running.id);
    expect(mine!.projectId).toBe(fixture.projectId);
    expect(mine!.projectName).toBe("F9-13 Projekt");
    expect(mine!.typeName).toBe("Travel");
    expect(mine!.running).toBe(true);
    expect(mine!.startAt).toBe(running.startAt);
  });

  it("F913-DB-02: ohne laufenden Timer null; nach Stopp null", async () => {
    const idle = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getMyRunningTimeEntry(tx, ctx),
    );
    expect(idle).toBeNull();

    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(running.id)),
    );
    const stopped = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getMyRunningTimeEntry(tx, ctx),
    );
    expect(stopped).toBeNull();
  });

  it("F913-DB-03: fremder laufender Timer bleibt unsichtbar", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    const foreign = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getMyRunningTimeEntry(tx, ctx),
    );
    expect(foreign).toBeNull();
    const own = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => getMyRunningTimeEntry(tx, ctx),
    );
    expect(own).not.toBeNull();
    expect(own!.projectId).toBe(fixture.projectId);
  });
});
