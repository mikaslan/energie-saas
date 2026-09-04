import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PROJECT_APPOINTMENT_COMMAND_VERSION } from "@/lib/integrations/calendar/contract";
import { executeProjectAppointmentCommand } from "@/modules/calendar";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import {
  createPortalInvite,
  PortalNotFoundError,
  resolvePortalByToken,
  withdrawPortalInvite,
} from "@/modules/portal";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  projectId: string;
  tenancyCalendarId: string;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const tenancyCalendarId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1002.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${`${contactId}@f1002.test`}, ${`${contactId}@f1002.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${label} Site`})
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${editorId}::uuid)
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
  return { workspaceId, editorId, editorMembershipId, projectId, tenancyCalendarId };
}

async function createInvite(fixture: Fixture) {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createPortalInvite(tx, ctx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      ttlDays: 14,
    }),
  );
}

async function createAppointment(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: fixture.projectId,
      title: "Vor-Ort-Termin",
      start: "2026-09-10T10:00:00",
      end: "2026-09-10T11:00:00",
      allDay: false,
      type: "on_site",
      location: "Musterstraße 1",
      description: "Interne Notiz — nie öffentlich",
      calendarId: fixture.tenancyCalendarId,
      attendeeMembershipIds: [fixture.editorMembershipId],
      ...overrides,
    }),
  );
}

describe("F10.2 Termine-Tab (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F10.2 ${randomUUID()}`);
  });

  it("F1002-DB-01: Resolve projiziert Termin ohne Description", async () => {
    const invite = await createInvite(fixture);
    await createAppointment(fixture);
    const view = await resolvePortalByToken(testPool, { token: invite.token });
    expect(view.appointments).toHaveLength(1);
    const appointment = view.appointments[0]!;
    expect(appointment.title).toBe("Vor-Ort-Termin");
    // Wanduhr 10:00 Berlin (September = +02:00) → Parser normiert auf UTC.
    expect(appointment.startAt).toBe("2026-09-10T08:00:00.000Z");
    expect(appointment.endAt).toBe("2026-09-10T09:00:00.000Z");
    expect(appointment.allDay).toBe(false);
    expect(appointment.appointmentType).toBe("on_site");
    expect(appointment.location).toBe("Musterstraße 1");
    expect(appointment).not.toHaveProperty("description");
  });

  it("F1002-DB-02: ohne Termin leeres Array, Withdraw bleibt not_found", async () => {
    const invite = await createInvite(fixture);
    const empty = await resolvePortalByToken(testPool, { token: invite.token });
    expect(empty.appointments).toEqual([]);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId: invite.inviteId,
        reason: "user_request",
      }),
    );
    await expect(resolvePortalByToken(testPool, { token: invite.token }))
      .rejects.toBeInstanceOf(PortalNotFoundError);
  });
});
