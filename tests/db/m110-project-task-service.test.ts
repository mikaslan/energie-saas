import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  executeProjectTaskCommand,
  getProjectActivityPage,
  getProjectTaskPage,
  getProjectTaskWorkspace,
  PROJECT_TASK_COMMAND_VERSION,
  PROJECT_TASK_MAX_ASSIGNEES,
  PROJECT_TASK_MAX_CHECKLIST_ITEMS,
  PROJECT_TASK_MAX_LABELS,
  PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  PROJECT_TASK_PAGE_LIMIT,
  ProjectTaskArchivedError,
  ProjectTaskConflictError,
  ProjectTaskNotFoundError,
  ProjectTaskValidationError,
  searchProjectTaskMembers,
  type ProjectTaskCommandV1,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  targetId: string;
  editorMembershipId: string;
  targetMembershipId: string;
};

const BODY = {
  schemaVersion: "task-rich-text.v1" as const,
  doc: {
    type: "doc" as const,
    content: [{
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: "M110-BODY-SENTINEL" }],
    }],
  },
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const targetId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerMembershipId = randomUUID();
  const externalMembershipId = randomUUID();
  const targetMembershipId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M1-10 Tasks')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m110.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m110.test`}),
        (${externalId}::uuid, ${`external-${externalId}@m110.test`}),
        (${targetId}::uuid, ${`target-${targetId}@m110.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
          'editor', '{}'::jsonb),
        (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
          'viewer', '{}'::jsonb),
        (${externalMembershipId}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
          'admin', '{"external_only":true}'::jsonb),
        (${targetMembershipId}::uuid, ${workspaceId}::uuid, ${targetId}::uuid,
          'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'M110-CUSTOMER-SENTINEL',
        'customer@m110.test', 'customer@m110.test'
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'M110 Site')
    `);
    const project = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id,
             'M110 Project', 'manual'
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
    if (project.rows.length !== 1) throw new Error("M1-10 project seed failed");
  });

  return {
    workspaceId,
    projectId,
    editorId,
    viewerId,
    externalId,
    targetId,
    editorMembershipId,
    targetMembershipId,
  };
}

function quick(fixture: Fixture, title = "M110-TITLE-SENTINEL"): ProjectTaskCommandV1 {
  return {
    schemaVersion: PROJECT_TASK_COMMAND_VERSION,
    kind: "quick_create",
    projectId: fixture.projectId,
    title,
  };
}

function full(fixture: Fixture): ProjectTaskCommandV1 {
  return {
    schemaVersion: PROJECT_TASK_COMMAND_VERSION,
    kind: "create",
    projectId: fixture.projectId,
    title: "M110-TITLE-SENTINEL",
    body: BODY,
    dueDate: "2026-10-25",
    assigneeMembershipIds: [fixture.targetMembershipId],
    checklist: [
      { text: "M110-CHECKLIST-SENTINEL", done: false },
      { text: "Netzanfrage prüfen", done: true },
    ],
    labels: [{ name: "M110-LABEL-SENTINEL", color: "emerald" }],
  };
}

type ErasureRaceOperation = "create" | "update" | "toggle" | "archive";

async function erasureRaceCommand(
  fixture: Fixture,
  operation: ErasureRaceOperation,
): Promise<ProjectTaskCommandV1> {
  if (operation === "create") return full(fixture);
  const created = await withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
  );
  const workspace = await withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
  );
  const task = workspace?.open.find(({ id }) => id === created.taskId);
  if (!task) throw new Error("M1-10 race fixture missing");
  if (operation === "update") {
    return {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "update",
      projectId: fixture.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
      title: `${task.title} aktualisiert`,
      body: task.body,
      dueDate: "2026-10-26",
      assigneeMembershipIds: task.assignees.map(({ membershipId }) => membershipId),
      checklist: task.checklist.map(({ id, text, done }) => ({ id, text, done })),
      labels: task.labels.map(({ id, name, color }) => ({ id, name, color })),
    };
  }
  if (operation === "toggle") {
    const item = task.checklist[0];
    if (!item) throw new Error("M1-10 race checklist fixture missing");
    return {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "toggle_checklist_item",
      projectId: fixture.projectId,
      taskId: task.id,
      checklistItemId: item.id,
      expectedRevision: task.revision,
      done: !item.done,
    };
  }
  return {
    schemaVersion: PROJECT_TASK_COMMAND_VERSION,
    kind: "archive",
    projectId: fixture.projectId,
    taskId: task.id,
    expectedRevision: task.revision,
    archiveConfirmation: "archive",
  };
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
  throw new Error(`M1-10 lock waiter ${applicationName} wurde nicht sichtbar`);
}

describe("M1-10 Project-Task-Service", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("legt Quick Tasks mit Actor-Assignee an und projiziert sie für interne Viewer", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    );
    expect(created).toMatchObject({ revision: 1, changed: true });

    const workspace = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    expect(workspace).toMatchObject({
      schemaVersion: "project-task-workspace.v1",
      permissions: { canWrite: false },
      archivedCount: 0,
    });
    expect(workspace).not.toHaveProperty("members");
    expect(workspace?.open).toHaveLength(1);
    expect(workspace?.open[0]).toMatchObject({
      id: created.taskId,
      title: "M110-TITLE-SENTINEL",
      revision: 1,
      dueAt: null,
      status: "open",
      checklist: [],
      labels: [],
    });
    expect(workspace?.open[0]?.assignees.map(({ membershipId }) => membershipId))
      .toEqual([fixture.editorMembershipId]);
  });

  it("speichert Full Create atomar und wandelt Berliner Fälligkeit DST-sicher", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    );
    const workspace = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    const task = workspace?.open[0];
    expect(task).toMatchObject({
      id: created.taskId,
      dueAt: "2026-10-25T22:59:59.999Z",
      body: BODY,
      labels: [{ name: "M110-LABEL-SENTINEL", color: "emerald", position: 0 }],
    });
    expect(task?.checklist.map(({ text, done }) => ({ text, done }))).toEqual([
      { text: "M110-CHECKLIST-SENTINEL", done: false },
      { text: "Netzanfrage prüfen", done: true },
    ]);
    expect(task?.assignees.map(({ membershipId }) => membershipId))
      .toEqual([fixture.targetMembershipId]);
  });

  it("schreibt alle erlaubten Maximalmengen mit konstant vielen DB-Roundtrips", async () => {
    const extraMembers = Array.from(
      { length: PROJECT_TASK_MAX_ASSIGNEES - 1 },
      (_, index) => ({
        userId: randomUUID(),
        membershipId: randomUUID(),
        email: `max-task-${String(index).padStart(2, "0")}-${fixture.workspaceId}@m110.test`,
      }),
    );
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values ${sql.join(extraMembers.map(({ userId, email }) =>
          sql`(${userId}::uuid, ${email})`), sql`, `)}
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values ${sql.join(extraMembers.map(({ membershipId, userId }) => sql`(
          ${membershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${userId}::uuid, 'viewer', '{}'::jsonb
        )`), sql`, `)}
      `);
    });
    const command: ProjectTaskCommandV1 = {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "create",
      projectId: fixture.projectId,
      title: "Maximal gebundene Aufgabe",
      body: { schemaVersion: "task-rich-text.v1", doc: { type: "doc", content: [] } },
      dueDate: null,
      assigneeMembershipIds: [
        fixture.targetMembershipId,
        ...extraMembers.map(({ membershipId }) => membershipId),
      ],
      checklist: Array.from(
        { length: PROJECT_TASK_MAX_CHECKLIST_ITEMS },
        (_, index) => ({ text: `Prüfpunkt ${String(index + 1).padStart(3, "0")}`, done: false }),
      ),
      labels: Array.from(
        { length: PROJECT_TASK_MAX_LABELS },
        (_, index) => ({ name: `Max Label ${String(index + 1).padStart(2, "0")}`, color: "slate" as const }),
      ),
    };
    let executeCount = 0;
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const interceptedExecute = (async (
          query: Parameters<TenantTx["execute"]>[0],
        ) => {
          executeCount += 1;
          return tx.execute(query);
        }) as TenantTx["execute"];
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "execute") return interceptedExecute;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
        return executeProjectTaskCommand(wrappedTx, ctx, command);
      },
    );
    expect(created.changed).toBe(true);
    expect(executeCount).toBeLessThanOrEqual(12);

    const workspace = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    expect(workspace?.open[0]?.assignees).toHaveLength(PROJECT_TASK_MAX_ASSIGNEES);
    expect(workspace?.open[0]?.checklist).toHaveLength(PROJECT_TASK_MAX_CHECKLIST_ITEMS);
    expect(workspace?.open[0]?.labels).toHaveLength(PROJECT_TASK_MAX_LABELS);
  });

  it("projiziert bei parallelem Full Edit nie einen zerrissenen Revisionsstand", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    );
    const initial = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    const initialTask = initial?.open[0];
    if (!initialTask) throw new Error("M1-10 task missing");
    const updatedChecklistText = "M110-CHECKLIST-UPDATED";
    const update: ProjectTaskCommandV1 = {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "update",
      projectId: fixture.projectId,
      taskId: created.taskId,
      expectedRevision: 1,
      title: initialTask.title,
      body: initialTask.body,
      dueDate: "2026-10-25",
      assigneeMembershipIds: initialTask.assignees.map(({ membershipId }) => membershipId),
      checklist: initialTask.checklist.map((item, index) => ({
        id: item.id,
        text: index === 0 ? updatedChecklistText : item.text,
        done: item.done,
      })),
      labels: initialTask.labels.map((item) => ({
        id: item.id,
        name: item.name,
        color: item.color,
      })),
    };
    let editCommitted = false;
    let serviceExecuteCount = 0;

    const workspace = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const interceptedExecute = (async (
          query: Parameters<TenantTx["execute"]>[0],
        ) => {
          const result = await tx.execute(query);
          serviceExecuteCount += 1;
          if (!editCommitted && serviceExecuteCount === 2) {
            await withAuthorizedTenantOn(
              testPool,
              fixture.editorId,
              fixture.workspaceId,
              (writeTx, writeCtx) => executeProjectTaskCommand(writeTx, writeCtx, update),
            );
            editCommitted = true;
          }
          return result;
        }) as TenantTx["execute"];
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "execute") return interceptedExecute;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
        return getProjectTaskWorkspace(wrappedTx, ctx, fixture.projectId);
      },
    );

    expect(editCommitted).toBe(true);
    expect(serviceExecuteCount).toBe(2);
    const projected = workspace?.open[0];
    if (!projected) throw new Error("M1-10 projected task missing");
    const oldSnapshot = projected.revision === 1
      && projected.checklist[0]?.text === "M110-CHECKLIST-SENTINEL";
    const newSnapshot = projected.revision === 2
      && projected.checklist[0]?.text === updatedChecklistText;
    expect(oldSnapshot || newSnapshot).toBe(true);
  });

  it("hält eine konkurrierende Project-Erasure hinter dem Read-Fence", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    );
    let serviceExecuteCount = 0;
    let competingCode: string | undefined;

    await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const interceptedExecute = (async (
          query: Parameters<TenantTx["execute"]>[0],
        ) => {
          const result = await tx.execute(query);
          serviceExecuteCount += 1;
          if (serviceExecuteCount === 1) {
            const competing = await testPool.connect();
            try {
              await competing.query("begin");
              await competing.query(
                "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
                [fixture.workspaceId, fixture.editorId],
              );
              try {
                await competing.query(
                  "select id from project where workspace_id = $1::uuid and id = $2::uuid for update nowait",
                  [fixture.workspaceId, fixture.projectId],
                );
              } catch (error) {
                competingCode = (error as { code?: string }).code;
              }
              await competing.query("rollback");
            } finally {
              competing.release();
            }
          }
          return result;
        }) as TenantTx["execute"];
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "execute") return interceptedExecute;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
        return getProjectTaskWorkspace(wrappedTx, ctx, fixture.projectId);
      },
    );

    expect(serviceExecuteCount).toBe(2);
    expect(competingCode).toBe("55P03");
  });

  it.each(["create", "update", "toggle", "archive"] as const)(
    "hält eine konkurrierende Project-Erasure vor jedem %s-Teilstand",
    async (operation) => {
      const command = await erasureRaceCommand(fixture, operation);

      let executeCount = 0;
      let competingCode: string | undefined;
      const result = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        async (tx, ctx) => {
          const interceptedExecute = (async (
            query: Parameters<TenantTx["execute"]>[0],
          ) => {
            const queryResult = await tx.execute(query);
            executeCount += 1;
            if (executeCount === 1) {
              const competing = await testPool.connect();
              try {
                await competing.query("begin");
                await competing.query(
                  "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
                  [fixture.workspaceId, fixture.editorId],
                );
                try {
                  await competing.query(
                    "select id from project where workspace_id = $1::uuid and id = $2::uuid for update nowait",
                    [fixture.workspaceId, fixture.projectId],
                  );
                } catch (error) {
                  competingCode = (error as { code?: string }).code;
                }
                await competing.query("rollback");
              } finally {
                competing.release();
              }
            }
            return queryResult;
          }) as TenantTx["execute"];
          const wrappedTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === "execute") return interceptedExecute;
              return Reflect.get(target, property, receiver) as unknown;
            },
          });
          return executeProjectTaskCommand(wrappedTx, ctx, command);
        },
      );

      expect(result.changed).toBe(true);
      expect(executeCount).toBeGreaterThan(1);
      expect(competingCode).toBe("55P03");
    },
  );

  it.each(["create", "update", "toggle", "archive"] as const)(
    "verwirft %s ohne Teilstand, wenn die Erasure den Project-Lock zuerst gewinnt",
    async (operation) => {
      const command = await erasureRaceCommand(fixture, operation);
      const before = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => getProjectTaskPage(tx, ctx, fixture.projectId),
      );
      const applicationName = `m110-${operation}-${randomUUID().slice(0, 8)}`;
      const erasureTx = await testPool.connect();
      let committed = false;
      let commandPromise: Promise<unknown> | undefined;
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
          `update contact
              set deleted_at = statement_timestamp()
            where workspace_id = $1::uuid
              and id = (
                select contact_id from project
                 where workspace_id = $1::uuid and id = $2::uuid
              )`,
          [fixture.workspaceId, fixture.projectId],
        );
        commandPromise = withAuthorizedTenantOn(
          testPool,
          fixture.editorId,
          fixture.workspaceId,
          async (tx, ctx) => {
            await tx.execute(sql`
              select set_config('application_name', ${applicationName}, true)
            `);
            return executeProjectTaskCommand(tx, ctx, command);
          },
        );
        await waitForNamedSessionLock(applicationName);
        await erasureTx.query("commit");
        committed = true;
      } finally {
        if (!committed) await erasureTx.query("rollback").catch(() => undefined);
        erasureTx.release();
      }
      if (!commandPromise) throw new Error("M1-10 race command wurde nicht gestartet");
      await expect(commandPromise).rejects.toBeInstanceOf(ProjectTaskNotFoundError);
      const after = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => getProjectTaskPage(tx, ctx, fixture.projectId),
      );
      expect(after).toEqual(before);
    },
  );

  it("filtert malformed Memberships fail-closed und lässt Altzuweisungen entfernen", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    );
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update membership
         set capabilities = '{"legacy":"yes"}'::jsonb
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.targetMembershipId}::uuid
    `));

    const workspace = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    const malformedSearch = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => searchProjectTaskMembers(tx, ctx, fixture.projectId, {
        query: "target-",
      }),
    );
    expect(malformedSearch?.members.map(({ membershipId }) => membershipId))
      .not.toContain(fixture.targetMembershipId);
    const task = workspace?.open[0];
    if (!task) throw new Error("M1-10 task missing");
    expect(task.assignees).toEqual([]);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    )).rejects.toBeInstanceOf(ProjectTaskNotFoundError);

    const cleaned = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "update",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: task.revision,
        title: task.title,
        body: task.body,
        dueDate: "2026-10-25",
        assigneeMembershipIds: [],
        checklist: task.checklist.map((item) => ({
          id: item.id,
          text: item.text,
          done: item.done,
        })),
        labels: task.labels.map((item) => ({
          id: item.id,
          name: item.name,
          color: item.color,
        })),
      }),
    );
    expect(cleaned).toMatchObject({ revision: 2, changed: true });
  });

  it("ersetzt Details per CAS, erkennt No-op und hält Stale teilstandsfrei", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    );
    const before = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    const task = before?.open[0];
    if (!task) throw new Error("M1-10 task missing");
    const update: ProjectTaskCommandV1 = {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "update",
      projectId: fixture.projectId,
      taskId: created.taskId,
      expectedRevision: 1,
      title: "Montage final abstimmen",
      body: task.body,
      dueDate: "2026-10-25",
      assigneeMembershipIds: task.assignees.map(({ membershipId }) => membershipId),
      checklist: task.checklist.map((item) => ({
        id: item.id,
        text: item.text,
        done: item.done,
      })),
      labels: task.labels.map((item) => ({
        id: item.id,
        name: item.name,
        color: item.color,
      })),
    };
    const changed = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, update),
    );
    expect(changed).toMatchObject({ revision: 2, changed: true });
    const noOp = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        ...update,
        expectedRevision: 2,
      }),
    );
    expect(noOp).toMatchObject({ revision: 2, changed: false });
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        ...update,
        title: "Darf nicht gewinnen",
      }),
    )).rejects.toBeInstanceOf(ProjectTaskConflictError);
  });

  it("führt Complete/Reopen/Archive revisionsfest und terminal aus", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    );
    const command = (kind: "complete" | "reopen" | "archive", revision: number) => ({
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind,
      projectId: fixture.projectId,
      taskId: created.taskId,
      expectedRevision: revision,
      ...(kind === "archive" ? { archiveConfirmation: "archive" as const } : {}),
    }) as ProjectTaskCommandV1;
    const completed = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, command("complete", 1)),
    );
    const reopened = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, command("reopen", 2)),
    );
    const archived = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, command("archive", 3)),
    );
    expect([completed.revision, reopened.revision, archived.revision]).toEqual([2, 3, 4]);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, command("complete", 4)),
    )).rejects.toBeInstanceOf(ProjectTaskArchivedError);
    const archiveView = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId, { archived: true }),
    );
    expect(archiveView?.archived).toHaveLength(1);
    expect(archiveView?.open).toEqual([]);
  });

  it("lässt aktive erledigte Aufgaben bearbeiten und ihre Checkliste ändern", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    );
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "complete",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: 1,
      }),
    );
    const completedWorkspace = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    const completedTask = completedWorkspace?.done[0];
    if (!completedTask) throw new Error("M1-10 completed task missing");

    const revised = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "update",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: 2,
        title: "Erledigte Aufgabe dokumentieren",
        body: completedTask.body,
        dueDate: "2026-10-25",
        assigneeMembershipIds: completedTask.assignees.map(({ membershipId }) => membershipId),
        checklist: completedTask.checklist.map((item) => ({
          id: item.id,
          text: item.text,
          done: item.done,
        })),
        labels: completedTask.labels.map((item) => ({
          id: item.id,
          name: item.name,
          color: item.color,
        })),
      }),
    );
    const checklistItemId = completedTask.checklist[0]?.id;
    if (!checklistItemId) throw new Error("M1-10 checklist item missing");
    const toggled = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "toggle_checklist_item",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: revised.revision,
        checklistItemId,
        done: true,
      }),
    );

    expect([revised.revision, toggled.revision]).toEqual([3, 4]);
    const after = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    expect(after?.done[0]).toMatchObject({
      title: "Erledigte Aufgabe dokumentieren",
      status: "done",
      revision: 4,
    });
    expect(after?.done[0]?.checklist[0]?.done).toBe(true);
  });

  it("schreibt für jede wirksame Mutation exakt redigierte Events/Audits und für No-ops nichts", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, full(fixture)),
    );
    const initial = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    const task = initial?.open[0];
    const checklistItemId = task?.checklist[0]?.id;
    if (!task || !checklistItemId) throw new Error("M1-10 evidence fixture missing");
    const update: ProjectTaskCommandV1 = {
      schemaVersion: PROJECT_TASK_COMMAND_VERSION,
      kind: "update",
      projectId: fixture.projectId,
      taskId: created.taskId,
      expectedRevision: 1,
      title: "M110-TITLE-UPDATED-SENTINEL",
      body: task.body,
      dueDate: "2026-10-25",
      assigneeMembershipIds: task.assignees.map(({ membershipId }) => membershipId),
      checklist: task.checklist.map(({ id, text, done }) => ({ id, text, done })),
      labels: task.labels.map(({ id, name, color }) => ({ id, name, color })),
    };
    const updated = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, update),
    );
    const updateNoOp = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        ...update,
        expectedRevision: updated.revision,
      }),
    );
    expect(updateNoOp.changed).toBe(false);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "toggle_checklist_item",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: updated.revision,
        checklistItemId: randomUUID(),
        done: true,
      }),
    )).rejects.toBeInstanceOf(ProjectTaskNotFoundError);

    const toggle = (expectedRevision: number, done: boolean) =>
      withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
          schemaVersion: PROJECT_TASK_COMMAND_VERSION,
          kind: "toggle_checklist_item",
          projectId: fixture.projectId,
          taskId: created.taskId,
          expectedRevision,
          checklistItemId,
          done,
        }),
      );
    const toggled = await toggle(updated.revision, true);
    expect((await toggle(toggled.revision, true)).changed).toBe(false);

    const transition = (kind: "complete" | "reopen" | "archive", expectedRevision: number) =>
      withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
          schemaVersion: PROJECT_TASK_COMMAND_VERSION,
          kind,
          projectId: fixture.projectId,
          taskId: created.taskId,
          expectedRevision,
          ...(kind === "archive" ? { archiveConfirmation: "archive" as const } : {}),
        } as ProjectTaskCommandV1),
      );
    const completed = await transition("complete", toggled.revision);
    expect((await transition("complete", completed.revision)).changed).toBe(false);
    const reopened = await transition("reopen", completed.revision);
    expect((await transition("reopen", reopened.revision)).changed).toBe(false);
    const archived = await transition("archive", reopened.revision);
    expect(archived.revision).toBe(6);

    const activity = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId),
    );
    expect(activity?.items.map(({ kind }) => kind)).toEqual([
      "task_archived",
      "task_reopened",
      "task_completed",
      "task_checklist_changed",
      "task_updated",
      "task_created",
    ]);
    expect(activity?.items.every(({ taskId, taskTitle }) => (
      taskId === created.taskId && taskTitle === "M110-TITLE-UPDATED-SENTINEL"
    ))).toBe(true);

    const proof = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{
        event_type: string;
        payload: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select event_type, payload
          from domain_events
         where aggregate_id = ${fixture.projectId}::uuid
           and event_type like 'project.task_%'
         order by occurred_at, id
      `);
      const audits = await tx.execute<{
        details: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select details
          from audit_log
         where details->>'taskId' = ${created.taskId}
           and action = 'task.write'
           and allowed = true
         order by occurred_at, id
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(proof.events.map(({ event_type: eventType }) => eventType)).toEqual([
      "project.task_created",
      "project.task_updated",
      "project.task_checklist_changed",
      "project.task_completed",
      "project.task_reopened",
      "project.task_archived",
    ]);
    expect(proof.audits.map(({ details }) => details))
      .toEqual(proof.events.map(({ payload }) => payload));
    const expectedPayloadKeys: Record<string, string[]> = {
      "project.task_created": ["counts", "kind", "projectId", "revision", "taskId"],
      "project.task_updated": ["changedKeys", "counts", "kind", "projectId", "revision", "taskId"],
      "project.task_checklist_changed": ["changedKeys", "kind", "projectId", "revision", "taskId"],
      "project.task_completed": ["changedKeys", "kind", "projectId", "revision", "taskId"],
      "project.task_reopened": ["changedKeys", "kind", "projectId", "revision", "taskId"],
      "project.task_archived": ["changedKeys", "kind", "projectId", "revision", "taskId"],
    };
    for (const { event_type: eventType, payload } of proof.events) {
      expect(Object.keys(payload).sort()).toEqual(expectedPayloadKeys[eventType]);
      expect(payload).not.toHaveProperty("changeKeys");
    }
    expect(proof.events.map(({ payload }) => payload.changedKeys ?? null)).toEqual([
      null,
      ["title"],
      ["checklist"],
      ["status"],
      ["status"],
      ["archived"],
    ]);
    const serializedEvidence = JSON.stringify(proof);
    for (const secret of [
      "M110-TITLE-SENTINEL",
      "M110-TITLE-UPDATED-SENTINEL",
      "M110-BODY-SENTINEL",
      "M110-CHECKLIST-SENTINEL",
      "M110-LABEL-SENTINEL",
      "M110-CUSTOMER-SENTINEL",
      "customer@m110.test",
      fixture.targetMembershipId,
    ]) {
      expect(serializedEvidence).not.toContain(secret);
    }
  });

  it("paginiert die Task-Projektion mit einem erreichbaren opaken Keysetcursor", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        insert into project_task (
          id, workspace_id, project_id, title, body_version, body,
          created_by, updated_by
        )
        select gen_random_uuid(), ${fixture.workspaceId}::uuid,
               ${fixture.projectId}::uuid, 'Bounded Task ' || value,
               'task-rich-text.v1', '{"type":"doc","content":[]}'::jsonb,
               ${fixture.editorId}::uuid, ${fixture.editorId}::uuid
          from generate_series(1, ${PROJECT_TASK_PAGE_LIMIT + 1}) value
      `),
    );

    const firstPage = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    expect(firstPage?.taskPageLimit).toBe(PROJECT_TASK_PAGE_LIMIT);
    expect(firstPage?.nextTaskCursor).toEqual(expect.any(String));
    expect(firstPage?.open).toHaveLength(PROJECT_TASK_PAGE_LIMIT);
    const cursor = firstPage?.nextTaskCursor;
    if (!cursor) throw new Error("M1-10 next task cursor missing");
    const secondPage = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId, {
        taskCursor: cursor,
      }),
    );
    expect(secondPage?.open).toHaveLength(1);
    expect(secondPage?.nextTaskCursor).toBeNull();
    const firstIds = new Set(firstPage?.open.map(({ id }) => id));
    expect(firstIds.has(secondPage?.open[0]?.id ?? "")).toBe(false);

    for (const options of [
      { archived: true, taskCursor: cursor },
      { taskCursor: "e30" },
    ]) {
      await expect(withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId, options),
      )).rejects.toBeInstanceOf(ProjectTaskValidationError);
    }
  });

  it("ordnet aktive Tasks stabil nach Status, Fälligkeit, Abschluss und UUID", async () => {
    const ids = {
      dueFirst: "00000000-0000-4000-8000-000000000101",
      dueFirstTie: "00000000-0000-4000-8000-000000000102",
      dueSecond: "00000000-0000-4000-8000-000000000103",
      noDue: "00000000-0000-4000-8000-000000000104",
      doneOlder: "00000000-0000-4000-8000-000000000105",
      doneNewer: "00000000-0000-4000-8000-000000000106",
    } as const;
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          insert into project_task (
            id, workspace_id, project_id, title, body_version, body, due_at,
            created_by, updated_by
          ) values
            (${ids.dueSecond}::uuid, ${fixture.workspaceId}::uuid,
              ${fixture.projectId}::uuid, 'due-second', 'task-rich-text.v1',
              '{"type":"doc","content":[]}'::jsonb, '2026-10-02T21:59:59.999Z',
              ${fixture.editorId}::uuid, ${fixture.editorId}::uuid),
            (${ids.dueFirstTie}::uuid, ${fixture.workspaceId}::uuid,
              ${fixture.projectId}::uuid, 'due-first-tie', 'task-rich-text.v1',
              '{"type":"doc","content":[]}'::jsonb, '2026-10-01T21:59:59.999Z',
              ${fixture.editorId}::uuid, ${fixture.editorId}::uuid),
            (${ids.dueFirst}::uuid, ${fixture.workspaceId}::uuid,
              ${fixture.projectId}::uuid, 'due-first', 'task-rich-text.v1',
              '{"type":"doc","content":[]}'::jsonb, '2026-10-01T21:59:59.999Z',
              ${fixture.editorId}::uuid, ${fixture.editorId}::uuid),
            (${ids.noDue}::uuid, ${fixture.workspaceId}::uuid,
              ${fixture.projectId}::uuid, 'no-due', 'task-rich-text.v1',
              '{"type":"doc","content":[]}'::jsonb, null,
              ${fixture.editorId}::uuid, ${fixture.editorId}::uuid),
            (${ids.doneOlder}::uuid, ${fixture.workspaceId}::uuid,
              ${fixture.projectId}::uuid, 'done-older', 'task-rich-text.v1',
              '{"type":"doc","content":[]}'::jsonb, null,
              ${fixture.editorId}::uuid, ${fixture.editorId}::uuid),
            (${ids.doneNewer}::uuid, ${fixture.workspaceId}::uuid,
              ${fixture.projectId}::uuid, 'done-newer', 'task-rich-text.v1',
              '{"type":"doc","content":[]}'::jsonb, null,
              ${fixture.editorId}::uuid, ${fixture.editorId}::uuid)
        `);
        await tx.execute(sql`
          update project_task
             set status = 'done', revision = revision + 1,
                 updated_by = ${fixture.editorId}::uuid
           where id = ${ids.doneOlder}::uuid
        `);
        await tx.execute(sql`
          update project_task
             set status = 'done', revision = revision + 1,
                 updated_by = ${fixture.editorId}::uuid
           where id = ${ids.doneNewer}::uuid
        `);
      },
    );

    const workspace = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    );
    expect(workspace?.open.map(({ title }) => title)).toEqual([
      "due-first",
      "due-first-tie",
      "due-second",
      "no-due",
    ]);
    expect(workspace?.done.map(({ title }) => title)).toEqual([
      "done-newer",
      "done-older",
    ]);
  });

  it("paginiert auch das Archiv vollständig und ohne Cursor-Duplikate", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          insert into project_task (
            id, workspace_id, project_id, title, body_version, body,
            created_by, updated_by
          )
          select gen_random_uuid(), ${fixture.workspaceId}::uuid,
                 ${fixture.projectId}::uuid, 'Archived Task ' || value,
                 'task-rich-text.v1', '{"type":"doc","content":[]}'::jsonb,
                 ${fixture.editorId}::uuid, ${fixture.editorId}::uuid
            from generate_series(1, ${PROJECT_TASK_PAGE_LIMIT + 1}) value
        `);
        await tx.execute(sql`
          update project_task
             set archived_at = statement_timestamp(), revision = revision + 1,
                 updated_by = ${fixture.editorId}::uuid
           where workspace_id = ${fixture.workspaceId}::uuid
             and project_id = ${fixture.projectId}::uuid
        `);
      },
    );

    const firstPage = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId, { archived: true }),
    );
    expect(firstPage?.archivedCount).toBe(PROJECT_TASK_PAGE_LIMIT + 1);
    expect(firstPage?.archived).toHaveLength(PROJECT_TASK_PAGE_LIMIT);
    const cursor = firstPage?.nextTaskCursor;
    if (!cursor) throw new Error("M1-10 archived task cursor missing");
    const secondPage = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId, {
        archived: true,
        taskCursor: cursor,
      }),
    );
    expect(secondPage?.archived).toHaveLength(1);
    expect(secondPage?.nextTaskCursor).toBeNull();
    const firstIds = new Set(firstPage?.archived.map(({ id }) => id));
    expect(firstIds.has(secondPage?.archived[0]?.id ?? "")).toBe(false);
  });

  it("paginiert Project-Activity per stabilem Keysetcursor", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    );
    const completed = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "complete",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: created.revision,
      }),
    );
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind: "reopen",
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: completed.revision,
      }),
    );

    const firstPage = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId, { limit: 2 }),
    );
    expect(firstPage?.items.map(({ kind }) => kind)).toEqual([
      "task_reopened",
      "task_completed",
    ]);
    const compositePage = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskPage(tx, ctx, fixture.projectId, { activityLimit: 2 }),
    );
    expect(compositePage?.activity).toEqual(firstPage);
    const cursor = firstPage?.nextCursor;
    if (!cursor) throw new Error("M1-10 activity cursor missing");
    const secondPage = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId, {
        cursor,
        limit: 2,
      }),
    );
    expect(secondPage?.items.map(({ kind }) => kind)).toEqual(["task_created"]);
    expect(secondPage?.nextCursor).toBeNull();
    expect(new Set([
      ...(firstPage?.items.map(({ id }) => id) ?? []),
      ...(secondPage?.items.map(({ id }) => id) ?? []),
    ]).size).toBe(3);
  });

  it("sucht task.write-gated höchstens 20 interne Members ohne Directory-Projektion", async () => {
    const candidates = Array.from(
      { length: PROJECT_TASK_MEMBER_SEARCH_LIMIT + 1 },
      (_, index) => ({
        userId: randomUUID(),
        membershipId: randomUUID(),
        email: `task-search-${String(index + 1).padStart(3, "0")}-${fixture.workspaceId}@m110.test`,
      }),
    );
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values ${sql.join(candidates.map(({ userId, email }) =>
          sql`(${userId}::uuid, ${email})`), sql`, `)}
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values ${sql.join(candidates.map(({ membershipId, userId }) => sql`(
          ${membershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${userId}::uuid, 'viewer', '{}'::jsonb
        )`), sql`, `)}
      `);
    });

    const page = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => searchProjectTaskMembers(tx, ctx, fixture.projectId, {
        query: "  task-search  ",
      }),
    );
    expect(page?.members).toHaveLength(PROJECT_TASK_MEMBER_SEARCH_LIMIT);
    expect(page?.hasMore).toBe(true);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => searchProjectTaskMembers(tx, ctx, fixture.projectId, {
        query: "task-search",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("hält Membership-Validierung über den Workspace-Lock race-sicher", async () => {
    let executeCount = 0;
    let competingCode: string | undefined;

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const interceptedExecute = (async (
          query: Parameters<TenantTx["execute"]>[0],
        ) => {
          const result = await tx.execute(query);
          executeCount += 1;
          if (executeCount === 3) {
            const competing = await testPool.connect();
            try {
              await competing.query("begin");
              await competing.query("set local lock_timeout = '100ms'");
              await competing.query(
                "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', '', true)",
                [fixture.workspaceId],
              );
              try {
                await competing.query(
                  "update membership set capabilities = '{\"external_only\":true}'::jsonb where workspace_id = $1::uuid and id = $2::uuid",
                  [fixture.workspaceId, fixture.targetMembershipId],
                );
              } catch (error) {
                competingCode = (error as { code?: string }).code;
              }
              await competing.query("rollback");
            } finally {
              competing.release();
            }
          }
          return result;
        }) as TenantTx["execute"];
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "execute") return interceptedExecute;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
        return executeProjectTaskCommand(wrappedTx, ctx, full(fixture));
      },
    );

    expect(competingCode).toBe("55P03");
    expect(executeCount).toBeGreaterThan(2);
  });

  it("projiziert Tasks und Activity aus demselben Statement-Snapshot", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    );
    let executeCount = 0;
    let completed = false;

    const page = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const interceptedExecute = (async (
          query: Parameters<TenantTx["execute"]>[0],
        ) => {
          const result = await tx.execute(query);
          executeCount += 1;
          if (executeCount === 2) {
            await withAuthorizedTenantOn(
              testPool,
              fixture.editorId,
              fixture.workspaceId,
              (writeTx, writeCtx) => executeProjectTaskCommand(writeTx, writeCtx, {
                schemaVersion: PROJECT_TASK_COMMAND_VERSION,
                kind: "complete",
                projectId: fixture.projectId,
                taskId: created.taskId,
                expectedRevision: 1,
              }),
            );
            completed = true;
          }
          return result;
        }) as TenantTx["execute"];
        const wrappedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "execute") return interceptedExecute;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
        return getProjectTaskPage(wrappedTx, ctx, fixture.projectId);
      },
    );

    expect(executeCount).toBe(2);
    expect(completed).toBe(true);
    expect(page?.workspace.open[0]).toMatchObject({ revision: 1, status: "open" });
    expect(page?.workspace.done).toEqual([]);
    expect(page?.activity.items).toHaveLength(1);
    expect(page?.activity.items[0]).toMatchObject({
      kind: "task_created",
      taskId: created.taskId,
      taskTitle: "M110-TITLE-SENTINEL",
    });
  });

  it("lässt bei parallelem gleicher Revision exakt einen Gewinner", async () => {
    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    );
    const mutate = (kind: "complete" | "archive") => withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, {
        schemaVersion: PROJECT_TASK_COMMAND_VERSION,
        kind,
        projectId: fixture.projectId,
        taskId: created.taskId,
        expectedRevision: 1,
        ...(kind === "archive" ? { archiveConfirmation: "archive" as const } : {}),
      } as ProjectTaskCommandV1),
    );
    const results = await Promise.allSettled([mutate("complete"), mutate("archive")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ProjectTaskConflictError);
    }
  });

  it("sperrt Viewer-Mutationen und External Reads/Activity bereits im Service", async () => {
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, quick(fixture)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTaskWorkspace(tx, ctx, fixture.projectId),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) => getProjectActivityPage(tx, ctx, fixture.projectId),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
