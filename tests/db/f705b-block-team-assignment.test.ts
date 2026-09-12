import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
  type SetChecklistBlockTeamCommand,
} from "@/lib/integrations/checklists/contract";
import {
  assignChecklistBlockTeam,
  ChecklistNotFoundError,
  ChecklistValidationError,
  completeChecklistSegment,
  saveProjectChecklist,
  unassignChecklistBlockTeam,
} from "@/modules/checklists";
import { createTeam, setTeamActive } from "@/modules/teams";
import { testPool } from "../setup/test-db";

/**
 * F7-05b Block-Team-Zuweisung (Katalog F7.5, mehrere Teams parallel).
 * Seitentabelle (Migration 0128): Assign/Unassign sind mengen-idempotent,
 * nur AKTIVE Teams sind zuweisbar, archivierte bleiben lesbar.
 */

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
      values (${editorId}::uuid, ${`editor-${editorId}@f705b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f705b.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f705b.test`})
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
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F7', 'Fixture',
        ${`${contactId}@f705b.test`}, ${`${contactId}@f705b.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${label} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${label}, 'fixture'
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

function blocks(blockId: string, segmentId: string): EditableChecklistBlocksV2 {
  return [{
    id: blockId,
    name: "Dach",
    position: 0,
    visible: true,
    segments: [{
      id: segmentId,
      name: "Basis",
      position: 0,
      visible: true,
      items: [{
        id: randomUUID(),
        title: "Punkt",
        done: false,
        required: false,
        visible: true,
      }],
    }],
  }];
}

async function seedTree(fixture: Fixture): Promise<{ checklist: ProjectChecklistDto; blockId: string; segmentId: string }> {
  const blockId = randomUUID();
  const segmentId = randomUUID();
  const checklist = await withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, {
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      checklistId: null,
      projectId: fixture.projectId,
      phase: "site_documentation",
      title: "Baustellendokumentation",
      baseVersion: 0,
      blocks: blocks(blockId, segmentId),
    } satisfies SaveProjectChecklistCommand),
  );
  return { checklist, blockId, segmentId };
}

async function seedTeam(fixture: Fixture, name: string): Promise<string> {
  const team = await withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => createTeam(tx, ctx, { name }),
  );
  return team.id;
}

function teamCommand(
  checklist: ProjectChecklistDto,
  blockId: string,
  teamId: string,
): SetChecklistBlockTeamCommand {
  return {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: checklist.checklistId!,
    projectId: checklist.projectId,
    blockId,
    teamId,
  };
}

describe("F7-05b Block-Team-Zuweisung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-05b Blockteams");
  });

  it("F705B-DB-01: Zwei Teams parallel zuweisen, eines entfernen, Evidenz belegt", async () => {
    const { checklist, blockId } = await seedTree(fixture);
    const teamA = await seedTeam(fixture, "Dachteam");
    const teamB = await seedTeam(fixture, "Elektroteam");
    const assign = (teamId: string) =>
      withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => assignChecklistBlockTeam(tx, ctx, teamCommand(checklist, blockId, teamId)),
      );
    await assign(teamA);
    const assigned = await assign(teamB);
    expect(assigned.blocks[0]!.assignedTeams).toEqual([
      { teamId: teamA, teamName: "Dachteam", active: true },
      { teamId: teamB, teamName: "Elektroteam", active: true },
    ]);

    const unassigned = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unassignChecklistBlockTeam(tx, ctx, teamCommand(checklist, blockId, teamA)),
    );
    expect(unassigned.blocks[0]!.assignedTeams).toEqual([
      { teamId: teamB, teamName: "Elektroteam", active: true },
    ]);

    const evidence = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      event_type: string;
      count: string;
    }>(sql`
      select event_type, count(*)::text as count
        from domain_events
       where workspace_id = ${fixture.workspaceId}::uuid
         and aggregate_id = ${checklist.checklistId}::uuid
         and event_type in ('checklist.block_team_assigned', 'checklist.block_team_unassigned')
       group by event_type
       order by event_type
    `));
    expect(evidence.rows).toEqual([
      { event_type: "checklist.block_team_assigned", count: "2" },
      { event_type: "checklist.block_team_unassigned", count: "1" },
    ]);
    const audit = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      count: string;
    }>(sql`
      select count(*)::text as count
        from audit_log
       where workspace_id = ${fixture.workspaceId}::uuid
         and action = 'checklist.write'
         and resource = 'project_checklist_block'
         and details->>'blockId' = ${blockId}
    `));
    expect(audit.rows).toEqual([{ count: "3" }]);
  });

  it("F705B-DB-02: Unbekannt, fremd, archiviert und lesend bleiben draußen", async () => {
    const { checklist, blockId } = await seedTree(fixture);
    const teamId = await seedTeam(fixture, "Dachteam");
    const act = (
      actorId: string,
      ws: string,
      override: Partial<SetChecklistBlockTeamCommand>,
      op: "assign" | "unassign" = "assign",
    ) =>
      withAuthorizedTenantOn(testPool, actorId, ws, (tx, ctx) =>
        op === "assign"
          ? assignChecklistBlockTeam(tx, ctx, { ...teamCommand(checklist, blockId, teamId), ...override })
          : unassignChecklistBlockTeam(tx, ctx, { ...teamCommand(checklist, blockId, teamId), ...override }));
    await expect(act(fixture.editorId, fixture.workspaceId, { blockId: randomUUID() }))
      .rejects.toBeInstanceOf(ChecklistNotFoundError);
    await expect(act(fixture.editorId, fixture.workspaceId, { teamId: randomUUID() }))
      .rejects.toBeInstanceOf(ChecklistValidationError);

    const foreign = await seedWorkspace("F7-05b Fremd");
    const foreignTeam = await seedTeam(foreign, "Fremdteam");
    // Fremdes Team im eigenen Kontext: kein Leak, nur Validation.
    await expect(act(fixture.editorId, fixture.workspaceId, { teamId: foreignTeam }))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    // Eigene Checkliste aus fremdem Kontext: NotFound statt Orakel.
    await expect(withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => assignChecklistBlockTeam(tx, ctx, teamCommand(checklist, blockId, teamId)),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);

    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => setTeamActive(tx, ctx, { id: teamId, active: false, expectedRevision: 1 }),
    );
    await expect(act(fixture.editorId, fixture.workspaceId, {}))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(act(fixture.viewerId, fixture.workspaceId, {}))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    expect(foreignTeam).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("F705B-DB-03: Archiv bleibt lesbar, Doppel/Leer sind still, Siegel egal", async () => {
    const { checklist, blockId, segmentId } = await seedTree(fixture);
    const teamId = await seedTeam(fixture, "Dachteam");
    const command = teamCommand(checklist, blockId, teamId);
    const asEditor = <T>(fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn);

    await asEditor((tx, ctx) => assignChecklistBlockTeam(tx, ctx, command));
    // Doppeltes Zuweisen: stiller Erfolg, genau eine Zeile.
    const replayed = await asEditor((tx, ctx) => assignChecklistBlockTeam(tx, ctx, command));
    expect(replayed.blocks[0]!.assignedTeams).toHaveLength(1);

    // Archivieren nach Zuweisung: lesbar mit active:false.
    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => setTeamActive(tx, ctx, { id: teamId, active: false, expectedRevision: 1 }),
    );
    const reread = await asEditor((tx, ctx) => unassignChecklistBlockTeam(tx, ctx, {
      ...command,
      teamId: randomUUID(),
    }));
    expect(reread.blocks[0]!.assignedTeams).toEqual([
      { teamId, teamName: "Dachteam", active: false },
    ]);

    // Leeres Entfernen: stiller Erfolg ohne Evidenz.
    const before = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      count: string;
    }>(sql`select count(*)::text as count from domain_events where workspace_id = ${fixture.workspaceId}::uuid`));
    await asEditor((tx, ctx) => unassignChecklistBlockTeam(tx, ctx, { ...command, teamId: randomUUID() }));
    const after = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      count: string;
    }>(sql`select count(*)::text as count from domain_events where workspace_id = ${fixture.workspaceId}::uuid`));
    expect(after.rows).toEqual(before.rows);

    // Abgeschlossenes Segment: Zuweisung bleibt operatives Metadatum.
    const teamB = await seedTeam(fixture, "Elektroteam");
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project set phase = 'installation', updated_at = statement_timestamp()
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.projectId}::uuid
      `);
      await tx.execute(sql`
        insert into installation (workspace_id, project_id, source, status)
        values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', 'active')
      `);
    });
    const sealed = await asEditor((tx, ctx) => completeChecklistSegment(tx, ctx, {
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      checklistId: checklist.checklistId!,
      projectId: fixture.projectId,
      segmentId,
      baseVersion: 1,
    }));
    expect(sealed.version).toBe(2);
    const afterSeal = await asEditor((tx, ctx) =>
      assignChecklistBlockTeam(tx, ctx, teamCommand(checklist, blockId, teamB)));
    expect(afterSeal.blocks[0]!.assignedTeams.map((entry) => entry.teamName).sort()).toEqual([
      "Dachteam",
      "Elektroteam",
    ]);
  });

  it("F705B-DB-04: RLS trennt Mandanten auf der Seitentabelle", async () => {
    const { checklist, blockId } = await seedTree(fixture);
    const teamId = await seedTeam(fixture, "Dachteam");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => assignChecklistBlockTeam(tx, ctx, teamCommand(checklist, blockId, teamId)),
    );
    const foreign = await seedWorkspace("F7-05b RLS");
    const foreignRows = await withTenantOn(testPool, foreign.workspaceId, (tx) => tx.execute<{
      count: string;
    }>(sql`select count(*)::text as count from project_checklist_block_assignment`));
    expect(foreignRows.rows).toEqual([{ count: "0" }]);
    const ownRows = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      count: string;
    }>(sql`select count(*)::text as count from project_checklist_block_assignment`));
    expect(ownRows.rows).toEqual([{ count: "1" }]);
  });
});
