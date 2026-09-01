import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { getDefaultRequestBoard } from "@/modules/boards";
import {
  PROJECT_LOSS_REASON_COMMAND_VERSION,
  PROJECT_OUTCOME_COMMAND_VERSION,
  changeProjectLossReason,
  changeProjectOutcome,
  getProjectOutcomeContext,
  listClosedRequests,
  listManagedProjectLossReasons,
  listProjectLossReasons,
  ProjectLossReasonConflictError,
  ProjectLossReasonUnavailableError,
  ProjectOutcomeConflictError,
  ProjectOutcomeIllegalTransitionError,
  ProjectOutcomeNotFoundError,
  ProjectOutcomeValidationError,
} from "@/modules/projects";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  raceProjectId: string;
  rollbackProjectId: string;
  adminId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  otherAdminId: string;
  contactId: string;
  siteId: string;
};

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    otherWorkspaceId: randomUUID(),
    projectId: randomUUID(),
    raceProjectId: randomUUID(),
    rollbackProjectId: randomUUID(),
    adminId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    otherAdminId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
  };

  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.workspaceId}::uuid, 'M1-11a Outcome Service')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${fixture.adminId}::uuid, ${`${fixture.adminId}@m111a-service.test`}),
        (${fixture.editorId}::uuid, ${`${fixture.editorId}@m111a-service.test`}),
        (${fixture.viewerId}::uuid, ${`${fixture.viewerId}@m111a-service.test`}),
        (${fixture.externalId}::uuid, ${`${fixture.externalId}@m111a-service.test`}),
        (${fixture.otherAdminId}::uuid, ${`${fixture.otherAdminId}@m111a-service.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.adminId}::uuid, 'admin', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${fixture.contactId}::uuid, ${fixture.workspaceId}::uuid,
        'M1-11a Kundin', 'kundin@m111a-service.test',
        'kundin@m111a-service.test'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address
      ) values (
        ${fixture.siteId}::uuid, ${fixture.workspaceId}::uuid,
        ${fixture.contactId}::uuid, 'M1-11a Standort',
        'Prüfweg 11, 10115 Berlin'
      )
    `);
    const projects = await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key
      )
      select seed.id, ${fixture.workspaceId}::uuid, ${fixture.contactId}::uuid,
             ${fixture.siteId}::uuid, board.id, intake.id, seed.name,
             'request', 'open', seed.source_key
        from (
          values
            (${fixture.projectId}::uuid, 'Outcome Hauptprojekt'::text, 'm111a-main'::text),
            (${fixture.raceProjectId}::uuid, 'Outcome Raceprojekt'::text, 'm111a-race'::text),
            (${fixture.rollbackProjectId}::uuid, 'Outcome Rollbackprojekt'::text, 'm111a-rollback'::text)
        ) seed(id, name, source_key)
        join kanban_board board
          on board.workspace_id = ${fixture.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
      returning id
    `);
    if (projects.rowCount !== 3) throw new Error("M1-11a projects were not seeded");
  });

  await withTenantOn(testPool, fixture.otherWorkspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.otherWorkspaceId}::uuid, 'M1-11a Other Workspace')
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${fixture.otherWorkspaceId}::uuid,
        ${fixture.otherAdminId}::uuid, 'admin', '{}'::jsonb)
    `);
  });
  return fixture;
}

function createReason(label: string) {
  return {
    schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
    kind: "create",
    label,
  } as const;
}

function markWon(projectId: string, expectedOutcomeRevision: number) {
  return {
    schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
    kind: "mark_won",
    projectId,
    expectedOutcomeRevision,
    confirmation: "mark_won",
  } as const;
}

async function waitForNamedSessionLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await testPool.query<{ waiting: boolean }>(`
      select exists (
        select 1
          from pg_catalog.pg_stat_activity
         where application_name = $1
           and wait_event_type = 'Lock'
      ) as waiting
    `, [applicationName]);
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`M1-11a Outcome-Lockwaiter ${applicationName} wurde nicht sichtbar`);
}

describe.sequential("M1-11a Outcome-Service", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("verwaltet kanonische Reasons Admin-only mit DB-owned Position und CAS", async () => {
    const first = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("  Kein Budget  ")),
    );
    const second = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Zeitplan")),
    );
    expect(first).toMatchObject({ label: "Kein Budget", position: 1, revision: 1 });
    expect(second).toMatchObject({ label: "Zeitplan", position: 2, revision: 1 });

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("kein budget")),
    )).rejects.toBeInstanceOf(ProjectLossReasonConflictError);

    const archived = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, {
        schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
        kind: "archive",
        reasonId: first.id,
        expectedRevision: 1,
        archiveConfirmation: "archive",
      }),
    );
    expect(archived).toMatchObject({ revision: 2 });
    expect(archived.archivedAt).not.toBeNull();
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, {
        schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
        kind: "reactivate",
        reasonId: first.id,
        expectedRevision: 1,
      }),
    )).rejects.toMatchObject({
      name: "ProjectLossReasonConflictError",
      currentRevision: 2,
    });

    const reactivated = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, {
        schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
        kind: "reactivate",
        reasonId: first.id,
        expectedRevision: 2,
      }),
    );
    expect(reactivated).toMatchObject({ revision: 3, archivedAt: null });

    const viewerReasons = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listProjectLossReasons(tx, ctx),
    );
    expect(viewerReasons.map(({ label }) => label)).toEqual(["Kein Budget", "Zeitplan"]);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listManagedProjectLossReasons(tx, ctx),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    const viewerContext = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectOutcomeContext(tx, ctx, fixture.projectId),
    );
    expect(viewerContext).toMatchObject({
      activeLossReasons: [],
      permissions: { canChangeOutcome: false, canManageReasons: false },
    });
    expect(JSON.stringify(viewerContext)).not.toContain(first.id);
    expect(JSON.stringify(viewerContext)).not.toContain("Kein Budget");
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Nicht erlaubt")),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("macht gelöschte Contacts für Outcome-Kontext und Mutation fail-closed", async () => {
    const reason = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Contact gelöscht")),
    );
    const beforeDeletion = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectOutcomeContext(tx, ctx, fixture.projectId),
    );
    expect(beforeDeletion).toMatchObject({
      activeLossReasons: [{ id: reason.id, label: "Contact gelöscht" }],
      permissions: { canChangeOutcome: true },
    });

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        update contact
           set deleted_at = statement_timestamp(), updated_at = statement_timestamp()
         where id = ${fixture.contactId}::uuid
      `),
    );

    const deletedContext = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectOutcomeContext(tx, ctx, fixture.projectId),
    );
    expect(deletedContext).toMatchObject({
      outcome: "open",
      outcomeRevision: 0,
      activeLossReasons: [],
      permissions: { canChangeOutcome: false },
    });
    expect(JSON.stringify(deletedContext)).not.toContain(reason.id);
    expect(JSON.stringify(deletedContext)).not.toContain("Contact gelöscht");
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.projectId, 0)),
    )).rejects.toBeInstanceOf(ProjectOutcomeNotFoundError);

    const proof = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      outcome: string;
      outcome_revision: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select project_record.outcome, project_record.outcome_revision,
             (select count(*)::int from domain_events
               where aggregate_id = project_record.id
                 and event_type like 'project.outcome_%') as events,
             (select count(*)::int from audit_log
               where details->>'projectId' = project_record.id::text
                 and action = 'project.outcome.write') as audits
        from project project_record
       where project_record.id = ${fixture.projectId}::uuid
    `));
    expect(proof.rows[0]).toEqual({
      outcome: "open",
      outcome_revision: 0,
      events: 0,
      audits: 0,
    });
  });

  it("lässt eine gewinnende Contact-Erasure keine wartende Outcome-Mutation durch", async () => {
    const applicationName = `m111a-outcome-${randomUUID().slice(0, 8)}`;
    const erasureTx = await testPool.connect();
    let committed = false;
    let waitingOutcome: Promise<unknown> | undefined;
    try {
      await erasureTx.query("begin");
      await erasureTx.query(
        "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
        [fixture.workspaceId, fixture.editorId],
      );
      await erasureTx.query(
        "select id from project where workspace_id = $1::uuid and id = $2::uuid for update",
        [fixture.workspaceId, fixture.raceProjectId],
      );
      await erasureTx.query(
        "update contact set deleted_at = statement_timestamp() where workspace_id = $1::uuid and id = $2::uuid",
        [fixture.workspaceId, fixture.contactId],
      );
      waitingOutcome = withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        async (tx, ctx) => {
          await tx.execute(sql`select set_config('application_name', ${applicationName}, true)`);
          return changeProjectOutcome(tx, ctx, markWon(fixture.raceProjectId, 0));
        },
      );
      await waitForNamedSessionLock(applicationName);
      await erasureTx.query("commit");
      committed = true;
    } finally {
      if (!committed) await erasureTx.query("rollback").catch(() => undefined);
      erasureTx.release();
    }
    if (!waitingOutcome) throw new Error("M1-11a Outcome-Race wurde nicht gestartet");
    await expect(waitingOutcome).rejects.toBeInstanceOf(ProjectOutcomeNotFoundError);

    const proof = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      outcome: string;
      outcome_revision: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select project_record.outcome, project_record.outcome_revision,
             (select count(*)::int from domain_events
               where aggregate_id = project_record.id
                 and event_type like 'project.outcome_%') as events,
             (select count(*)::int from audit_log
               where details->>'projectId' = project_record.id::text
                 and action = 'project.outcome.write') as audits
        from project project_record
       where project_record.id = ${fixture.raceProjectId}::uuid
    `));
    expect(proof.rows[0]).toEqual({
      outcome: "open",
      outcome_revision: 0,
      events: 0,
      audits: 0,
    });
  });

  it("serialisiert parallele Reason-Creates auf lückenlose DB-owned Positionen", async () => {
    const created = await Promise.all([
      withAuthorizedTenantOn(
        testPool,
        fixture.adminId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Race Alpha")),
      ),
      withAuthorizedTenantOn(
        testPool,
        fixture.adminId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Race Beta")),
      ),
    ]);
    expect(created.map(({ position }) => position).sort((left, right) => left - right))
      .toEqual([1, 2]);
    expect(new Set(created.map(({ id }) => id)).size).toBe(2);
  });

  it("schließt Lost, öffnet wieder und gewinnt mit exakt redigierter DB-Evidenz", async () => {
    const reason = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Kein Budget")),
    );
    const lost = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "mark_lost",
        projectId: fixture.projectId,
        expectedOutcomeRevision: 0,
        lossReasonId: reason.id,
        lossReasonText: "Kundin wartet bis Winter",
        confirmation: "mark_lost",
      }),
    );
    expect(lost).toMatchObject({
      projectId: fixture.projectId,
      outcome: "lost",
      outcomeRevision: 1,
      lossReason: { id: reason.id, label: "Kein Budget", archived: false },
      lossReasonText: "Kundin wartet bis Winter",
    });
    expect(lost.closedAt).not.toBeNull();

    const evidence = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      event_type: string;
      payload: Record<string, unknown>;
      details: Record<string, unknown>;
      project_time: Date | string;
      event_time: Date | string;
      audit_time: Date | string;
      [key: string]: unknown;
    }>(sql`
      select event_record.event_type, event_record.payload,
             audit_record.details,
             project_record.updated_at as project_time,
             event_record.occurred_at as event_time,
             audit_record.occurred_at as audit_time
        from project project_record
        join domain_events event_record
          on event_record.workspace_id = project_record.workspace_id
         and event_record.aggregate_id = project_record.id
         and event_record.event_type = 'project.outcome_lost'
        join audit_log audit_record
          on audit_record.workspace_id = project_record.workspace_id
         and audit_record.action = 'project.outcome.write'
         and audit_record.details->>'projectId' = project_record.id::text
       where project_record.id = ${fixture.projectId}::uuid
    `));
    expect(evidence.rows).toHaveLength(1);
    const proof = evidence.rows[0]!;
    expect(proof.event_type).toBe("project.outcome_lost");
    expect(proof.payload).toEqual({
      projectId: fixture.projectId,
      previousOutcome: "open",
      nextOutcome: "lost",
      outcomeRevision: 1,
      lossReasonId: reason.id,
      hasComment: true,
    });
    expect(proof.details).toEqual(proof.payload);
    expect(new Date(proof.event_time).valueOf()).toBe(new Date(proof.project_time).valueOf());
    expect(new Date(proof.audit_time).valueOf()).toBe(new Date(proof.project_time).valueOf());
    expect(JSON.stringify(proof)).not.toContain("Kundin wartet bis Winter");
    expect(JSON.stringify(proof)).not.toContain("Kein Budget");

    const reopened = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "reopen",
        projectId: fixture.projectId,
        expectedOutcomeRevision: 1,
        confirmation: "reopen",
      }),
    );
    expect(reopened).toMatchObject({
      outcome: "open",
      outcomeRevision: 2,
      closedAt: null,
      lossReason: null,
      lossReasonText: null,
    });
    const won = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.projectId, 2)),
    );
    expect(won).toMatchObject({ outcome: "won", outcomeRevision: 3 });

    const board = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getDefaultRequestBoard(tx, ctx),
    );
    expect(board.columns.flatMap(({ cards }) => cards)
      .map(({ id }) => id)).not.toContain(fixture.projectId);
  });

  it("blockiert stale, illegale, archivierte, Viewer- und External-Pfade fail-closed", async () => {
    const reason = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Unpassend")),
    );
    await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, {
        schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
        kind: "archive",
        reasonId: reason.id,
        expectedRevision: 1,
        archiveConfirmation: "archive",
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "mark_lost",
        projectId: fixture.projectId,
        expectedOutcomeRevision: 0,
        lossReasonId: reason.id,
        lossReasonText: null,
        confirmation: "mark_lost",
      }),
    )).rejects.toBeInstanceOf(ProjectLossReasonUnavailableError);

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.projectId, 0)),
    );
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.projectId, 0)),
    )).rejects.toMatchObject({
      name: "ProjectOutcomeConflictError",
      currentRevision: 1,
    });
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.projectId, 1)),
    )).rejects.toBeInstanceOf(ProjectOutcomeIllegalTransitionError);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.raceProjectId, 0)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => getProjectOutcomeContext(tx, ctx, fixture.projectId),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => listClosedRequests(tx, ctx),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("serialisiert zwei Commands derselben Revision zu genau einem Gewinner", async () => {
    const reason = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectLossReason(tx, ctx, createReason("Race Reason")),
    );
    const attempts = await Promise.allSettled([
      withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectOutcome(tx, ctx, {
          schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
          kind: "mark_lost",
          projectId: fixture.raceProjectId,
          expectedOutcomeRevision: 0,
          lossReasonId: reason.id,
          lossReasonText: "Darf nie in der Evidenz landen",
          confirmation: "mark_lost",
        }),
      ),
      withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => changeProjectOutcome(tx, ctx, markWon(fixture.raceProjectId, 0)),
      ),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status !== "rejected") throw new Error("missing race loser");
    expect(rejected.reason).toBeInstanceOf(ProjectOutcomeConflictError);

    const counts = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from domain_events
          where aggregate_id = ${fixture.raceProjectId}::uuid
            and event_type in ('project.outcome_won', 'project.outcome_lost')) as events,
        (select count(*)::int from audit_log
          where action = 'project.outcome.write'
            and details->>'projectId' = ${fixture.raceProjectId}) as audits
    `));
    expect(counts.rows[0]).toEqual({ events: 1, audits: 1 });
  });

  it("rollt Project, Event und Audit gemeinsam zurück", async () => {
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        await changeProjectOutcome(tx, ctx, markWon(fixture.rollbackProjectId, 0));
        throw new Error("force outcome rollback");
      },
    )).rejects.toThrow("force outcome rollback");

    const proof = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      outcome: string;
      outcome_revision: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select project_record.outcome, project_record.outcome_revision,
             (select count(*)::int from domain_events
               where aggregate_id = project_record.id
                 and event_type = 'project.outcome_won') as events,
             (select count(*)::int from audit_log
               where details->>'projectId' = project_record.id::text
                 and action = 'project.outcome.write') as audits
        from project project_record
       where project_record.id = ${fixture.rollbackProjectId}::uuid
    `));
    expect(proof.rows[0]).toEqual({
      outcome: "open",
      outcome_revision: 0,
      events: 0,
      audits: 0,
    });
  });

  it("paginiert geschlossene Requests stabil und bindet Cursor an Workspace und Filter", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx) => {
        const inserted = await tx.execute(sql`
          insert into project (
            workspace_id, contact_id, site_id, kanban_board_id,
            kanban_column_id, name, phase, outcome, source_key
          )
          select ${fixture.workspaceId}::uuid, ${fixture.contactId}::uuid,
                 ${fixture.siteId}::uuid, board.id, intake.id,
                 'Abgeschlossen ' || series.value,
                 'request', 'open', 'm111a-page-' || series.value
            from generate_series(1, 51) series(value)
            join kanban_board board
              on board.workspace_id = ${fixture.workspaceId}::uuid
             and board.scope = 'residential'
             and board.is_default = true
             and board.archived_at is null
            join kanban_column intake
              on intake.workspace_id = board.workspace_id
             and intake.board_id = board.id
             and intake.is_intake = true
             and intake.archived_at is null
          returning id
        `);
        expect(inserted.rowCount).toBe(51);
        const closed = await tx.execute(sql`
          update project
             set outcome = 'won', outcome_revision = 1,
                 closed_at = transaction_timestamp(),
                 updated_at = transaction_timestamp()
           where workspace_id = ${fixture.workspaceId}::uuid
             and source_key like 'm111a-page-%'
        `);
        expect(closed.rowCount).toBe(51);
      },
    );

    const first = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listClosedRequests(tx, ctx, { filter: "won" }),
    );
    expect(first.records).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listClosedRequests(tx, ctx, {
        filter: "won",
        cursor: first.nextCursor,
      }),
    );
    expect(second.records).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.records, ...second.records].map(({ projectId }) => projectId)).size)
      .toBe(51);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => listClosedRequests(tx, ctx, {
        filter: "lost",
        cursor: first.nextCursor,
      }),
    )).rejects.toBeInstanceOf(ProjectOutcomeValidationError);
  });
});
