import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  internalId: string;
  externalAId: string;
  externalBId: string;
  malformedId: string;
  explicitFalseId: string;
  crossTenantId: string;
  externalAMembershipId: string;
  externalBMembershipId: string;
  malformedMembershipId: string;
  crossTenantMembershipId: string;
  assignedOpenProjectId: string;
  unassignedProjectId: string;
  otherAssignedProjectId: string;
  assignedOfferProjectId: string;
  assignedClosedProjectId: string;
  crossTenantProjectId: string;
};

function postgresField(error: unknown, field: "code" | "constraint"): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as Record<string, unknown> & { cause?: unknown };
    if (typeof candidate[field] === "string") return candidate[field];
    current = candidate.cause;
  }
  return undefined;
}

async function expectPostgresCode(
  work: Promise<unknown>,
  code: string | readonly string[],
): Promise<unknown> {
  const failure = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).not.toBeNull();
  if (Array.isArray(code)) expect(code).toContain(postgresField(failure, "code"));
  else expect(postgresField(failure, "code")).toBe(code);
  return failure;
}

async function withRawActor<T>(
  fixture: Fixture,
  actorId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`select set_config('app.actor_id', ${actorId}, true)`);
    return work(tx);
  });
}

async function withRuntimeActor<T>(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenantOn(pool, workspaceId, async (tx) => {
    await tx.execute(sql`select set_config('app.actor_id', ${actorId}, true)`);
    return work(tx);
  });
}

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    otherWorkspaceId: randomUUID(),
    internalId: randomUUID(),
    externalAId: randomUUID(),
    externalBId: randomUUID(),
    malformedId: randomUUID(),
    explicitFalseId: randomUUID(),
    crossTenantId: randomUUID(),
    externalAMembershipId: randomUUID(),
    externalBMembershipId: randomUUID(),
    malformedMembershipId: randomUUID(),
    crossTenantMembershipId: randomUUID(),
    assignedOpenProjectId: randomUUID(),
    unassignedProjectId: randomUUID(),
    otherAssignedProjectId: randomUUID(),
    assignedOfferProjectId: randomUUID(),
    assignedClosedProjectId: randomUUID(),
    crossTenantProjectId: randomUUID(),
  };
  const internalMembershipId = randomUUID();
  const explicitFalseMembershipId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();

  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.workspaceId}::uuid, 'M1-09 RLS A')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${fixture.internalId}::uuid, ${`internal-${fixture.internalId}@m109-rls.test`}),
        (${fixture.externalAId}::uuid, ${`external-a-${fixture.externalAId}@m109-rls.test`}),
        (${fixture.externalBId}::uuid, ${`external-b-${fixture.externalBId}@m109-rls.test`}),
        (${fixture.malformedId}::uuid, ${`malformed-${fixture.malformedId}@m109-rls.test`}),
        (${fixture.explicitFalseId}::uuid, ${`false-${fixture.explicitFalseId}@m109-rls.test`}),
        (${fixture.crossTenantId}::uuid, ${`cross-${fixture.crossTenantId}@m109-rls.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${internalMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.internalId}::uuid, 'editor', '{}'::jsonb),
        (${fixture.externalAMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.externalAId}::uuid, 'viewer', '{"external_only":true}'::jsonb),
        (${fixture.externalBMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.externalBId}::uuid, 'viewer', '{"external_only":true}'::jsonb),
        (${fixture.malformedMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.malformedId}::uuid, 'viewer', '{"external_only":"false"}'::jsonb),
        (${explicitFalseMembershipId}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.explicitFalseId}::uuid, 'viewer', '{"external_only":false}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid, 'M1-09 RLS Contact A', 'Fixture', 'Contact',
        ${`contact-a-${contactId}@m109-rls.test`},
        ${`contact-a-${contactId}@m109-rls.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${fixture.workspaceId}::uuid, ${contactId}::uuid, 'RLS Site A')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key
      )
      select project_seed.id, ${fixture.workspaceId}::uuid,
             ${contactId}::uuid, ${siteId}::uuid,
             board.id, intake.id, project_seed.name,
             project_seed.phase, project_seed.outcome, 'manual'
        from (
          values
            (${fixture.assignedOpenProjectId}::uuid, 'Assigned Open'::text,
              'request'::text, 'open'::text),
            (${fixture.unassignedProjectId}::uuid, 'Unassigned Open'::text,
              'request'::text, 'open'::text),
            (${fixture.otherAssignedProjectId}::uuid, 'Other Assigned'::text,
              'request'::text, 'open'::text),
            (${fixture.assignedOfferProjectId}::uuid, 'Assigned Offer'::text,
              'offer'::text, 'open'::text),
            (${fixture.assignedClosedProjectId}::uuid, 'Assigned Closed'::text,
              'request'::text, 'open'::text)
        ) as project_seed(id, name, phase, outcome)
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
    `);
    await tx.execute(sql`
      insert into project_assignment (
        workspace_id, project_id, membership_id, assignment_role
      ) values
        (${fixture.workspaceId}::uuid, ${fixture.assignedOpenProjectId}::uuid,
          ${fixture.externalAMembershipId}::uuid, 'user'),
        (${fixture.workspaceId}::uuid, ${fixture.otherAssignedProjectId}::uuid,
          ${fixture.externalBMembershipId}::uuid, 'key_account'),
        (${fixture.workspaceId}::uuid, ${fixture.assignedOfferProjectId}::uuid,
          ${fixture.externalAMembershipId}::uuid, 'user'),
        (${fixture.workspaceId}::uuid, ${fixture.assignedClosedProjectId}::uuid,
          ${fixture.externalAMembershipId}::uuid, 'user')
    `);
  });

  await withRawActor(fixture, fixture.internalId, async (tx) => {
    await tx.execute(sql`
      update project
         set outcome = 'won', outcome_revision = 1,
             updated_at = statement_timestamp()
       where id = ${fixture.assignedClosedProjectId}::uuid
    `);
  });

  const crossContactId = randomUUID();
  const crossSiteId = randomUUID();
  await withTenantOn(testPool, fixture.otherWorkspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.otherWorkspaceId}::uuid, 'M1-09 RLS B')
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${fixture.crossTenantMembershipId}::uuid, ${fixture.otherWorkspaceId}::uuid,
        ${fixture.crossTenantId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${crossContactId}::uuid, ${fixture.otherWorkspaceId}::uuid,
        'M1-09 RLS Contact B', 'Fixture', 'Contact', ${`contact-b-${crossContactId}@m109-rls.test`},
        ${`contact-b-${crossContactId}@m109-rls.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${crossSiteId}::uuid, ${fixture.otherWorkspaceId}::uuid,
        ${crossContactId}::uuid, 'RLS Site B')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key
      )
      select ${fixture.crossTenantProjectId}::uuid, ${fixture.otherWorkspaceId}::uuid,
             ${crossContactId}::uuid, ${crossSiteId}::uuid,
             board.id, intake.id, 'Cross Tenant', 'request', 'open', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${fixture.otherWorkspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
    `);
  });

  return fixture;
}

describe("M1-09 direkte Project-/Assignment-RLS", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("filtert rohe Reads nach Tenant, direkter Zuweisung und request/open", async () => {
    const internal = await withAuthorizedTenantOn(
      testPool,
      fixture.internalId,
      fixture.workspaceId,
      async (tx) => {
        const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
          select id from project order by id
        `);
        const assignments = await tx.execute<{
          project_id: string;
          [key: string]: unknown;
        }>(sql`select project_id from project_assignment order by project_id`);
        return {
          projects: projects.rows.map(({ id }) => id),
          assignments: assignments.rows.map(({ project_id: id }) => id),
        };
      },
    );
    expect(internal.projects).toEqual([
      fixture.assignedClosedProjectId,
      fixture.assignedOfferProjectId,
      fixture.assignedOpenProjectId,
      fixture.otherAssignedProjectId,
      fixture.unassignedProjectId,
    ].sort());
    expect(internal.assignments).toEqual([
      fixture.assignedClosedProjectId,
      fixture.assignedOfferProjectId,
      fixture.assignedOpenProjectId,
      fixture.otherAssignedProjectId,
    ].sort());

    const externalA = await withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      async (tx) => {
        const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
          select id from project order by id
        `);
        const assignments = await tx.execute<{
          project_id: string;
          [key: string]: unknown;
        }>(sql`select project_id from project_assignment order by project_id`);
        return {
          projects: projects.rows.map(({ id }) => id),
          assignments: assignments.rows.map(({ project_id: id }) => id),
        };
      },
    );
    expect(externalA.projects).toEqual([fixture.assignedOpenProjectId]);
    expect(externalA.assignments).toEqual([
      fixture.assignedClosedProjectId,
      fixture.assignedOfferProjectId,
      fixture.assignedOpenProjectId,
    ].sort());

    const externalB = await withAuthorizedTenantOn(
      testPool,
      fixture.externalBId,
      fixture.workspaceId,
      async (tx) => {
        const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
          select id from project order by id
        `);
        const assignments = await tx.execute<{
          project_id: string;
          [key: string]: unknown;
        }>(sql`select project_id from project_assignment order by project_id`);
        return {
          projects: projects.rows.map(({ id }) => id),
          assignments: assignments.rows.map(({ project_id: id }) => id),
        };
      },
    );
    expect(externalB).toEqual({
      projects: [fixture.otherAssignedProjectId],
      assignments: [fixture.otherAssignedProjectId],
    });
  });

  it("behandelt fehlende und fehlgeformte external_only-Kontexte fail-closed", async () => {
    const malformed = await withRawActor(fixture, fixture.malformedId, async (tx) => {
      const flag = await tx.execute<{ external: boolean; [key: string]: unknown }>(sql`
        select public.app_actor_is_external_only(${fixture.workspaceId}::uuid) as external
      `);
      const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
        select id from project order by id
      `);
      return { external: flag.rows[0].external, projects: projects.rows };
    });
    expect(malformed).toEqual({ external: true, projects: [] });

    const missing = await withRawActor(fixture, randomUUID(), async (tx) => {
      const flag = await tx.execute<{ external: boolean; [key: string]: unknown }>(sql`
        select public.app_actor_is_external_only(${fixture.workspaceId}::uuid) as external
      `);
      const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
        select id from project order by id
      `);
      return { external: flag.rows[0].external, projects: projects.rows };
    });
    expect(missing).toEqual({ external: true, projects: [] });

    const explicitFalse = await withRawActor(fixture, fixture.explicitFalseId, async (tx) => {
      const flag = await tx.execute<{ external: boolean; [key: string]: unknown }>(sql`
        select public.app_actor_is_external_only(${fixture.workspaceId}::uuid) as external
      `);
      const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
        select id from project order by id
      `);
      return { external: flag.rows[0].external, projectCount: projects.rows.length };
    });
    expect(explicitFalse).toEqual({ external: false, projectCount: 5 });
  });

  it("sperrt External-DML direkt in PostgreSQL und lässt den Bestand unverändert", async () => {
    await expectPostgresCode(withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        insert into project_assignment (
          workspace_id, project_id, membership_id, assignment_role
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.unassignedProjectId}::uuid,
          ${fixture.externalAMembershipId}::uuid, 'user'
        )
      `),
    ), "42501");

    const assignmentUpdate = await withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        update project_assignment
           set assignment_role = 'key_account'
         where workspace_id = ${fixture.workspaceId}::uuid
           and project_id = ${fixture.assignedOpenProjectId}::uuid
        returning id
      `),
    );
    const assignmentDelete = await withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        delete from project_assignment
         where workspace_id = ${fixture.workspaceId}::uuid
           and project_id = ${fixture.assignedOpenProjectId}::uuid
        returning id
      `),
    );
    const projectUpdate = await withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        update project
           set name = 'External mutation must not persist'
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.assignedOpenProjectId}::uuid
        returning id
      `),
    );
    const projectDelete = await withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        delete from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.assignedOpenProjectId}::uuid
        returning id
      `),
    );
    expect(assignmentUpdate.rows).toHaveLength(0);
    expect(assignmentDelete.rows).toHaveLength(0);
    expect(projectUpdate.rows).toHaveLength(0);
    expect(projectDelete.rows).toHaveLength(0);

    await expectPostgresCode(withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        insert into project (
          id, workspace_id, contact_id, site_id, kanban_board_id,
          kanban_column_id, name, phase, outcome, source_key
        )
        select ${randomUUID()}::uuid, workspace_id, contact_id, site_id,
               kanban_board_id, kanban_column_id, 'External Insert',
               phase, outcome, source_key
          from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.assignedOpenProjectId}::uuid
      `),
    ), "42501");

    await expectPostgresCode(withRawActor(
      fixture,
      fixture.malformedId,
      (tx) => tx.execute(sql`
        insert into project_assignment (
          workspace_id, project_id, membership_id, assignment_role
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.unassignedProjectId}::uuid,
          ${fixture.malformedMembershipId}::uuid, 'user'
        )
      `),
    ), "42501");

    const proof = await withAuthorizedTenantOn(
      testPool,
      fixture.internalId,
      fixture.workspaceId,
      async (tx) => {
        const project = await tx.execute<{ name: string; [key: string]: unknown }>(sql`
          select name from project where id = ${fixture.assignedOpenProjectId}::uuid
        `);
        const assignment = await tx.execute<{
          assignment_role: string;
          [key: string]: unknown;
        }>(sql`
          select assignment_role from project_assignment
           where project_id = ${fixture.assignedOpenProjectId}::uuid
        `);
        return { project: project.rows, assignment: assignment.rows };
      },
    );
    expect(proof).toEqual({
      project: [{ name: "Assigned Open" }],
      assignment: [{ assignment_role: "user" }],
    });
  });

  it("weist Cross-Tenant-Assignment an RLS ab und benennt den Offboarding-FK exakt", async () => {
    await expectPostgresCode(withAuthorizedTenantOn(
      testPool,
      fixture.internalId,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        insert into project_assignment (
          workspace_id, project_id, membership_id, assignment_role
        ) values (
          ${fixture.otherWorkspaceId}::uuid, ${fixture.crossTenantProjectId}::uuid,
          ${fixture.crossTenantMembershipId}::uuid, 'user'
        )
      `),
    ), "42501");

    // ON DELETE RESTRICT meldet je nach PG-Version 23001 (klassisch) oder
    // 23503 (Embedded-PG18 in CI, 2026-09-05) — der Constraint-Name-Assert
    // unten pinnt, dass exakt der Offboarding-FK feuerte.
    const membershipFailure = await expectPostgresCode(withTenantOn(
      testPool,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        delete from membership
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.externalAMembershipId}::uuid
      `),
    ), ["23001", "23503"]);
    expect(postgresField(membershipFailure, "constraint"))
      .toBe("project_assignment_membership_fk");
  });
});

describe.sequential("M1-09 Actor-RLS als echte app_runtime-Loginrolle", () => {
  it("erzwingt die migrierten Rollen-Policies und ACLs funktional als Non-Owner", async () => {
    const embedded = await startEmbeddedPostgres();
    const admin = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    const owner = new Pool({ connectionString: embedded.url, max: 2 });
    let runtime: Pool | undefined;

    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const internalId = randomUUID();
    const externalId = randomUUID();
    const internalMembershipId = randomUUID();
    const externalMembershipId = randomUUID();
    const assignedOpenProjectId = randomUUID();
    const unassignedProjectId = randomUUID();
    const assignedOfferProjectId = randomUUID();
    const assignedClosedProjectId = randomUUID();
    const crossTenantProjectId = randomUUID();

    try {
      await admin.query(`
        create role app_runtime login password 'm109_runtime_contract'
          noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
        create role app_worker nologin
          noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
      `);
      await migrate(drizzle(owner), { migrationsFolder: resolve("drizzle") });
      // Der Test-Runner migriert bewusst im Legacy-Single-Role-Modus und führt
      // deshalb das strikte Post-Migrations-ACL-Manifest nicht aus. Für diesen
      // isolierten Rollenpfad installieren wir exakt dessen bereits separat
      // kataloggeprüften Core-Read-/Project-Rechte. Die neuen Assignment- und
      // Helper-Rechte bleiben ausschließlich das Ergebnis von Migration 0037.
      await owner.query(`
        grant usage on schema public to app_runtime;
        grant select on
          public.workspace,
          public.membership,
          public.user_identity,
          public.project
        to app_runtime;
        grant insert, update on public.project to app_runtime;
        grant execute on function public.app_actor_id() to app_runtime;
      `);

      await withTenantOn(owner, workspaceA, async (tx) => {
        const contactId = randomUUID();
        const siteId = randomUUID();
        await tx.execute(sql`
          insert into workspace (id, name)
          values (${workspaceA}::uuid, 'M1-09 Runtime A')
        `);
        await tx.execute(sql`
          insert into user_identity (id, email)
          values
            (${internalId}::uuid, ${`internal-${internalId}@m109-runtime.test`}),
            (${externalId}::uuid, ${`external-${externalId}@m109-runtime.test`})
        `);
        await tx.execute(sql`
          insert into membership (id, workspace_id, user_id, role, capabilities)
          values
            (${internalMembershipId}::uuid, ${workspaceA}::uuid,
              ${internalId}::uuid, 'editor', '{}'::jsonb),
            (${externalMembershipId}::uuid, ${workspaceA}::uuid,
              ${externalId}::uuid, 'viewer', '{"external_only":true}'::jsonb)
        `);
        await tx.execute(sql`
          insert into contact (
            id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
          ) values (
            ${contactId}::uuid, ${workspaceA}::uuid, 'Runtime Contact A', 'Fixture', 'Contact',
            ${`contact-${contactId}@m109-runtime.test`},
            ${`contact-${contactId}@m109-runtime.test`}
          )
        `);
        await tx.execute(sql`
          insert into site (id, workspace_id, contact_id, label)
          values (${siteId}::uuid, ${workspaceA}::uuid, ${contactId}::uuid, 'Runtime Site A')
        `);
        await tx.execute(sql`
          insert into project (
            id, workspace_id, contact_id, site_id, kanban_board_id,
            kanban_column_id, name, phase, outcome, source_key
          )
          select project_seed.id, ${workspaceA}::uuid, ${contactId}::uuid,
                 ${siteId}::uuid, board.id, intake.id, project_seed.name,
                 project_seed.phase, project_seed.outcome, 'manual'
            from (
              values
                (${assignedOpenProjectId}::uuid, 'Assigned Open'::text,
                  'request'::text, 'open'::text),
                (${unassignedProjectId}::uuid, 'Unassigned Open'::text,
                  'request'::text, 'open'::text),
                (${assignedOfferProjectId}::uuid, 'Assigned Offer'::text,
                  'offer'::text, 'open'::text),
                (${assignedClosedProjectId}::uuid, 'Assigned Closed'::text,
                  'request'::text, 'open'::text)
            ) as project_seed(id, name, phase, outcome)
            join kanban_board board
              on board.workspace_id = ${workspaceA}::uuid
             and board.scope = 'residential'
             and board.is_default = true
             and board.archived_at is null
            join kanban_column intake
              on intake.workspace_id = board.workspace_id
             and intake.board_id = board.id
             and intake.is_intake = true
             and intake.archived_at is null
        `);
        await tx.execute(sql`
          insert into project_assignment (
            workspace_id, project_id, membership_id, assignment_role
          ) values
            (${workspaceA}::uuid, ${assignedOpenProjectId}::uuid,
              ${externalMembershipId}::uuid, 'user'),
            (${workspaceA}::uuid, ${assignedOfferProjectId}::uuid,
              ${externalMembershipId}::uuid, 'user'),
            (${workspaceA}::uuid, ${assignedClosedProjectId}::uuid,
              ${externalMembershipId}::uuid, 'user')
        `);
      });

      await withRuntimeActor(owner, workspaceA, internalId, async (tx) => {
        await tx.execute(sql`
          update project
             set outcome = 'won', outcome_revision = 1,
                 updated_at = statement_timestamp()
           where id = ${assignedClosedProjectId}::uuid
        `);
      });

      await withTenantOn(owner, workspaceB, async (tx) => {
        const contactId = randomUUID();
        const siteId = randomUUID();
        await tx.execute(sql`
          insert into workspace (id, name)
          values (${workspaceB}::uuid, 'M1-09 Runtime B')
        `);
        await tx.execute(sql`
          insert into contact (
            id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
          ) values (
            ${contactId}::uuid, ${workspaceB}::uuid, 'Runtime Contact B', 'Fixture', 'Contact',
            ${`contact-${contactId}@m109-runtime.test`},
            ${`contact-${contactId}@m109-runtime.test`}
          )
        `);
        await tx.execute(sql`
          insert into site (id, workspace_id, contact_id, label)
          values (${siteId}::uuid, ${workspaceB}::uuid, ${contactId}::uuid, 'Runtime Site B')
        `);
        await tx.execute(sql`
          insert into project (
            id, workspace_id, contact_id, site_id, kanban_board_id,
            kanban_column_id, name, phase, outcome, source_key
          )
          select ${crossTenantProjectId}::uuid, ${workspaceB}::uuid,
                 ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id,
                 'Cross Tenant', 'request', 'open', 'manual'
            from kanban_board board
            join kanban_column intake
              on intake.workspace_id = board.workspace_id
             and intake.board_id = board.id
             and intake.is_intake = true
             and intake.archived_at is null
           where board.workspace_id = ${workspaceB}::uuid
             and board.scope = 'residential'
             and board.is_default = true
             and board.archived_at is null
        `);
      });

      const runtimeUrl = new URL(embedded.url);
      runtimeUrl.username = "app_runtime";
      runtimeUrl.password = "m109_runtime_contract";
      runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 3 });

      const catalog = await admin.query<{
        owner: string;
        actor_policy_count: number;
        actor_policies_runtime_only: boolean;
        runtime_select: boolean;
        runtime_insert: boolean;
        runtime_update: boolean;
        runtime_delete: boolean;
        runtime_membership_helper: boolean;
        runtime_external_helper: boolean;
        worker_table_access: boolean;
        worker_membership_helper: boolean;
        worker_external_helper: boolean;
      }>(`
        select owner.rolname as owner,
               (select count(*)::int
                  from pg_catalog.pg_policies policy
                 where policy.schemaname = 'public'
                   and policy.tablename in ('project', 'project_assignment')
                   and policy.policyname in (
                     'project_assignment_actor_select',
                     'project_assignment_actor_insert_guard',
                     'project_assignment_actor_update_guard',
                     'project_assignment_actor_delete_guard',
                     'project_external_select_scope',
                     'project_external_insert_guard',
                     'project_external_update_guard',
                     'project_external_delete_guard'
                   )) as actor_policy_count,
               (select bool_and(policy.roles = '{app_runtime}'::name[])
                  from pg_catalog.pg_policies policy
                 where policy.schemaname = 'public'
                   and policy.tablename in ('project', 'project_assignment')
                   and policy.policyname like any(array[
                     'project_assignment_actor_%', 'project_external_%'
                   ])) as actor_policies_runtime_only,
               pg_catalog.has_table_privilege(
                 'app_runtime', 'public.project_assignment', 'SELECT'
               ) as runtime_select,
               pg_catalog.has_table_privilege(
                 'app_runtime', 'public.project_assignment', 'INSERT'
               ) as runtime_insert,
               pg_catalog.has_table_privilege(
                 'app_runtime', 'public.project_assignment', 'UPDATE'
               ) as runtime_update,
               pg_catalog.has_table_privilege(
                 'app_runtime', 'public.project_assignment', 'DELETE'
               ) as runtime_delete,
               pg_catalog.has_function_privilege(
                 'app_runtime', 'public.app_actor_membership_id(uuid)', 'EXECUTE'
               ) as runtime_membership_helper,
               pg_catalog.has_function_privilege(
                 'app_runtime', 'public.app_actor_is_external_only(uuid)', 'EXECUTE'
               ) as runtime_external_helper,
               pg_catalog.has_table_privilege(
                 'app_worker', 'public.project_assignment', 'SELECT'
               ) or pg_catalog.has_table_privilege(
                 'app_worker', 'public.project_assignment', 'INSERT'
               ) or pg_catalog.has_table_privilege(
                 'app_worker', 'public.project_assignment', 'UPDATE'
               ) or pg_catalog.has_table_privilege(
                 'app_worker', 'public.project_assignment', 'DELETE'
               ) as worker_table_access,
               pg_catalog.has_function_privilege(
                 'app_worker', 'public.app_actor_membership_id(uuid)', 'EXECUTE'
               ) as worker_membership_helper,
               pg_catalog.has_function_privilege(
                 'app_worker', 'public.app_actor_is_external_only(uuid)', 'EXECUTE'
               ) as worker_external_helper
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace
            on namespace.oid = relation.relnamespace
          join pg_catalog.pg_roles owner on owner.oid = relation.relowner
         where namespace.nspname = 'public'
           and relation.relname = 'project_assignment'
      `);
      expect(catalog.rows[0]).toEqual({
        owner: "app_test",
        actor_policy_count: 8,
        actor_policies_runtime_only: true,
        runtime_select: true,
        runtime_insert: true,
        runtime_update: true,
        runtime_delete: true,
        runtime_membership_helper: true,
        runtime_external_helper: true,
        worker_table_access: false,
        worker_membership_helper: false,
        worker_external_helper: false,
      });

      const external = await withRuntimeActor(
        runtime,
        workspaceA,
        externalId,
        async (tx) => {
          const identity = await tx.execute<{
            session_role: string;
            current_role: string;
            bypasses_rls: boolean;
            [key: string]: unknown;
          }>(sql`
            select session_user::text as session_role,
                   current_user::text as current_role,
                   (select rolbypassrls from pg_catalog.pg_roles
                     where rolname = current_user) as bypasses_rls
          `);
          const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
            select id from project order by id
          `);
          const assignments = await tx.execute<{
            project_id: string;
            [key: string]: unknown;
          }>(sql`select project_id from project_assignment order by project_id`);
          const update = await tx.execute(sql`
            update project_assignment
               set assignment_role = 'key_account'
             where project_id = ${assignedOpenProjectId}::uuid
            returning id
          `);
          const deletion = await tx.execute(sql`
            delete from project_assignment
             where project_id = ${assignedOpenProjectId}::uuid
            returning id
          `);
          return {
            identity: identity.rows[0],
            projects: projects.rows.map(({ id }) => id),
            assignments: assignments.rows.map(({ project_id: id }) => id),
            updated: update.rows.length,
            deleted: deletion.rows.length,
          };
        },
      );
      expect(external).toEqual({
        identity: {
          session_role: "app_runtime",
          current_role: "app_runtime",
          bypasses_rls: false,
        },
        projects: [assignedOpenProjectId],
        assignments: [
          assignedClosedProjectId,
          assignedOfferProjectId,
          assignedOpenProjectId,
        ].sort(),
        updated: 0,
        deleted: 0,
      });

      await expectPostgresCode(withRuntimeActor(
        runtime,
        workspaceA,
        externalId,
        (tx) => tx.execute(sql`
          insert into project_assignment (
            workspace_id, project_id, membership_id, assignment_role
          ) values (
            ${workspaceA}::uuid, ${unassignedProjectId}::uuid,
            ${externalMembershipId}::uuid, 'user'
          )
        `),
      ), "42501");

      const internal = await withRuntimeActor(
        runtime,
        workspaceA,
        internalId,
        async (tx) => {
          const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
            select id from project order by id
          `);
          const inserted = await tx.execute(sql`
            insert into project_assignment (
              workspace_id, project_id, membership_id, assignment_role
            ) values (
              ${workspaceA}::uuid, ${unassignedProjectId}::uuid,
              ${internalMembershipId}::uuid, 'user'
            )
            returning id
          `);
          return { projects: projects.rows.map(({ id }) => id), inserted: inserted.rows.length };
        },
      );
      expect(internal).toEqual({
        projects: [
          assignedClosedProjectId,
          assignedOfferProjectId,
          assignedOpenProjectId,
          unassignedProjectId,
        ].sort(),
        inserted: 1,
      });

      const crossTenant = await withRuntimeActor(
        runtime,
        workspaceB,
        externalId,
        (tx) => tx.execute<{ id: string; [key: string]: unknown }>(sql`
          select id from project order by id
        `),
      );
      expect(crossTenant.rows).toEqual([]);
    } finally {
      await runtime?.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
    }
  }, 120_000);
});
