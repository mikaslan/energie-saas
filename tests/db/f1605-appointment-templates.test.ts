import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  applyAppointmentTemplate,
  archiveAppointmentTemplate,
  APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
  createAppointmentTemplate,
  listAppointmentTemplates,
  listProjectAppointments,
  restoreAppointmentTemplate,
  AppointmentTemplateConflictError,
  AppointmentTemplateNotFoundError,
  AppointmentTemplateValidationError,
} from "@/modules/calendar";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  viewerId: string;
  calendarId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const calendarId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F16-05 Templates')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1605.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1605.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1605-CUSTOMER', 'Fixture', 'Contact', 'c@f1605.test', 'c@f1605.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1605 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1605 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${calendarId}::uuid, ${workspaceId}::uuid, 'F1605 Kalender', 'tenancy', ${editorId}::uuid)
    `);
  });

  return { workspaceId, projectId, editorId, viewerId, calendarId };
}

async function apply(
  fixture: Fixture,
  userId: string,
  input: { templateId: string; calendarId?: string; start?: string; projectId?: string },
) {
  return withAuthorizedTenantOn(testPool, userId, fixture.workspaceId, (tx, ctx) =>
    applyAppointmentTemplate(tx, ctx, {
      schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
      templateId: input.templateId,
      projectId: input.projectId ?? fixture.projectId,
      calendarId: input.calendarId ?? fixture.calendarId,
      start: input.start ?? "2026-09-04T08:00",
    }),
  );
}

async function readAppointment(
  userId: string,
  fixture: Fixture,
  appointmentId: string,
) {
  return withAuthorizedTenantOn(testPool, userId, fixture.workspaceId, async (tx, ctx) => {
    const range = await listProjectAppointments(tx, ctx, fixture.projectId, {
      rangeStart: "2026-01-01T00:00:00",
      rangeEnd: "2027-01-01T00:00:00",
      view: "month",
    });
    const found = range?.items.find((item) => item.id === appointmentId);
    if (!found) throw new Error(`appointment ${appointmentId} not found`);
    return found;
  });
}

describe("F16-05 Termin-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1605-DB-01: Anlage → Liste (canWrite je Rolle) → Anwenden mit Titel/Dauer", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "Vor-Ort-Termin",
        title: "Dachbesichtigung",
        durationMinutes: 90,
      }),
    );
    expect(created.name).toBe("Vor-Ort-Termin");
    expect(created.title).toBe("Dachbesichtigung");
    expect(created.durationMinutes).toBe(90);
    expect(created.active).toBe(true);
    expect(created.permissions.canWrite).toBe(true);

    const editorList = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listAppointmentTemplates(tx, ctx),
    );
    expect(editorList).toHaveLength(1);

    const viewerList = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listAppointmentTemplates(tx, ctx),
    );
    expect(viewerList).toHaveLength(1);
    expect(viewerList[0]!.permissions.canWrite).toBe(false);

    const applied = await apply(fixture, fixture.editorId, { templateId: created.id });
    expect(applied.projectId).toBe(fixture.projectId);
    expect(applied.templateId).toBe(created.id);

    const appointment = await readAppointment(fixture.editorId, fixture, applied.appointmentId);
    expect(appointment.title).toBe("Dachbesichtigung");
    expect(appointment.start).toBe("2026-09-04T08:00:00.000");
    // Ende = Start + 90 Minuten (Berliner Wanduhr).
    expect(appointment.end).toBe("2026-09-04T09:30:00.000");
    expect(appointment.allDay).toBe(false);
  });

  it("F1605-DB-02: Duplikat (normalisiert) → Konflikt; ungültige Eingaben fail-closed", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "Test Termin",
        title: "Titel",
        durationMinutes: 60,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "  TEST termin ",
        title: "Anderer Titel",
        durationMinutes: 60,
      }),
    )).rejects.toBeInstanceOf(AppointmentTemplateConflictError);

    const bad = [
      { name: "   ", title: "Titel", durationMinutes: 60 },
      { name: "Gültig", title: "Titel", durationMinutes: 0 },
      { name: "Gültig", title: "Titel", durationMinutes: 2881 },
    ];
    for (const input of bad) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => createAppointmentTemplate(tx, ctx, {
          schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
          ...input,
        }),
      )).rejects.toBeInstanceOf(AppointmentTemplateValidationError);
    }

    // DST-Lücke (2026-03-29 02:30 existiert in Europe/Berlin nicht).
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "DST-Test",
        title: "DST-Titel",
        durationMinutes: 60,
      }),
    );
    await expect(apply(fixture, fixture.editorId, {
      templateId: template.id,
      start: "2026-03-29T02:30",
    })).rejects.toBeInstanceOf(AppointmentTemplateValidationError);
  });

  it("F1605-DB-03: Viewer ohne appointment.write fail-closed; Archiv sperrt Anwenden; Restore hebt auf", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "Archiv-Test",
        title: "Archiv-Titel",
        durationMinutes: 30,
      }),
    );

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "Viewer-Versuch",
        title: "Titel",
        durationMinutes: 30,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(apply(fixture, fixture.viewerId, { templateId: created.id }))
      .rejects.toBeInstanceOf(PermissionDeniedError);

    const archived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        active: false,
      }),
    );
    expect(archived.active).toBe(false);

    const hidden = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listAppointmentTemplates(tx, ctx),
    );
    expect(hidden).toHaveLength(0);

    await expect(apply(fixture, fixture.editorId, { templateId: created.id }))
      .rejects.toBeInstanceOf(AppointmentTemplateNotFoundError);

    const restored = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        active: true,
      }),
    );
    expect(restored.active).toBe(true);

    const applied = await apply(fixture, fixture.editorId, { templateId: created.id });
    const appointment = await readAppointment(fixture.editorId, fixture, applied.appointmentId);
    expect(appointment.title).toBe("Archiv-Titel");
    expect(appointment.end).toBe("2026-09-04T08:30:00.000");
  });

  it("F1605-DB-04: Unbekannte/fremde Vorlage, fremder Kalender, fremdes Projekt → NotFound", async () => {
    await expect(apply(fixture, fixture.editorId, { templateId: randomUUID() }))
      .rejects.toBeInstanceOf(AppointmentTemplateNotFoundError);

    const other = await seedFixture();
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "Fremde Vorlage",
        title: "Fremd",
        durationMinutes: 60,
      }),
    );
    await expect(apply(fixture, fixture.editorId, { templateId: foreign.id }))
      .rejects.toBeInstanceOf(AppointmentTemplateNotFoundError);

    const own = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        name: "Eigene Vorlage",
        title: "Eigen",
        durationMinutes: 60,
      }),
    );
    await expect(apply(fixture, fixture.editorId, {
      templateId: own.id,
      calendarId: other.calendarId,
    })).rejects.toBeInstanceOf(AppointmentTemplateValidationError);
    await expect(apply(fixture, fixture.editorId, {
      templateId: own.id,
      projectId: other.projectId,
    })).rejects.toBeInstanceOf(AppointmentTemplateNotFoundError);
  });
});
