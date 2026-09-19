import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  workspaceTimeUtilizationQuerySchema,
} from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEntry,
  createTimeEntry,
  getWorkspaceTimeUtilization,
  listTimeEntries,
  startTimeEntry,
  TimeTrackingValidationError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  secondId: string;
  runnerId: string;
  viewerId: string;
  externalId: string;
  projectAId: string;
  projectBId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const secondId = randomUUID();
  const runnerId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f911.test`}),
             (${secondId}::uuid, ${`second-${secondId}@f911.test`}),
             (${runnerId}::uuid, ${`runner-${runnerId}@f911.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f911.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f911.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${secondId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${runnerId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  const projectAId = randomUUID();
  const projectBId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.11 Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f911.test`}, ${`${contactId}@f911.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.11 Site')
    `);
    for (const [projectId, name] of [[projectAId, "F9.11 Projekt A"], [projectBId, "F9.11 Projekt B"]] as const) {
      await tx.execute(sql`
        insert into project (
          id, workspace_id, contact_id, site_id, kanban_board_id,
          kanban_column_id, name, source_key
        )
        select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
               ${siteId}::uuid, board.id, intake_column.id, ${name}, 'fixture'
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
    }
  });
  return { workspaceId, editorId, secondId, runnerId, viewerId, externalId, projectAId, projectBId };
}

async function createEntry(
  fixture: Fixture,
  actorId: string,
  projectId: string,
  startAt: string,
  endAt: string,
  minutes: number,
  comment: string,
): Promise<string> {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => createTimeEntry(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      projectId,
      fields: {
        typeId: null,
        startAt,
        endAt,
        workingTimeMinutes: minutes,
        breakDurationMinutes: 0,
        comment,
      },
    }).then((created) => created.id),
  );
}

describe("F9-11 Workspace-Team-Auslastung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F9.11 Team");
    // Baseline (alle Berlin 2026-09-04): Editor 90 (A) + 60 (B) = 150,
    // Zweit-Editor 30 (A). UTC-Zeiten liegen bewusst am selben Berlin-Tag
    // (September = CEST, UTC+2).
    await createEntry(fixture, fixture.editorId, fixture.projectAId,
      "2026-09-04T08:00:00.000Z", "2026-09-04T10:00:00.000Z", 90, "A Montage");
    await createEntry(fixture, fixture.editorId, fixture.projectBId,
      "2026-09-04T12:00:00.000Z", "2026-09-04T14:00:00.000Z", 60, "B Montage");
    await createEntry(fixture, fixture.secondId, fixture.projectAId,
      "2026-09-04T14:00:00.000Z", "2026-09-04T16:00:00.000Z", 30, "A Nacharbeit");
  });

  it("F911-DB-01: Aggregation ueber Projekte (90+60=150, eine Zeile), Summe absteigend", async () => {
    const utilization = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    expect(utilization.rows).toHaveLength(2);
    // Sortierung: Summe absteigend.
    expect(utilization.rows[0]!.userId).toBe(fixture.editorId);
    expect(utilization.rows[0]!.totalWorkingMinutes).toBe(150);
    expect(utilization.rows[0]!.entryCount).toBe(2);
    expect(utilization.rows[0]!.running).toBe(false);
    expect(utilization.rows[0]!.label).toContain("f911.test");
    expect(utilization.rows[1]!.userId).toBe(fixture.secondId);
    expect(utilization.rows[1]!.totalWorkingMinutes).toBe(30);
    expect(utilization.rows[1]!.entryCount).toBe(1);
    expect(utilization.rows[1]!.running).toBe(false);
  });

  it("F911-DB-02: WYSIWYG-Pin — Workspace-Summe = Summe der Projekt-Listensummen", async () => {
    const utilization = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    const listA = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectAId }),
    );
    const listB = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectBId }),
    );
    const dashboardTotal = utilization.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0);
    expect(dashboardTotal).toBe(listA.totalWorkingMinutes + listB.totalWorkingMinutes);
    expect(dashboardTotal).toBe(180);

    // Gleicher Filter auf beiden Seiten: userIds + Zeitraum.
    const filter = { userIds: [fixture.editorId], startDate: "2026-09-04", endDate: "2026-09-04" };
    const filteredWs = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, filter),
    );
    const filteredA = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectAId, ...filter }),
    );
    const filteredB = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectBId, ...filter }),
    );
    const filteredTotal = filteredWs.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0);
    expect(filteredTotal).toBe(filteredA.totalWorkingMinutes + filteredB.totalWorkingMinutes);
    expect(filteredTotal).toBe(150);
    expect(filteredWs.rows).toHaveLength(1);
  });

  it("F911-DB-03: laufender Eintrag zaehlt nicht, markiert \"laeuft\" (auch Summe 0)", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectBId,
        typeId: null,
        comment: "Laufend B",
      }),
    );
    const withRunning = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    const editorRow = withRunning.rows.find((row) => row.userId === fixture.editorId)!;
    expect(editorRow.totalWorkingMinutes).toBe(150);
    expect(editorRow.entryCount).toBe(3);
    expect(editorRow.running).toBe(true);
    const secondRow = withRunning.rows.find((row) => row.userId === fixture.secondId)!;
    expect(secondRow.running).toBe(false);

    // Nur-laufender Nutzer (kein gestoppter Eintrag) erscheint mit Summe 0 und Flag.
    await withAuthorizedTenantOn(
      testPool, fixture.runnerId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectAId,
        typeId: null,
        comment: "Nur laufend",
      }),
    );
    const afterRunnerStart = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    const runnerRow = afterRunnerStart.rows.find((row) => row.userId === fixture.runnerId)!;
    expect(runnerRow.totalWorkingMinutes).toBe(0);
    expect(runnerRow.entryCount).toBe(1);
    expect(runnerRow.running).toBe(true);
  });

  it("F911-DB-04: archivierte Eintraege zaehlen nicht (fix, kein Toggle)", async () => {
    const archivedId = await createEntry(fixture, fixture.secondId, fixture.projectBId,
      "2026-09-04T10:00:00.000Z", "2026-09-04T12:00:00.000Z", 60, "WirdArchiviert");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, archivedId),
    );
    const afterArchive = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    expect(afterArchive.rows.find((row) => row.userId === fixture.secondId)!.totalWorkingMinutes)
      .toBe(30);
    expect(afterArchive.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0)).toBe(180);

    // Query kennt kein includeArchived (F9.4-D-Default verhaertet).
    expect(Object.keys(workspaceTimeUtilizationQuerySchema.shape)).not.toContain("includeArchived");
    expect(Object.keys(workspaceTimeUtilizationQuerySchema.shape)).not.toContain("projectId");
  });

  it("F911-DB-05: userIds-Filter treu (ein Nutzer, fremd-nur leer)", async () => {
    const onlySecond = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { userIds: [fixture.secondId] }),
    );
    expect(onlySecond.rows).toHaveLength(1);
    expect(onlySecond.rows[0]!.userId).toBe(fixture.secondId);
    expect(onlySecond.rows[0]!.totalWorkingMinutes).toBe(30);

    // Fehlend / leer / null = kein Filter.
    for (const query of [{}, { userIds: [] }, { userIds: null }] as const) {
      const unfiltered = await withAuthorizedTenantOn(
        testPool, fixture.viewerId, fixture.workspaceId,
        (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, query),
      );
      expect(unfiltered.rows).toHaveLength(2);
    }

    // Nur-fremde UUID → leer, kein Fehler, kein Leak.
    const unknownOnly = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { userIds: [randomUUID()] }),
    );
    expect(unknownOnly.rows).toHaveLength(0);

    // Nutzer aus fremdem Workspace → ebenfalls leer.
    const other = await seedWorkspace("F9.11 Fremd");
    const foreignOnly = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { userIds: [other.editorId] }),
    );
    expect(foreignOnly.rows).toHaveLength(0);

    // Mischfall bekannt+fremd → nur bekannter.
    const mixed = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {
        userIds: [fixture.editorId, randomUUID(), other.editorId],
      }),
    );
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.rows[0]!.userId).toBe(fixture.editorId);
    expect(mixed.rows[0]!.totalWorkingMinutes).toBe(150);
  });

  it("F911-DB-06: Zeitraumfilter Berlin-Tage (ausserhalb raus, Grenze drin)", async () => {
    // Ausserhalb: Berlin 2026-09-05 08:00 (UTC 06:00), 45 Min.
    await createEntry(fixture, fixture.editorId, fixture.projectAId,
      "2026-09-05T06:00:00.000Z", "2026-09-05T06:45:00.000Z", 45, "Folgetag");
    // Grenze: UTC 2026-09-03 22:30 = Berlin 2026-09-04 00:30 → gehoert zum 04.09.
    await createEntry(fixture, fixture.secondId, fixture.projectBId,
      "2026-09-03T22:30:00.000Z", "2026-09-04T00:00:00.000Z", 20, "Grenze Berlin-Tag");

    // Eintaegig (startDate == endDate erlaubt): 04.09. enthaelt Baseline + Grenze.
    const day = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { startDate: "2026-09-04", endDate: "2026-09-04" }),
    );
    const dayTotal = day.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0);
    expect(dayTotal).toBe(200);
    expect(day.rows.find((row) => row.userId === fixture.editorId)!.totalWorkingMinutes).toBe(150);
    expect(day.rows.find((row) => row.userId === fixture.secondId)!.totalWorkingMinutes).toBe(50);

    // Offene Grenze: nur startDate → nur Folgetag.
    const fromNext = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { startDate: "2026-09-05" }),
    );
    expect(fromNext.rows).toHaveLength(1);
    expect(fromNext.rows[0]!.userId).toBe(fixture.editorId);
    expect(fromNext.rows[0]!.totalWorkingMinutes).toBe(45);

    // Offene Grenze: nur endDate → Folgetag raus.
    const untilDay = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { endDate: "2026-09-04" }),
    );
    expect(untilDay.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0)).toBe(200);

    // Ohne Datum = unbegrenzt.
    const all = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    expect(all.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0)).toBe(245);
  });

  it("F911-DB-07: Viewer lesen ok, Externer denied; Query-Validierung fail-closed", async () => {
    const viewer = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    );
    expect(viewer.rows).toHaveLength(2);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {}),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Schema-Ebene (RED-Pin auf den neuen Contract).
    expect(workspaceTimeUtilizationQuerySchema.safeParse({}).success).toBe(true);
    expect(workspaceTimeUtilizationQuerySchema.safeParse({
      userIds: [fixture.editorId], startDate: "2026-09-04", endDate: "2026-09-04",
    }).success).toBe(true);
    expect(workspaceTimeUtilizationQuerySchema.safeParse({
      startDate: "2026-09-05", endDate: "2026-09-04",
    }).success).toBe(false);
    expect(workspaceTimeUtilizationQuerySchema.safeParse({ startDate: "2026-02-30" }).success)
      .toBe(false);
    expect(workspaceTimeUtilizationQuerySchema.safeParse({
      userIds: Array.from({ length: 51 }, () => randomUUID()),
    }).success).toBe(false);

    // Service-Ebene: ungueltig → TimeTrackingValidationError (fail-closed).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { startDate: "2026-09-05", endDate: "2026-09-04" }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, {
        userIds: Array.from({ length: 51 }, () => randomUUID()),
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });

  it("F911-DB-08: userIds-Filter ohne 200er-Cap der Member-Options (SQL-Schnittmenge)", async () => {
    // 200 Fuell-Mitgliedschaften mit sortiert-ersten E-Mails: editorId und
    // secondId fallen aus listTimeMemberOptions (Limit 200, E-Mail-Sort).
    // Der Filter muss sie trotzdem finden (reine IN-Liste wie
    // listTimeEntries/getTimeUtilization — kein JS-Schnitt mit Options).
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      for (let n = 0; n < 200; n += 1) {
        const fillerId = randomUUID();
        const email = `aaa-${String(n).padStart(3, "0")}@f911.test`;
        await tx.execute(sql`
          insert into user_identity (id, email) values (${fillerId}::uuid, ${email})
        `);
        await tx.execute(sql`
          insert into membership (id, workspace_id, user_id, role, capabilities)
          values (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fillerId}::uuid,
            'viewer', '{}'::jsonb)
        `);
      }
    });
    const beyondCap = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { userIds: [fixture.secondId] }),
    );
    expect(beyondCap.rows).toHaveLength(1);
    expect(beyondCap.rows[0]!.userId).toBe(fixture.secondId);
    expect(beyondCap.rows[0]!.totalWorkingMinutes).toBe(30);
    const beyondCapEditor = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getWorkspaceTimeUtilization(tx, ctx, { userIds: [fixture.editorId] }),
    );
    expect(beyondCapEditor.rows).toHaveLength(1);
    expect(beyondCapEditor.rows[0]!.totalWorkingMinutes).toBe(150);
  });
});
