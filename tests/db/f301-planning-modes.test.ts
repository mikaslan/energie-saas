import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION } from "@/lib/integrations/planning/contract";
import {
  getPlanningModeDefaultForVariantCreation,
  getPlanningSettings,
  PlanningSettingsConflictError,
  PlanningSettingsValidationError,
  upsertPlanningSettings,
} from "@/modules/planning";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  adminId: string;
  editorId: string;
  viewerId: string;
  externalAdminId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalAdminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'F3.1 Planung')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${adminId}::uuid, ${`admin-${adminId}@f301.test`}),
        (${editorId}::uuid, ${`editor-${editorId}@f301.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f301.test`}),
        (${externalAdminId}::uuid, ${`external-${externalAdminId}@f301.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
          'admin', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
          'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
          'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalAdminId}::uuid,
          'admin', '{"external_only":true}'::jsonb)
    `);
  });
  return { workspaceId, adminId, editorId, viewerId, externalAdminId };
}

function command(baseRevision: number, defaultPlanningMode: "quick" | "2d" | "3d") {
  return {
    schemaVersion: WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
    baseRevision,
    defaultPlanningMode,
  };
}

describe("F3.1 Planungsmodi — PostgreSQL", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F301-DB-01 liefert 3D/Revision 0 und erzwingt CAS ab Revision 1", async () => {
    const empty = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) => getPlanningSettings(tx, ctx),
    );
    expect(empty).toMatchObject({
      revision: 0,
      defaultPlanningMode: "3d",
      permissions: { canWrite: false },
    });

    const created = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command(0, "2d")),
    );
    expect(created).toMatchObject({ revision: 1, defaultPlanningMode: "2d" });
    const updated = await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command(1, "quick")),
    );
    expect(updated).toMatchObject({ revision: 2, defaultPlanningMode: "quick" });
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command(1, "3d")),
    )).rejects.toMatchObject({
      name: PlanningSettingsConflictError.name,
      currentRevision: 2,
    });
  });

  it("F301-DB-02 erlaubt interne Reads, aber nur internem Admin den Write", async () => {
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getPlanningSettings(tx, ctx),
    )).resolves.toMatchObject({ defaultPlanningMode: "3d" });
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command(0, "2d")),
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalAdminId,
      fixture.workspaceId,
      (tx, ctx) => getPlanningSettings(tx, ctx),
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalAdminId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command(0, "2d")),
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  it("F301-DB-03 pinnt Membership-FK, Mode-CHECK, RLS/FORCE und no-truncate", async () => {
    let modeError: unknown;
    try {
      await withAuthorizedTenantOn(
        testPool,
        fixture.adminId,
        fixture.workspaceId,
        (tx) => tx.execute(sql`
          insert into workspace_planning_settings (
            workspace_id, default_planning_mode, revision, updated_by
          ) values (
            ${fixture.workspaceId}::uuid, '4d', 1, ${fixture.adminId}::uuid
          )
        `),
      );
    } catch (error) {
      modeError = error;
    }
    expect((modeError as { cause?: { code?: string; constraint?: string } }).cause)
      .toMatchObject({ code: "23514", constraint: "workspace_planning_settings_mode_ck" });

    const foreignWorkspace = randomUUID();
    const foreignAdmin = randomUUID();
    await withTenantOn(testPool, foreignWorkspace, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name) values (${foreignWorkspace}::uuid, 'F3.1 Fremd')
      `);
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${foreignAdmin}::uuid, ${`foreign-${foreignAdmin}@f301.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${foreignWorkspace}::uuid,
          ${foreignAdmin}::uuid, 'admin', '{}'::jsonb)
      `);
    });
    let foreignKeyError: unknown;
    try {
      await withAuthorizedTenantOn(
        testPool,
        fixture.adminId,
        fixture.workspaceId,
        (tx) => tx.execute(sql`
          insert into workspace_planning_settings (
            workspace_id, default_planning_mode, revision, updated_by
          ) values (
            ${fixture.workspaceId}::uuid, '3d', 1, ${foreignAdmin}::uuid
          )
        `),
      );
    } catch (error) {
      foreignKeyError = error;
    }
    expect((foreignKeyError as { cause?: { code?: string; constraint?: string } }).cause)
      .toMatchObject({
        code: "23503",
        constraint: "workspace_planning_settings_updated_by_fk",
      });

    const flags = await testPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where oid = 'public.workspace_planning_settings'::regclass
    `);
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const snapshotChecks = await testPool.query<{ definition: string }>(`
      select pg_catalog.pg_get_constraintdef(oid, true) as definition
        from pg_catalog.pg_constraint
       where conrelid = 'public.offer_variant_revision'::regclass
         and conname = 'offer_variant_revision_json_ck'
    `);
    expect(snapshotChecks.rows[0]?.definition).toContain("revision_snapshot ? 'planningMode'");
    expect(snapshotChecks.rows[0]?.definition).toContain("offer-variant-snapshot.v4");
    await expect(testPool.query(
      "truncate table public.workspace_planning_settings",
    )).rejects.toThrow(/forbid_mutation|TRUNCATE|append-only/u);
  });

  it("F301-DB-04 serialisiert Default-Write und Variant-Creation-Read", async () => {
    let signalWriterReady!: () => void;
    let releaseWriter!: () => void;
    const writerReady = new Promise<void>((resolve) => { signalWriterReady = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });

    const writer = withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const result = await upsertPlanningSettings(tx, ctx, command(0, "2d"));
        signalWriterReady();
        await writerRelease;
        return result;
      },
    );
    await writerReady;
    const reader = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getPlanningModeDefaultForVariantCreation(tx, ctx),
    );
    const releaseTimer = setTimeout(releaseWriter, 25);
    try {
      const [written, observed] = await Promise.all([writer, reader]);
      expect(written.defaultPlanningMode).toBe("2d");
      expect(observed).toBe("2d");
    } finally {
      clearTimeout(releaseTimer);
      releaseWriter();
    }
  });

  it("F301-DB-05 schreibt exakt ein Event/Audit und mappt DB-Checks", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, command(0, "3d")),
    );
    const evidence = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ event_type: string; [key: string]: unknown }>(sql`
        select event_type from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_type = 'workspace_planning_settings'
      `);
      const audits = await tx.execute<{ action: string; [key: string]: unknown }>(sql`
        select action from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and resource = 'workspace_planning_settings'
      `);
      return { events: events.rows, audits: audits.rows };
    });
    expect(evidence.events.map((row) => row.event_type)).toEqual([
      "workspace_planning_settings.upserted",
    ]);
    expect(evidence.audits.map((row) => row.action)).toEqual(["settings.manage"]);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.adminId,
      fixture.workspaceId,
      (tx, ctx) => upsertPlanningSettings(tx, ctx, {
        ...command(1, "2d"),
        defaultPlanningMode: "4d" as never,
      }),
    )).rejects.toBeInstanceOf(PlanningSettingsValidationError);
  });
});
