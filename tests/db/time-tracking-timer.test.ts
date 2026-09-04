import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type StartTimeEntryCommand,
  type StopTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  discardTimeEntry,
  listTimeEntries,
  startTimeEntry,
  stopTimeEntry,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f902.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f902.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.2 Projekt', 'F9', 'Zwei',
        ${`${contactId}@f902.test`}, ${`${contactId}@f902.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.2 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F9.2 Projekt', 'fixture'
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
  return { workspaceId, editorId, viewerId, projectId };
}

function startCommand(projectId: string): StartTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    typeId: null,
    comment: "Timer",
  };
}

function stopCommand(id: string, minutes = 90): StopTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id,
    workingTimeMinutes: minutes,
    breakDurationMinutes: 0,
    comment: "Timer",
  };
}

describe("F9.2 Stoppuhr (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9.2 Timer");
  });

  it("F902-DB-01: start → running-DTO zuerst; stop setzt Ende + Minuten", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    expect(running.running).toBe(true);
    expect(running.endAt).toBeNull();
    expect(running.workingTimeMinutes).toBeNull();

    const list = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(list.entries[0]!.running).toBe(true);
    expect(list.totalWorkingMinutes).toBe(0);

    const stopped = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(running.id, 90)),
    );
    expect(stopped.running).toBe(false);
    expect(stopped.endAt).not.toBeNull();
    expect(stopped.workingTimeMinutes).toBe(90);

    const after = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(after.entries[0]!.running).toBe(false);
    expect(after.totalWorkingMinutes).toBe(90);
  });

  it("F902-DB-02: zweiter start → Conflict (partieller Unique über Service-Mapping)", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);
  });

  it("F902-DB-03: stop-Validierung — 0 Minuten, Pause > Arbeitszeit, fremder Eintrag", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(running.id, 0)),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, {
        ...stopCommand(running.id, 60),
        breakDurationMinutes: 90,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    // 1441 Minuten → Validation (Service-min 1..1440, DB-CHECK 0..1440
    // als Defensive-Layer — bewusste Schichtung).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(running.id, 1441)),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    // Fremde, nicht existierende Id → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(randomUUID(), 60)),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });

  it("F902-DB-03b: fremder REALER Eintrag + Doppel-Stopp → NotFound (Kimi-P1-2)", async () => {
    // Viewer startet (eigene Stoppuhr) — Editor versucht zu stoppen → NotFound.
    const other = await seedWorkspace("F9.2 Fremd-Eintrag");
    const foreignRunning = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(other.projectId)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(foreignRunning.id, 60)),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);

    // Doppel-Stopp des eigenen Eintrags → NotFound (Guard end_at is null).
    const mine = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(mine.id, 60)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, stopCommand(mine.id, 60)),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });

  it("F902-DB-03c: Archivieren laufender Einträge ist blockiert (Kimi-P1-1)", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => import("@/modules/time-tracking").then((module) =>
        module.archiveTimeEntry(tx, ctx, running.id)),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
    // Neue Stoppuhr bleibt möglich (kein Deadlock).
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => discardTimeEntry(tx, ctx, running.id),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
  });

  it("F902-DB-04: discard entfernt nur laufende; Viewer schreib-blockiert", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => discardTimeEntry(tx, ctx, running.id),
    );
    const list = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(list.entries).toHaveLength(0);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F902-DB-05: DB-CHECKs — laufend ohne Minuten ok, gestoppt ohne Minuten rejected", async () => {
    // Laufend (end_at NULL, Minuten NULL) ist erlaubt.
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into time_entry (
        workspace_id, user_id, project_id, start_at, end_at,
        working_time_minutes, created_by
      ) values (
        ${fixture.workspaceId}::uuid, ${fixture.editorId}::uuid, ${fixture.projectId}::uuid,
        now(), null, null, ${fixture.editorId}::uuid
      )
    `));
    // Gestoppt ohne Minuten verletzt time_entry_running_ck (23514).
    let caught: unknown;
    try {
      await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        insert into time_entry (
          workspace_id, user_id, project_id, start_at, end_at,
          working_time_minutes, created_by
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.editorId}::uuid, ${fixture.projectId}::uuid,
          now(), now() + interval '1 hour', null, ${fixture.editorId}::uuid
        )
      `));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } }).cause;
    expect(String(cause?.message ?? "")).toMatch(/running_ck/);
  });
});
