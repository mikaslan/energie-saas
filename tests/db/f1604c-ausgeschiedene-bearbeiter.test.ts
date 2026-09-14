import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  createTaskTemplate,
  listTaskTemplates,
  TASK_TEMPLATE_SCHEMA_VERSION,
  TaskTemplateNotFoundError,
  TaskTemplateValidationError,
  updateTaskTemplate,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

/**
 * F16-04c Ausgeschiedene Bearbeiter sichtbar (Katalog F16.3, Folgeslice zu
 * F16-04b). Ausgeschiedene entfallen nicht mehr still: Das DTO weist sie
 * separat aus (IDs ohne Label — kein PII-Lookup an Nicht-Mitglieder), das
 * Anwenden überspringt sie weiter, und das Speichern erhält sie statt sie
 * still zu purgen. Einschleusen fremder IDs über Update bleibt Validation.
 */

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  memberBId: string;
  memberBMembershipId: string;
  memberDMembershipId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const memberBId = randomUUID();
  const memberDId = randomUUID();
  const editorMembershipId = randomUUID();
  const memberBMembershipId = randomUUID();
  const memberDMembershipId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F16-04c Bearbeiter')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1604c.test`}),
             (${memberBId}::uuid, ${`member-b-${memberBId}@f1604c.test`}),
             (${memberDId}::uuid, ${`member-d-${memberDId}@f1604c.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${memberBMembershipId}::uuid, ${workspaceId}::uuid, ${memberBId}::uuid, 'editor', '{}'::jsonb),
        (${memberDMembershipId}::uuid, ${workspaceId}::uuid, ${memberDId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1604C-CUSTOMER', 'Fixture', 'Contact', 'c@f1604c.test', 'c@f1604c.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1604c Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1604c Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId, memberBId, memberBMembershipId, memberDMembershipId };
}

async function depart(membershipId: string, workspaceId: string): Promise<void> {
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`delete from membership where id = ${membershipId}::uuid`);
  });
}

describe("F16-04c Ausgeschiedene Bearbeiter sichtbar (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1604C-DB-01: DTO weist Ausgeschiedene separat aus (IDs ohne Label)", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Fluktuation",
        title: "Wechselrichter prüfen",
        dueOffsetDays: null,
        assigneeMembershipIds: [fixture.memberBMembershipId, fixture.memberDMembershipId],
      }),
    );
    await depart(fixture.memberDMembershipId, fixture.workspaceId);

    const listed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTaskTemplates(tx, ctx, {}),
    );
    const found = listed.find((entry) => entry.id === created.id)!;
    // Lebende mit Label; Ausgeschiedene nur als ID (kein PII-Lookup).
    expect(found.assignees.map((entry) => entry.membershipId))
      .toEqual([fixture.memberBMembershipId]);
    expect(found.departedAssigneeMembershipIds).toEqual([fixture.memberDMembershipId]);
    expect(found.assigneeMembershipIds).toEqual(
      [fixture.memberBMembershipId, fixture.memberDMembershipId],
    );
  });

  it("F1604C-DB-02: Update erhält Ausgeschiedene statt still zu purgen", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Fluktuation",
        title: "Wechselrichter prüfen",
        dueOffsetDays: null,
        assigneeMembershipIds: [fixture.memberBMembershipId, fixture.memberDMembershipId],
      }),
    );
    await depart(fixture.memberDMembershipId, fixture.workspaceId);

    // Formular-Semantik: Lebende + erhaltene Ausgeschiedene zurückschicken.
    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "Fluktuation",
        title: "Wechselrichter prüfen v2",
        dueOffsetDays: null,
        assigneeMembershipIds: [fixture.memberBMembershipId, fixture.memberDMembershipId],
        position: created.position,
      }),
    );
    expect(updated.title).toBe("Wechselrichter prüfen v2");
    expect(updated.assigneeMembershipIds).toEqual(
      [fixture.memberBMembershipId, fixture.memberDMembershipId],
    );
    expect(updated.departedAssigneeMembershipIds).toEqual([fixture.memberDMembershipId]);
  });

  it("F1604C-DB-03: Einschleusen fremder IDs bleibt Validation; explizites Leeren purgt", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: "Fluktuation",
        title: "Wechselrichter prüfen",
        dueOffsetDays: null,
        assigneeMembershipIds: [fixture.memberBMembershipId, fixture.memberDMembershipId],
      }),
    );
    await depart(fixture.memberDMembershipId, fixture.workspaceId);
    const base = {
      schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
      id: created.id,
      name: "Fluktuation",
      title: "Wechselrichter prüfen",
      dueOffsetDays: null,
      position: created.position,
    } as const;

    // Fremde ID (nie gespeichert) → Validation, kein Einschleusen.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        ...base,
        assigneeMembershipIds: [fixture.memberBMembershipId, randomUUID()],
      }),
    )).rejects.toBeInstanceOf(TaskTemplateValidationError);

    // Bewusstes Leeren (nur Lebende ohne Ausgeschiedene) bleibt möglich —
    // ehrliches Löschen statt stillem Purgen.
    const cleared = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        ...base,
        assigneeMembershipIds: [fixture.memberBMembershipId],
      }),
    );
    expect(cleared.assigneeMembershipIds).toEqual([fixture.memberBMembershipId]);
    expect(cleared.departedAssigneeMembershipIds).toEqual([]);
  });

  it("F1604C-DB-04: Update auf fehlende Vorlage → NotFound", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: randomUUID(),
        name: "Geist",
        title: "Geist",
        dueOffsetDays: null,
        assigneeMembershipIds: [],
        position: 0,
      }),
    )).rejects.toBeInstanceOf(TaskTemplateNotFoundError);
  });
});
