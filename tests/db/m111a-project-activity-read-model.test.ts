import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { projectActivityLabels } from "@/lib/integrations/tasks/contract";
import {
  executeProjectTaskCommand,
  getProjectActivityPage,
  getProjectTaskPage,
  PROJECT_TASK_COMMAND_VERSION,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  adminId: string;
  viewerId: string;
  reasonId: string;
};

const LOSS_COMMENT = "M111A-LOSS-COMMENT-SENTINEL";

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  const reasonId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M1-11a Activity')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${adminId}::uuid, ${`admin-${adminId}@m111a.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m111a.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
        (${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'M111A Customer',
        'customer@m111a.test', 'customer@m111a.test'
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'M111A Site')
    `);
    const project = await tx.execute<{ id: string }>(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id,
             'M111A Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
      returning id
    `);
    if (project.rows.length !== 1) throw new Error("M1-11a activity project seed failed");
  });

  await withAuthorizedTenantOn(testPool, adminId, workspaceId, (tx) => tx.execute(sql`
    insert into project_loss_reason (id, workspace_id, label, position)
    values (${reasonId}::uuid, ${workspaceId}::uuid, 'Budget', 1)
  `));

  return { workspaceId, projectId, adminId, viewerId, reasonId };
}

describe("M1-11a Project-Activity-Readmodel", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("mischt Outcome- und Task-Events mit festen Labels und ohne Payloaddetails", async () => {
    const task = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "quick_create",
        projectId: fixture.projectId,
        title: "M111A Activity Task",
      }),
    );

    await withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, (tx) => tx.execute(sql`
      update project
         set outcome = 'lost', outcome_revision = 1,
             loss_reason_id = ${fixture.reasonId}::uuid,
             loss_reason_text = ${LOSS_COMMENT},
             updated_at = statement_timestamp()
       where id = ${fixture.projectId}::uuid and outcome_revision = 0
    `));
    await withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, (tx) => tx.execute(sql`
      update project
         set outcome = 'open', outcome_revision = 2,
             loss_reason_id = null, loss_reason_text = null,
             updated_at = statement_timestamp()
       where id = ${fixture.projectId}::uuid and outcome_revision = 1
    `));
    await withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, (tx) => tx.execute(sql`
      update project
         set outcome = 'won', outcome_revision = 3,
             updated_at = statement_timestamp()
       where id = ${fixture.projectId}::uuid and outcome_revision = 2
    `));

    const activity = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId),
    );
    const taskPage = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskPage(tx, ctx, fixture.projectId),
    );

    expect(activity?.items.map(({ kind }) => kind)).toEqual([
      "outcome_won",
      "outcome_reopened",
      "outcome_lost",
      "task_created",
    ]);
    expect(taskPage?.activity.items.map(({ kind }) => kind))
      .toEqual(activity?.items.map(({ kind }) => kind));
    expect(activity?.items.map(({ label }) => label)).toEqual([
      "Anfrage gewonnen",
      "Anfrage wieder geöffnet",
      "Anfrage verloren",
      "Aufgabe erstellt",
    ]);
    expect(projectActivityLabels).toMatchObject({
      outcome_won: "Anfrage gewonnen",
      outcome_lost: "Anfrage verloren",
      outcome_reopened: "Anfrage wieder geöffnet",
    });

    const taskItem = activity?.items.find(({ kind }) => kind === "task_created");
    expect(taskItem).toMatchObject({
      taskId: task.taskId,
      taskTitle: "M111A Activity Task",
    });
    for (const item of activity?.items.filter(({ kind }) => kind.startsWith("outcome_")) ?? []) {
      expect(item.taskId).toBeNull();
      expect(item.taskTitle).toBeNull();
      expect(Object.keys(item).sort()).toEqual([
        "actorLabel",
        "id",
        "kind",
        "label",
        "occurredAt",
        "taskId",
        "taskTitle",
      ]);
    }

    const rawEvidence = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const event = await tx.execute<{ payload: Record<string, unknown> }>(sql`
        select payload
          from domain_events
         where aggregate_id = ${fixture.projectId}::uuid
           and event_type = 'project.outcome_lost'
      `);
      return event.rows[0]?.payload;
    });
    expect(rawEvidence).toMatchObject({
      lossReasonId: fixture.reasonId,
      hasComment: true,
    });
    const serialized = JSON.stringify({ activity, taskActivity: taskPage?.activity });
    expect(serialized).not.toContain(fixture.reasonId);
    expect(serialized).not.toContain(LOSS_COMMENT);
    for (const forbidden of [
      "payload",
      "lossReasonId",
      "hasComment",
      "previousOutcome",
      "nextOutcome",
      "outcomeRevision",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
