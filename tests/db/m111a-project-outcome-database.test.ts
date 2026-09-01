import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { testPool } from "../setup/test-db";

const MIGRATION = "drizzle/0039_m1_11a_project_outcome.sql";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  adminId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  reasonId: string;
  contactId: string;
  siteId: string;
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
  workspaceId: string,
  actorId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withAuthorizedTenantOn(testPool, actorId, workspaceId, work);
}

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    otherWorkspaceId: randomUUID(),
    projectId: randomUUID(),
    adminId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    reasonId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
  };

  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.workspaceId}::uuid, 'M1-11a Outcome Contract')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${fixture.adminId}::uuid, ${`${fixture.adminId}@m111a.test`}),
        (${fixture.editorId}::uuid, ${`${fixture.editorId}@m111a.test`}),
        (${fixture.viewerId}::uuid, ${`${fixture.viewerId}@m111a.test`}),
        (${fixture.externalId}::uuid, ${`${fixture.externalId}@m111a.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.adminId}::uuid, 'admin', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.viewerId}::uuid, 'viewer', '{"external_only":false}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${fixture.contactId}::uuid, ${fixture.workspaceId}::uuid, 'M1-11a Contact',
        ${`${fixture.contactId}@m111a.test`}, ${`${fixture.contactId}@m111a.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${fixture.siteId}::uuid, ${fixture.workspaceId}::uuid,
        ${fixture.contactId}::uuid, 'M1-11a Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key
      )
      select ${fixture.projectId}::uuid, ${fixture.workspaceId}::uuid,
             ${fixture.contactId}::uuid, ${fixture.siteId}::uuid, board.id, intake.id,
             'M1-11a Project', 'request', 'open', 'fixture'
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
      values (${fixture.otherWorkspaceId}::uuid, 'M1-11a Other Tenant')
    `);
  });
  return fixture;
}

async function insertOpenProject(fixture: Fixture, name: string): Promise<string> {
  const projectId = randomUUID();
  const inserted = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, phase, outcome, source_key
    )
    select ${projectId}::uuid, ${fixture.workspaceId}::uuid,
           ${fixture.contactId}::uuid, ${fixture.siteId}::uuid,
           board.id, intake.id, ${name}, 'request', 'open', ${`m111a-${projectId}`}
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
  `));
  if (inserted.rowCount !== 1) throw new Error("M1-11a Sicherheitsprojekt fehlt");
  return projectId;
}

describe.sequential("M1-11a Project-Outcome DB-Vertrag", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await seedFixture();
  });

  it("pinnt Schema, Upgrade, Tenant-FK, Kohärenz und Journal", async () => {
    const [migration, projectSchema, reasonSchema, barrel, journal] = await Promise.all([
      readFile(MIGRATION, "utf8"),
      readFile("lib/db/schema/project.ts", "utf8"),
      readFile("lib/db/schema/project-loss-reason.ts", "utf8"),
      readFile("lib/db/schema/index.ts", "utf8"),
      readFile("drizzle/meta/_journal.json", "utf8"),
    ]);

    expect(reasonSchema).toContain('"project_loss_reason"');
    expect(barrel).toContain('export * from "./project-loss-reason"');
    expect(projectSchema).toContain('outcomeRevision: integer("outcome_revision")');
    expect(projectSchema).toContain('closedAt: timestamp("closed_at"');
    expect(projectSchema).toContain('lossReasonId: uuid("loss_reason_id")');
    expect(projectSchema).toContain('lossReasonText: text("loss_reason_text")');
    expect(migration).toContain('CREATE TABLE "project_loss_reason"');
    expect(migration).toContain('ADD COLUMN "outcome_revision" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain('ADD COLUMN "closed_at" timestamp with time zone');
    expect(migration).toContain("project_outcome_state_ck");
    expect(migration).toContain("project_outcome_revision_ck");
    expect(migration).toContain("project_loss_reason_fk");
    expect(migration).toContain("project_ws_request_closed_idx");
    expect(migration).toContain("M1-11a kann bestehende Lost-Projects ohne strukturierten Grund nicht migrieren");
    expect(migration).toMatch(/SET closed_at = updated_at[\s\S]+outcome IN \('won', 'cannot_fulfill'\)/u);
    expect(JSON.parse(journal).entries.at(-1)).toMatchObject({
      idx: 39,
      tag: "0039_m1_11a_project_outcome",
    });
  });

  it("erzwingt FORCE RLS, genau eine permissive Policy und geschlossene ACLs", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    expect(migration).toContain("ALTER TABLE public.project_loss_reason ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE public.project_loss_reason FORCE ROW LEVEL SECURITY");
    expect(migration.match(/CREATE POLICY tenant_isolation ON public\.project_loss_reason/g))
      .toHaveLength(1);
    expect(migration).toContain("project_loss_reason_actor_select");
    expect(migration).toContain("project_loss_reason_actor_insert");
    expect(migration).toContain("project_loss_reason_actor_update");
    expect(migration).toContain("project_loss_reason_actor_delete");
    expect(migration).toContain("AS RESTRICTIVE FOR SELECT");
    expect(migration).toContain("REVOKE ALL ON public.project_loss_reason FROM PUBLIC");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON public.project_loss_reason TO app_runtime");
    expect(migration).not.toMatch(/GRANT[^;]+project_loss_reason[^;]+app_worker/iu);

    const relation = await testPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where oid = 'public.project_loss_reason'::regclass
    `);
    expect(relation.rows).toEqual([{
      relrowsecurity: true,
      relforcerowsecurity: true,
    }]);

    const policies = await testPool.query<{
      policyname: string;
      permissive: string;
      cmd: string;
    }>(`
      select policyname, permissive, cmd
        from pg_catalog.pg_policies
       where schemaname = 'public' and tablename = 'project_loss_reason'
       order by policyname
    `);
    expect(policies.rows).toHaveLength(5);
    expect(policies.rows.filter(({ permissive }) => permissive === "PERMISSIVE"))
      .toEqual([{ policyname: "tenant_isolation", permissive: "PERMISSIVE", cmd: "ALL" }]);
    expect(policies.rows.filter(({ permissive }) => permissive === "RESTRICTIVE")
      .map(({ cmd }) => cmd).sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("verweigert vorweggenommene Closed-Inserts ohne Project- oder Evidenzrest", async () => {
    const rejectedProjectId = randomUUID();
    const insertError = await rejected(asActor(
      fixture.workspaceId,
      fixture.editorId,
      async (tx) => tx.execute(sql`
        insert into project (
          id, workspace_id, contact_id, site_id, kanban_board_id,
          kanban_column_id, name, phase, outcome, outcome_revision,
          closed_at, source_key
        )
        select ${rejectedProjectId}::uuid, ${fixture.workspaceId}::uuid,
               ${fixture.contactId}::uuid, ${fixture.siteId}::uuid,
               board.id, intake.id, 'Vorweggenommen geschlossen',
               'request', 'won', 1, statement_timestamp(),
               ${`m111a-preclosed-${rejectedProjectId}`}
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
      `),
    ));
    expect(postgresCode(insertError)).toBe("23514");

    const residue = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      projects: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from project
          where id = ${rejectedProjectId}::uuid) as projects,
        (select count(*)::int from domain_events
          where aggregate_id = ${rejectedProjectId}::uuid) as events,
        (select count(*)::int from audit_log
          where details->>'projectId' = ${rejectedProjectId}) as audits
    `));
    expect(residue.rows[0]).toEqual({ projects: 0, events: 0, audits: 0 });
  });

  it("bindet Transition und Evidenz positiv an Membership und den DB-Trigger", async () => {
    const securedProjectId = await insertOpenProject(fixture, "Actor- und Evidenzgrenze");
    const fakePayload = {
      projectId: securedProjectId,
      previousOutcome: "open",
      nextOutcome: "won",
      outcomeRevision: 1,
    };

    const fakeEvent = await rejected(asActor(
      fixture.workspaceId,
      fixture.editorId,
      async (tx) => tx.execute(sql`
        insert into domain_events (
          workspace_id, aggregate_type, aggregate_id, event_type, actor, payload
        ) values (
          ${fixture.workspaceId}::uuid, 'project', ${securedProjectId}::uuid,
          'project.outcome_won', ${fixture.editorId},
          ${JSON.stringify(fakePayload)}::jsonb
        )
      `),
    ));
    expect(postgresCode(fakeEvent)).toBe("23514");

    const fakeAudit = await rejected(asActor(
      fixture.workspaceId,
      fixture.editorId,
      async (tx) => tx.execute(sql`
        insert into audit_log (
          workspace_id, actor, action, resource, allowed, details
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.editorId},
          'project.outcome.write', 'project', true,
          ${JSON.stringify(fakePayload)}::jsonb
        )
      `),
    ));
    expect(postgresCode(fakeAudit)).toBe("23514");

    const missingActor = await rejected(withTenantOn(
      testPool,
      fixture.workspaceId,
      async (tx) => tx.execute(sql`
        update project
           set outcome = 'won', outcome_revision = 1,
               closed_at = statement_timestamp(), updated_at = statement_timestamp()
         where id = ${securedProjectId}::uuid
      `),
    ));
    expect(postgresCode(missingActor)).toBe("23514");

    const strangerId = randomUUID();
    const missingMembership = await withTenantOn(
      testPool,
      fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`select set_config('app.actor_id', ${strangerId}, true)`);
        return tx.execute(sql`
          update project
             set outcome = 'won', outcome_revision = 1,
                 closed_at = statement_timestamp(), updated_at = statement_timestamp()
           where id = ${securedProjectId}::uuid
        `);
      },
    );
    expect(missingMembership.rowCount).toBe(0);

    await asActor(fixture.workspaceId, fixture.editorId, (tx) => tx.execute(sql`
      update project
         set outcome = 'won', outcome_revision = 1,
             closed_at = statement_timestamp(), updated_at = statement_timestamp()
       where id = ${securedProjectId}::uuid
    `));
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
       where project_record.id = ${securedProjectId}::uuid
    `));
    expect(proof.rows[0]).toEqual({
      outcome: "won",
      outcome_revision: 1,
      events: 1,
      audits: 1,
    });
  });

  it("lässt nur Admins kanonische Gründe erstellen und interne Actors lesen", async () => {
    await asActor(fixture.workspaceId, fixture.adminId, async (tx) => {
      await tx.execute(sql`
        insert into project_loss_reason (
          id, workspace_id, label, position
        ) values (
          ${fixture.reasonId}::uuid, ${fixture.workspaceId}::uuid,
          'Kein Budget', 1
        )
      `);
    });

    for (const actorId of [fixture.adminId, fixture.editorId, fixture.viewerId]) {
      const rows = await asActor(fixture.workspaceId, actorId, async (tx) => tx.execute<{
        id: string;
      }>(sql`
        select id from project_loss_reason where id = ${fixture.reasonId}::uuid
      `));
      expect(rows.rows).toEqual([{ id: fixture.reasonId }]);
    }
    const externalRows = await asActor(
      fixture.workspaceId,
      fixture.externalId,
      async (tx) => tx.execute(sql`
        select id from project_loss_reason where id = ${fixture.reasonId}::uuid
      `),
    );
    expect(externalRows.rows).toEqual([]);

    for (const actorId of [fixture.editorId, fixture.viewerId, fixture.externalId]) {
      const error = await rejected(asActor(fixture.workspaceId, actorId, async (tx) => tx.execute(sql`
        insert into project_loss_reason (workspace_id, label, position)
        values (${fixture.workspaceId}::uuid, 'Nicht erlaubt', 2)
      `)));
      expect(["23514", "42501"]).toContain(postgresCode(error));
    }

    for (const label of [" kein budget ", "Ｌｅｇａｃｙ", "Mehr\nZeilen"] as const) {
      const error = await rejected(asActor(fixture.workspaceId, fixture.adminId, async (tx) => tx.execute(sql`
        insert into project_loss_reason (workspace_id, label, position)
        values (${fixture.workspaceId}::uuid, ${label}, 2)
      `)));
      expect(["23505", "23514"]).toContain(postgresCode(error));
    }
  });

  it("erzwingt revisionsgebundenes Archive/Reactivate und verbietet Delete/Truncate", async () => {
    await asActor(fixture.workspaceId, fixture.adminId, async (tx) => {
      const archived = await tx.execute<{ revision: number }>(sql`
        update project_loss_reason
           set archived_at = statement_timestamp(), revision = revision + 1,
               updated_at = statement_timestamp()
         where id = ${fixture.reasonId}::uuid and revision = 1
         returning revision
      `);
      expect(archived.rows).toEqual([{ revision: 2 }]);
    });

    const invalidRevision = await rejected(asActor(
      fixture.workspaceId,
      fixture.adminId,
      async (tx) => tx.execute(sql`
        update project_loss_reason
           set revision = revision + 2, updated_at = statement_timestamp()
         where id = ${fixture.reasonId}::uuid
      `),
    ));
    expect(postgresCode(invalidRevision)).toBe("23514");

    await asActor(fixture.workspaceId, fixture.adminId, async (tx) => {
      const reactivated = await tx.execute<{ revision: number }>(sql`
        update project_loss_reason
           set archived_at = null, revision = revision + 1,
               updated_at = statement_timestamp()
         where id = ${fixture.reasonId}::uuid and revision = 2
         returning revision
      `);
      expect(reactivated.rows).toEqual([{ revision: 3 }]);
    });

    const deleted = await asActor(
      fixture.workspaceId,
      fixture.adminId,
      async (tx) => tx.execute(sql`
        delete from project_loss_reason where id = ${fixture.reasonId}::uuid
      `),
    );
    expect(deleted.rowCount).toBe(0);
    const retained = await asActor(
      fixture.workspaceId,
      fixture.adminId,
      async (tx) => tx.execute<{ id: string }>(sql`
        select id from project_loss_reason where id = ${fixture.reasonId}::uuid
      `),
    );
    expect(retained.rows).toEqual([{ id: fixture.reasonId }]);
    const truncated = await rejected(testPool.query("truncate public.project_loss_reason"));
    expect(postgresCode(truncated)).toBe("0A000");
  });

  it("erzwingt Lost/Reopen/Won als kohärente Request-State-Machine", async () => {
    const lost = await asActor(fixture.workspaceId, fixture.editorId, async (tx) => tx.execute<{
      outcome: string;
      outcome_revision: number;
      closed_at: Date;
      loss_reason_id: string;
      loss_reason_text: string;
    }>(sql`
      update project
         set outcome = 'lost', outcome_revision = 1,
             closed_at = statement_timestamp(),
             loss_reason_id = ${fixture.reasonId}::uuid,
             loss_reason_text = 'Kunde hat verschoben',
             updated_at = statement_timestamp()
       where id = ${fixture.projectId}::uuid and outcome_revision = 0
       returning outcome, outcome_revision, closed_at,
                 loss_reason_id, loss_reason_text
    `));
    expect(lost.rows[0]).toMatchObject({
      outcome: "lost",
      outcome_revision: 1,
      loss_reason_id: fixture.reasonId,
      loss_reason_text: "Kunde hat verschoben",
    });
    expect(Number.isFinite(new Date(lost.rows[0]!.closed_at).valueOf())).toBe(true);

    const illegalWon = await rejected(asActor(
      fixture.workspaceId,
      fixture.editorId,
      async (tx) => tx.execute(sql`
        update project
           set outcome = 'won', outcome_revision = 2,
               loss_reason_id = null, loss_reason_text = null,
               updated_at = statement_timestamp()
         where id = ${fixture.projectId}::uuid
      `),
    ));
    expect(postgresCode(illegalWon)).toBe("23514");

    const reopened = await asActor(fixture.workspaceId, fixture.editorId, async (tx) => tx.execute<{
      outcome: string;
      outcome_revision: number;
    }>(sql`
      update project
         set outcome = 'open', outcome_revision = 2, closed_at = null,
             loss_reason_id = null, loss_reason_text = null,
             updated_at = statement_timestamp()
       where id = ${fixture.projectId}::uuid and outcome_revision = 1
       returning outcome, outcome_revision
    `));
    expect(reopened.rows).toEqual([{ outcome: "open", outcome_revision: 2 }]);

    const won = await asActor(fixture.workspaceId, fixture.editorId, async (tx) => tx.execute<{
      outcome: string;
      outcome_revision: number;
    }>(sql`
      update project
         set outcome = 'won', outcome_revision = 3,
             closed_at = statement_timestamp(),
             updated_at = statement_timestamp()
       where id = ${fixture.projectId}::uuid and outcome_revision = 2
       returning outcome, outcome_revision
    `));
    expect(won.rows).toEqual([{ outcome: "won", outcome_revision: 3 }]);
  });

  it("sperrt Viewer/External, fremde oder archivierte Reasons und Feldbypass", async () => {
    const viewerWrite = await rejected(asActor(
      fixture.workspaceId,
      fixture.viewerId,
      async (tx) => tx.execute(sql`
        update project
           set outcome = 'open', outcome_revision = 4, closed_at = null,
               updated_at = statement_timestamp()
         where id = ${fixture.projectId}::uuid
      `),
    ));
    expect(postgresCode(viewerWrite)).toBe("23514");

    const externalWrite = await asActor(
      fixture.workspaceId,
      fixture.externalId,
      async (tx) => tx.execute(sql`
        update project
           set outcome = 'open', outcome_revision = 4, closed_at = null,
               updated_at = statement_timestamp()
         where id = ${fixture.projectId}::uuid
      `),
    );
    expect(externalWrite.rowCount).toBe(0);

    const fieldBypass = await rejected(asActor(
      fixture.workspaceId,
      fixture.editorId,
      async (tx) => tx.execute(sql`
        update project
           set closed_at = statement_timestamp(), updated_at = statement_timestamp()
         where id = ${fixture.projectId}::uuid
      `),
    ));
    expect(postgresCode(fieldBypass)).toBe("23514");
  });
});
