import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { getRequestBoard } from "@/modules/boards";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  sourceId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const sourceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-07 Score')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f107.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F107 Messe', 'f107 messe')
    `);
  });
  return { workspaceId, editorId, editorMembershipId, sourceId };
}

// Minimal valides Profil-JSON (site_energy_profile_json_ck): exakt die
// sieben Top-Level-Schlüssel, 1–4 Dächer, Version passend zur Spalte.
function minimalProfileJson(): string {
  return JSON.stringify({
    schemaVersion: "site-energy-profile.v1",
    inputMode: "consumption",
    building: {},
    roofs: [{}],
    consumption: {},
    existingAssets: {},
    provenance: {},
  });
}

describe("F1-07 Lead-Score am Board (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const run = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const enrichHotLead = async (fx: Fixture, projectId: string, siteId: string): Promise<void> => {
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      await tx.execute(sql`
        update site set lat = 49.28, lng = 8.73
        where workspace_id = ${fx.workspaceId}::uuid and id = ${siteId}::uuid
      `);
      const profile = minimalProfileJson();
      const hash = createHash("sha256").update(profile, "utf8").digest("hex");
      await tx.execute(sql`
        insert into site_energy_profile (
          workspace_id, site_id, revision, schema_version, input_mode,
          source_kind, source_snapshot_id, source_project_id, address_revision,
          profile, profile_sha256, confirmed_profile_revision,
          confirmed_address_revision, confirmed_by, confirmed_at
        ) values (
          ${fx.workspaceId}::uuid, ${siteId}::uuid, 1,
          'site-energy-profile.v1', 'consumption', 'manual', null, null, 1,
          ${profile}::jsonb, decode(${hash}, 'hex'), 1, 1,
          ${fx.editorId}::uuid, now()
        )
      `);
      await tx.execute(sql`
        insert into project_assignment (workspace_id, project_id, membership_id, assignment_role)
        values (
          ${fx.workspaceId}::uuid, ${projectId}::uuid,
          ${fx.editorMembershipId}::uuid, 'key_account'
        )
      `);
    });
  };

  const seedHotAndCold = async (fx: Fixture): Promise<{ hotId: string; coldId: string }> => {
    const hot = await run(fx, (tx, ctx) =>
      createManualLead(tx, ctx, {
        scope: "residential",
        displayName: "Heißer Lead",
        email: "heiss@example.com",
        phone: "+49 171 1234567",
        postalCode: "69234",
        city: "Dielheim",
        leadSourceId: fx.sourceId,
      }),
    );
    await enrichHotLead(fx, hot.projectId, hot.siteId);
    const cold = await run(fx, (tx, ctx) =>
      createManualLead(tx, ctx, {
        scope: "residential",
        displayName: "Kalter Lead",
        phone: "+49 171 7654321",
      }),
    );
    return { hotId: hot.projectId, coldId: cold.projectId };
  };

  const cardsById = (board: Awaited<ReturnType<typeof getRequestBoard>>) => {
    const map = new Map<string, (typeof board.columns)[number]["cards"][number]>();
    for (const column of board.columns) {
      for (const card of column.cards) map.set(card.id, card);
    }
    return map;
  };

  it("F107-DB-01: Score, Ampel und Signale je Karte", async () => {
    const { hotId, coldId } = await seedHotAndCold(fixture);
    const board = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const cards = cardsById(board);

    const hot = cards.get(hotId);
    expect(hot?.score?.value).toBe(85);
    expect(hot?.score?.band).toBe("hot");
    expect(hot?.score?.signals).toEqual([
      "email",
      "phone",
      "address",
      "geo",
      "profile",
      "profileConfirmed",
      "keyAccount",
      "source",
    ]);

    const cold = cards.get(coldId);
    expect(cold?.score?.value).toBe(10);
    expect(cold?.score?.band).toBe("cold");
    expect(cold?.score?.signals).toEqual(["phone"]);
  });

  it("F107-DB-02: Filter-Presets heiss/warm/kalt", async () => {
    const { hotId, coldId } = await seedHotAndCold(fixture);

    const hot = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", scoreBand: "hot" }),
    );
    const hotIds = hot.columns.flatMap((column) => column.cards.map((card) => card.id));
    expect(hotIds).toEqual([hotId]);

    const cold = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", scoreBand: "cold" }),
    );
    const coldIds = cold.columns.flatMap((column) => column.cards.map((card) => card.id));
    expect(coldIds).toEqual([coldId]);

    const warm = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", scoreBand: "warm" }),
    );
    expect(warm.columns.flatMap((column) => column.cards)).toHaveLength(0);
    // Spaltenstruktur bleibt stehen (stabile Ansicht, nur Karten gefiltert).
    expect(warm.columns.length).toBeGreaterThan(0);
  });

  it("F107-DB-03: unbekanntes Band fail-closed", async () => {
    await expect(
      run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", scoreBand: "lava" as never })),
    ).rejects.toThrow(/unknown score band/);
  });
});
