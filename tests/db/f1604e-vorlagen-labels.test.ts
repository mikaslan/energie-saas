import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TaskLabelColor } from "@/lib/integrations/tasks/contract";
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
 * F16-04e Vorlagen mit Label-Inhalt (Katalog F16.3, Folgeslice zu
 * F16-04d — dort als „Vorlagen mit Label-Inhalt" bewusst offen).
 * Vorlagen tragen Label-Inhalt (Name + Farbe, max 15); Anwenden erzeugt
 * daraus Task-Labels (IDs/Positionen vergibt die Task-Anlage).
 * Migration 0147 (`label_items` jsonb, Default []).
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F16-04e Labels')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1604e.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1604E-CUSTOMER', 'Fixture', 'Contact', 'c@f1604e.test', 'c@f1604e.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1604e Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1604e Project', 'manual'
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

// Label-Read-back über den Service (Actor-Kontext): Raw-SQL sieht
// durch die restriktive Actor-SELECT-Policy still nichts.
async function readTaskLabels(taskId: string, projectId: string, editorId: string, workspaceId: string) {
  const page = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => getProjectTaskPage(tx, ctx, projectId),
  );
  const task = page?.workspace.open.find((entry) => entry.id === taskId);
  if (!task) throw new Error("angewendete Aufgabe nicht gefunden");
  return task.labels.map((label) => ({ name: label.name, color: label.color }));
}

describe("F16-04e Vorlagen-Labels (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1604E-DB-01: Vorlage mit Labels → Apply erzeugt Task-Labels mit Farbe", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Abnahme",
        title: "Anlage abnehmen",
        dueOffsetDays: null,
        labelItems: [
          { name: "Dringend", color: "rose" },
          { name: "Förderung", color: "emerald" },
        ],
      }),
    );
    expect(created.labelItems).toEqual([
      { name: "Dringend", color: "rose" },
      { name: "Förderung", color: "emerald" },
    ]);

    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    );
    await expect(readTaskLabels(applied.taskId, fixture.projectId, fixture.editorId, fixture.workspaceId)).resolves.toEqual([
      { name: "Dringend", color: "rose" },
      { name: "Förderung", color: "emerald" },
    ]);
  });

  it("F1604E-DB-02: Update ersetzt Labels; fehlend = leer (Migration-Default [])", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Ohne Inhalt",
        title: "Schlichter Titel",
        dueOffsetDays: null,
      }),
    );
    // Altzeilen-Semantik: ohne Feld angelegt → keine Labels.
    expect(created.labelItems).toEqual([]);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "Ohne Inhalt",
        title: "Schlichter Titel",
        dueOffsetDays: null,
        labelItems: [{ name: "Nachgetragen", color: "slate" }],
        position: created.position,
      }),
    );
    expect(updated.labelItems).toEqual([{ name: "Nachgetragen", color: "slate" }]);

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
    expect(cleared.labelItems).toEqual([]);
  });

  it("F1604E-DB-03: Cap, Duplikat, Leername und Steuerzeichen fail-closed", async () => {
    const base = {
      schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
      name: "Ungültig",
      title: "Ungültig",
      dueOffsetDays: null,
    } as const;
    const create = (labelItems: { name: string; color: TaskLabelColor }[]) => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, { ...base, labelItems }),
    );
    await expect(create(Array.from({ length: 16 }, (_, i) => ({ name: `Label ${i}`, color: "slate" as TaskLabelColor }))))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([
      { name: "Doppelt", color: "slate" },
      { name: "doppelt", color: "blue" },
    ])).rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([{ name: "   ", color: "slate" }]))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([{ name: "Zeile\u0000mit Null", color: "slate" }]))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(create([{ name: "x".repeat(41), color: "slate" }]))
      .rejects.toBeInstanceOf(TaskTemplateValidationError);
    // Genau 15 bleibt zulässig.
    const full = await create(Array.from({ length: 15 }, (_, i) => ({ name: `Label ${i}`, color: "slate" as TaskLabelColor })));
    expect(full.labelItems).toHaveLength(15);
  });
});
