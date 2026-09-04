import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEntry,
  createTimeEntry,
  listTimeEntries,
  listTimeMemberOptions,
  startTimeEntry,
  TimeTrackingValidationError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
};

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F9.3 Filter')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f903.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f903.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f903.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f903.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb),
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.3 Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f903.test`}, ${`${contactId}@f903.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.3 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9.3 Projekt', 'fixture'
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
  return { workspaceId, editorId, adminId, viewerId, externalId, projectId };
}

function entryCommand(projectId: string, minutes: number, startHour: number): CreateTimeEntryCommand {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields: {
      typeId: null,
      startAt: `2026-09-04T${pad(startHour)}:00:00.000Z`,
      endAt: `2026-09-04T${pad(startHour + 2)}:00:00.000Z`,
      workingTimeMinutes: minutes,
      breakDurationMinutes: 0,
      comment: "Filter-Fixture",
    },
  };
}

describe("F9.3 Fremdnutzer-Filter (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, 120, 8)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, 60, 12)),
    );
  });

  it("F903-DB-01: filtert Eintraege je Nutzer, Summe folgt", async () => {
    const onlyEditor = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [fixture.editorId] }),
    );
    expect(onlyEditor.entries).toHaveLength(1);
    expect(onlyEditor.entries[0]!.userId).toBe(fixture.editorId);
    expect(onlyEditor.totalWorkingMinutes).toBe(120);

    const both = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        userIds: [fixture.editorId, fixture.adminId],
      }),
    );
    expect(both.entries).toHaveLength(2);
    expect(both.totalWorkingMinutes).toBe(180);
  });

  it("F903-DB-02: fehlend/leer/null = kein Filter; nur-Unbekannte != leer", async () => {
    const base = { projectId: fixture.projectId } as const;
    const unfiltered = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, base),
    );
    const empty = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [] }),
    );
    const nulled = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: null }),
    );
    expect(unfiltered.entries).toHaveLength(2);
    expect(empty.entries).toHaveLength(2);
    expect(nulled.entries).toHaveLength(2);

    const unknownOnly = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [randomUUID()] }),
    );
    expect(unknownOnly.entries).toHaveLength(0);
    expect(unknownOnly.totalWorkingMinutes).toBe(0);
  });

  it("F903-DB-03: Mischfall bekannt+fremd, fremder Workspace", async () => {
    const other = await seedWorkspace();
    const mixed = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        userIds: [fixture.adminId, randomUUID(), other.editorId],
      }),
    );
    expect(mixed.entries).toHaveLength(1);
    expect(mixed.entries[0]!.userId).toBe(fixture.adminId);
    expect(mixed.totalWorkingMinutes).toBe(60);

    const foreignOnly = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [other.editorId] }),
    );
    expect(foreignOnly.entries).toHaveLength(0);
  });

  it("F903-DB-03b: laufende/archivierte Eintraege unter Filter", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: null,
      }),
    );
    const stopped = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, 30, 14)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, stopped.id),
    );
    const adminOnly = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [fixture.adminId] }),
    );
    expect(adminOnly.entries.map((e) => e.id)).toContain(running.id);
    expect(adminOnly.totalWorkingMinutes).toBe(60);
    const editorOnly = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [fixture.editorId] }),
    );
    expect(editorOnly.entries.map((e) => e.id)).not.toContain(stopped.id);
    expect(editorOnly.totalWorkingMinutes).toBe(120);
  });

  it("F903-DB-04: 50 IDs ok, 51 und keine UUID -> ValidationError", async () => {
    const fifty: string[] = Array.from({ length: 49 }, () => randomUUID());
    fifty.push(fixture.editorId);
    const ok = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: fifty }),
    );
    expect(ok.entries).toHaveLength(1);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, {
        projectId: fixture.projectId,
        userIds: Array.from({ length: 51 }, () => randomUUID()),
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: ["keine-uuid"] }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });

  it("F903-DB-05: Member-Options fuer time.read, Externe blockiert", async () => {
    const options = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeMemberOptions(tx, ctx),
    );
    const byId = new Map(options.map((o) => [o.userId, o.label]));
    expect(byId.get(fixture.editorId)).toContain("editor-");
    expect(byId.get(fixture.adminId)).toContain("admin-");

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => listTimeMemberOptions(tx, ctx),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, userIds: [fixture.editorId] }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
