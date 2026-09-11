import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  AppointmentValidationError,
  createTeamCalendar,
  executeProjectAppointmentCommand,
  listVisibleCalendars,
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
};

async function seedFixture(emailDomain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1.13 Teamkalender')`);
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1.13', 'F', 'X', ${`${contactId}@${emailDomain}`}, ${`${contactId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1.13 Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F1.13 Projekt', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, adminId, editorId, editorMembershipId, viewerId, projectId };
}

describe("F1-13 Team-Kalender (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f1013.test");
  });

  const asAdmin = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  const makeTeam = (withEditor: boolean) =>
    asAdmin(async (tx, ctx) => {
      const team = await createTeam(tx, ctx, { name: "Kalender-Team" });
      if (withEditor) {
        await setTeamMembers(tx, ctx, { id: team.id, membershipIds: [fixture.editorMembershipId] });
      }
      return team;
    });

  it("F1013-DB-01: Anlage mit Team-Bindung, nur calendar.write", async () => {
    const team = await makeTeam(false);
    const created = await asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: team.id, name: "Team-Montage", color: "#10B981",
    }));
    expect(created).toMatchObject({
      name: "Team-Montage", color: "#10B981", type: "team",
      teamId: team.id, teamName: "Kalender-Team",
    });
    // Editor verwaltet keine Kalender (calendar.write = Admin).
    await expect(asEditor((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: team.id, name: "Nein",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F1013-DB-02: Sichtbarkeit nur für Mitglieder (+ Admin)", async () => {
    const team = await makeTeam(true);
    await asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: team.id, name: "Team-Montage",
    }));

    const editorCals = await asEditor((tx, ctx) => listVisibleCalendars(tx, ctx));
    const mine = editorCals.find((calendar) => calendar.type === "team");
    expect(mine).toMatchObject({ name: "Team-Montage", teamId: team.id, teamName: "Kalender-Team" });

    // Fremder Workspace sieht nichts; Tenancy-Einträge tragen keine Team-Bindung.
    const other = await seedFixture("f1013-fremd.test");
    const foreign = await withAuthorizedTenantOn(
      testPool, other.adminId, other.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    expect(foreign.find((calendar) => calendar.type === "team")).toBeUndefined();
    for (const calendar of editorCals.filter((entry) => entry.type !== "team")) {
      expect(calendar.teamId).toBeNull();
      expect(calendar.teamName).toBeNull();
    }
  });

  it("F1013-DB-03: Termine auf Teamkalender für Mitglieder buchbar", async () => {
    const team = await makeTeam(true);
    const calendar = await asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: team.id, name: "Team-Montage",
    }));
    const created = await asEditor((tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: fixture.projectId,
      title: "Montage",
      start: "2026-09-08T10:00:00",
      end: "2026-09-08T11:00:00",
      allDay: false,
      type: "installation",
      location: null,
      description: null,
      calendarId: calendar.id,
      attendeeMembershipIds: [fixture.editorMembershipId],
      teamId: null,
    }));
    expect(created.appointmentId).toBeDefined();
  });

  it("F1013-DB-04: fremd/archiviert/unbekannt/deform fail-closed", async () => {
    const team = await makeTeam(false);
    // Fremdes Team (anderer Workspace) → Validation, kein Orakel.
    const other = await seedFixture("f1013-fremd.test");
    const foreignTeam = await withAuthorizedTenantOn(
      testPool, other.adminId, other.workspaceId,
      (tx, ctx) => createTeam(tx, ctx, { name: "Fremd-Team" }),
    );
    await expect(asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: foreignTeam.id, name: "Nein",
    }))).rejects.toBeInstanceOf(AppointmentValidationError);
    // Archiviert → Validation.
    await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      id: team.id, active: false, expectedRevision: 1,
    }));
    await expect(asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: team.id, name: "Nein",
    }))).rejects.toBeInstanceOf(AppointmentValidationError);
    // Unbekannt + deform → Validation (kein PG-Fehlerleak).
    await expect(asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: randomUUID(), name: "Nein",
    }))).rejects.toBeInstanceOf(AppointmentValidationError);
    await expect(asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: "keine-uuid", name: "Nein",
    }))).rejects.toBeInstanceOf(AppointmentValidationError);
    await expect(asAdmin((tx, ctx) => createTeamCalendar(tx, ctx, {
      teamId: null, name: "Nein",
    }))).rejects.toBeInstanceOf(AppointmentValidationError);
  });
});
