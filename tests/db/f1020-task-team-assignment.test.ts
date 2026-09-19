import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_TASK_COMMAND_VERSION,
  PROJECT_TASK_TEAM_ASSIGNMENT_COMMAND_VERSION,
  changeTaskTeamAssignment,
  executeProjectTaskCommand,
  getTaskTeamAssignmentContext,
  TaskTeamAssignmentConflictError,
  TaskTeamAssignmentLimitError,
  TaskTeamAssignmentNotFoundError,
  TaskTeamAssignmentTargetError,
  TaskTeamAssignmentValidationError,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  taskId: string;
  unassignedTaskId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  revokedId: string;
  editorMembershipId: string;
  viewerMembershipId: string;
  externalMembershipId: string;
  revokedMembershipId: string;
  crossTenantMembershipId: string;
  otherEditorId: string;
  teamAId: string;
  teamBId: string;
  archivedTeamId: string;
  foreignTeamId: string;
};

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const unassignedTaskId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const revokedId = randomUUID();
  const crossTenantId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerMembershipId = randomUUID();
  const externalMembershipId = randomUUID();
  const revokedMembershipId = randomUUID();
  const crossTenantMembershipId = randomUUID();
  const otherEditorId = randomUUID();
  const otherEditorMembershipId = randomUUID();
  const teamAId = randomUUID();
  const teamBId = randomUUID();
  const archivedTeamId = randomUUID();
  const foreignTeamId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'F1-20 Task-Teamzuweisung')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f1020.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f1020.test`}),
        (${externalId}::uuid, ${`external-${externalId}@f1020.test`}),
        (${revokedId}::uuid, ${`revoked-${revokedId}@f1020.test`}),
        (${crossTenantId}::uuid, ${`cross-${crossTenantId}@f1020.test`}),
        (${otherEditorId}::uuid, ${`other-editor-${otherEditorId}@f1020.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
          'editor', '{}'::jsonb),
        (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
          'viewer', '{}'::jsonb),
        (${externalMembershipId}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
          'viewer', '{"external_only": true}'::jsonb),
        (${revokedMembershipId}::uuid, ${workspaceId}::uuid, ${revokedId}::uuid,
          'editor', '{}'::jsonb)
    `);
    // M1-10-Guard (_m110_guard_project_task): Task-Insert verlangt einen
    // internen Editor/Admin als Actor.
    await tx.execute(sql`select set_config('app.actor_id', ${editorId}, true)`);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized,
        phone_raw, phone_e164
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'Kundin F1-20', 'Fixture', 'Contact',
        'kundin@f1020.test', 'kundin@f1020.test', '+49 30 123456', '+4930123456'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required
      ) values (
        ${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'Projektstandort',
        'Testweg 9, 10115 Berlin', decode(repeat('39', 32), 'hex'), 1, 'selected',
        'Testweg', '9', '10115', 'Berlin', 'DE', 52.5201, 13.4051,
        'photon', 'house', false
      )
    `);
    const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id, 'Teamanfrage F1-20', 'manual'
      from kanban_board board
      join kanban_column intake
        on intake.workspace_id = board.workspace_id
       and intake.board_id = board.id
       and intake.is_intake = true
       and intake.archived_at is null
     where board.workspace_id = ${workspaceId}::uuid
       and board.scope = 'residential'
       and board.is_default = true
       and board.archived_at is null
      returning id
    `);
    if (projects.rows.length !== 1) throw new Error("F1-20 project was not seeded");
    await tx.execute(sql`
      insert into project_task (
        id, workspace_id, project_id, title, body_version, body,
        created_by, updated_by
      ) values
        (${taskId}::uuid, ${workspaceId}::uuid, ${projectId}::uuid,
          'Zugewiesene Teamaufgabe', 'task-rich-text.v1',
          '{"type":"doc","content":[]}'::jsonb, ${editorId}::uuid, ${editorId}::uuid),
        (${unassignedTaskId}::uuid, ${workspaceId}::uuid, ${projectId}::uuid,
          'Unzugewiesene Teamaufgabe', 'task-rich-text.v1',
          '{"type":"doc","content":[]}'::jsonb, ${editorId}::uuid, ${editorId}::uuid)
    `);
    await tx.execute(sql`
      insert into team (id, workspace_id, name, name_normalized, active, revision, created_by)
      values
        (${teamAId}::uuid, ${workspaceId}::uuid, 'Montage Nord', 'montage nord', true, 1, ${editorId}::uuid),
        (${teamBId}::uuid, ${workspaceId}::uuid, 'Vertrieb Ost', 'vertrieb ost', true, 1, ${editorId}::uuid),
        (${archivedTeamId}::uuid, ${workspaceId}::uuid, 'Altbau West', 'altbau west', false, 2, ${editorId}::uuid)
    `);
  });

  await withTenantOn(testPool, otherWorkspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${otherWorkspaceId}::uuid, 'F1-20 Other Tenant')
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${crossTenantMembershipId}::uuid, ${otherWorkspaceId}::uuid,
        ${crossTenantId}::uuid, 'viewer', '{}'::jsonb),
        (${otherEditorMembershipId}::uuid, ${otherWorkspaceId}::uuid,
        ${otherEditorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into team (id, workspace_id, name, name_normalized, active, revision, created_by)
      values (${foreignTeamId}::uuid, ${otherWorkspaceId}::uuid, 'Fremdteam',
        'fremdteam', true, 1, ${crossTenantId}::uuid)
    `);
  });

  return {
    workspaceId,
    otherWorkspaceId,
    projectId,
    taskId,
    unassignedTaskId,
    editorId,
    viewerId,
    externalId,
    revokedId,
    editorMembershipId,
    viewerMembershipId,
    externalMembershipId,
    revokedMembershipId,
    crossTenantMembershipId,
    otherEditorId,
    teamAId,
    teamBId,
    archivedTeamId,
    foreignTeamId,
  };
}

function command(
  kind: "assign_team" | "unassign_team",
  fixture: Fixture,
  teamId: string,
  expectedTeamAssignmentRevision: number,
  taskId: string = fixture.taskId,
) {
  return {
    schemaVersion: PROJECT_TASK_TEAM_ASSIGNMENT_COMMAND_VERSION,
    kind,
    taskId,
    teamId,
    expectedTeamAssignmentRevision,
  } as const;
}

async function assignedTeams(fixture: Fixture): Promise<string[]> {
  const rows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{ team_id: string }>(sql`
      select team_id from project_task_team_assignment
       where workspace_id = ${fixture.workspaceId}::uuid
         and task_id = ${fixture.taskId}::uuid
       order by team_id
    `);
    return result.rows;
  });
  return rows.map((row) => row.team_id);
}

async function taskRevisions(fixture: Fixture): Promise<{
  revision: number;
  team_assignment_revision: number;
}> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    // Actor-Policy auf project_task: SELECT braucht internen Viewer+.
    await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
    const result = await tx.execute<{
      revision: number;
      team_assignment_revision: number;
    }>(sql`
      select revision, team_assignment_revision from project_task
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.taskId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F1-20 task was not found");
    return row;
  });
}

describe("F1-20 Aufgaben-Team-Zuweisung", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1020-DB-01: weist ein aktives Team zu und bumpst die Revision", async () => {
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    expect(result).toEqual({
      taskId: fixture.taskId,
      teamAssignmentRevision: 1,
      changed: true,
    });

    const context = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getTaskTeamAssignmentContext(tx, ctx, fixture.taskId),
    );
    expect(context).toMatchObject({
      taskId: fixture.taskId,
      teamAssignmentRevision: 1,
      canAssign: true,
      teams: [{ teamId: fixture.teamAId, label: "Montage Nord" }],
    });

    // M1-10-Entkopplung: Aufgaben-Revision bleibt unberuehrt.
    expect(await taskRevisions(fixture)).toMatchObject({
      revision: 1,
      team_assignment_revision: 1,
    });
  });

  it("F1020-DB-02: entzieht ein Team und bumpst die Revision erneut", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(result).toEqual({
      taskId: fixture.taskId,
      teamAssignmentRevision: 2,
      changed: true,
    });
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1020-DB-03: Doppel-Zuweisen und Doppel-Entzug sind idempotent", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const replayAssign = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(replayAssign).toEqual({
      taskId: fixture.taskId,
      teamAssignmentRevision: 1,
      changed: false,
    });
    const replayUnassign = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamBId, 1),
      ),
    );
    expect(replayUnassign).toEqual({
      taskId: fixture.taskId,
      teamAssignmentRevision: 1,
      changed: false,
    });
  });

  it("F1020-DB-04: veraltete Revision wirft Konflikt mit aktuellem Stand", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamBId, 0),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(TaskTeamAssignmentConflictError);
    expect((failure as TaskTeamAssignmentConflictError).currentRevision).toBe(1);
    expect(await assignedTeams(fixture)).toEqual([fixture.teamAId]);
  });

  it("F1020-DB-05: archivierte, fremde und unbekannte Teams scheitern fail-closed", async () => {
    for (const teamId of [fixture.archivedTeamId, fixture.foreignTeamId, randomUUID()]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeTaskTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, teamId, 0),
        ).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(TaskTeamAssignmentTargetError);
    }
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1020-DB-06: mehr als 50 Teams je Aufgabe werden verweigert", async () => {
    const teamIds = Array.from({ length: 51 }, () => randomUUID());
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      for (const [index, teamId] of teamIds.entries()) {
        const name = `Capteam ${index}`;
        await tx.execute(sql`
          insert into team (id, workspace_id, name, name_normalized, active, revision, created_by)
          values (${teamId}::uuid, ${fixture.workspaceId}::uuid, ${name}, ${name.toLowerCase()},
            true, 1, ${fixture.editorId}::uuid)
        `);
      }
    });
    let revision = 0;
    for (const teamId of teamIds.slice(0, 50)) {
      const result = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeTaskTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, teamId, revision),
        ),
      );
      revision = result.teamAssignmentRevision;
    }
    expect(revision).toBe(50);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, teamIds[50], revision),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(TaskTeamAssignmentLimitError);
  });

  it("F1020-DB-07: Team mit Zuweisung ist per RESTRICT gegen Loeschen geschuetzt", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const code = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      try {
        await tx.execute(sql`
          delete from team
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${fixture.teamAId}::uuid
        `);
        return null;
      } catch (error) {
        return postgresCode(error) ?? "unknown";
      }
    });
    expect(code).toBe("23001");
  });

  it("F1020-DB-08: Task-FK traegt CASCADE, Team-FK RESTRICT", async () => {
    // Task-Direct-Delete ist dem Erasurevertrag vorbehalten (M1-10-Guard
    // + restriktive DELETE-Policy); ein behavioraler CASCADE-Delete ist
    // ausserhalb der Erasure-Maschinerie unmoeglich. Der Vertrag wird
    // daher am Katalog gepinnt (PG setzt ihn beim Erasure-Delete durch).
    const fks = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{ conname: string; confdeltype: string }>(sql`
        select conname, confdeltype
          from pg_catalog.pg_constraint
         where conrelid = 'public.project_task_team_assignment'::regclass
           and contype = 'f'
         order by conname
      `);
      return result.rows;
    });
    expect(fks).toContainEqual({
      conname: "project_task_team_assignment_task_fk",
      confdeltype: "c",
    });
    expect(fks).toContainEqual({
      conname: "project_task_team_assignment_team_fk",
      confdeltype: "r",
    });
  });

  it("F1020-DB-09: fremder Mandant sieht und aendert nichts", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.otherEditorId,
      fixture.otherWorkspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(TaskTeamAssignmentNotFoundError);
    const foreignContext = await withAuthorizedTenantOn(
      testPool,
      fixture.otherEditorId,
      fixture.otherWorkspaceId,
      (tx, ctx) => getTaskTeamAssignmentContext(tx, ctx, fixture.taskId),
    );
    expect(foreignContext).toBeNull();
  });

  it("F1020-DB-10: Viewer/External/entzogen duerfen nicht schreiben", async () => {
    for (const userId of [
      fixture.viewerId,
      fixture.externalId,
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        userId,
        fixture.workspaceId,
        (tx, ctx) => changeTaskTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, fixture.teamAId, 0),
        ).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(PermissionDeniedError);
    }
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        delete from membership where id = ${fixture.revokedMembershipId}::uuid
      `);
    });
    const revokedFailure = await withAuthorizedTenantOn(
      testPool,
      fixture.revokedId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(revokedFailure).toBeInstanceOf(PermissionDeniedError);
    expect(await assignedTeams(fixture)).toEqual([]);

    const viewerContext = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getTaskTeamAssignmentContext(tx, ctx, fixture.taskId),
    );
    expect(viewerContext).toMatchObject({ canAssign: false, teams: [] });
    const externalContext = await withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => getTaskTeamAssignmentContext(tx, ctx, fixture.taskId),
    );
    expect(externalContext).toBeNull();
  });

  it("F1020-DB-11: Events und Audit sind PII-frei", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const evidence = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ event_type: string; payload: unknown }>(sql`
        select event_type, payload from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_type = 'project'
           and aggregate_id = ${fixture.projectId}::uuid
           and event_type in ('project.task_team_assigned', 'project.task_team_unassigned')
         order by occurred_at, id
      `);
      const audits = await tx.execute<{
        action: string;
        resource: string;
        allowed: boolean;
        details: unknown;
      }>(sql`
        select action, resource, allowed, details from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'task.write'
           and resource = 'project_task_team_assignment'
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0]?.event_type).toBe("project.task_team_assigned");
    expect(evidence.events[0]?.payload).toMatchObject({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      teamId: fixture.teamAId,
      teamAssignmentRevision: 1,
    });
    expect(JSON.stringify(evidence.events[0]?.payload)).not.toContain("Montage Nord");
    expect(evidence.audits).toHaveLength(1);
    expect(evidence.audits[0]).toMatchObject({
      action: "task.write",
      resource: "project_task_team_assignment",
      allowed: true,
    });
    expect(JSON.stringify(evidence.audits[0]?.details)).not.toContain("Montage Nord");

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamAId, 1),
      ),
    );
    const afterUnassign = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ event_type: string; payload: unknown }>(sql`
        select event_type, payload from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_type = 'project'
           and aggregate_id = ${fixture.projectId}::uuid
           and event_type in ('project.task_team_assigned', 'project.task_team_unassigned')
         order by occurred_at, id
      `);
      const audits = await tx.execute<{
        action: string;
        resource: string;
        allowed: boolean;
        details: unknown;
      }>(sql`
        select action, resource, allowed, details from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'task.write'
           and resource = 'project_task_team_assignment'
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(afterUnassign.events).toHaveLength(2);
    expect(afterUnassign.events[1]?.event_type).toBe("project.task_team_unassigned");
    expect(afterUnassign.events[1]?.payload).toMatchObject({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      teamId: fixture.teamAId,
      teamAssignmentRevision: 2,
    });
    expect(JSON.stringify(afterUnassign.events[1]?.payload)).not.toContain("Montage Nord");
    expect(afterUnassign.audits).toHaveLength(2);
    expect(JSON.stringify(afterUnassign.audits[1]?.details)).not.toContain("Montage Nord");
  });

  it("F1020-DB-12: Entzug wirkt auch auf archivierte Teams", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update team set active = false
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.teamAId}::uuid
      `);
    });
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(result).toEqual({
      taskId: fixture.taskId,
      teamAssignmentRevision: 2,
      changed: true,
    });
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1020-DB-13: ungueltige Commands scheitern als ValidationError", async () => {
    const base = command("assign_team", fixture, fixture.teamAId, 0);
    for (const broken of [
      { ...base, schemaVersion: "project-task-command.v1" },
      { ...base, teamId: "keine-uuid" },
      { ...base, expectedTeamAssignmentRevision: -1 },
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeTaskTeamAssignment(
          tx,
          ctx,
          broken as unknown as Parameters<typeof changeTaskTeamAssignment>[2],
        ).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(TaskTeamAssignmentValidationError);
    }
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1020-DB-14: Revision am INT_MAX wirft Konflikt statt Ueberlauf", async () => {
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      // Guard-Carve-out (0233): reine Revisions-Seeds brauchen Actor.
      await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
      await tx.execute(sql`
        update project_task
           set team_assignment_revision = 2147483647, updated_by = ${fixture.editorId}::uuid
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.taskId}::uuid
      `);
    });
    // .then AUSSERHALB: Der Guard wirft NACH dem Insert — nur so rollt
    // die Transaktion zurueck (innen gefangen wuerde committen).
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 2147483647),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TaskTeamAssignmentConflictError);
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1020-DB-15: Aufgaben- und Team-Revision sind entkoppelt", async () => {
    // Echte M1-10-Mutation (complete): revision bumpst, team_assignment_revision
    // bleibt fix — und umgekehrt.
    const completed = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "complete",
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        expectedRevision: 1,
      }),
    );
    expect(completed.revision).toBe(2);
    expect(await taskRevisions(fixture)).toMatchObject({
      revision: 2,
      team_assignment_revision: 0,
    });

    const assigned = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeTaskTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    expect(assigned.teamAssignmentRevision).toBe(1);
    expect(await taskRevisions(fixture)).toMatchObject({
      revision: 2,
      team_assignment_revision: 1,
    });
  });
});
