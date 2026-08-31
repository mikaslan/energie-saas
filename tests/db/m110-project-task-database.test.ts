import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { testPool } from "../setup/test-db";

const MIGRATION = "drizzle/0038_m1_10_project_task.sql";
const TABLES = [
  "project_task",
  "project_task_assignee",
  "project_task_checklist_item",
  "project_task_label",
] as const;
const EMPTY_DOC = { type: "doc", content: [] };

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  viewerMembershipId: string;
  externalId: string;
  externalMembershipId: string;
};

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function rejected(work: Promise<unknown>): Promise<unknown> {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).not.toBeNull();
  return error;
}

async function asActor<T>(
  fixture: Fixture,
  actorId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    async (tx) => work(tx),
  );
}

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    otherWorkspaceId: randomUUID(),
    projectId: randomUUID(),
    editorId: randomUUID(),
    editorMembershipId: randomUUID(),
    viewerId: randomUUID(),
    viewerMembershipId: randomUUID(),
    externalId: randomUUID(),
    externalMembershipId: randomUUID(),
  };
  const contactId = randomUUID();
  const siteId = randomUUID();

  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.workspaceId}::uuid, 'M1-10 Task Contract')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${fixture.editorId}::uuid, ${`${fixture.editorId}@m110.test`}),
        (${fixture.viewerId}::uuid, ${`${fixture.viewerId}@m110.test`}),
        (${fixture.externalId}::uuid, ${`${fixture.externalId}@m110.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${fixture.editorMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.editorId}::uuid, 'editor', '{}'::jsonb),
        (${fixture.viewerMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.viewerId}::uuid, 'viewer', '{"external_only":false}'::jsonb),
        (${fixture.externalMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.externalId}::uuid, 'viewer', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'M1-10 Contact',
        ${`${contactId}@m110.test`}, ${`${contactId}@m110.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${fixture.workspaceId}::uuid,
        ${contactId}::uuid, 'M1-10 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key
      )
      select ${fixture.projectId}::uuid, ${fixture.workspaceId}::uuid,
             ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id,
             'M1-10 Project', 'request', 'open', 'fixture'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${fixture.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
    `);
  });

  await withTenantOn(testPool, fixture.otherWorkspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.otherWorkspaceId}::uuid, 'M1-10 Other Tenant')
    `);
  });
  return fixture;
}

describe.sequential("M1-10 Project-Task DB-Vertrag", () => {
  let fixture: Fixture;
  let taskId: string;

  beforeAll(async () => {
    fixture = await seedFixture();
  });

  it("pinnt vier task-owned Tabellen, Limits und die getrennte Rich-Text-v1-Ablage", async () => {
    const [migration, schema, barrel, erasureSchema, journal] = await Promise.all([
      readFile(MIGRATION, "utf8"),
      readFile("lib/db/schema/project-task.ts", "utf8"),
      readFile("lib/db/schema/index.ts", "utf8"),
      readFile("lib/db/schema/erasure.ts", "utf8"),
      readFile("drizzle/meta/_journal.json", "utf8"),
    ]);

    for (const table of TABLES) {
      expect(schema).toContain(`\"${table}\"`);
      expect(migration).toContain(`CREATE TABLE \"${table}\"`);
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(barrel).toContain('export * from "./project-task"');
    expect(schema).toContain('bodyVersion: text("body_version")');
    expect(schema).toContain('body: jsonb("body")');
    expect(schema).toContain('revision: integer("revision")');
    expect(migration).toContain("task-rich-text.v1");
    expect(migration).toContain("32768");
    expect(migration).toContain("500");
    expect(migration).toContain("10000");
    expect(migration).toContain("depth > 8");
    expect(migration).toContain("project_task_checklist_position_ck");
    expect(migration).toContain("project_task_label_color_ck");
    expect(migration).toContain("project_task_revision_ck");
    expect(erasureSchema).toMatch(/taskIds\?: string\[\]/u);
    expect(JSON.parse(journal).entries.at(-1)).toMatchObject({
      idx: 38,
      tag: "0038_m1_10_project_task",
    });
  });

  it("pinnt Allowlist, interne Rollen, geschlossene ACLs und den Erasure-Upgradepfad", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    expect(migration).toContain("_m110_valid_task_rich_text_v1");
    expect(migration).toMatch(/paragraph[\s\S]+heading[\s\S]+bulletList[\s\S]+orderedList[\s\S]+listItem[\s\S]+hardBreak[\s\S]+text/u);
    expect(migration).toMatch(/bold[\s\S]+italic/u);
    expect(migration).not.toMatch(/INSERT INTO public\.domain_events/iu);
    expect(migration).toContain("_m110_actor_can_read_tasks");
    expect(migration).toContain("_m110_actor_can_write_tasks");
    expect(migration).toContain("external_only");
    expect(migration).toContain("actor_role NOT IN ('viewer', 'editor', 'admin')");
    expect(migration).toContain("IN ('editor', 'admin')");
    expect(migration).toContain("CURRENT_USER = ''app_owner''");
    expect(migration).toContain("REVOKE ALL ON public.project_task FROM PUBLIC");
    expect(migration).not.toMatch(/GRANT[^;]+project_task[^;]+app_worker/iu);
    expect(migration).toContain("1d865e697787271c715ee6a606f5cc6463456c53ee0c2fb5c906213e5170287c");
    expect(migration).toContain("build_inactive_lead_erasure_graph_m203b1");
    expect(migration).toContain("'taskIds'");
    expect(migration).toContain("operational_graph_document->'taskIds'");
    expect(migration).toContain("DELETE FROM public.project_task AS task_record");
  });

  it("erstellt Revision 1 und validiert das kanonische leere Dokument", async () => {
    taskId = randomUUID();
    const created = await asActor(fixture, fixture.editorId, async (tx) => tx.execute<{
      id: string;
      revision: number;
      body_version: string;
      body: unknown;
      status: string;
    }>(sql`
      insert into project_task (
        id, workspace_id, project_id, title, body_version, body,
        created_by, updated_by
      ) values (
        ${taskId}::uuid, ${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid,
        'Unterlagen pruefen', 'task-rich-text.v1', ${JSON.stringify(EMPTY_DOC)}::jsonb,
        ${fixture.editorId}::uuid, ${fixture.editorId}::uuid
      )
      returning id, revision, body_version, body, status
    `));
    expect(created.rows[0]).toEqual({
      id: taskId,
      revision: 1,
      body_version: "task-rich-text.v1",
      body: EMPTY_DOC,
      status: "open",
    });

    const complexBody = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Montage", marks: [{ type: "bold" }] }],
        },
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [{
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "Termin" }, { type: "hardBreak" }],
            }],
          }],
        },
      ],
    };
    const validated = await asActor(fixture, fixture.editorId, async (tx) => tx.execute<{ valid: boolean }>(sql`
      select public._m110_valid_task_rich_text_v1(${JSON.stringify(complexBody)}::jsonb) as valid
    `));
    expect(validated.rows).toEqual([{ valid: true }]);
  });

  it("weist unbekannte Nodes sowie Byte-, Knoten-, Tiefen- und Textueberlauf in der DB ab", async () => {
    const bodies: unknown[] = [
      { type: "doc", content: [{ type: "image", attrs: { src: "https://example.test/x" } }] },
      { type: "doc", content: [{ type: "paragraph", attrs: { style: "color:red" } }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(6_000) }, { type: "text", text: "y".repeat(6_000) }] }] },
      { type: "doc", content: Array.from({ length: 500 }, () => ({ type: "paragraph", content: [] })) },
      { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [] }] }] }] }] }] }] }] }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "😀".repeat(9_000) }] }] },
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "bold" }] }] }] },
    ];
    for (const body of bodies) {
      const error = await rejected(asActor(fixture, fixture.editorId, async (tx) => tx.execute(sql`
        insert into project_task (
          workspace_id, project_id, title, body_version, body, created_by, updated_by
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'Invalid',
          'task-rich-text.v1', ${JSON.stringify(body)}::jsonb,
          ${fixture.editorId}::uuid, ${fixture.editorId}::uuid
        )
      `)));
      expect(postgresCode(error)).toBe("23514");
    }
  });

  it("laesst interne Viewer nur lesen und schliesst External strukturell aus", async () => {
    const actorlessRows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => tx.execute<{ id: string }>(sql`
      select id from project_task where id = ${taskId}::uuid
    `));
    expect(actorlessRows.rows).toEqual([]);

    const viewerRows = await asActor(fixture, fixture.viewerId, async (tx) => tx.execute<{ id: string }>(sql`
      select id from project_task where id = ${taskId}::uuid
    `));
    expect(viewerRows.rows).toEqual([{ id: taskId }]);

    const viewerWrite = await asActor(fixture, fixture.viewerId, async (tx) => tx.execute(sql`
      update project_task set title = 'Viewer write', revision = revision + 1,
        updated_by = ${fixture.viewerId}::uuid
      where id = ${taskId}::uuid
    `));
    expect(viewerWrite.rowCount).toBe(0);

    const externalRows = await asActor(fixture, fixture.externalId, async (tx) => tx.execute<{ id: string }>(sql`
      select id from project_task where id = ${taskId}::uuid
    `));
    expect(externalRows.rows).toEqual([]);
    const externalWrite = await rejected(asActor(fixture, fixture.externalId, async (tx) => tx.execute(sql`
      insert into project_task (
        workspace_id, project_id, title, body_version, body, created_by, updated_by
      ) values (
        ${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'External',
        'task-rich-text.v1', ${JSON.stringify(EMPTY_DOC)}::jsonb,
        ${fixture.externalId}::uuid, ${fixture.externalId}::uuid
      )
    `)));
    expect(postgresCode(externalWrite)).toBe("23514");
  });

  it("besitzt exakt eine permissive Tenant-Policy und restriktive Actor-Policies", async () => {
    const relations = await testPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname
    `, [TABLES]);
    expect(relations.rows).toEqual([...TABLES].sort().map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));

    const policies = await testPool.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
    }>(`
      select tablename, policyname, permissive, cmd
        from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = any($1::text[])
       order by tablename, policyname
    `, [TABLES]);
    for (const table of TABLES) {
      const tablePolicies = policies.rows.filter(({ tablename }) => tablename === table);
      expect(tablePolicies).toHaveLength(5);
      expect(tablePolicies.filter(({ permissive }) => permissive === "PERMISSIVE"))
        .toEqual([{ tablename: table, policyname: "tenant_isolation", permissive: "PERMISSIVE", cmd: "ALL" }]);
      expect(tablePolicies.filter(({ permissive }) => permissive === "RESTRICTIVE").map(({ cmd }) => cmd).sort())
        .toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }
  });

  it("erzwingt interne Assignees, Kindlimits, Completion-Kohaerenz und einwegiges Archiv", async () => {
    await asActor(fixture, fixture.editorId, async (tx) => {
      await tx.execute(sql`
        insert into project_task_assignee (workspace_id, task_id, membership_id)
        values (${fixture.workspaceId}::uuid, ${taskId}::uuid,
          ${fixture.viewerMembershipId}::uuid)
      `);
    });
    const externalAssignee = await rejected(asActor(fixture, fixture.editorId, async (tx) => tx.execute(sql`
      insert into project_task_assignee (workspace_id, task_id, membership_id)
      values (${fixture.workspaceId}::uuid, ${taskId}::uuid,
        ${fixture.externalMembershipId}::uuid)
    `)));
    expect(postgresCode(externalAssignee)).toBe("23514");

    const overChecklist = await rejected(asActor(fixture, fixture.editorId, async (tx) => tx.execute(sql`
      insert into project_task_checklist_item (
        workspace_id, task_id, position, text, is_done
      )
      select ${fixture.workspaceId}::uuid, ${taskId}::uuid, value, 'Punkt ' || value, false
        from generate_series(0, 100) as value
    `)));
    expect(postgresCode(overChecklist)).toBe("23514");

    const overLabels = await rejected(asActor(fixture, fixture.editorId, async (tx) => tx.execute(sql`
      insert into project_task_label (workspace_id, task_id, position, name, color)
      select ${fixture.workspaceId}::uuid, ${taskId}::uuid, value,
             'Label ' || value, 'slate'
        from generate_series(0, 15) as value
    `)));
    expect(postgresCode(overLabels)).toBe("23514");

    await asActor(fixture, fixture.editorId, async (tx) => {
      await tx.execute(sql`
        update project_task
           set status = 'done', completed_at = now(), revision = 2,
               updated_by = ${fixture.editorId}::uuid
         where id = ${taskId}::uuid and revision = 1
      `);
      await tx.execute(sql`
        update project_task
           set archived_at = now(), revision = 3,
               updated_by = ${fixture.editorId}::uuid
         where id = ${taskId}::uuid and revision = 2
      `);
    });

    const archivedMutation = await rejected(asActor(fixture, fixture.editorId, async (tx) => tx.execute(sql`
      update project_task
         set archived_at = null, revision = 4,
             updated_by = ${fixture.editorId}::uuid
       where id = ${taskId}::uuid and revision = 3
    `)));
    expect(postgresCode(archivedMutation)).toBe("23514");
  });
});
