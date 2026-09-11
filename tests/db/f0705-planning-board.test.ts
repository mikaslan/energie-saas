import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_BOARD_VERSION,
  PROJECT_APPOINTMENT_COMMAND_VERSION,
} from "@/lib/integrations/calendar/contract";
import {
  AppointmentValidationError,
  executeProjectAppointmentCommand,
  getPlanningBoard,
  listAppointmentProjectOptions,
} from "@/modules/calendar";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
  projectName: string;
  editorCalendarId: string;
};

// Woche: Montag 2026-09-07 .. Sonntag 2026-09-13 (Berlin, MESZ +2).
const MONDAY = "2026-09-07";

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const editorMembershipId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7.05 Plantafel')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f705.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f705.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f705.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const projectName = "F7.05 Projekt";
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7.05 Kontakt', 'F7', 'Fixture',
        ${`${contactId}@f705.test`}, ${`${contactId}@f705.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7.05 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, ${projectName}, 'fixture'
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
  const editorCalendarId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, membership_id, created_by)
      values (${editorCalendarId}::uuid, ${workspaceId}::uuid, 'Editor-Kalender',
              'user', ${editorMembershipId}::uuid, ${editorId}::uuid)
    `);
  });
  return {
    workspaceId, editorId, editorMembershipId, viewerId, externalId,
    projectId, projectName, editorCalendarId,
  };
}

// Seed über den echten Schreibpfad (Trigger-Guard verlangt Actor-Kontext;
// Berlin-Wanduhr ohne Offset, vgl. M1-15b ADR 0021 E6).
async function seedAppointment(
  fixture: Fixture,
  input: { title: string; start: string; end: string; attendee: boolean },
): Promise<string> {
  const result = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: fixture.projectId,
      title: input.title,
      start: input.start,
      end: input.end,
      allDay: false,
      type: "on_site",
      location: null,
      description: null,
      calendarId: fixture.editorCalendarId,
      attendeeMembershipIds: input.attendee ? [fixture.editorMembershipId] : [],
      // F1-12: neues Pflichtfeld (ohne Team).
      teamId: null,
    }),
  );
  return result.appointmentId;
}

function boardOf(fixture: Fixture, userId: string, weekStart: string) {
  return withAuthorizedTenantOn(
    testPool, userId, fixture.workspaceId,
    (tx, ctx) => getPlanningBoard(tx, ctx, { weekStart }),
  );
}

describe("F7.05 Plantafel-Lesepfad (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace();
  });

  it("F705-DB-01: Wochenschnitt, Attendee-Zeile, Mittwoch normalisiert auf Montag", async () => {
    await seedAppointment(fixture, {
      title: "Montage Montag",
      start: "2026-09-07T10:00:00",
      end: "2026-09-07T11:00:00",
      attendee: true,
    });
    await seedAppointment(fixture, {
      title: "Folgewoche",
      start: "2026-09-14T10:00:00",
      end: "2026-09-14T11:00:00",
      attendee: true,
    });
    const board = await boardOf(fixture, fixture.editorId, "2026-09-09");

    expect(board.schemaVersion).toBe(PLANNING_BOARD_VERSION);
    expect(board.weekStart).toBe(MONDAY);
    expect(board.weekEnd).toBe("2026-09-13");
    const editorRow = board.rows.find((row) => row.membershipId === fixture.editorMembershipId);
    expect(editorRow).toBeDefined();
    expect(editorRow!.days).toHaveLength(7);
    const mondayCell = editorRow!.days[0]!;
    expect(mondayCell.date).toBe(MONDAY);
    expect(mondayCell.entries.map((entry) => entry.title)).toEqual(["Montage Montag"]);
    expect(mondayCell.entries[0]).toMatchObject({
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      calendarName: "Editor-Kalender",
    });
    // Folgewoche draußen; restliche Zellen leer.
    expect(editorRow!.days.slice(1).flatMap((day) => day.entries)).toEqual([]);
  });

  it("F705-DB-02: Mehrtag-Termin je Tag, Berlin- statt UTC-Schnitt", async () => {
    await seedAppointment(fixture, {
      title: "Mehrtägig",
      start: "2026-09-11T12:00:00",
      end: "2026-09-13T12:00:00",
      attendee: true,
    });
    // Wanduhr-Montag 00:30 (MESZ = UTC-Sonntag 22:30): gehört auf Montag,
    // nicht auf den UTC-Sonntag.
    await seedAppointment(fixture, {
      title: "Grenzgänger",
      start: "2026-09-07T00:30:00",
      end: "2026-09-07T01:30:00",
      attendee: true,
    });
    const board = await boardOf(fixture, fixture.editorId, MONDAY);
    const editorRow = board.rows.find((row) => row.membershipId === fixture.editorMembershipId)!;

    const titlesOf = (index: number) => editorRow.days[index]!.entries.map((e) => e.title);
    expect(titlesOf(0)).toEqual(["Grenzgänger"]);
    expect(titlesOf(4)).toEqual(["Mehrtägig"]);
    expect(titlesOf(5)).toEqual(["Mehrtägig"]);
    expect(titlesOf(6)).toEqual(["Mehrtägig"]);
  });

  it("F705-DB-03: ohne Attendees in Sammelzeile, ungültige Woche wirft", async () => {
    await seedAppointment(fixture, {
      title: "Unzugeordnet",
      start: "2026-09-08T10:00:00",
      end: "2026-09-08T11:00:00",
      attendee: false,
    });
    const board = await boardOf(fixture, fixture.viewerId, MONDAY);
    const unassigned = board.rows.find((row) => row.membershipId === null);
    expect(unassigned?.label).toBe("Ohne Zuordnung");
    expect(unassigned!.days[1]!.entries.map((entry) => entry.title)).toEqual(["Unzugeordnet"]);

    await expect(boardOf(fixture, fixture.viewerId, "kein-datum")).rejects
      .toBeInstanceOf(AppointmentValidationError);
    await expect(boardOf(fixture, fixture.viewerId, "2026-02-30")).rejects
      .toBeInstanceOf(AppointmentValidationError);
  });

  it("F705-DB-05: Projektoptionen für Editor und Viewer", async () => {
    for (const userId of [fixture.editorId, fixture.viewerId]) {
      const options = await withAuthorizedTenantOn(
        testPool, userId, fixture.workspaceId,
        (tx, ctx) => listAppointmentProjectOptions(tx, ctx),
      );
      expect(options).toEqual([{ id: fixture.projectId, name: fixture.projectName }]);
    }
  });

  it("F705-DB-06: Anlage-Roundtrip — erstellter Termin steht auf der Tafel", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "create_appointment",
        projectId: fixture.projectId,
        title: "Neu von der Tafel",
        start: "2026-09-09T14:00:00",
        end: "2026-09-09T15:00:00",
        allDay: false,
        type: "consultation",
        location: null,
        description: null,
        calendarId: fixture.editorCalendarId,
        attendeeMembershipIds: [fixture.editorMembershipId],
        // F1-12: neues Pflichtfeld (ohne Team).
        teamId: null,
      }),
    );
    const board = await boardOf(fixture, fixture.editorId, MONDAY);
    const editorRow = board.rows.find((row) => row.membershipId === fixture.editorMembershipId)!;
    expect(editorRow.days[2]!.entries.map((entry) => entry.title)).toEqual(["Neu von der Tafel"]);

    // Fail-closed: Ende vor Beginn verweigert der echte Pfad.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "create_appointment",
        projectId: fixture.projectId,
        title: "Ungültig",
        start: "2026-09-09T15:00:00",
        end: "2026-09-09T14:00:00",
        allDay: false,
        type: "consultation",
        location: null,
        description: null,
        calendarId: fixture.editorCalendarId,
        attendeeMembershipIds: [fixture.editorMembershipId],
        // F1-12: neues Pflichtfeld (ohne Team).
        teamId: null,
      }),
    )).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("F705-DB-04: Viewer liest, External bleibt fail-closed", async () => {
    await seedAppointment(fixture, {
      title: "Sichtbar",
      start: "2026-09-08T10:00:00",
      end: "2026-09-08T11:00:00",
      attendee: true,
    });
    const viewerBoard = await boardOf(fixture, fixture.viewerId, MONDAY);
    expect(viewerBoard.rows.length).toBeGreaterThan(0);

    await expect(boardOf(fixture, fixture.externalId, MONDAY)).rejects
      .toBeInstanceOf(PermissionDeniedError);
  });
});
