// F1-24 Kommunikations-Events im Projekt-Feed (PostgreSQL, RED).
// `project.appointment_created/updated` + `project.note_mentioned` werden in
// getProjectActivityPage projiziert (Guards: appointment.read auf sichtbarem
// Kalender, note.read; ohne Recht entfällt der Eintrag lautlos, Rest bleibt).
// ANNAHMEN (Spec docs/spec/F1-24-kommunikations-feed.md legt sie nicht fest):
// - Labels: "Termin erstellt" / "Termin bearbeitet" / "Erwähnung".
// - DB-03/DB-05 (SPEC-korrigiert): External bleibt denied (requireActivityRead
//   geschlossen, KEINE Berechtigungs-Erweiterung); Filter-Regeln belegen
//   DB-01/02/04 an Rollen mit Feed-Recht.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  executeProjectAppointmentCommand,
  type ProjectAppointmentCommandV1,
} from "@/modules/calendar";
import {
  PROJECT_NOTE_COMMAND_VERSION,
  executeProjectNoteCommand,
} from "@/modules/notes";
import {
  PROJECT_TASK_COMMAND_VERSION,
  executeProjectTaskCommand,
  getProjectActivityPage,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  viewerEmail: string;
  externalId: string;
  tenancyCalendarId: string;
  userCalendarId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();
  const viewerEmail = `viewer-${viewerId}@f124.test`;
  const externalId = randomUUID();
  const tenancyCalendarId = randomUUID();
  const userCalendarId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F124 Feed')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f124.test`}),
        (${viewerId}::uuid, ${viewerEmail}),
        (${externalId}::uuid, ${`external-${externalId}@f124.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'admin', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F124-CUSTOMER', 'F124', 'Customer', 'c@f124.test', 'c@f124.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F124 Site')`);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${editorId}::uuid)
    `);
    await tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by, membership_id)
      values (${userCalendarId}::uuid, ${workspaceId}::uuid, 'Persoenlich Editor', 'user', ${editorId}::uuid, ${editorMembershipId}::uuid)
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F124 Project', 'manual'
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
    editorId,
    editorMembershipId,
    viewerId,
    viewerEmail,
    externalId,
    tenancyCalendarId,
    userCalendarId,
  };
}

async function seedForeignReader(): Promise<{ workspaceId: string; userId: string }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F124 Fremd')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values (${userId}::uuid, ${`fremd-${userId}@f124.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${workspaceId}::uuid, ${userId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, userId };
}

async function createTask(fixture: Fixture, title: string): Promise<void> {
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
    executeProjectTaskCommand(tx, ctx, {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "quick_create",
      projectId: fixture.projectId,
      title,
    }));
}

function appointmentFields(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    projectId: fixture.projectId,
    title: "F124 Beratung",
    start: "2026-07-01T10:00:00",
    end: "2026-07-01T11:00:00",
    allDay: false,
    type: "on_site",
    location: "Musterstrasse 1",
    description: "Erstgespraech",
    calendarId: fixture.tenancyCalendarId,
    attendeeMembershipIds: [fixture.editorMembershipId],
    teamId: null,
    ...overrides,
  };
}

async function createAppointment(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      ...appointmentFields(fixture, overrides),
    } as ProjectAppointmentCommandV1),
  );
}

async function createNote(fixture: Fixture, textMarkdown: string) {
  return withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId: fixture.projectId,
      textMarkdown,
      pinned: false,
    }),
  );
}

async function readFeed(fixture: Fixture, actorId: string) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId),
  );
}

async function domainEventId(
  fixture: Fixture,
  eventType: "project.appointment_created" | "project.appointment_updated" | "project.note_mentioned",
): Promise<string | undefined> {
  const rows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      select id from domain_events
       where workspace_id = ${fixture.workspaceId}::uuid
         and aggregate_id = ${fixture.projectId}::uuid
         and event_type = ${eventType}
       order by occurred_at desc, id desc limit 1
    `);
    return result.rows;
  });
  return rows[0]?.id.toLowerCase();
}

describe("F1-24 Kommunikations-Feed (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("DB-01: Termin anlegen/aendern → appointment_created/updated mit Titel + Event-Link", async () => {
    await createTask(fixture, "F124 Baseline");
    const created = await createAppointment(fixture, { title: "F124 Beratungsgespraech" });
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "update_appointment",
        appointmentId: created.appointmentId,
        expectedRevision: created.revision,
        ...appointmentFields(fixture, { title: "F124 Beratungsgespraech v2" }),
      } as ProjectAppointmentCommandV1),
    );

    const page = await readFeed(fixture, fixture.viewerId);
    const kinds = (page?.items ?? []).map((item) => item.kind as string);
    expect(kinds).toContain("appointment_created");
    expect(kinds).toContain("appointment_updated");

    const createdItem = page?.items.find((item) => (item.kind as string) === "appointment_created");
    const updatedItem = page?.items.find((item) => (item.kind as string) === "appointment_updated");
    expect(createdItem?.label).toBe("Termin erstellt");
    expect(updatedItem?.label).toBe("Termin bearbeitet");
    // Link-Ziel Termin → ?event=: Feed-ID ist die Domain-Event-ID.
    expect(createdItem?.id).toBe(await domainEventId(fixture, "project.appointment_created"));
    expect(updatedItem?.id).toBe(await domainEventId(fixture, "project.appointment_updated"));
    // Titel minimal projiziert.
    expect(JSON.stringify(createdItem)).toContain("F124 Beratungsgespraech");
    expect(JSON.stringify(updatedItem)).toContain("F124 Beratungsgespraech v2");
  });

  it("DB-02: Mention schreiben → note_mentioned mit Notiz-Anker", async () => {
    await createTask(fixture, "F124 Baseline");
    const note = await createNote(fixture, `Bitte pruefen @${fixture.viewerEmail} F124`);

    const page = await readFeed(fixture, fixture.viewerId);
    const kinds = (page?.items ?? []).map((item) => item.kind as string);
    expect(kinds).toContain("note_created");
    expect(kinds).toContain("note_mentioned");

    const mentioned = page?.items.find((item) => (item.kind as string) === "note_mentioned");
    expect(mentioned?.label).toBe("Erwähnung");
    expect(mentioned?.id).toBe(await domainEventId(fixture, "project.note_mentioned"));
    // Link-Ziel Erwaehnung → Notiz-Anker: Notiz-ID minimal projiziert.
    expect(JSON.stringify(mentioned)).toContain(note.noteId.toLowerCase());
  });

  it("DB-03: External bleibt denied (keine Feed-Oeffnung durch F1-24)", async () => {
    await createTask(fixture, "F124 Baseline");
    await createAppointment(fixture, { title: "F124 Interner Termin" });

    await expect(readFeed(fixture, fixture.externalId)).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("DB-04: Termin auf unsichtbarem Kalender → kein Eintrag fuer Viewer, Rest da", async () => {
    await createTask(fixture, "F124 Baseline");
    await createAppointment(fixture, {
      title: "F124 Privat",
      calendarId: fixture.userCalendarId,
    });

    const page = await readFeed(fixture, fixture.viewerId);
    const kinds = (page?.items ?? []).map((item) => item.kind as string);
    expect(kinds).not.toContain("appointment_created");
    expect(kinds).toContain("task_created");
  });

  it("DB-05: External bleibt denied (keine Mention-Oeffnung durch F1-24)", async () => {
    await createTask(fixture, "F124 Baseline");
    await createNote(fixture, `Bitte pruefen @${fixture.viewerEmail} F124`);

    await expect(readFeed(fixture, fixture.externalId)).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("DB-06: Fremdtenant liest leeren Feed (null)", async () => {
    await createTask(fixture, "F124 Baseline");
    await createAppointment(fixture, { title: "F124 Beratung" });
    const foreign = await seedForeignReader();

    const page = await withAuthorizedTenantOn(
      testPool,
      foreign.userId,
      foreign.workspaceId,
      (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId),
    );
    expect(page).toBeNull();
  });
});
