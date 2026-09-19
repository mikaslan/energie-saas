// F1-12-Folgenachweis S2 (T9): validateCalendar prüft team.active (PostgreSQL).
// Lücke (DISCOVERED): Termine waren auf Kalendern archivierter Teams buchbar,
// inkonsistent zum F1-12-`validateTeam`. Fix: type=team ⇒ Team aktiv, sonst
// `invalid`. Lesen bleibt unverändert (Historie lesbar).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import {
  AppointmentValidationError,
  createTeamCalendar,
  executeProjectAppointmentCommand,
  getPlanningBoard,
  listProjectAppointments,
} from "@/modules/calendar";
import { createTeam, setTeamActive, setTeamMembers } from "@/modules/teams";
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F112 S2 Nachweis')`);
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F112 S2', 'F', 'X', ${`${contactId}@${emailDomain}`}, ${`${contactId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F112 S2 Site')
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${adminId}::uuid)
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F112 S2 Projekt', 'manual'
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

describe("F1-12-Folgenachweis S2: Team-Kalender nur bei aktivem Team buchbar (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f112-s2.test");
  });

  const asAdmin = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  // Team mit Editor als Mitglied + Team-Kalender (Editor sieht ihn ⇒
  // Sichtbarkeit scheidet als Ablehnungsgrund aus; nur team.active zählt).
  const setupTeamCalendar = async () => {
    const team = await asAdmin(async (tx, ctx) => {
      const created = await createTeam(tx, ctx, { name: "S2-Team" });
      await setTeamMembers(tx, ctx, { id: created.id, membershipIds: [fixture.editorMembershipId] });
      return created;
    });
    const calendar = await asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: team.id, name: "S2-Teamkalender",
    }));
    return { team, calendar };
  };

  const createOn = (calendarId: string, title = "Montage") =>
    asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: fixture.projectId,
      title,
      start: "2026-09-08T10:00:00",
      end: "2026-09-08T11:00:00",
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId,
      attendeeMembershipIds: [fixture.editorMembershipId],
      teamId: null,
    }));

  it("F112-S2-01: Buchen auf Kalender archivierten Teams → invalid (create + update)", async () => {
    const { team, calendar } = await setupTeamCalendar();
    // Vor Archivierung buchbar (Kontrolle).
    await createOn(calendar.id, "Vor Archiv");
    // Zweiter Termin auf Tenancy-Kalender für den Update-Pfad.
    const { appointmentId } = await createOn(fixture.tenancyCalendarId, "Umzugskandidat");

    await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      id: team.id, active: false, expectedRevision: 1,
    }));

    await expect(createOn(calendar.id, "Nach Archiv"))
      .rejects.toBeInstanceOf(AppointmentValidationError);
    await expect(asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "update_appointment",
      projectId: fixture.projectId,
      appointmentId,
      expectedRevision: 1,
      title: "Umzugskandidat",
      start: "2026-09-08T10:00:00",
      end: "2026-09-08T11:00:00",
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId: calendar.id,
      attendeeMembershipIds: [fixture.editorMembershipId],
      teamId: null,
    }))).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("F112-S2-02: Lesen bleibt — Historie auf archiviertem Team-Kalender lesbar", async () => {
    const { team, calendar } = await setupTeamCalendar();
    const { appointmentId } = await createOn(calendar.id, "Historie");

    await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      id: team.id, active: false, expectedRevision: 1,
    }));

    const range = await asEditor((tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: "2026-09-01",
      rangeEnd: "2026-09-30",
      view: "month",
    }));
    const item = range!.items.find((entry) => entry.id === appointmentId);
    expect(item).toMatchObject({
      title: "Historie",
      calendarId: calendar.id,
      calendarName: "S2-Teamkalender",
    });

    const board = await asEditor((tx, ctx) => getPlanningBoard(tx, ctx, { weekStart: MONDAY }));
    const entries = board.rows.flatMap((row) => row.days.flatMap((day) => day.entries));
    const boardEntry = entries.find((entry) => entry.id === appointmentId);
    expect(boardEntry).toMatchObject({
      title: "Historie",
      calendarName: "S2-Teamkalender",
    });
  });

  it("F112-S2-03: Reaktiviertes Team → Team-Kalender wieder buchbar", async () => {
    const { team, calendar } = await setupTeamCalendar();
    const archived = await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      id: team.id, active: false, expectedRevision: 1,
    }));
    expect(archived.active).toBe(false);

    const restored = await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      id: team.id, active: true, expectedRevision: 2,
    }));
    expect(restored.active).toBe(true);

    const created = await createOn(calendar.id, "Nach Reaktivierung");
    expect(created.changed).toBe(true);
    expect(created.revision).toBe(1);
  });
});
