import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  createInstallation,
  getInstallationWorkbook,
  setInstallationVariant,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";
import { seedSignedGraphDirect } from "../setup/f806-offer-import-seed";

type Fixture = { workspaceId: string; editorId: string; adminId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-10 Workbook')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f710.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@f710.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, adminId };
}

describe("F7-10 Workbook-Kapazitaeten (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F710-DB-01: Custom-Graph traegt keine erfundene Leistung", async () => {
    const { graph } = await seedSignedGraphDirect(testPool, {
      workspaceId: fixture.workspaceId,
      adminId: fixture.adminId,
    });
    await asEditor(fixture, (tx, ctx) => createInstallation(tx, ctx, { projectId: graph.projectId }));
    await asEditor(fixture, (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }));

    const workbook = await asEditor(fixture, (tx, ctx) => getInstallationWorkbook(tx, ctx, {
      projectId: graph.projectId,
    }));
    expect(workbook).not.toBeNull();
    // Custom-`other`-Position: keine Zähler, keine Flags, kein Absturz.
    expect(workbook!.capacities.moduleCount).toBe(0);
    expect(workbook!.capacities.pvPeakPowerWatts).toBe(0);
    expect(workbook!.capacities.batteryCount).toBe(0);
    expect(workbook!.capacities.storageUsableCapacityWh).toBe(0);
    expect(workbook!.capacities.inverterCount).toBe(0);
    expect(workbook!.capacities.inverterAcPowerWatts).toBe(0);
    expect(workbook!.capacities.wallboxCount).toBe(0);
    expect(workbook!.capacities.wallboxChargePowerWatts).toBe(0);
    expect(workbook!.capacities.hasUncertifiedModuleLines).toBe(false);
    expect(workbook!.capacities.hasUncertifiedBatteryLines).toBe(false);
    expect(workbook!.capacities.hasUncertifiedInverterLines).toBe(false);
    expect(workbook!.capacities.hasUncertifiedWallboxLines).toBe(false);
  });
});
