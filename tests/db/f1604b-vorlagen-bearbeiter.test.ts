import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  applyTaskTemplate,
  createTaskTemplate,
  getProjectTaskWorkspace,
  searchTaskTemplateMembers,
  TaskTemplateValidationError,
  TASK_TEMPLATE_SCHEMA_VERSION,
  updateTaskTemplate,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

/**
 * F16-04b Mehrfach-Bearbeiter aus Aufgaben-Vorlage (Katalog F16.3).
 * Template trägt Bearbeiter-Memberships; Anwenden weist alle noch
 * gültigen zu (Ausgeschiedene entfallen, leer = Anwender-Fallback).
 * Schreiben validiert fail-closed; Suche ist query-gebunden
 * (keine Voll-Enumeration, task.write-Gate).
 */

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  viewerId: string;
  memberBId: string;
  editorMembershipId: string;
  memberBMembershipId: string;
  memberDMembershipId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const memberBId = randomUUID();
  const memberDId = randomUUID();
  const editorMembershipId = randomUUID();
  const memberBMembershipId = randomUUID();
  const memberDMembershipId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F16-04b Bearbeiter')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1604b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1604b.test`}),
             (${memberBId}::uuid, ${`member-b-${memberBId}@f1604b.test`}),
             (${memberDId}::uuid, ${`member-d-${memberDId}@f1604b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${memberBMembershipId}::uuid, ${workspaceId}::uuid, ${memberBId}::uuid, 'editor', '{}'::jsonb),
        (${memberDMembershipId}::uuid, ${workspaceId}::uuid, ${memberDId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1604B-CUSTOMER', 'Fixture', 'Contact', 'c@f1604b.test', 'c@f1604b.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1604b Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1604b Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId, viewerId, memberBId, editorMembershipId, memberBMembershipId, memberDMembershipId };
}

async function taskAssignees(
  userId: string,
  workspaceId: string,
  projectId: string,
  taskId: string,
): Promise<{ membershipId: string; label: string }[]> {
  return withAuthorizedTenantOn(testPool, userId, workspaceId, async (tx, ctx) => {
    const workspace = await getProjectTaskWorkspace(tx, ctx, projectId);
    const found = [...workspace?.open ?? [], ...workspace?.done ?? []].find((task) => task.id === taskId);
    if (!found) throw new Error(`task ${taskId} not found`);
    return found.assignees;
  });
}

describe("F16-04b Mehrfach-Bearbeiter aus Aufgaben-Vorlage (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1604B-DB-01: Vorlage mit zwei Bearbeitern → Apply weist beide zu", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Dach-Team",
        title: "Module tragen",
        dueOffsetDays: null,
        assigneeMembershipIds: [fixture.editorMembershipId, fixture.memberBMembershipId],
      }),
    );
    expect(created.assigneeMembershipIds).toEqual(
      expect.arrayContaining([fixture.editorMembershipId, fixture.memberBMembershipId]),
    );
    expect(created.assignees).toHaveLength(2);

    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    );
    const assignees = await taskAssignees(
      fixture.editorId, fixture.workspaceId, fixture.projectId, applied.taskId,
    );
    expect(assignees.map((entry) => entry.membershipId).sort()).toEqual(
      [fixture.editorMembershipId, fixture.memberBMembershipId].sort(),
    );
  });

  it("F1604B-DB-02: Ausgeschiedene entfallen still; leer → Anwender-Fallback", async () => {
    // Mitglied D scheidet NACH Vorlagen-Anlage aus (Membership-Zeile weg).
    const departedMembershipId = fixture.memberDMembershipId;
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Fluktuation",
        title: "Wechselrichter prüfen",
        dueOffsetDays: null,
        assigneeMembershipIds: [fixture.memberBMembershipId, departedMembershipId],
      }),
    );
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`delete from membership where id = ${departedMembershipId}::uuid`);
    });
    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: created.id,
        projectId: fixture.projectId,
      }),
    );
    const assignees = await taskAssignees(
      fixture.editorId, fixture.workspaceId, fixture.projectId, applied.taskId,
    );
    expect(assignees.map((entry) => entry.membershipId)).toEqual([fixture.memberBMembershipId]);

    // Leere Liste (Legacy) → Anwender-Fallback. (Nur-Ausgeschiedene
    // lässt sich per Public-API nicht konstruieren — Anlage validiert
    // fail-closed, s. DB-03; der Fallback-Zweig teilt den Codepfad.)
    const legacy = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Solo",
        title: "Solo prüfen",
        dueOffsetDays: null,
      }),
    );
    const appliedLegacy = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        templateId: legacy.id,
        projectId: fixture.projectId,
      }),
    );
    const legacyAssignees = await taskAssignees(
      fixture.editorId, fixture.workspaceId, fixture.projectId, appliedLegacy.taskId,
    );
    expect(legacyAssignees.map((entry) => entry.membershipId)).toEqual([fixture.editorMembershipId]);
  });

  it("F1604B-DB-03: Unbekannte/fremde IDs und Cap-Überschreitung fail-closed", async () => {
    const foreignWorkspace = await seedFixture();
    const foreignMembership = await withTenantOn(testPool, foreignWorkspace.workspaceId, async (tx) => {
      const found = await tx.execute<{ id: string }>(sql`
        select id from membership
         where workspace_id = ${foreignWorkspace.workspaceId}::uuid limit 1
      `);
      return found.rows[0]!.id;
    });
    for (const ids of [[randomUUID()], [foreignMembership]]) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => createTaskTemplate(tx, ctx, {
          schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
          name: "Fremd",
          title: "Darf nicht",
          dueOffsetDays: null,
          assigneeMembershipIds: ids,
        }),
      )).rejects.toBeInstanceOf(TaskTemplateValidationError);
    }
    const tooMany = Array.from({ length: 51 }, () => randomUUID());
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Masse",
        title: "Zu viele",
        dueOffsetDays: null,
        assigneeMembershipIds: tooMany,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateValidationError);

    // Update-Pfad ebenso.
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Rein",
        title: "Rein",
        dueOffsetDays: null,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "Rein",
        title: "Rein",
        dueOffsetDays: null,
        assigneeMembershipIds: [randomUUID()],
        position: 0,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateValidationError);
  });

  it("F1604B-DB-04: Suche ist query-gebunden und task.write-gated", async () => {
    const page = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => searchTaskTemplateMembers(tx, ctx, { query: "f1604b" }),
    );
    expect(page.members.length).toBeGreaterThan(0);
    expect(page.members.every((entry) => entry.label.includes("f1604b"))).toBe(true);
    expect(page.hasMore).toBe(false);

    // Leere Treffer → leere Seite (kein Orakel über Fremde).
    const empty = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => searchTaskTemplateMembers(tx, ctx, { query: "zz-unbekannt-zz" }),
    );
    expect(empty.members).toEqual([]);

    // Zu kurze Query fail-closed; Viewer ohne task.write denied.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => searchTaskTemplateMembers(tx, ctx, { query: "x" }),
    )).rejects.toBeInstanceOf(TaskTemplateValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => searchTaskTemplateMembers(tx, ctx, { query: "f1604b" }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
