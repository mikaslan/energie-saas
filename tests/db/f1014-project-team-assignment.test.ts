import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_TEAM_ASSIGNMENT_COMMAND_VERSION,
  changeProjectTeamAssignment,
  getProjectTeamAssignmentContext,
  ProjectTeamAssignmentConflictError,
  ProjectTeamAssignmentLimitError,
  ProjectTeamAssignmentNotFoundError,
  ProjectTeamAssignmentTargetError,
  ProjectTeamAssignmentValidationError,
} from "@/modules/projects";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  unassignedProjectId: string;
  editorId: string;
  editorWithoutRightId: string;
  viewerId: string;
  externalId: string;
  revokedId: string;
  editorMembershipId: string;
  editorWithoutRightMembershipId: string;
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
  const unassignedProjectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const editorWithoutRightId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const revokedId = randomUUID();
  const crossTenantId = randomUUID();
  const editorMembershipId = randomUUID();
  const editorWithoutRightMembershipId = randomUUID();
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
      values (${workspaceId}::uuid, 'F1-14 Teamzuweisung')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f1014.test`}),
        (${editorWithoutRightId}::uuid, ${`limited-${editorWithoutRightId}@f1014.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f1014.test`}),
        (${externalId}::uuid, ${`external-${externalId}@f1014.test`}),
        (${revokedId}::uuid, ${`revoked-${revokedId}@f1014.test`}),
        (${crossTenantId}::uuid, ${`cross-${crossTenantId}@f1014.test`}),
        (${otherEditorId}::uuid, ${`other-editor-${otherEditorId}@f1014.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
          'editor', '{"assign_projects": true}'::jsonb),
        (${editorWithoutRightMembershipId}::uuid, ${workspaceId}::uuid,
          ${editorWithoutRightId}::uuid, 'editor', '{}'::jsonb),
        (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
          'viewer', '{}'::jsonb),
        (${externalMembershipId}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
          'viewer', '{"external_only": true}'::jsonb),
        (${revokedMembershipId}::uuid, ${workspaceId}::uuid, ${revokedId}::uuid,
          'editor', '{"assign_projects": true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized,
        phone_raw, phone_e164
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'Kundin F1-14', 'Fixture', 'Contact',
        'kundin@f1014.test', 'kundin@f1014.test', '+49 30 123456', '+4930123456'
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
      select project_seed.id, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id, project_seed.name, 'manual'
      from (
        values
          (${projectId}::uuid, 'Zugewiesene Teamanfrage'::text),
          (${unassignedProjectId}::uuid, 'Unzugewiesene Teamanfrage'::text)
      ) as project_seed(id, name)
      join kanban_board board
        on board.workspace_id = ${workspaceId}::uuid
       and board.scope = 'residential'
       and board.is_default = true
       and board.archived_at is null
      join kanban_column intake
        on intake.workspace_id = board.workspace_id
       and intake.board_id = board.id
       and intake.is_intake = true
       and intake.archived_at is null
      returning id
    `);
    if (projects.rows.length !== 2) throw new Error("F1-14 projects were not seeded");
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
      values (${otherWorkspaceId}::uuid, 'F1-14 Other Tenant')
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${crossTenantMembershipId}::uuid, ${otherWorkspaceId}::uuid,
        ${crossTenantId}::uuid, 'viewer', '{}'::jsonb),
        (${otherEditorMembershipId}::uuid, ${otherWorkspaceId}::uuid,
        ${otherEditorId}::uuid, 'editor', '{"assign_projects": true}'::jsonb)
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
    unassignedProjectId,
    editorId,
    editorWithoutRightId,
    viewerId,
    externalId,
    revokedId,
    editorMembershipId,
    editorWithoutRightMembershipId,
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
  projectId: string = fixture.projectId,
) {
  return {
    schemaVersion: PROJECT_TEAM_ASSIGNMENT_COMMAND_VERSION,
    kind,
    projectId,
    teamId,
    expectedTeamAssignmentRevision,
  } as const;
}

async function assignedTeams(fixture: Fixture): Promise<string[]> {
  const rows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{ team_id: string }>(sql`
      select team_id from project_team_assignment
       where workspace_id = ${fixture.workspaceId}::uuid
         and project_id = ${fixture.projectId}::uuid
       order by team_id
    `);
    return result.rows;
  });
  return rows.map((row) => row.team_id);
}

describe("F1-14 Projekt-Team-Zuweisung", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1014-DB-01: weist ein aktives Team zu und bumpst die Revision", async () => {
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    expect(result).toEqual({
      projectId: fixture.projectId,
      teamAssignmentRevision: 1,
      changed: true,
    });

    const context = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTeamAssignmentContext(tx, ctx, fixture.projectId),
    );
    expect(context).toMatchObject({
      projectId: fixture.projectId,
      teamAssignmentRevision: 1,
      canAssign: true,
      teams: [{ teamId: fixture.teamAId, label: "Montage Nord" }],
    });

    // M1-09-Entkopplung: Personen-Revision bleibt unberuehrt.
    const revisions = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{
        assignment_revision: number;
        team_assignment_revision: number;
      }>(sql`
        select assignment_revision, team_assignment_revision from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.projectId}::uuid
      `);
      return result.rows[0];
    });
    expect(revisions).toMatchObject({ assignment_revision: 0, team_assignment_revision: 1 });
  });

  it("F1014-DB-02: entzieht ein Team und bumpst die Revision erneut", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(result).toEqual({
      projectId: fixture.projectId,
      teamAssignmentRevision: 2,
      changed: true,
    });
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1014-DB-03: Doppel-Zuweisen und Doppel-Entzug sind idempotent", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const replayAssign = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(replayAssign).toEqual({
      projectId: fixture.projectId,
      teamAssignmentRevision: 1,
      changed: false,
    });
    const replayUnassign = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamBId, 1),
      ),
    );
    expect(replayUnassign).toEqual({
      projectId: fixture.projectId,
      teamAssignmentRevision: 1,
      changed: false,
    });
  });

  it("F1014-DB-04: veraltete Revision wirft Konflikt mit aktuellem Stand", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamBId, 0),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(ProjectTeamAssignmentConflictError);
    expect((failure as ProjectTeamAssignmentConflictError).currentRevision).toBe(1);
    expect(await assignedTeams(fixture)).toEqual([fixture.teamAId]);
  });

  it("F1014-DB-05: archivierte, fremde und unbekannte Teams scheitern fail-closed", async () => {
    for (const teamId of [fixture.archivedTeamId, fixture.foreignTeamId, randomUUID()]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, teamId, 0),
        ).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(ProjectTeamAssignmentTargetError);
    }
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1014-DB-06: mehr als 50 Teams je Projekt werden verweigert", async () => {
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
        (tx, ctx) => changeProjectTeamAssignment(
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
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, teamIds[50], revision),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(ProjectTeamAssignmentLimitError);
  });

  it("F1014-DB-07: Team mit Zuweisung ist per RESTRICT gegen Loeschen geschuetzt", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
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

  it("F1014-DB-08: Projekt-Delete raeumt Zuweisungen per CASCADE auf", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        delete from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.projectId}::uuid
      `);
    });
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1014-DB-09: fremder Mandant sieht und aendert nichts", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.otherEditorId,
      fixture.otherWorkspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(ProjectTeamAssignmentNotFoundError);
    const foreignContext = await withAuthorizedTenantOn(
      testPool,
      fixture.otherEditorId,
      fixture.otherWorkspaceId,
      (tx, ctx) => getProjectTeamAssignmentContext(tx, ctx, fixture.projectId),
    );
    expect(foreignContext).toBeNull();
  });

  it("F1014-DB-10: Viewer/External/ohne-Recht/entzogen duerfen nicht schreiben", async () => {
    for (const userId of [
      fixture.viewerId,
      fixture.externalId,
      fixture.editorWithoutRightId,
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        userId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectTeamAssignment(
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
      (tx, ctx) => changeProjectTeamAssignment(
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
      (tx, ctx) => getProjectTeamAssignmentContext(tx, ctx, fixture.projectId),
    );
    expect(viewerContext).toMatchObject({ canAssign: false, teams: [] });
    const externalContext = await withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTeamAssignmentContext(tx, ctx, fixture.projectId),
    );
    expect(externalContext).toBeNull();
  });

  it("F1014-DB-11: Events und Audit sind PII-frei", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
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
           and event_type in ('project.team_assigned', 'project.team_unassigned')
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
           and action = 'project.assign'
           and resource = 'project_team_assignment'
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0]?.event_type).toBe("project.team_assigned");
    expect(evidence.events[0]?.payload).toMatchObject({
      projectId: fixture.projectId,
      teamId: fixture.teamAId,
      teamAssignmentRevision: 1,
    });
    expect(JSON.stringify(evidence.events[0]?.payload)).not.toContain("Montage Nord");
    expect(evidence.audits).toHaveLength(1);
    expect(evidence.audits[0]).toMatchObject({
      action: "project.assign",
      resource: "project_team_assignment",
      allowed: true,
    });
    expect(JSON.stringify(evidence.audits[0]?.details)).not.toContain("Montage Nord");

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
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
           and event_type in ('project.team_assigned', 'project.team_unassigned')
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
           and action = 'project.assign'
           and resource = 'project_team_assignment'
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(afterUnassign.events).toHaveLength(2);
    expect(afterUnassign.events[1]?.event_type).toBe("project.team_unassigned");
    expect(afterUnassign.events[1]?.payload).toMatchObject({
      projectId: fixture.projectId,
      teamId: fixture.teamAId,
      teamAssignmentRevision: 2,
    });
    expect(JSON.stringify(afterUnassign.events[1]?.payload)).not.toContain("Montage Nord");
    expect(afterUnassign.audits).toHaveLength(2);
    expect(JSON.stringify(afterUnassign.audits[1]?.details)).not.toContain("Montage Nord");
  });

  it("F1014-DB-12: Entzug wirkt auch auf archivierte Teams", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
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
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(result).toEqual({
      projectId: fixture.projectId,
      teamAssignmentRevision: 2,
      changed: true,
    });
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1014-DB-13: ungueltige Commands scheitern als ValidationError", async () => {
    const base = command("assign_team", fixture, fixture.teamAId, 0);
    for (const broken of [
      { ...base, schemaVersion: "project-assignment-command.v1" },
      { ...base, teamId: "keine-uuid" },
      { ...base, expectedTeamAssignmentRevision: -1 },
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectTeamAssignment(
          tx,
          ctx,
          broken as unknown as Parameters<typeof changeProjectTeamAssignment>[2],
        ).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(ProjectTeamAssignmentValidationError);
    }
    expect(await assignedTeams(fixture)).toEqual([]);
  });

  it("F1014-DB-14: Revision am INT_MAX wirft Konflikt statt Ueberlauf", async () => {
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project set team_assignment_revision = 2147483647
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.projectId}::uuid
      `);
    });
    // .then AUSSERHALB: Der Guard wirft NACH dem Insert — nur so rollt
    // die Transaktion zurueck (innen gefangen wuerde committen).
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 2147483647),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProjectTeamAssignmentConflictError);
    expect(await assignedTeams(fixture)).toEqual([]);
  });
});