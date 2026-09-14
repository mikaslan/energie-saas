import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  applyTaskTemplate,
  createTaskTemplate,
  getProjectTaskPage,
  TASK_TEMPLATE_SCHEMA_VERSION,
  TaskTemplateValidationError,
  updateTaskTemplate,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

/**
 * F16-04d Vorlagen mit Checklisten-Inhalt (Katalog F16.3, Folgeslice zu
 * F16-04b). Vorlagen tragen reine Checklisten-Texte (max 100); Anwenden
 * erzeugt daraus unerledigte Task-Items in stabiler Reihenfolge.
 * Migration 0146 (`checklist_items` jsonb, Default []).
 */

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F16-04d Checkliste')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1604d.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1604D-CUSTOMER', 'Fixture', 'Contact', 'c@f1604d.test', 'c@f1604d.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1604d Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1604d Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId };
}

// Checklisten-Read-back über den Service (Actor-Kontext): Raw-SQL sieht
// durch die restriktive Actor-SELECT-Policy still nichts.
async function readTaskChecklist(taskId: string, projectId: string, editorId: string, workspaceId: string) {
  const page = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => getProjectTaskPage(tx, ctx, projectId),
  );
  const task = page?.workspace.open.find((entry) => entry.id === taskId);
  if (!task) throw new Error("angewendete Aufgabe nicht gefunden");
  return task.checklist.map((item) => ({ text: item.text, is_done: item.done }));
}

describe("F16-04d Vorlagen-Checkliste (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1604D-DB-01: Vorlage mit Checkliste → Apply erzeugt unerledigte Items in Reihenfolge", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Inbetriebnahme",
        title: "WR in Betrieb nehmen",
        dueOffsetDays: null,
        checklistItems: [
          { text: "Wechselrichter prüfen" },
          { text: "Zählerstand notieren" },
          { text: "Kunde einweisen" },
        ],
      }),
    );
    expect(created.checklistItems).toEqual([
      { text: "Wechselrichter prüfen" },
      { text: "Zählerstand notieren" },
      { text: "Kunde einweisen" },
    ]);

    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    );
    await expect(readTaskChecklist(applied.taskId, fixture.projectId, fixture.editorId, fixture.workspaceId)).resolves.toEqual([
      { text: "Wechselrichter prüfen", is_done: false },
      { text: "Zählerstand notieren", is_done: false },
      { text: "Kunde einweisen", is_done: false },
    ]);
  });

  it("F1604D-DB-02: Update ersetzt Checkliste; fehlend = leer (Migration-Default [])", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Ohne Inhalt",
        title: "Schlichter Titel",
        dueOffsetDays: null,
      }),
    );
    // Altzeilen-Semantik: ohne Feld angelegt → leere Checkliste.
    expect(created.checklistItems).toEqual([]);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "Ohne Inhalt",
        title: "Schlichter Titel",
        dueOffsetDays: null,
        checklistItems: [{ text: "Nachgetragen" }],
        position: created.position,
      }),
    );
    expect(updated.checklistItems).toEqual([{ text: "Nachgetragen" }]);

    const cleared = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "Ohne Inhalt",
        title: "Schlichter Titel",
        dueOffsetDays: null,
        position: created.position,
      }),
    );
    expect(cleared.checklistItems).toEqual([]);
  });

  it("F1604D-DB-03: Cap-Überschreitung, Leertext und Steuerzeichen fail-closed", async () => {
    const base = {
      schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
      name: "Ungültig",
      title: "Ungültig",
      dueOffsetDays: null,
    } as const;
    const create = (checklistItems: { text: string }[]) => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, { ...base, checklistItems }),
    );
    await expect(create(Array.from({ length: 101 }, (_, i) => ({ text: `Punkt ${i}` }))))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([{ text: "   " }]))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([{ text: "Zeile\u0000mit Null" }]))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([{ text: `x`.repeat(501) }]))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    // Genau 100 bleibt zulässig.
    const full = await create(Array.from({ length: 100 }, (_, i) => ({ text: `Punkt ${i}` })));
    expect(full.checklistItems).toHaveLength(100);
  });
});
