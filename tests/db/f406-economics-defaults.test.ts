import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CASHFLOW_HORIZON_DEFAULT_YEARS,
  WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
} from "@/lib/integrations/economics/contract";
import {
  getEconomicsSettings,
  upsertEconomicsSettings,
  EconomicsConflictError,
  EconomicsNotFoundError,
  EconomicsValidationError,
  type EconomicsSettingsCommandV1,
} from "@/modules/economics";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string; adminId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F4.6 Defaults')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f406.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f406.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f406.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{"economics":true}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId, adminId };
}

function command(baseRevision: number, overrides: Partial<EconomicsSettingsCommandV1["input"]> = {}): EconomicsSettingsCommandV1 {
  return {
    schemaVersion: WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      electricityPriceNetCentsPerKwh: null,
      escalationRateBps: null,
      oilPriceNetCentsPerLiter: null,
      gasPriceNetCentsPerKwh: null,
      cashflowHorizonYears: CASHFLOW_HORIZON_DEFAULT_YEARS,
      ...overrides,
    },
  };
}

describe("F4.6 Workspace-Economics-Defaults (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F406-DB-01: Leerstand-Read (revision 0), Insert, CAS-Update, stale-Konflikt", async () => {
    // Kimi-P1-1: vor dem ersten Upsert → DTO mit revision 0, keine Exception.
    const empty = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getEconomicsSettings(tx, ctx),
    );
    expect(empty.revision).toBe(0);
    expect(empty.electricityPriceNetCentsPerKwh).toBeNull();
    expect(empty.cashflowHorizonYears).toBe(CASHFLOW_HORIZON_DEFAULT_YEARS);
    expect(empty.hasAnyDefaults).toBe(false);
    expect(empty.permissions.canWrite).toBe(false);

    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        electricityPriceNetCentsPerKwh: 30,
        escalationRateBps: 100,
      })),
    );
    expect(created.revision).toBe(1);
    expect(created.hasAnyDefaults).toBe(true);

    // CAS-Update gegen frische Revision
    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(1, {
        electricityPriceNetCentsPerKwh: 32,
      })),
    );
    expect(updated.revision).toBe(2);
    expect(updated.electricityPriceNetCentsPerKwh).toBe(32);

    // Stale baseRevision → Conflict mit aktueller Revision
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(1)),
    )).rejects.toBeInstanceOf(EconomicsConflictError);

    // baseRevision >= 1 ohne Zeile → NotFound
    const otherWorkspace = randomUUID();
    const otherEditor = randomUUID();
    await withTenantOn(testPool, otherWorkspace, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${otherWorkspace}::uuid, 'F4.6 Fremd')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values (${otherEditor}::uuid, ${`other-${otherEditor}@f406.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${otherWorkspace}::uuid, ${otherEditor}::uuid,
                'editor', '{"economics":true}'::jsonb)
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, otherEditor, otherWorkspace,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(1)),
    )).rejects.toBeInstanceOf(EconomicsNotFoundError);
  });

  it("F406-DB-02: DB-CHECKs — Bereichsverletzungen scheitern an der Datenbank", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        electricityPriceNetCentsPerKwh: 1_000_001,
      })),
    )).rejects.toBeInstanceOf(EconomicsValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        escalationRateBps: 2001,
      })),
    )).rejects.toBeInstanceOf(EconomicsValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        cashflowHorizonYears: 51,
      })),
    )).rejects.toBeInstanceOf(EconomicsValidationError);
    // Insert ohne expliziten Horizont ist der Command-Pflicht wegen nicht
    // möglich — der DB-DEFAULT 20 ist über den Leerstand-Read belegt.
  });

  it("F406-DB-03: RBAC — Admin ohne Capability schreibt, Viewer nur liest, Fremder fail-closed", async () => {
    const asAdmin = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        gasPriceNetCentsPerKwh: 12,
      })),
    );
    expect(asAdmin.revision).toBe(1);

    const asViewer = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getEconomicsSettings(tx, ctx),
    );
    expect(asViewer.gasPriceNetCentsPerKwh).toBe(12);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(1)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Editor OHNE economics-Capability darf nicht schreiben
    const noCapabilityEditor = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email) values (${noCapabilityEditor}::uuid, ${`nocap-${noCapabilityEditor}@f406.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${noCapabilityEditor}::uuid,
                'editor', '{}'::jsonb)
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, noCapabilityEditor, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(1)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremder (kein Membership) scheitert auch beim Read
    const stranger = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email) values (${stranger}::uuid, ${`stranger-${stranger}@f406.test`})
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, stranger, fixture.workspaceId,
      (tx, ctx) => getEconomicsSettings(tx, ctx),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F406-DB-05 (Kimi-P2-3): zweiter Insert mit baseRevision 0 → Conflict, Revision bleibt", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        electricityPriceNetCentsPerKwh: 30,
      })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        electricityPriceNetCentsPerKwh: 31,
      })),
    )).rejects.toBeInstanceOf(EconomicsConflictError);
    const after = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getEconomicsSettings(tx, ctx),
    );
    expect(after.revision).toBe(1);
    expect(after.electricityPriceNetCentsPerKwh).toBe(30);
  });

  it("F406-DB-06 (Kimi-P2-4): Upsert emittiert genau ein Domain-Event + Audit im eigenen Namespace", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        gasPriceNetCentsPerKwh: 12,
      })),
    );
    const events = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ event_type: string; [key: string]: unknown }>(sql`
        select event_type from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_type = 'workspace_economics_settings'
         order by occurred_at desc
      `));
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "workspace_economics_settings.upserted",
    ]);
    const audits = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ action: string; [key: string]: unknown }>(sql`
        select action from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and resource = 'workspace_economics_settings'
         order by occurred_at desc
      `));
    expect(audits.rows.map((row) => row.action)).toEqual([
      "economics.settings.write",
    ]);
  });

  it("F406-DB-04: no_truncate + RLS-Forcing + Fremdtenant-Isolation", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command(0, {
        electricityPriceNetCentsPerKwh: 40,
      })),
    );
    // TRUNCATE scheitert (no_truncate-Trigger) — als Superuser-Verbindung.
    await expect(testPool.query(
      "truncate table public.workspace_economics_settings",
    )).rejects.toThrow(/append-only|forbid_mutation|TRUNCATE/u);

    // Fremdtenant: eigener Workspace sieht die Zeile des anderen nicht.
    const otherWorkspace = randomUUID();
    const otherViewer = randomUUID();
    await withTenantOn(testPool, otherWorkspace, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${otherWorkspace}::uuid, 'F4.6 Fremd-2')`);
      await tx.execute(sql`
        insert into user_identity (id, email) values (${otherViewer}::uuid, ${`ov-${otherViewer}@f406.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${otherWorkspace}::uuid, ${otherViewer}::uuid,
                'viewer', '{}'::jsonb)
      `);
    });
    const foreignRead = await withAuthorizedTenantOn(
      testPool, otherViewer, otherWorkspace,
      (tx, ctx) => getEconomicsSettings(tx, ctx),
    );
    expect(foreignRead.revision).toBe(0);
    expect(foreignRead.electricityPriceNetCentsPerKwh).toBeNull();
  });
});
