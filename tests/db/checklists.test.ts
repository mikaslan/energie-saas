import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  checklistProgress,
  type ChecklistBlocksV1,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistValidationError,
  getProjectChecklist,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  projectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f702.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702.test`})
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
  });
  const projectId = await seedProject(workspaceId, "F7.2 Projekt");
  return { workspaceId, editorId, viewerId, adminId, projectId };
}

async function seedProject(workspaceId: string, name: string): Promise<string> {
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${name}, 'F7', 'Fixture',
        ${`${contactId}@f702.test`}, ${`${contactId}@f702.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${name} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${name}, 'fixture'
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
  return projectId;
}

function blocks(overrides: Partial<ChecklistBlocksV1[number]> = {}): ChecklistBlocksV1 {
  return [{
    name: "PV",
    position: 0,
    segments: [{
      name: "Basis",
      position: 0,
      items: [
        { title: "Dach geprüft", done: false },
        { title: "Zählerschrank dokumentiert", done: true },
      ],
    }],
    ...overrides,
  }];
}

function command(projectId: string, baseVersion: number, value: ChecklistBlocksV1 = blocks()): SaveProjectChecklistCommand {
  return {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    projectId,
    baseVersion,
    blocks: value,
  };
}

describe("F7.2 Projekt-Checklisten (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7.2 Checklisten");
  });

  it("F702-DB-01: Leer-Read, Insert, CAS-Update, Stale-Konflikt", async () => {
    const empty = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(empty.version).toBe(0);
    expect(empty.blocks).toEqual([]);

    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    );
    expect(created.version).toBe(1);
    expect(created.blocks[0]!.name).toBe("PV");

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 1, blocks({
        name: "PV+Speicher",
      }))),
    );
    expect(updated.version).toBe(2);
    expect(updated.blocks[0]!.name).toBe("PV+Speicher");

    // Stale baseVersion → Conflict mit aktueller Version.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 1)),
    )).rejects.toBeInstanceOf(ChecklistConflictError);
  });

  it("F702-DB-02: Blocks-Validierung (Form, Längen, Steuerzeichen, done-Typ)", async () => {
    const invalid = [
      blocks({ name: "  " }),
      blocks({ name: "x".repeat(201) }),
      blocks({ name: "Block", segments: [{ name: "S", position: 0, items: [{ title: "a\nb", done: false }] }] }),
      blocks({ name: "Block", segments: [{ name: "S", position: 0, items: [{ title: "t", done: "ja" as unknown as boolean }] }] }),
      blocks({ name: "Block", position: -1, segments: [] }),
    ];
    for (const value of invalid) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, value)),
      )).rejects.toBeInstanceOf(ChecklistValidationError);
    }

    // Unbekanntes Projekt → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(randomUUID(), 0)),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);

    // DB-CHECK: blocks muss jsonb-array sein.
    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into project_checklist (workspace_id, project_id, blocks, created_by)
      values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, '{}'::jsonb, ${fixture.editorId}::uuid)
    `))).rejects.toThrow();
  });

  it("F702-DB-03: 1:1 je Projekt + Cross-Workspace-Isolation", async () => {
    const other = await seedWorkspace("F7.2 Fremd");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    );

    // Zweites Insert (baseVersion 0) auf dasselbe Projekt → Konflikt (1:1).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    )).rejects.toBeInstanceOf(ChecklistConflictError);

    // Fremder Workspace: eigener Leer-Read für dasselbe Projekt (RLS).
    const foreign = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(foreign.version).toBe(0);

    // Save aus fremdem Workspace auf fremdes Projekt → NotFound (FK-Komposit).
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F702-DB-03b: Concurrent-Create — zwei parallele baseVersion-0-Saves (Kimi-P3-1)", async () => {
    const save = () => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    );
    const results = await Promise.allSettled([save(), save()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ChecklistConflictError);
  });

  it("F702-DB-03c: External-Ctx fail-closed vor Projekt-Lookup (Kimi-P3-2)", async () => {
    // Membership mit external_only:true → can() verweigert internalOnly-Actions.
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.viewerId}::uuid,
                'viewer', '{"external_only":true}'::jsonb)
        on conflict (workspace_id, user_id) do update
          set capabilities = '{"external_only":true}'::jsonb
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F702-DB-04: Viewer read, write blockiert; Fortschrittsrechnung", async () => {
    const value = blocks();
    expect(checklistProgress(value)).toEqual({ done: 1, total: 2 });

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const read = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(read.permissions.canWrite).toBe(false);
  });
});
