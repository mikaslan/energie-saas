import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentValidationError,
  executeProjectAppointmentCommand,
  listProjectAppointments,
  type ProjectAppointmentCommandV1,
} from "@/modules/calendar";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  contactId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  viewerMembershipId: string;
  externalId: string;
  tenancyCalendarId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();
  const viewerMembershipId = randomUUID();
  const externalId = randomUUID();
  const tenancyCalendarId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M1-15 Calendar')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m115.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m115.test`}),
        (${externalId}::uuid, ${`external-${externalId}@m115.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'admin', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'M115-CUSTOMER', 'M115', 'Customer', 'c@m115.test', 'c@m115.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'M115 Site')`);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${editorId}::uuid)
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'M115 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return {
    workspaceId,
    projectId,
    contactId,
    editorId,
    editorMembershipId,
    viewerId,
    viewerMembershipId,
    externalId,
    tenancyCalendarId,
  };
}

function createCommand(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): ProjectAppointmentCommandV1 {
  return {
    schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
    kind: "create_appointment",
    projectId: fixture.projectId,
    title: "Beratung",
    start: "2026-07-01T10:00:00",
    end: "2026-07-01T11:00:00",
    allDay: false,
    type: "on_site",
    location: "Musterstraße 1",
    description: "Erstgespräch",
    calendarId: fixture.tenancyCalendarId,
    attendeeMembershipIds: [fixture.editorMembershipId],
    ...overrides,
  } as ProjectAppointmentCommandV1;
}

async function createAppointment(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, createCommand(fixture, overrides)),
  );
}

async function listAppointments(fixture: Fixture, actorId: string) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: "2025-07-01T00:00:00",
      rangeEnd: "2027-07-01T00:00:00",
      view: "month",
    }),
  );
}

describe("M1-15 Termine/Kalender-Service (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("legt Termine an, liest sie mit Teilnehmern und sortiert nach Start", async () => {
    await createAppointment(fixture, { start: "2026-07-02T10:00:00", end: "2026-07-02T11:00:00", title: "Später" });
    await createAppointment(fixture, { start: "2026-07-01T10:00:00", end: "2026-07-01T11:00:00", title: "Früher" });

    const range = await listAppointments(fixture, fixture.editorId);
    expect(range?.items.map((item) => item.title)).toEqual(["Früher", "Später"]);
    expect(range?.items[0]?.attendees).toEqual([
      { membershipId: fixture.editorMembershipId, label: `editor-${fixture.editorId}@m115.test` },
    ]);
    expect(range?.permissions.canWrite).toBe(true);
    expect(range?.members).toHaveLength(2);
  });

  it("editiert und löscht mit Revision + CAS und Hard-Delete", async () => {
    await createAppointment(fixture);
    const range = await listAppointments(fixture, fixture.editorId);
    const appointment = range!.items[0]!;

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "update_appointment",
        projectId: fixture.projectId,
        appointmentId: appointment.id,
        expectedRevision: 1,
        title: "Bearbeitet",
        start: "2026-07-03T09:00:00",
        end: "2026-07-03T10:00:00",
        allDay: false,
        type: "phone",
        location: null,
        description: null,
        calendarId: fixture.tenancyCalendarId,
        attendeeMembershipIds: [],
      }),
    );
    expect(updated.revision).toBe(2);

    const afterEdit = await listAppointments(fixture, fixture.editorId);
    expect(afterEdit!.items[0]!.title).toBe("Bearbeitet");
    expect(afterEdit!.items[0]!.revision).toBe(2);
    expect(afterEdit!.items[0]!.attendees).toEqual([]);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "delete_appointment",
        projectId: fixture.projectId,
        appointmentId: appointment.id,
        expectedRevision: 2,
      }),
    );

    const afterDelete = await listAppointments(fixture, fixture.editorId);
    expect(afterDelete!.items).toEqual([]);

    // Hard-Delete: die Zeile ist physisch weg, Event und Audit bleiben erhalten.
    const counts = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const rows = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from project_appointment
         where workspace_id = ${fixture.workspaceId}::uuid
      `);
      const events = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and event_type = 'project.appointment_deleted'
      `);
      const audits = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'appointment.write' and resource = 'project_appointment'
      `);
      return { rows: rows.rows[0]!.count, events: events.rows[0]!.count, audits: audits.rows[0]!.count };
    });
    expect(counts.rows).toBe(0);
    expect(counts.events).toBe(1);
    expect(counts.audits).toBe(3);
  });

  it("meldet Revisionskonflikte für Edit und Delete", async () => {
    const created = await createAppointment(fixture);
    for (const kind of ["update_appointment", "delete_appointment"] as const) {
      const command: ProjectAppointmentCommandV1 = kind === "update_appointment"
        ? {
            schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
            kind,
            projectId: fixture.projectId,
            appointmentId: created.appointmentId,
            expectedRevision: 99,
            title: "X",
            start: "2026-07-01T10:00:00",
            end: "2026-07-01T11:00:00",
            allDay: false,
            type: "phone",
            location: null,
            description: null,
            calendarId: fixture.tenancyCalendarId,
            attendeeMembershipIds: [],
          }
        : {
            schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
            kind,
            projectId: fixture.projectId,
            appointmentId: created.appointmentId,
            expectedRevision: 99,
          };
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, command),
      )).rejects.toBeInstanceOf(AppointmentConflictError);
    }
  });

  it("behandelt gelöschte Termine als not_found", async () => {
    const created = await createAppointment(fixture);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "delete_appointment",
        projectId: fixture.projectId,
        appointmentId: created.appointmentId,
        expectedRevision: 1,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "delete_appointment",
        projectId: fixture.projectId,
        appointmentId: created.appointmentId,
        expectedRevision: 1,
      }),
    )).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });

  it("normalisiert Zeitzonen Europe/Berlin korrekt über DST (Round-Trip)", async () => {
    await createAppointment(fixture, { start: "2026-07-01T10:00:00", end: "2026-07-01T11:00:00" });
    await createAppointment(fixture, { start: "2026-01-15T10:00:00", end: "2026-01-15T11:00:00" });

    const range = await listAppointments(fixture, fixture.editorId);
    const summer = range!.items.find((item) => item.start.startsWith("2026-07-01"));
    const winter = range!.items.find((item) => item.start.startsWith("2026-01-15"));
    expect(summer?.start).toBe("2026-07-01T10:00:00.000");
    expect(winter?.start).toBe("2026-01-15T10:00:00.000");

    // Speicherung ist UTC: Sommer UTC+2, Winter UTC+1.
    const utc = await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
      const rows = await tx.execute<{ start_utc: string }>(sql`
        select to_char(start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') as start_utc
          from project_appointment
         where workspace_id = ${fixture.workspaceId}::uuid
         order by start_at
      `);
      return rows.rows.map((row) => row.start_utc);
    });
    expect(utc).toContain("2026-01-15T09:00:00.000");
    expect(utc).toContain("2026-07-01T08:00:00.000");
  });

  it("liefert Termine über die Range-Grenze (Überlappungsfilter)", async () => {
    await createAppointment(fixture, { start: "2026-07-01T10:00:00", end: "2026-07-01T11:00:00" });
    const outside = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
        rangeStart: "2026-08-01T00:00:00",
        rangeEnd: "2026-08-31T00:00:00",
        view: "month",
      }),
    );
    expect(outside?.items).toEqual([]);

    const boundary = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
        rangeStart: "2026-07-01T10:30:00",
        rangeEnd: "2026-07-02T00:00:00",
        view: "month",
      }),
    );
    expect(boundary?.items).toHaveLength(1);
  });

  it("Viewer liest, External wird abgewiesen (RLS + Service)", async () => {
    await createAppointment(fixture);
    const viewerRange = await listAppointments(fixture, fixture.viewerId);
    expect(viewerRange?.items).toHaveLength(1);
    expect(viewerRange?.permissions.canWrite).toBe(false);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, createCommand(fixture)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(listAppointments(fixture, fixture.externalId)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("Cross-Tenant-Lesen ist fail-closed", async () => {
    await createAppointment(fixture);
    const other = await seedFixture();
    const otherRange = await listAppointments(other, other.editorId);
    expect(otherRange?.items).toEqual([]);
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
        rangeStart: "2025-07-01T00:00:00",
        rangeEnd: "2027-07-01T00:00:00",
        view: "month",
      }),
    );
    expect(foreign).toBeNull();
  });

  it("lehnt ungültige Typen und Fenster serverseitig ab", async () => {
    await expect(createAppointment(fixture, { type: "nope" })).rejects.toBeInstanceOf(AppointmentValidationError);
    await expect(createAppointment(fixture, {
      start: "2026-07-01T11:00:00",
      end: "2026-07-01T10:00:00",
    })).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("verhindert im DB-Trigger frische Termin-Inserts nach Kontakterasure", async () => {
    const erasureTx = await testPool.connect();
    let committed = false;
    let waitingInsert: Promise<unknown> | undefined;
    try {
      await erasureTx.query("begin");
      await erasureTx.query(
        "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
        [fixture.workspaceId, fixture.editorId],
      );
      await erasureTx.query(
        "select id from project where workspace_id = $1::uuid and id = $2::uuid for update",
        [fixture.workspaceId, fixture.projectId],
      );
      await erasureTx.query(
        "update contact set deleted_at = statement_timestamp() where workspace_id = $1::uuid and id = $2::uuid",
        [fixture.workspaceId, fixture.contactId],
      );
      waitingInsert = withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, createCommand(fixture)),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await erasureTx.query("commit");
      committed = true;
    } finally {
      if (!committed) await erasureTx.query("rollback").catch(() => undefined);
      erasureTx.release();
    }
    if (!waitingInsert) throw new Error("M1-15 DB-Race-Insert wurde nicht gestartet");
    await expect(waitingInsert).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });

  it("akzeptiert Ganztag über die Frühjahrs-Umstellung (DST-Datumsebene)", async () => {
    await createAppointment(fixture, {
      allDay: true,
      start: "2026-03-29T00:00:00",
      end: "2026-03-30T00:00:00",
    });
    const range = await listAppointments(fixture, fixture.editorId);
    expect(range?.items).toHaveLength(1);
    expect(range?.items[0]?.allDay).toBe(true);
  });

  it("lehnt Wanduhrzeiten in der DST-Lücke serverseitig ab", async () => {
    await expect(createAppointment(fixture, {
      start: "2026-03-29T02:30:00",
      end: "2026-03-29T03:30:00",
    })).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("M1-15b P1-1: Termin-Items maskieren fremde persönliche Kalender (Name=null)", async () => {
    // Persönlicher Kalender des EDITORS + Termin darauf.
    const personalId = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, membership_id, created_by)
      values (${personalId}::uuid, ${fixture.workspaceId}::uuid,
        'Persönlich — editor@m115.test', 'user', ${fixture.editorMembershipId}::uuid,
        ${fixture.editorId}::uuid)
    `));
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "create_appointment",
        projectId: fixture.projectId,
        title: "Privattermin",
        start: "2026-07-01T12:00:00",
        end: "2026-07-01T13:00:00",
        allDay: false,
        type: "phone",
        location: null,
        description: null,
        calendarId: personalId,
        attendeeMembershipIds: [],
      }),
    );

    // Viewer liest die Range: Termin sichtbar, Kalender-Name MASKIERT.
    const range = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectAppointments(tx, ctx, fixture.projectId, {
        rangeStart: "2026-07-01T00:00:00",
        rangeEnd: "2026-07-02T00:00:00",
        view: "month",
      }),
    );
    expect(range).not.toBeNull();
    const item = range!.items.find((entry) => entry.title === "Privattermin");
    expect(item).toBeDefined();
    expect(item!.calendarId).toBe(personalId);
    expect(item!.calendarName).toBeNull();
    expect(item!.calendarColor).toBeNull();
  });

  it("validiert calendarId gegen den Workspace (unsichtbar → invalid, kein Scope-Leak)", async () => {
    await expect(createAppointment(fixture, {
      calendarId: "99999999-9999-4999-8999-999999999999",
    })).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("Erasure-Graph und Migration tragen appointmentIds (quellgepinnt)", async () => {
    const [erasureSchema, migration] = await Promise.all([
      readFile("lib/db/schema/erasure.ts", "utf8"),
      readFile("drizzle/0043_m1_15_appointments_calendar.sql", "utf8"),
    ]);
    expect(erasureSchema).toMatch(/appointmentIds\?: string\[\]/u);
    expect(migration).toContain("'appointmentIds'");
    expect(migration).toContain("operational_graph_document->'appointmentIds'");
    expect(migration).toContain("build_inactive_lead_erasure_graph_m115");
  });
});
