import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
} from "@/lib/integrations/time-tracking/contract";
import { BILLING_RUN_SCHEMA_VERSION } from "@/lib/integrations/time-tracking/billing-contract";
import {
  approveTimeEntry,
  closeBillingRun,
  createBillingRun,
  createTimeEntry,
  createTimeEventType,
  getBillingRunBreakdown,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editor2Id: string;
  viewerId: string;
  projectId: string;
  typeId: string;
};

async function seedFixture(tag: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const editor2Id = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${`F9-08 ${tag}`})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f0908.test`}),
             (${editor2Id}::uuid, ${`editor2-${editor2Id}@f0908.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f0908.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editor2Id}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${`F9-08 ${tag}`}, 'F9', 'Fixture', ${`c-${contactId}@f0908.test`}, ${`c-${contactId}@f0908.test`})
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`F9-08 ${tag}`})`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, ${`F9-08 ${tag}`}, 'manual'
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
  return { workspaceId, editorId, editor2Id, viewerId, projectId, typeId };
}

async function createApprovedEntry(
  fixture: Fixture,
  actorId: string,
  input: { startAt: string; endAt: string; minutes: number },
): Promise<string> {
  const entryId = await withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
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
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => approveTimeEntry(tx, ctx, entryId),
  );
  return entryId;
}

async function closeRun(fixture: Fixture, label: string): Promise<string> {
  const created = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createBillingRun(tx, ctx, {
      schemaVersion: BILLING_RUN_SCHEMA_VERSION,
      label,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
    }),
  );
  const closed = await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => closeBillingRun(tx, ctx, {
      schemaVersion: BILLING_RUN_SCHEMA_VERSION,
      id: created.id,
    }),
  );
  return closed.id;
}

function breakdown(fixture: Fixture, actorId: string, billingRunId: string) {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => getBillingRunBreakdown(tx, ctx, {
      schemaVersion: BILLING_RUN_SCHEMA_VERSION,
      billingRunId,
    }),
  );
}

describe("F9-08 Lauf-Auswertung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture(`Basis-${randomUUID().slice(0, 8)}`);
  });

  it("F0908-DB-01: Zeilen je Person mit Labels, Summen = Snapshot", async () => {
    await createApprovedEntry(fixture, fixture.editorId, { startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T10:00:00.000Z", minutes: 120 });
    await createApprovedEntry(fixture, fixture.editorId, { startAt: "2026-09-05T08:00:00.000Z", endAt: "2026-09-05T09:00:00.000Z", minutes: 60 });
    await createApprovedEntry(fixture, fixture.editor2Id, { startAt: "2026-09-06T08:00:00.000Z", endAt: "2026-09-06T11:00:00.000Z", minutes: 180 });
    const runId = await closeRun(fixture, "September 2026");

    const result = await breakdown(fixture, fixture.editorId, runId);
    expect(result.billingRunId).toBe(runId);
    expect(result.entryCount).toBe(3);
    expect(result.totalMinutes).toBe(360);
    expect(result.rows).toHaveLength(2);
    // Sortierung: Minuten absteigend.
    expect(result.rows[0]).toMatchObject({ userId: fixture.editor2Id, entryCount: 1, totalWorkingMinutes: 180 });
    expect(result.rows[0]!.label).toContain("editor2-");
    expect(result.rows[1]).toMatchObject({ userId: fixture.editorId, entryCount: 2, totalWorkingMinutes: 180 });
    expect(result.rows[1]!.label).toContain("editor-");
  });

  it("F0908-DB-02: offener/leerer Lauf → leere Zeilen; Viewer lesend", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createBillingRun(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        label: "Offen",
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
      }),
    );
    const open = await breakdown(fixture, fixture.editorId, created.id);
    expect(open.rows).toEqual([]);
    expect(open.entryCount).toBe(0);

    await createApprovedEntry(fixture, fixture.editorId, { startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T09:00:00.000Z", minutes: 60 });
    const runId = await closeRun(fixture, "September 2026");
    const viewerResult = await breakdown(fixture, fixture.viewerId, runId);
    expect(viewerResult.rows).toHaveLength(1);
    expect(viewerResult.totalMinutes).toBe(60);
  });

  it("F0908-DB-03: fremder/unbekannter Lauf → NotFound; ungültige ID fail-closed", async () => {
    const other = await seedFixture(`Fremd-${randomUUID().slice(0, 8)}`);
    await createApprovedEntry(other, other.editorId, { startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T09:00:00.000Z", minutes: 60 });
    const foreignRunId = await closeRun(other, "Fremd");
    await expect(breakdown(fixture, fixture.editorId, foreignRunId))
      .rejects.toBeInstanceOf(TimeTrackingNotFoundError);
    await expect(breakdown(fixture, fixture.editorId, randomUUID()))
      .rejects.toBeInstanceOf(TimeTrackingNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getBillingRunBreakdown(tx, ctx, {
        schemaVersion: BILLING_RUN_SCHEMA_VERSION,
        billingRunId: "keine-uuid",
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });

  it("F0908-DB-04: Snapshot-Mismatch fail-closed statt stiller Anzeige", async () => {
    await createApprovedEntry(fixture, fixture.editorId, { startAt: "2026-09-04T08:00:00.000Z", endAt: "2026-09-04T09:00:00.000Z", minutes: 60 });
    const runId = await closeRun(fixture, "September 2026");
    // Snapshot nachträglich verfälschen (bypassiert die F9-07-Sperren auf
    // Zeilenebene — genau davor schützt die Kohärenzprüfung).
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update billing_run
           set total_minutes = total_minutes + 30
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${runId}::uuid
      `);
    });
    await expect(breakdown(fixture, fixture.editorId, runId))
      .rejects.toBeInstanceOf(TimeTrackingValidationError);
  });
});
