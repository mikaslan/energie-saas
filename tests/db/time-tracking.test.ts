import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
  type CreateTimeEventTypeCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEntry,
  archiveTimeEventType,
  createTimeEntry,
  createTimeEventType,
  listTimeEntries,
  listTimeEventTypes,
  restoreTimeEventType,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
  updateTimeEntry,
  updateTimeEventType,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  projectId: string;
  otherProjectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f901.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f901.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f901.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
  });
  const projectId = await seedProject(workspaceId, "F9 Projekt");
  const otherProjectId = await seedProject(workspaceId, "F9 Zweites Projekt");
  return { workspaceId, editorId, viewerId, adminId, projectId, otherProjectId };
}

async function seedProject(workspaceId: string, name: string): Promise<string> {
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${name}, 'F9', 'Fixture',
        ${`${contactId}@f901.test`}, ${`${contactId}@f901.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${name} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${name}, 'fixture'
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
  return projectId;
}

function eventTypeCommand(overrides: Partial<CreateTimeEventTypeCommand> = {}): CreateTimeEventTypeCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    name: "Montage",
    position: 0,
    textColor: "#FFFFFF",
    backgroundColor: "#3B82F6",
    ...overrides,
  };
}

function entryCommand(projectId: string, overrides: Partial<CreateTimeEntryCommand["fields"]> = {}): CreateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields: {
      typeId: null,
      startAt: "2026-09-04T08:00:00.000Z",
      endAt: "2026-09-04T10:00:00.000Z",
      workingTimeMinutes: 120,
      breakDurationMinutes: 0,
      comment: "Anlage installiert",
      ...overrides,
    },
  };
}

describe("F9.1 Zeiterfassung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9.1 Zeiterfassung");
  });

  it("F901-DB-01: Event-Typ CRUD happy path, Normalisierung, Sortierung nach Position", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand()),
    );
    expect(created.name).toBe("Montage");
    expect(created.textColor).toBe("#FFFFFF");
    expect(created.backgroundColor).toBe("#3B82F6");

    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand({ name: "Büro", position: 0 })),
    );
    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx),
    );
    // Position 0 zweimal → Name entscheidet (Büro < Montage).
    expect(list.map((t) => t.name)).toEqual(["Büro", "Montage"]);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEventType(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: second.id,
        name: "  Büroarbeit  ",
        position: 9,
        textColor: null,
        backgroundColor: null,
      }),
    );
    expect(updated.name).toBe("Büroarbeit");
    expect(updated.position).toBe(9);
    expect(updated.textColor).toBeNull();

    // Unbekannte Id → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEventType(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: randomUUID(),
        name: "neu",
        position: 0,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });

  it("F901-DB-02: Namenskollision aktiv; Name frei nach Archivierung; Restore-Konflikt", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand()),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand({ name: "MONTAGE" })),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEventType(tx, ctx, first.id),
    );
    const recreated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand({ name: "montage" })),
    );
    // Alter Typ wieder aktivieren → Konflikt mit neu vergebenem Namen.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreTimeEventType(tx, ctx, first.id),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    // Archivierte Typen sind per Default unsichtbar, mit Flag sichtbar.
    const active = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx),
    );
    expect(active.map((t) => t.id)).toEqual([recreated.id]);
    const all = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx, { includeArchived: true }),
    );
    expect(all).toHaveLength(2);
  });

  it("F901-DB-03: Zeiteintrag create/list/update/archive + Summe nur aktiver Einträge", async () => {
    const type = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand()),
    );
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, {
        typeId: type.id,
        breakDurationMinutes: 15,
      })),
    );
    expect(created.workingTimeMinutes).toBe(120);
    expect(created.breakDurationMinutes).toBe(15);
    expect(created.userId).toBe(fixture.editorId);
    expect(created.archivedAt).toBeNull();

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, {
        startAt: "2026-09-04T12:00:00.000Z",
        endAt: "2026-09-04T13:00:00.000Z",
        workingTimeMinutes: 60,
      })),
    );

    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(list.entries).toHaveLength(2);
    expect(list.totalWorkingMinutes).toBe(180);
    // Absteigend nach startAt.
    expect(list.entries[0]!.workingTimeMinutes).toBe(60);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: created.id,
        fields: entryCommand(fixture.projectId).fields,
      }),
    );
    expect(updated.comment).toBe("Anlage installiert");

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, created.id),
    );
    const afterArchive = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(afterArchive.entries).toHaveLength(1);
    expect(afterArchive.totalWorkingMinutes).toBe(60);
  });

  it("F901-DB-04: Validierung — Intervall, Minuten-Grenzen, Pause > Arbeitszeit, fremder Typ", async () => {
    const other = await seedWorkspace("F9.1 Fremd");
    const foreignType = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand()),
    );

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, {
        startAt: "2026-09-04T10:00:00.000Z",
        endAt: "2026-09-04T08:00:00.000Z",
      })),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, {
        workingTimeMinutes: 2000,
      })),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, {
        workingTimeMinutes: 60,
        breakDurationMinutes: 90,
      })),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    // Fremder Event-Typ (anderer Workspace) → FK/Validierungsfehler.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId, {
        typeId: foreignType.id,
      })),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });

  it("F901-DB-05: Cross-Workspace-Isolation + Viewer schreib-blockiert", async () => {
    const other = await seedWorkspace("F9.1 Fremd-Workspace");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand()),
    );

    const foreignList = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx, { includeArchived: true }),
    );
    expect(foreignList).toHaveLength(0);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, eventTypeCommand({ name: "viewer" })),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremder Workspace sieht keine Einträge des Projekts (RLS).
    const foreignEntries = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(foreignEntries.entries).toHaveLength(0);
    expect(foreignEntries.totalWorkingMinutes).toBe(0);
  });

  it("F901-DB-04b: DB-CHECKs — Steuerzeichen-Kommentar, ungültige Farbe, Update mit invaliden Feldern (Kimi-P2-3)", async () => {
    // Direkter Insert am CHECK vorbei erzwingt 23514 (Service-Zod fängt
    // dieselben Fälle bereits ab — hier wird die DB-Ebene selbst geprüft).
    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into time_event_type (workspace_id, name, name_normalized, background_color)
      values (${fixture.workspaceId}::uuid, 'rot', 'rot', 'rot')
    `))).rejects.toThrow();

    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into time_entry (
        workspace_id, user_id, project_id, start_at, end_at,
        working_time_minutes, comment, created_by
      ) values (
        ${fixture.workspaceId}::uuid, ${fixture.editorId}::uuid, ${fixture.projectId}::uuid,
        now() - interval '1 hour', now(), 30,
        ${`Zeile1\nZeile2`}, ${fixture.editorId}::uuid
      )
    `))).rejects.toThrow();

    // Update-Pfad mit invaliden Feldern (Kimi-P2-3).
    const entry = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(fixture.projectId)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: entry.id,
        fields: entryCommand(fixture.projectId, {
          startAt: "2026-09-04T12:00:00.000Z",
          endAt: "2026-09-04T11:00:00.000Z",
        }).fields,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: entry.id,
        fields: entryCommand(fixture.projectId, {
          workingTimeMinutes: 60,
          breakDurationMinutes: 120,
        }).fields,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });

  it("F901-DB-06: Eintrag nur für Projekt des eigenen Workspaces", async () => {
    const other = await seedWorkspace("F9.1 Projekt-Fremd");
    // otherWorkspace-Projekt aus Sicht von fixture referenzieren → FK schlägt fehl.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(other.projectId)),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });
});
