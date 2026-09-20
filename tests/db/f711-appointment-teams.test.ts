// F7-11 Termin-Mehr-Team (RED): Junction-Zuweisung mehrerer Teams je Termin.
// Verbindlich: docs/spec/F7-11-termin-mehr-team.md. Stilvorlage: f1020 (Tasks).
// Der Import aus @/modules/calendar ist absichtlich rot — der Service
// (modules/calendar/team-assignment-service.ts + Migration 0320) existiert noch nicht.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  AppointmentTeamConflictError,
  AppointmentTeamLimitError,
  AppointmentTeamTargetError,
  AppointmentTeamValidationError,
  changeAppointmentTeamAssignment,
  executeProjectAppointmentCommand,
  getAppointmentTeamAssignmentContext,
  getPlanningBoard,
} from "@/modules/calendar";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  calendarId: string;
  appointmentId: string;
  teamAppointmentId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  revokedId: string;
  editorMembershipId: string;
  viewerMembershipId: string;
  externalMembershipId: string;
  revokedMembershipId: string;
  otherEditorId: string;
  teamAId: string;
  teamBId: string;
  archivedTeamId: string;
  foreignTeamId: string;
};

// Woche: Montag 2026-09-07 .. Sonntag 2026-09-13 (Berlin, MESZ +2).
const MONDAY = "2026-09-07";
const START_1 = "2026-09-08T10:00:00";
const END_1 = "2026-09-08T11:00:00";
const START_2 = "2026-09-08T14:00:00";
const END_2 = "2026-09-08T15:00:00";

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
  const calendarId = randomUUID();
  const appointmentId = randomUUID();
  const teamAppointmentId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const revokedId = randomUUID();
  const otherEditorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerMembershipId = randomUUID();
  const externalMembershipId = randomUUID();
  const revokedMembershipId = randomUUID();
  const otherEditorMembershipId = randomUUID();
  const teamAId = randomUUID();
  const teamBId = randomUUID();
  const archivedTeamId = randomUUID();
  const foreignTeamId = randomUUID();
  const domain = "f711.test";

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'F7-11 Termin-Mehr-Team')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@${domain}`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@${domain}`}),
        (${externalId}::uuid, ${`external-${externalId}@${domain}`}),
        (${revokedId}::uuid, ${`revoked-${revokedId}@${domain}`}),
        (${otherEditorId}::uuid, ${`other-editor-${otherEditorId}@${domain}`})
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
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7-11 Kundin', 'Fixture', 'Contact',
        ${`${contactId}@${domain}`}, ${`${contactId}@${domain}`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7-11 Site')
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${calendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${editorId}::uuid)
    `);
    const projects = await tx.execute<{ id: string }>(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'Teamanfrage F7-11', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
      returning id
    `);
    if (projects.rows.length !== 1) throw new Error("F7-11 project was not seeded");
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
      values (${otherWorkspaceId}::uuid, 'F7-11 Other Tenant')
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${otherEditorMembershipId}::uuid, ${otherWorkspaceId}::uuid,
        ${otherEditorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into team (id, workspace_id, name, name_normalized, active, revision, created_by)
      values (${foreignTeamId}::uuid, ${otherWorkspaceId}::uuid, 'Fremdteam',
        'fremdteam', true, 1, ${otherEditorId}::uuid)
    `);
  });

  const fixture: Fixture = {
    workspaceId,
    otherWorkspaceId,
    projectId,
    calendarId,
    appointmentId,
    teamAppointmentId,
    editorId,
    viewerId,
    externalId,
    revokedId,
    editorMembershipId,
    viewerMembershipId,
    externalMembershipId,
    revokedMembershipId,
    otherEditorId,
    teamAId,
    teamBId,
    archivedTeamId,
    foreignTeamId,
  };

  // Termine ueber den Legacy-Service (F1-12/F7-06-Pfad): einer ohne team_id,
  // einer mit team_id (Disjunktheit/Wechsel-Nachweise). Zeiten disjunkt,
  // damit keine Ueberlappungs-Validierung greifen kann. Die erzeugten IDs
  // ueberschreiben die Fixture-Platzhalter (Service generiert eigene IDs).
  await withAuthorizedTenantOn(testPool, editorId, workspaceId, async (tx, ctx) => {
    const plain = await executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId,
      title: "Teamtermin",
      start: START_1,
      end: END_1,
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId,
      attendeeMembershipIds: [editorMembershipId],
      teamId: null,
    });
    const singleTeam = await executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId,
      title: "Single-Team-Termin",
      start: START_2,
      end: END_2,
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId,
      attendeeMembershipIds: [editorMembershipId],
      teamId: teamAId,
    });
    fixture.appointmentId = plain.appointmentId;
    fixture.teamAppointmentId = singleTeam.appointmentId;
  });

  return fixture;
}

function command(
  kind: "assign_team" | "unassign_team",
  fixture: Fixture,
  teamId: string,
  expectedTeamAssignmentRevision: number,
  appointmentId: string = fixture.appointmentId,
) {
  return {
    appointmentId,
    projectId: fixture.projectId,
    kind,
    teamId,
    expectedTeamAssignmentRevision,
  } as const;
}

function updateTeamCommand(
  fixture: Fixture,
  appointmentId: string,
  expectedRevision: number,
  teamId: string | null,
) {
  return {
    schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
    kind: "update_appointment",
    projectId: fixture.projectId,
    appointmentId,
    expectedRevision,
    title: "Teamtermin",
    start: START_1,
    end: END_1,
    allDay: false,
    type: "installation",
    location: null,
    description: null,
    calendarId: fixture.calendarId,
    attendeeMembershipIds: [fixture.editorMembershipId] as string[],
    teamId,
  } as const;
}

async function assignedTeams(
  fixture: Fixture,
  appointmentId: string = fixture.appointmentId,
): Promise<string[]> {
  const rows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{ team_id: string }>(sql`
      select team_id from project_appointment_team_assignment
       where workspace_id = ${fixture.workspaceId}::uuid
         and appointment_id = ${appointmentId}::uuid
       order by team_id
    `);
    return result.rows;
  });
  return rows.map((row) => row.team_id);
}

async function appointmentRevisions(
  fixture: Fixture,
  appointmentId: string = fixture.appointmentId,
): Promise<{ revision: number; team_assignment_revision: number }> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    // Actor-Policy auf project_appointment: SELECT braucht internen Viewer+.
    await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
    const result = await tx.execute<{
      revision: number;
      team_assignment_revision: number;
    }>(sql`
      select revision, team_assignment_revision from project_appointment
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${appointmentId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F7-11 appointment was not found");
    return row;
  });
}

async function appointmentTeamId(
  fixture: Fixture,
  appointmentId: string = fixture.appointmentId,
): Promise<string | null> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`select set_config('app.actor_id', ${fixture.editorId}, true)`);
    const result = await tx.execute<{ team_id: string | null }>(sql`
      select team_id from project_appointment
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${appointmentId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F7-11 appointment was not found");
    return row.team_id;
  });
}

describe("F7-11 Termin-Mehr-Team-Zuweisung", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F711-DB-01: weist ein aktives Team zu und bumpt die Team-Revision", async () => {
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    expect(result.teamAssignmentRevision).toBe(1);

    const context = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getAppointmentTeamAssignmentContext(tx, ctx, fixture.appointmentId),
    );
    expect(context).toMatchObject({
      teamAssignmentRevision: 1,
      canAssign: true,
      teams: [{ id: fixture.teamAId, name: "Montage Nord" }],
    });

    expect(await assignedTeams(fixture)).toEqual([fixture.teamAId]);
    // Guard-Carve-out: Fach-Revision bleibt unberuehrt.
    expect(await appointmentRevisions(fixture)).toMatchObject({
      revision: 1,
      team_assignment_revision: 1,
    });
  });

  it("F711-DB-02: entzieht ein Team und bumpt die Team-Revision erneut", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(result.teamAssignmentRevision).toBe(2);
    expect(await assignedTeams(fixture)).toEqual([]);
    expect(await appointmentRevisions(fixture)).toMatchObject({
      revision: 1,
      team_assignment_revision: 2,
    });
  });

  it("F711-DB-03: veraltete Revision wirft Konflikt mit aktuellem Stand", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamBId, 0),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(AppointmentTeamConflictError);
    expect((failure as AppointmentTeamConflictError).currentRevision).toBe(1);
    expect(await assignedTeams(fixture)).toEqual([fixture.teamAId]);
  });

  it("F711-DB-04: Doppel-Zuweisen und Doppel-Entzug sind Noops ohne Bump", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    const replayAssign = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 1),
      ),
    );
    expect(replayAssign.teamAssignmentRevision).toBe(1);
    const replayUnassign = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("unassign_team", fixture, fixture.teamBId, 1),
      ),
    );
    expect(replayUnassign.teamAssignmentRevision).toBe(1);
    expect(await assignedTeams(fixture)).toEqual([fixture.teamAId]);
    expect(await appointmentRevisions(fixture)).toMatchObject({
      revision: 1,
      team_assignment_revision: 1,
    });
  });

  it("F711-DB-05: archivierte, fremde, unbekannte und deformierte Teams scheitern fail-closed", async () => {
    for (const teamId of [
      fixture.archivedTeamId,
      fixture.foreignTeamId,
      randomUUID(),
      "keine-uuid",
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeAppointmentTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, teamId, 0),
        ).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(AppointmentTeamTargetError);
    }
    expect(await assignedTeams(fixture)).toEqual([]);
    expect(await appointmentRevisions(fixture)).toMatchObject({
      team_assignment_revision: 0,
    });
  });

  it("F711-DB-06: mehr als 50 Teams je Termin werden verweigert", async () => {
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
        (tx, ctx) => changeAppointmentTeamAssignment(
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
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, teamIds[50] as string, revision),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(AppointmentTeamLimitError);
  });

  it("F711-DB-07: Assign auf das team_id-Team verletzt die Disjunktheit", async () => {
    expect(await appointmentTeamId(fixture, fixture.teamAppointmentId)).toBe(fixture.teamAId);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0, fixture.teamAppointmentId),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(AppointmentTeamValidationError);
    expect(await assignedTeams(fixture, fixture.teamAppointmentId)).toEqual([]);
    expect(await appointmentRevisions(fixture, fixture.teamAppointmentId)).toMatchObject({
      revision: 1,
      team_assignment_revision: 0,
    });
  });

  it("F711-DB-08: team_id-Wechsel beruehrt die Junction nicht", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamBId, 0),
      ),
    );
    // Spaeterer team_id-Wechsel auf dasselbe Team: kein stilles Entfernen.
    const updated = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(
        tx,
        ctx,
        updateTeamCommand(fixture, fixture.appointmentId, 1, fixture.teamBId),
      ),
    );
    expect(updated.revision).toBe(2);
    expect(await appointmentTeamId(fixture)).toBe(fixture.teamBId);
    expect(await assignedTeams(fixture)).toEqual([fixture.teamBId]);
    expect(await appointmentRevisions(fixture)).toMatchObject({
      revision: 2,
      team_assignment_revision: 1,
    });
  });

  it("F711-DB-09: Legacy-team_id-Pfad bleibt unveraendert (update + Board-Projektion)", async () => {
    const updated = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(
        tx,
        ctx,
        updateTeamCommand(fixture, fixture.appointmentId, 1, fixture.teamAId),
      ),
    );
    expect(updated.revision).toBe(2);
    expect(await appointmentTeamId(fixture)).toBe(fixture.teamAId);
    expect(await assignedTeams(fixture)).toEqual([]);

    const board = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getPlanningBoard(tx, ctx, { weekStart: MONDAY }),
    );
    const entries = board.rows.flatMap((row) => row.days.flatMap((day) => day.entries));
    const boardEntry = entries.find((entry) => entry.id === fixture.appointmentId);
    expect(boardEntry).toMatchObject({
      title: "Teamtermin",
      teamId: fixture.teamAId,
    });
  });

  it("F711-DB-10: fremder Mandant sieht und aendert nichts", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    // Fremder Scope: kein Orakel — der Change scheitert, der Context ist null.
    await expect(
      withAuthorizedTenantOn(
        testPool,
        fixture.otherEditorId,
        fixture.otherWorkspaceId,
        (tx, ctx) => changeAppointmentTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, fixture.teamAId, 0),
        ),
      ),
    ).rejects.toThrow();
    const foreignContext = await withAuthorizedTenantOn(
      testPool,
      fixture.otherEditorId,
      fixture.otherWorkspaceId,
      (tx, ctx) => getAppointmentTeamAssignmentContext(tx, ctx, fixture.appointmentId),
    );
    expect(foreignContext).toBeNull();

    // Unbekannter Termin im eigenen Mandanten: ebenfalls kein Orakel.
    await expect(
      withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeAppointmentTeamAssignment(
          tx,
          ctx,
          command("assign_team", fixture, fixture.teamAId, 0, randomUUID()),
        ),
      ),
    ).rejects.toThrow();
    expect(await assignedTeams(fixture)).toEqual([fixture.teamAId]);
  });

  it("F711-DB-11: Viewer/External/entzogen duerfen nicht schreiben", async () => {
    for (const userId of [fixture.viewerId, fixture.externalId]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        userId,
        fixture.workspaceId,
        (tx, ctx) => changeAppointmentTeamAssignment(
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
      (tx, ctx) => changeAppointmentTeamAssignment(
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
      (tx, ctx) => getAppointmentTeamAssignmentContext(tx, ctx, fixture.appointmentId),
    );
    expect(viewerContext).toMatchObject({ canAssign: false, teams: [] });
    const externalContext = await withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => getAppointmentTeamAssignmentContext(tx, ctx, fixture.appointmentId),
    );
    expect(externalContext).toBeNull();
  });

  it("F711-DB-12: Events und Audit sind ID-only und PII-frei", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
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
           and event_type in ('project.appointment_team_assigned', 'project.appointment_team_unassigned')
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
           and action = 'appointment.write'
           and resource = 'project_appointment_team_assignment'
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0]?.event_type).toBe("project.appointment_team_assigned");
    const assignPayload = evidence.events[0]?.payload as Record<string, unknown>;
    expect(assignPayload).toMatchObject({
      projectId: fixture.projectId,
      appointmentId: fixture.appointmentId,
      teamId: fixture.teamAId,
    });
    expect(assignPayload.teamAssignmentRevision ?? assignPayload.revision).toBe(1);
    expect(JSON.stringify(assignPayload)).not.toContain("Montage Nord");
    expect(evidence.audits).toHaveLength(1);
    expect(evidence.audits[0]).toMatchObject({
      action: "appointment.write",
      resource: "project_appointment_team_assignment",
      allowed: true,
    });
    expect(JSON.stringify(evidence.audits[0]?.details)).not.toContain("Montage Nord");

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
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
           and event_type in ('project.appointment_team_assigned', 'project.appointment_team_unassigned')
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
           and action = 'appointment.write'
           and resource = 'project_appointment_team_assignment'
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(afterUnassign.events).toHaveLength(2);
    expect(afterUnassign.events[1]?.event_type).toBe("project.appointment_team_unassigned");
    const unassignPayload = afterUnassign.events[1]?.payload as Record<string, unknown>;
    expect(unassignPayload).toMatchObject({
      projectId: fixture.projectId,
      appointmentId: fixture.appointmentId,
      teamId: fixture.teamAId,
    });
    expect(unassignPayload.teamAssignmentRevision ?? unassignPayload.revision).toBe(2);
    expect(JSON.stringify(unassignPayload)).not.toContain("Montage Nord");
    expect(afterUnassign.audits).toHaveLength(2);
    expect(JSON.stringify(afterUnassign.audits[1]?.details)).not.toContain("Montage Nord");
  });

  it("F711-DB-13: Team mit Zuweisung ist per RESTRICT gegen Loeschen geschuetzt", async () => {
    // teamB (keine Legacy-team_id-Bindung): sonst feuert vor dem RESTRICT der
    // Legacy-SET-NULL-Pfad in den Revisions-Guard (23514, 0114/0043-Verhalten).
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamBId, 0),
      ),
    );
    const code = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      try {
        await tx.execute(sql`
          delete from team
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${fixture.teamBId}::uuid
        `);
        return null;
      } catch (error) {
        return postgresCode(error) ?? "unknown";
      }
    });
    expect(code).toBe("23001");

    // Vertrag am Katalog gepinnt (namen-agnostisch): Appointment-FK CASCADE,
    // Team-FK RESTRICT.
    const fks = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{ confdeltype: string; reftable: string }>(sql`
        select c.confdeltype, rel.relname as reftable
          from pg_catalog.pg_constraint c
          join pg_catalog.pg_class rel on rel.oid = c.confrelid
         where c.conrelid = 'public.project_appointment_team_assignment'::regclass
           and c.contype = 'f'
         order by rel.relname
      `);
      return result.rows;
    });
    expect(fks).toContainEqual({ confdeltype: "c", reftable: "project_appointment" });
    expect(fks).toContainEqual({ confdeltype: "r", reftable: "team" });
  });

  it("F711-DB-14: Termin- und Team-Revision sind entkoppelt", async () => {
    // Echte Fach-Mutation (update): revision bumpt, team_assignment_revision bleibt fix.
    const updated = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(
        tx,
        ctx,
        updateTeamCommand(fixture, fixture.appointmentId, 1, null),
      ),
    );
    expect(updated.revision).toBe(2);
    expect(await appointmentRevisions(fixture)).toMatchObject({
      revision: 2,
      team_assignment_revision: 0,
    });

    // Umgekehrt: Team-Change bumpt nur die Team-Revision.
    const assigned = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeAppointmentTeamAssignment(
        tx,
        ctx,
        command("assign_team", fixture, fixture.teamAId, 0),
      ),
    );
    expect(assigned.teamAssignmentRevision).toBe(1);
    expect(await appointmentRevisions(fixture)).toMatchObject({
      revision: 2,
      team_assignment_revision: 1,
    });
  });
});
