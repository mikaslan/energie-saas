import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { TIME_TRACKING_SCHEMA_VERSION } from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEventType,
  listTimeEventTypes,
  TimeTrackingConflictError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
};

// F901-Stil: insert into workspace feuert den Provisionierungs-Trigger;
// frischer Workspace je Test, kein W3-Recycling.
async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f912.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f912.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

const EXPECTED_DEFAULTS: Array<[string, number]> = [
  ["Travel", 0],
  ["On-site", 1],
  ["Office", 2],
  ["Other", 3],
];

describe("F9-12 Default-4er-Kategorie-Satz (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9-12 Kategorie-Defaults");
  });

  it("F912-DB-01: frischer Workspace hat exakt Travel/On-site/Office/Other auf 0-3, Farben null", async () => {
    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx),
    );
    expect(list.map((t) => [t.name, t.position])).toEqual(EXPECTED_DEFAULTS);
    for (const type of list) {
      expect(type.textColor).toBeNull();
      expect(type.backgroundColor).toBeNull();
      expect(type.archivedAt).toBeNull();
    }
    const all = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx, { includeArchived: true }),
    );
    expect(all).toHaveLength(4);
  });

  it("F912-DB-02: Seed-Funktion ist idempotent (Doppelaufruf, keine Duplikate)", async () => {
    await testPool.query("select public.seed_default_time_event_types($1::uuid)", [fixture.workspaceId]);
    await testPool.query("select public.seed_default_time_event_types($1::uuid)", [fixture.workspaceId]);
    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx),
    );
    expect(list).toHaveLength(4);
    expect(new Set(list.map((t) => t.name)).size).toBe(4);
    expect(list.map((t) => [t.name, t.position])).toEqual(EXPECTED_DEFAULTS);
  });

  it("F912-DB-03: Custom-Travel bleibt unverändert, Rest wird ergänzt", async () => {
    // Teil-customisierten Bestand simulieren: Defaults entfernen, dann per
    // Service ein Custom-Travel anlegen (Backfill-Lage alter Workspaces).
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      delete from time_event_type where workspace_id = ${fixture.workspaceId}::uuid
    `));
    const custom = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEventType(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        name: "Travel",
        position: 7,
        textColor: "#111111",
        backgroundColor: "#EEEEEE",
      }),
    );
    await testPool.query("select public.seed_default_time_event_types($1::uuid)", [fixture.workspaceId]);
    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEventTypes(tx, ctx),
    );
    expect(list).toHaveLength(4);
    const travel = list.find((t) => t.name === "Travel")!;
    expect(travel.id).toBe(custom.id);
    expect(travel.position).toBe(7);
    expect(travel.textColor).toBe("#111111");
    expect(travel.backgroundColor).toBe("#EEEEEE");
    expect(new Set(list.map((t) => t.name))).toEqual(
      new Set(["Travel", "On-site", "Office", "Other"]),
    );
    for (const [name, position] of [["On-site", 1], ["Office", 2], ["Other", 3]] as const) {
      expect(list.find((t) => t.name === name)!.position).toBe(position);
    }
  });

  it("F912-DB-04: Duplikat-Anlage (Case/Trim/exakt) wirft TimeTrackingConflictError", async () => {
    for (const name of ["travel", "  Office  ", "Other"]) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => createTimeEventType(tx, ctx, {
          schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
          name,
        }),
      )).rejects.toBeInstanceOf(TimeTrackingConflictError);
    }
  });
});
