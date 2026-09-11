import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import {
  AppointmentConflictError,
  AppointmentValidationError,
  executeProjectAppointmentCommand,
  getPlanningBoard,
} from "@/modules/calendar";
import { createTeam, setTeamActive } from "@/modules/teams";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  adminId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  projectId: string;
  tenancyCalendarId: string;
};

// Woche: Montag 2026-09-07 .. Sonntag 2026-09-13 (Berlin, MESZ +2).
const MONDAY = "2026-09-07";

async function seedFixture(emailDomain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const adminId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();
  const tenancyCalendarId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7.06 Disposition')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${adminId}::uuid, ${`admin-${adminId}@${emailDomain}`}),
             (${editorId}::uuid, ${`editor-${editorId}@${emailDomain}`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
             (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7.06', 'F', 'X', ${`${contactId}@${emailDomain}`}, ${`${contactId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7.06 Site')
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${adminId}::uuid)
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F7.06 Projekt', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return {
    workspaceId, adminId, editorId, editorMembershipId, viewerId,
    projectId, tenancyCalendarId,
  };
}

describe("F7-06 Disposition (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f0706.test");
  });

  const asAdmin = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  const seedAppointment = (teamId: string | null): Promise<string> =>
    asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: fixture.projectId,
      title: "Dispo-Termin",
      start: "2026-09-08T10:00:00",
      end: "2026-09-08T11:00:00",
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId: fixture.tenancyCalendarId,
      attendeeMembershipIds: [fixture.editorMembershipId],
      teamId,
    })).then((result) => result.appointmentId);

  const boardEntries = async () => {
    const board = await asEditor((tx, ctx) => getPlanningBoard(tx, ctx, { weekStart: MONDAY }));
    return board.rows.flatMap((row) => row.days.flatMap((day) => day.entries));
  };

  const updateTeam = (
    appointmentId: string,
    expectedRevision: number,
    teamId: string | null,
  ) => asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
    schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
    kind: "update_appointment",
    projectId: fixture.projectId,
    appointmentId,
    expectedRevision,
    title: "Dispo-Termin",
    start: "2026-09-08T10:00:00",
    end: "2026-09-08T11:00:00",
    allDay: false,
    type: "installation",
    location: null,
    description: null,
    calendarId: fixture.tenancyCalendarId,
    attendeeMembershipIds: [fixture.editorMembershipId],
    teamId,
  }));

  it("F0706-DB-01: Board projiziert Team-Bindung und Revision je Eintrag", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Dispo-Team" }));
    const withTeam = await seedAppointment(team.id);
    const withoutTeam = await seedAppointment(null);

    const entries = await boardEntries();
    const gotWith = entries.find((entry) => entry.id === withTeam);
    const gotWithout = entries.find((entry) => entry.id === withoutTeam);
    expect(gotWith).toMatchObject({
      teamId: team.id, teamName: "Dispo-Team", revision: 1,
    });
    expect(gotWithout).toMatchObject({ teamId: null, teamName: null, revision: 1 });
  });

  it("F0706-DB-02: Zuweisung und Entzug über Update mit Revision-CAS", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Dispo-Team" }));
    const appointmentId = await seedAppointment(null);

    const assigned = await updateTeam(appointmentId, 1, team.id);
    expect(assigned.revision).toBe(2);
    expect(assigned.changed).toBe(true);
    let entries = await boardEntries();
    expect(entries.find((entry) => entry.id === appointmentId)).toMatchObject({
      teamId: team.id, teamName: "Dispo-Team", revision: 2,
    });

    const withdrawn = await updateTeam(appointmentId, 2, null);
    expect(withdrawn.revision).toBe(3);
    entries = await boardEntries();
    expect(entries.find((entry) => entry.id === appointmentId)).toMatchObject({
      teamId: null, teamName: null, revision: 3,
    });
  });

  it("F0706-DB-03: fremd/archiviert/unbekannt fail-closed, Mandantentrennung", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Dispo-Team" }));
    const appointmentId = await seedAppointment(null);

    // Fremdes Team (anderer Workspace) → Validation, kein Orakel.
    const other = await seedFixture("f0706-fremd.test");
    const foreignTeam = await withAuthorizedTenantOn(
      testPool, other.adminId, other.workspaceId,
      (tx, ctx) => createTeam(tx, ctx, { name: "Fremd-Team" }),
    );
    await expect(updateTeam(appointmentId, 1, foreignTeam.id))
      .rejects.toBeInstanceOf(AppointmentValidationError);

    // Archiviertes Team → Validation (bestehende Bindungen bleiben lesbar).
    await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      id: team.id, active: false, expectedRevision: 1,
    }));
    await expect(updateTeam(appointmentId, 1, team.id))
      .rejects.toBeInstanceOf(AppointmentValidationError);

    // Unbekannte UUID → Validation.
    await expect(updateTeam(appointmentId, 1, randomUUID()))
      .rejects.toBeInstanceOf(AppointmentValidationError);

    // Fremder Workspace sieht den Eintrag nicht.
    const foreignBoard = await withAuthorizedTenantOn(
      testPool, other.adminId, other.workspaceId,
      (tx, ctx) => getPlanningBoard(tx, ctx, { weekStart: MONDAY }),
    );
    const foreignEntries = foreignBoard.rows.flatMap((row) =>
      row.days.flatMap((day) => day.entries));
    expect(foreignEntries.find((entry) => entry.id === appointmentId)).toBeUndefined();
  });

  it("F0706-DB-04: veraltete Revision → Konflikt, kein stiller Overwrite", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Dispo-Team" }));
    const appointmentId = await seedAppointment(null);
    await updateTeam(appointmentId, 1, team.id);
    await expect(updateTeam(appointmentId, 1, null))
      .rejects.toBeInstanceOf(AppointmentConflictError);
    // Verloren ist nichts: Stand bleibt bei Revision 2 mit Team.
    const entries = await boardEntries();
    expect(entries.find((entry) => entry.id === appointmentId)).toMatchObject({ revision: 2 });
  });
});
