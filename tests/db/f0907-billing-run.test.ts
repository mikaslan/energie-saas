import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
} from "@/lib/integrations/time-tracking/contract";
import { BILLING_RUN_SCHEMA_VERSION } from "@/lib/integrations/time-tracking/billing-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  approveTimeEntry,
  archiveTimeEntry,
  closeBillingRun,
  createBillingRun,
  createTimeEntry,
  createTimeEventType,
  listBillingRuns,
  listTimeEntries,
  startTimeEntry,
  unapproveTimeEntry,
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
  typeId: string;
};

async function seedFixture(tag: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${`F9-07 ${tag}`})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f0907.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f0907.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${`F9-07 ${tag}`}, 'F9', 'Fixture', ${`c-${contactId}@f0907.test`}, ${`c-${contactId}@f0907.test`})
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`F9-07 ${tag}`})`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, ${`F9-07 ${tag}`}, 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });
  const typeId = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEventType(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      name: "Montage",
    }).then((created) => created.id),
  );
  return { workspaceId, editorId, viewerId, projectId, typeId };
}

async function createEntry(
  fixture: Fixture,
  input: { startAt: string; endAt: string; minutes: number },
): Promise<string> {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createTimeEntry(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      projectId: fixture.projectId,
      fields: {
        typeId: fixture.typeId,
        startAt: input.startAt,
        endAt: input.endAt,
        workingTimeMinutes: input.minutes,
        breakDurationMinutes: 0,
        comment: null,
      },
    }).then((created) => created.id),
  );
}

async function approveEntry(fixture: Fixture, entryId: string): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => approveTimeEntry(tx, ctx, entryId),
  );
}

async function createRun(fixture: Fixture, label: string, periodStart: string, periodEnd: string) {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createBillingRun(tx, ctx, {
      schemaVersion: BILLING_RUN_SCHEMA_VERSION,
      label,
      periodStart,
      periodEnd,
    }),
  );
}

describe("F9-07 Abrechnungslauf (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture(`Basis-${randomUUID().slice(0, 8)}`);
  });

  it("F0907-DB-01: Anlegen → Schließen übernimmt nur freigegebene, beendete Einträge im Zeitraum (Snapshot)", async () => {
    const billableA = await createEntry(fixture, { startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T10:00:00.000Z", minutes: 120 });
    const billableB = await createEntry(fixture, { startAt: "2026-09-10T08:00:00.000Z", endAt: "2026-09-10T09:00:00.000Z", minutes: 60 });
    await approveEntry(fixture, billableA);
    await approveEntry(fixture, billableB);

    // Nicht abrechenbar: unapproved (beendet), laufend, archiviert, außerhalb.
    await createEntry(fixture, { startAt: "2026-09-11T08:00:00.000Z", endAt: "2026-09-11T09:00:00.000Z", minutes: 60 });
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: fixture.typeId,
        comment: null,
      }),
    );
    const archived = await createEntry(fixture, { startAt: "2026-09-12T08:00:00.000Z", endAt: "2026-09-12T09:00:00.000Z", minutes: 45 });
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, archived),
    );
    const outside = await createEntry(fixture, { startAt: "2026-10-02T08:00:00.000Z", endAt: "2026-10-02T09:00:00.000Z", minutes: 90 });
    await approveEntry(fixture, outside);

    const created = await createRun(fixture, "September 2026", "2026-09-01", "2026-09-30");
    expect(created.status).toBe("open");
    expect(created.entryCount).toBe(0);
    expect(created.permissions.canWrite).toBe(true);

    const closed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: created.id,
      }),
    );
    expect(closed.status).toBe("closed");
    expect(closed.entryCount).toBe(2);
    expect(closed.totalMinutes).toBe(180);
    expect(closed.closedBy).toBe(fixture.editorId);
    expect(closed.closedAt).not.toBeNull();

    const runs = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listBillingRuns(tx, ctx),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.permissions.canWrite).toBe(false);

    // Listendurchsicht trägt das Sperrkennzeichen (UI-Badge/Sperre).
    const listed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    const byId = new Map(listed.entries.map((entry) => [entry.id, entry]));
    expect(byId.get(billableA)?.billed).toBe(true);
    expect(byId.get(billableB)?.billed).toBe(true);
  });

  it("F0907-DB-02: Ungültige Läufe und doppeltes Schließen fail-closed; Viewer ohne time.write", async () => {
    await expect(createRun(fixture, "   ", "2026-09-01", "2026-09-30"))
      .rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(createRun(fixture, "Start nach Ende", "2026-10-01", "2026-09-30"))
      .rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(createRun(fixture, "Zu lang", "2025-01-01", "2026-06-01"))
      .rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(createRun(fixture, "Kalenderlücke", "2026-02-30", "2026-03-01"))
      .rejects.toBeInstanceOf(TimeTrackingValidationError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        label: "Viewer-Versuch",
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const run = await createRun(fixture, "Doppelt schließen", "2026-09-01", "2026-09-30");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: run.id,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: run.id,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: randomUUID(),
      }),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: run.id,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F0907-DB-03: Abgerechnet bleibt abgerechnet (Doppelabrechnung, Unapprove-Sperre, Berlin-Tagesgrenze)", async () => {
    const first = await createEntry(fixture, { startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T10:00:00.000Z", minutes: 120 });
    await approveEntry(fixture, first);
    // 2026-09-30 22:30 UTC = 2026-10-01 00:30 Europe/Berlin.
    const berlinBoundary = await createEntry(fixture, { startAt: "2026-09-30T22:30:00.000Z", endAt: "2026-09-30T23:30:00.000Z", minutes: 60 });
    await approveEntry(fixture, berlinBoundary);

    const september = await createRun(fixture, "September 2026", "2026-09-01", "2026-09-30");
    const closedSeptember = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: september.id,
      }),
    );
    // Nur der echte September-Eintrag; der Grenz-Eintrag zählt als Oktober-Tag.
    expect(closedSeptember.entryCount).toBe(1);
    expect(closedSeptember.totalMinutes).toBe(120);

    // Unapprove nach Schließung ist gesperrt (Snapshot-Schutz).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unapproveTimeEntry(tx, ctx, first),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    // Zweiter Lauf über denselben Zeitraum findet nichts Neues mehr.
    const repeat = await createRun(fixture, "September erneut", "2026-09-01", "2026-09-30");
    const closedRepeat = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: repeat.id,
      }),
    );
    expect(closedRepeat.entryCount).toBe(0);
    expect(closedRepeat.totalMinutes).toBe(0);

    // Oktober-Lauf übernimmt den Grenz-Eintrag (Berlin-Tag).
    const october = await createRun(fixture, "Oktober 2026", "2026-10-01", "2026-10-31");
    const closedOctober = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: october.id,
      }),
    );
    expect(closedOctober.entryCount).toBe(1);
    expect(closedOctober.totalMinutes).toBe(60);
  });

  it("F0907-DB-04: Mandantenisolation (Liste, Schließen fremder Läufe)", async () => {
    const other = await seedFixture(`Fremd-${randomUUID().slice(0, 8)}`);
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        label: "Fremder Lauf",
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
      }),
    );
    const own = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listBillingRuns(tx, ctx),
    );
    expect(own).toHaveLength(0);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => closeBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        id: foreign.id,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });
});
