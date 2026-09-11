// F1-12 Teams (PostgreSQL): Stammdaten + Termin-Bindung.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import { executeProjectAppointmentCommand, listProjectAppointments } from "@/modules/calendar";
import { AppointmentValidationError } from "@/modules/calendar/errors";
import {
  createTeam,
  listTeamOptions,
  listTeams,
  renameTeam,
  setTeamActive,
  setTeamMembers,
  TeamConflictError,
  TeamNotFoundError,
  TeamValidationError,
} from "@/modules/teams";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  adminId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  viewerMembershipId: string;
  tenancyCalendarId: string;
};

async function seedFixture(emailDomain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const adminId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();
  const viewerMembershipId = randomUUID();
  const tenancyCalendarId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1012 Teams')`);
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
             (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1012', 'F', 'X', 'c@f1012.test', 'c@f1012.test')
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1012 Site')
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${adminId}::uuid)
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, 'F1012 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return {
    workspaceId, projectId, adminId, editorId, editorMembershipId,
    viewerId, viewerMembershipId, tenancyCalendarId,
  };
}

describe("F1-12 Teams (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f1012.test");
  });

  const asAdmin = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  const asViewer = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.viewerId, fixture.workspaceId, fn as never) as Promise<T>;

  it("F1012-DB-01: CRUD, Revision-CAS, Archiv statt Delete", async () => {
    const created = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Montageteam Nord" }));
    expect(created.active).toBe(true);
    expect(created.revision).toBe(1);
    expect(created.members).toEqual([]);

    // Doppelter Name (case-insensitiv) → Konflikt.
    await expect(asAdmin((tx, ctx) =>
      createTeam(tx, ctx, { name: "  MONTAGETEAM nord " }))).rejects.toBeInstanceOf(TeamConflictError);
    // Leertext → Validation.
    await expect(asAdmin((tx, ctx) =>
      createTeam(tx, ctx, { name: "   " }))).rejects.toBeInstanceOf(TeamValidationError);

    const renamed = await asAdmin((tx, ctx) =>
      renameTeam(tx, ctx, { id: created.id, name: "Team Nord", expectedRevision: 1 }));
    expect(renamed.name).toBe("Team Nord");
    expect(renamed.revision).toBe(2);
    // Veraltete Revision → Konflikt.
    await expect(asAdmin((tx, ctx) =>
      renameTeam(tx, ctx, { id: created.id, name: "Stale", expectedRevision: 1 }))).rejects.toBeInstanceOf(
      TeamConflictError,
    );
    // Unbekanntes Team → NotFound (kein Orakel-Leak: gleiche Klasse für fremde IDs).
    await expect(asAdmin((tx, ctx) =>
      renameTeam(tx, ctx, { id: randomUUID(), name: "X", expectedRevision: 1 }))).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );

    const archived = await asAdmin((tx, ctx) =>
      setTeamActive(tx, ctx, { id: created.id, active: false, expectedRevision: 2 }));
    expect(archived.active).toBe(false);
    // Gleicher Name nach Archivierung wieder frei.
    const recreated = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Team Nord" }));
    expect(recreated.id).not.toBe(created.id);
  });

  it("F1012-DB-02: Mitglieder (nur intern), RBAC, Mandantentrennung", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Team Süd" }));
    const withMembers = await asAdmin((tx, ctx) =>
      setTeamMembers(tx, ctx, { id: team.id, membershipIds: [fixture.editorMembershipId] }));
    expect(withMembers.members).toHaveLength(1);
    expect(withMembers.members[0]?.membershipId).toBe(fixture.editorMembershipId);
    // Unbekannte Membership → Validation (kein stiller Ausschluss).
    await expect(asAdmin((tx, ctx) =>
      setTeamMembers(tx, ctx, { id: team.id, membershipIds: [randomUUID()] }))).rejects.toBeInstanceOf(
      TeamValidationError,
    );
    // Editor/Viewer verwalten nicht (settings.manage = Admin).
    await expect(asEditor((tx, ctx) =>
      createTeam(tx, ctx, { name: "Nein" }))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer((tx, ctx) =>
      setTeamMembers(tx, ctx, { id: team.id, membershipIds: [] }))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    // Editor liest Optionen (Dialog-Kontext), Fremdmandant sieht nichts.
    const options = await asEditor((tx, ctx) => listTeamOptions(tx, ctx));
    expect(options.map((option) => option.name)).toContain("Team Süd");
    const foreign = await seedFixture("f1012-foreign.test");
    const foreignOptions = await withAuthorizedTenantOn(
      testPool, foreign.adminId, foreign.workspaceId,
      (tx, ctx) => listTeamOptions(tx, ctx),
    );
    expect(foreignOptions).toEqual([]);
    expect(await withAuthorizedTenantOn(
      testPool, foreign.adminId, foreign.workspaceId,
      (tx, ctx) => listTeams(tx, ctx),
    )).toEqual([]);
  });

  it("F1012-DB-03: Termin-Bindung (aktiv ok, Rest fail-closed, DTO-Projektion)", async () => {
    const team = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Team West" }));
    const create = (teamId: string | null) => asEditor((tx, ctx) =>
      executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "create_appointment",
        projectId: fixture.projectId,
        title: "Montage",
        start: "2026-09-10T10:00:00",
        end: "2026-09-10T12:00:00",
        allDay: false,
        type: "installation",
        location: null,
        description: null,
        calendarId: fixture.tenancyCalendarId,
        attendeeMembershipIds: [],
        teamId,
      }));
    const { appointmentId } = await create(team.id);
    const range = await asEditor((tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: "2026-09-01",
      rangeEnd: "2026-09-30",
      view: "month",
    }));
    const item = range!.items.find((entry) => entry.id === appointmentId);
    expect(item?.teamId).toBe(team.id);
    expect(item?.teamName).toBe("Team West");
    expect(range!.teams.map((option) => option.name)).toContain("Team West");

    // Fremdes Team, unbekanntes Team, archiviertes Team → fail-closed.
    const foreign = await seedFixture("f1012-foreign2.test");
    const foreignTeam = await withAuthorizedTenantOn(
      testPool, foreign.adminId, foreign.workspaceId,
      (tx, ctx) => createTeam(tx, ctx, { name: "Fremd" }),
    );
    await expect(create(foreignTeam.id)).rejects.toBeInstanceOf(AppointmentValidationError);
    await expect(create(randomUUID())).rejects.toBeInstanceOf(AppointmentValidationError);
    await asAdmin((tx, ctx) =>
      setTeamActive(tx, ctx, { id: team.id, active: false, expectedRevision: 1 }));
    await expect(create(team.id)).rejects.toBeInstanceOf(AppointmentValidationError);
    // Archiviertes Team bleibt am Termin lesbar, fehlt in den Optionen.
    const reread = await asEditor((tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: "2026-09-01",
      rangeEnd: "2026-09-30",
      view: "month",
    }));
    expect(reread!.items.find((entry) => entry.id === appointmentId)?.teamName).toBe("Team West");
    expect(reread!.teams).toEqual([]);
  });
});
