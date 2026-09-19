// F1-12-Folgenachweis S1 (T9): Assign bei mehrtägigem Termin (PostgreSQL).
// Hypothese (DISCOVERED): Der Range-Filter im Assign-Lesepfad
// (plantafel/actions.ts → listProjectAppointments mit Range = eigene
// Start/Ende des Tafeleintrags) könnte mehrtägige Termine verfehlen und
// fälschlich `not_found` liefern. Der Test repliziert EXAKT diesen
// Lesepfad auf Service-Ebene und weist danach das Team per
// update_appointment (Voll-Resend + Revision-CAS, wie die Action) zu.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import {
  executeProjectAppointmentCommand,
  getPlanningBoard,
  listProjectAppointments,
} from "@/modules/calendar";
import { createTeam } from "@/modules/teams";
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F112 S1 Nachweis')`);
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F112 S1', 'F', 'X', ${`${contactId}@${emailDomain}`}, ${`${contactId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F112 S1 Site')
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${adminId}::uuid)
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F112 S1 Projekt', 'manual'
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

describe("F1-12-Folgenachweis S1: Assign bei mehrtägigem Termin (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f112-s1.test");
  });

  const asAdmin = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  it("F112-S1-01: mehrtägiger Termin im Assign-Lesepfad gefunden, Team zuweisbar", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "S1-Team" }));
    // Mehrtägig: Montag 08:00 bis Mittwoch 17:00 (Berlin).
    const { appointmentId } = await asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: fixture.projectId,
      title: "Mehrtägige Montage",
      start: "2026-09-07T08:00:00",
      end: "2026-09-09T17:00:00",
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId: fixture.tenancyCalendarId,
      attendeeMembershipIds: [fixture.editorMembershipId],
      teamId: null,
    }));

    // Tafeleintrag lesen (Quelle der hidden start/end-Felder der Assign-Form).
    const board = await asEditor((tx, ctx) => getPlanningBoard(tx, ctx, { weekStart: MONDAY }));
    const boardStarts = board.rows.flatMap((row) =>
      row.days.flatMap((day) => day.entries)).filter((entry) => entry.id === appointmentId);
    expect(boardStarts.length).toBeGreaterThan(0);
    const entry = boardStarts[0]!;
    // Auf allen drei Tagen platziert.
    const entryDays = board.rows.flatMap((row) => row.days)
      .filter((day) => day.entries.some((candidate) => candidate.id === appointmentId))
      .map((day) => day.date);
    expect(new Set(entryDays)).toEqual(new Set(["2026-09-07", "2026-09-08", "2026-09-09"]));

    // Exakter Assign-Lesepfad aus assignPlanningBoardEntryTeamAction:
    // Range = eigene Start/Ende des Tafeleintrags, view week.
    const range = await asEditor((tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: entry.start,
      rangeEnd: entry.end,
      view: "week",
    }));
    const current = range?.items.find((item) => item.id === appointmentId) ?? null;
    // Negativ-Erwartung (Overlap-Filter): gefunden, kein not_found.
    expect(current).not.toBeNull();

    // Assign per update_appointment (Voll-Resend + Revision-CAS, wie die Action).
    const assigned = await asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "update_appointment",
      projectId: fixture.projectId,
      appointmentId,
      expectedRevision: current!.revision,
      title: current!.title,
      start: "2026-09-07T08:00:00",
      end: "2026-09-09T17:00:00",
      allDay: current!.allDay,
      type: current!.type,
      location: current!.location,
      description: current!.description,
      attendeeMembershipIds: current!.attendees.map((attendee) => attendee.membershipId),
      calendarId: current!.calendarId,
      teamId: team.id,
    }));
    expect(assigned.revision).toBe(2);
    expect(assigned.changed).toBe(true);

    const reread = await asEditor((tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: "2026-09-01",
      rangeEnd: "2026-09-30",
      view: "month",
    }));
    expect(reread!.items.find((item) => item.id === appointmentId)).toMatchObject({
      teamId: team.id, teamName: "S1-Team", revision: 2,
    });
  });
});
