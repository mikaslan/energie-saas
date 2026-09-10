import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  applyTaskTemplate,
  archiveTaskTemplate,
  berlinDatePlusDays,
  createTaskTemplate,
  getProjectTaskWorkspace,
  listTaskTemplates,
  restoreTaskTemplate,
  TaskTemplateConflictError,
  TaskTemplateNotFoundError,
  TaskTemplateValidationError,
  TASK_TEMPLATE_SCHEMA_VERSION,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; projectId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F16-04 Templates')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1604.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1604.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1604-CUSTOMER', 'Fixture', 'Contact', 'c@f1604.test', 'c@f1604.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1604 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1604 Project', 'manual'
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

type TaskRow = { title: string; dueDate: string | null; status: string };

// Actor-autorisierte Lesart (project_task hat eine restriktive
// Actor-SELECT-Policy; Roh-SQL ohne app.actor_id sieht keine Zeilen).
async function readTask(
  userId: string,
  workspaceId: string,
  projectId: string,
  taskId: string,
): Promise<TaskRow> {
  return withAuthorizedTenantOn(testPool, userId, workspaceId, async (tx, ctx) => {
    const workspace = await getProjectTaskWorkspace(tx, ctx, projectId);
    const found = [...workspace?.open ?? [], ...workspace?.done ?? []]
      .find((task) => task.id === taskId);
    if (!found) throw new Error(`task ${taskId} not found`);
    return { title: found.title, dueDate: found.dueAt === null ? null : found.dueAt.slice(0, 10), status: found.status };
  });
}

describe("F16-04 Aufgaben-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1604-DB-01: Anlage → Liste (canWrite je Rolle) → Anwenden legt Aufgabe mit Titel-Preset und Offset-Fälligkeit an", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "PV-Abnahme",
        title: "Abnahmeprotokoll erstellen",
        dueOffsetDays: 7,
      }),
    );
    expect(created.name).toBe("PV-Abnahme");
    expect(created.title).toBe("Abnahmeprotokoll erstellen");
    expect(created.dueOffsetDays).toBe(7);
    expect(created.active).toBe(true);
    expect(created.permissions.canWrite).toBe(true);

    const editorList = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTaskTemplates(tx, ctx),
    );
    expect(editorList).toHaveLength(1);
    expect(editorList[0]!.permissions.canWrite).toBe(true);

    const viewerList = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTaskTemplates(tx, ctx),
    );
    expect(viewerList).toHaveLength(1);
    expect(viewerList[0]!.permissions.canWrite).toBe(false);

    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    );
    expect(applied.projectId).toBe(fixture.projectId);
    expect(applied.templateId).toBe(created.id);

    const task = await readTask(fixture.editorId, fixture.workspaceId, fixture.projectId, applied.taskId);
    expect(task.title).toBe("Abnahmeprotokoll erstellen");
    expect(task.status).toBe("open");
    expect(task.dueDate).toBe(berlinDatePlusDays(7));

    // Ohne Offset bleibt die Aufgabe ohne Fälligkeit.
    const noDue = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Ohne Termin",
        title: "Freie Aufgabe",
        dueOffsetDays: null,
      }),
    );
    const appliedNoDue = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: noDue.id,
        projectId: fixture.projectId,
      }),
    );
    const freeTask = await readTask(fixture.editorId, fixture.workspaceId, fixture.projectId, appliedNoDue.taskId);
    expect(freeTask.title).toBe("Freie Aufgabe");
    expect(freeTask.dueDate).toBeNull();
  });

  it("F1604-DB-02: Duplikat (normalisiert) → Konflikt; ungültige Eingaben fail-closed", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Test Vorlage",
        title: "Titel",
        dueOffsetDays: null,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "  TEST vorlage ",
        title: "Anderer Titel",
        dueOffsetDays: null,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateConflictError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "   ",
        title: "Titel",
        dueOffsetDays: null,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateValidationError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: 999 as never,
        name: "Gültig",
        title: "Titel",
        dueOffsetDays: null,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateValidationError);
  });

  it("F1604-DB-03: Viewer ohne task.write fail-closed; Archiv blendet aus und sperrt Anwenden; Restore hebt auf", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Archiv-Test",
        title: "Archiv-Titel",
        dueOffsetDays: null,
      }),
    );

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Viewer-Versuch",
        title: "Titel",
        dueOffsetDays: null,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const archived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        active: false,
      }),
    );
    expect(archived.active).toBe(false);

    const hidden = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTaskTemplates(tx, ctx),
    );
    expect(hidden).toHaveLength(0);

    const withArchived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTaskTemplates(tx, ctx, { includeArchived: true }),
    );
    expect(withArchived).toHaveLength(1);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateNotFoundError);

    const restored = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        active: true,
      }),
    );
    expect(restored.active).toBe(true);

    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    );
    const task = await readTask(fixture.editorId, fixture.workspaceId, fixture.projectId, applied.taskId);
    expect(task.title).toBe("Archiv-Titel");
  });

  it("F1604-DB-04: Unbekannte oder fremde Vorlage → NotFound (Mandantenisolation)", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: randomUUID(),
        projectId: fixture.projectId,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateNotFoundError);

    const other = await seedFixture();
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Fremde Vorlage",
        title: "Fremd",
        dueOffsetDays: null,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: foreign.id,
        projectId: fixture.projectId,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateNotFoundError);
  });
});
