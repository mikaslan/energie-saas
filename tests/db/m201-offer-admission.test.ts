import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { withTenantOn } from "@/lib/db/tenant";
import {
  reserveOfferMutationAttempt,
  type OfferMutationAdmission,
} from "@/lib/integrations/offers/admission";
import type { Action, ServiceCtx } from "@/lib/permissions";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  adminA: ServiceCtx;
  adminB: ServiceCtx;
  viewer: ServiceCtx;
};

type CounterRow = {
  scope: "actor" | "workspace";
  actor_id: string | null;
  attempts: number;
  window_start: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

async function createFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const adminAId = randomUUID();
  const adminBId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M2-01 Admission')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${adminAId}::uuid, ${`${adminAId}@m201-admission.test`}),
        (${adminBId}::uuid, ${`${adminBId}@m201-admission.test`}),
        (${viewerId}::uuid, ${`${viewerId}@m201-admission.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${workspaceId}::uuid, ${adminAId}::uuid, 'admin', '{}'::jsonb),
        (${workspaceId}::uuid, ${adminBId}::uuid, 'admin', '{}'::jsonb),
        (${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  const context = (actor: string, role: "admin" | "viewer"): ServiceCtx => ({
    workspaceId,
    actor,
    role,
    capabilities: {},
    featureFlags: {},
  });
  return {
    workspaceId,
    adminA: context(adminAId, "admin"),
    adminB: context(adminBId, "admin"),
    viewer: context(viewerId, "viewer"),
  };
}

function reserve(
  fixture: Fixture,
  ctx: ServiceCtx,
  action: Action = "price.edit",
): Promise<OfferMutationAdmission> {
  return withTenantOn(testPool, fixture.workspaceId, (tx) =>
    reserveOfferMutationAttempt(tx, ctx, action));
}

async function counters(fixture: Fixture): Promise<CounterRow[]> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<CounterRow>(sql`
      select scope, actor_id, attempts, window_start, created_at, updated_at
        from offer_mutation_rate_window
       where workspace_id = ${fixture.workspaceId}::uuid
       order by scope, actor_id nulls first
    `);
    return result.rows;
  });
}

async function seedCounter(
  fixture: Fixture,
  input: { scope: "actor" | "workspace"; actorId?: string; attempts: number },
): Promise<void> {
  await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
    insert into offer_mutation_rate_window (
      workspace_id, scope, actor_id, window_start, attempts
    ) values (
      ${fixture.workspaceId}::uuid, ${input.scope},
      ${input.actorId ?? null}::uuid,
      date_bin(
        interval '15 minutes', clock_timestamp(),
        timestamptz '1970-01-01 00:00:00+00'
      ),
      ${input.attempts}
    )
  `));
}

describe.sequential("M2-01 Offer-Mutationsquote", () => {
  it("committet die fachinhaltsfreie Admission vor einem Domain-Rollback", async () => {
    const fixture = await createFixture();

    await expect(reserve(fixture, fixture.adminA)).resolves.toMatchObject({
      status: "admitted",
      actor: fixture.adminA.actor,
    });
    await expect(withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into audit_log (
          workspace_id, actor, action, resource, allowed, details
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.adminA.actor},
          'price.edit', 'offer_variant', true, '{}'::jsonb
        )
      `);
      throw new Error("synthetic domain rollback");
    })).rejects.toThrow("synthetic domain rollback");

    const rows = await counters(fixture);
    expect(rows.map(({ scope, actor_id: actorId, attempts }) => ({
      scope,
      actorId,
      attempts,
    }))).toEqual([
      { scope: "actor", actorId: fixture.adminA.actor, attempts: 1 },
      { scope: "workspace", actorId: null, attempts: 1 },
    ]);
    const rolledBackAudit = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute(sql`
        select 1 from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and resource = 'offer_variant'
      `));
    expect(rolledBackAudit.rows).toEqual([]);
  });

  it("zählt grobes Denied nur beim Actor und belastet die Workspacequote nicht", async () => {
    const fixture = await createFixture();

    await expect(reserve(fixture, fixture.viewer, "price.edit")).resolves.toEqual({
      status: "denied",
      actor: fixture.viewer.actor,
      action: "price.edit",
      reason: "capability",
    });

    const rows = await counters(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "actor",
      actor_id: fixture.viewer.actor,
      attempts: 1,
    });
  });

  it("behandelt ein malformed external_only niemals als internen Actor", async () => {
    const fixture = await createFixture();
    const malformed = {
      ...fixture.adminA,
      capabilities: { external_only: "false" },
    } as unknown as ServiceCtx;

    await expect(reserve(fixture, malformed)).resolves.toEqual({
      status: "denied",
      actor: fixture.adminA.actor,
      action: "price.edit",
      reason: "external_only_without_assignment",
    });
    const rows = await counters(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "actor",
      actor_id: fixture.adminA.actor,
      attempts: 1,
    });
  });

  it("blockiert nach einer Zählung niemals den Entzug der Membership", async () => {
    const fixture = await createFixture();
    await expect(reserve(fixture, fixture.adminA)).resolves.toMatchObject({
      status: "admitted",
    });

    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      delete from membership
       where workspace_id = ${fixture.workspaceId}::uuid
         and user_id = ${fixture.adminA.actor}::uuid
    `))).resolves.toBeDefined();

    const rows = await counters(fixture);
    expect(rows.some((row) => row.scope === "actor"
      && row.actor_id === fixture.adminA.actor)).toBe(false);
    expect(rows.find((row) => row.scope === "workspace")).toMatchObject({ attempts: 1 });
  });

  it("entscheidet den Actor-Grenzwert 119/120/121 unter Race exakt einmal", async () => {
    const fixture = await createFixture();
    await seedCounter(fixture, {
      scope: "actor",
      actorId: fixture.adminA.actor,
      attempts: 119,
    });

    const results = await Promise.all([
      reserve(fixture, fixture.adminA),
      reserve(fixture, fixture.adminA),
    ]);

    expect(results.filter((result) => result.status === "admitted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rate_limited")).toHaveLength(1);
    const rows = await counters(fixture);
    expect(rows.find((row) => row.scope === "actor")).toMatchObject({ attempts: 120 });
    expect(rows.find((row) => row.scope === "workspace")).toMatchObject({ attempts: 1 });
  });

  it("entscheidet den Workspace-Grenzwert 1199/1200/1201 unter Race ohne Actor-Verlust", async () => {
    const fixture = await createFixture();
    await seedCounter(fixture, { scope: "workspace", attempts: 1199 });

    const results = await Promise.all([
      reserve(fixture, fixture.adminA),
      reserve(fixture, fixture.adminB),
    ]);

    expect(results.filter((result) => result.status === "admitted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rate_limited")).toHaveLength(1);
    const rows = await counters(fixture);
    expect(rows.find((row) => row.scope === "workspace")).toMatchObject({ attempts: 1200 });
    expect(rows.filter((row) => row.scope === "actor")).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor_id: fixture.adminA.actor, attempts: 1 }),
      expect.objectContaining({ actor_id: fixture.adminB.actor, attempts: 1 }),
    ]));
  });

  it("liefert bei erschöpfter Quote exakt das feste UTC-Fensterende", async () => {
    const fixture = await createFixture();
    await seedCounter(fixture, {
      scope: "actor",
      actorId: fixture.adminA.actor,
      attempts: 120,
    });

    const result = await reserve(fixture, fixture.adminA);
    expect(result.status).toBe("rate_limited");
    if (result.status !== "rate_limited") throw new Error("rate limit expected");
    expect(result.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|15|30|45):00\.000Z$/u);

    const actor = (await counters(fixture)).find((row) => row.scope === "actor");
    expect(actor).toBeDefined();
    expect(new Date(result.retryAfter).getTime() - new Date(actor!.window_start).getTime())
      .toBe(15 * 60 * 1_000);
    expect(actor).toMatchObject({ attempts: 120 });
  });

  it.runIf(process.env.M201_REAL_QUARTER_BOUNDARY === "1")(
    "belastet einen echten Lock-Waiter erst in der physisch erreichten neuen UTC-Viertelstunde",
    async () => {
      const fixture = await createFixture();
      const blocker = await testPool.connect();
      const workspaceLockKey = `offer-rate:workspace:${fixture.workspaceId}`;
      let blockerOpen = false;
      try {
        await blocker.query("begin");
        blockerOpen = true;
        const timing = await blocker.query<{
          blocker_pid: number;
          old_window: Date | string;
          boundary: Date | string;
        }>(`
          select pg_catalog.pg_backend_pid() as blocker_pid,
                 date_bin(
                   interval '15 minutes', clock_timestamp(),
                   timestamptz '1970-01-01 00:00:00+00'
                 ) as old_window,
                 date_bin(
                   interval '15 minutes', clock_timestamp(),
                   timestamptz '1970-01-01 00:00:00+00'
                 ) + interval '15 minutes' as boundary
        `);
        const clock = timing.rows[0];
        if (!clock) throw new Error("Physische Viertelstunden-Uhr fehlt.");
        await blocker.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [workspaceLockKey],
        );

        const admission = reserve(fixture, fixture.adminA);
        const waitDeadline = Date.now() + 5_000;
        let waiterObserved = false;
        while (Date.now() < waitDeadline) {
          const waiting = await testPool.query<{ waiting: boolean }>(`
            select exists (
              select 1
                from pg_catalog.pg_stat_activity activity
               where $1::integer = any(pg_catalog.pg_blocking_pids(activity.pid))
                 and activity.wait_event_type = 'Lock'
            ) as waiting
          `, [clock.blocker_pid]);
          if (waiting.rows[0]?.waiting) {
            waiterObserved = true;
            break;
          }
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
        }
        expect(waiterObserved).toBe(true);

        const boundaryMs = new Date(clock.boundary).getTime();
        const remainingMs = boundaryMs - Date.now() + 150;
        if (remainingMs > 0) {
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, remainingMs));
        }
        await blocker.query("commit");
        blockerOpen = false;

        await expect(admission).resolves.toMatchObject({ status: "admitted" });
        const rows = await counters(fixture);
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => new Date(row.window_start).toISOString()))
          .toEqual([new Date(clock.boundary).toISOString(), new Date(clock.boundary).toISOString()]);
        expect(new Date(clock.boundary).getTime())
          .toBe(new Date(clock.old_window).getTime() + 15 * 60 * 1_000);
      } finally {
        if (blockerOpen) await blocker.query("rollback").catch(() => undefined);
        blocker.release();
      }
    },
    16 * 60 * 1_000,
  );

  it("pinnt die globale UTC-Viertelstunde an beiden exakten Grenzzeitpunkten", async () => {
    const fixture = await createFixture();
    const result = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{
        input: Date | string;
        bucket: Date | string;
        [key: string]: unknown;
      }>(sql`
        select input, date_bin(
          interval '15 minutes', input,
          timestamptz '1970-01-01 00:00:00+00'
        ) as bucket
        from (values
          (timestamptz '2026-08-30 12:14:59.999999+00'),
          (timestamptz '2026-08-30 12:15:00.000000+00')
        ) as boundaries(input)
        order by input
      `));

    expect(result.rows.map((row) => new Date(row.bucket).toISOString())).toEqual([
      "2026-08-30T12:00:00.000Z",
      "2026-08-30T12:15:00.000Z",
    ]);
  });
});
