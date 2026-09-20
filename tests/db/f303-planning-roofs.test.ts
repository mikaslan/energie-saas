import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

// F3-03 Dach-Minimal (TDD-RED, Batch-1 F3-BATCH-1-vertrag + F3-03-dach-minimal):
// Alle Tests sprechen `planning_roof_min` (Migration 0271) direkt per SQL an
// (Quellen per `planning_source`/0270 als FK-Basis). Die Tabelle existiert
// noch NICHT — jeder Test muss ROT sein mit
// `relation "planning_roof_min" does not exist` (PG 42P01).
// Polygon-/Tilt-Formen sind mit tests/contracts/planning-batch1-contract.test.ts
// abgestimmt ({x,y}-Punkte, tilt 0–90, flat-XOR-per-edge).
// App-Anteile (Selbstschnitt, Fremdquelle-NotFound, RBAC) laufen über
// Service-/Contract-Import; der Roof-Probe-Gate davor hält die RED-Signatur
// einheitlich auf 42P01 `planning_roof_min`.

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  siteId: string;
  foreignEditorId: string;
  foreignProjectId: string;
  foreignSiteId: string;
};

async function seedWorkspace(label: string): Promise<{
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  siteId: string;
}> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f303.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f303.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F3', 'Fixture',
        ${`${contactId}@f303.test`}, ${`${contactId}@f303.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${label} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${label}, 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
        and intake_column.board_id = board.id
        and intake_column.is_intake = true
        and intake_column.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
  });
  return { workspaceId, editorId, viewerId, projectId, siteId };
}

const rectangle = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

const bowtie = [
  { x: 0, y: 0 },
  { x: 10, y: 10 },
  { x: 10, y: 0 },
  { x: 0, y: 10 },
];

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

// RED-Gate: berührt als Erstes `planning_roof_min`, damit jeder Test mit
// 42P01 auf genau dieser Tabelle scheitert (GREEN: wirkungsloses limit-1).
async function probeRoofTable(workspaceId: string): Promise<void> {
  await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute(sql`select 1 from public.planning_roof_min limit 1`),
  );
}

async function seedSelfDrawnSource(
  workspaceId: string,
  projectId: string,
  siteId: string,
  createdBy: string,
): Promise<string> {
  const created = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_source (workspace_id, project_id, site_id, kind, created_by)
      values (${workspaceId}::uuid, ${projectId}::uuid, ${siteId}::uuid,
        'self_drawn', ${createdBy}::uuid)
      returning id
    `),
  );
  return created.rows[0]!.id;
}

type RoofInsert = {
  sourceId: string;
  polygon?: unknown;
  tiltPerEdge?: number[] | null;
  flatSingleTilt?: number | null;
  edgeMargins?: unknown;
};

async function tryInsertRoof(
  workspaceId: string,
  createdBy: string,
  roof: RoofInsert,
): Promise<unknown> {
  try {
    const inserted = await withTenantOn(testPool, workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_roof_min (
          workspace_id, source_id, polygon_json,
          tilt_per_edge_json, flat_single_tilt, edge_margins_json, created_by
        ) values (
          ${workspaceId}::uuid, ${roof.sourceId}::uuid,
          ${JSON.stringify(roof.polygon ?? rectangle)}::jsonb,
          ${roof.tiltPerEdge === undefined ? null : JSON.stringify(roof.tiltPerEdge)}::jsonb,
          ${roof.flatSingleTilt ?? null},
          ${roof.edgeMargins === undefined ? null : JSON.stringify(roof.edgeMargins)}::jsonb,
          ${createdBy}::uuid
        )
        returning id
      `),
    );
    return inserted.rows[0]!.id;
  } catch (error) {
    return error;
  }
}

describe("F3-03 planning_roof_min Dach-Minimal (DB, RED: Tabelle fehlt)", () => {
  let fx: Fixture;

  beforeEach(async () => {
    const label = `F303 ${randomUUID()}`;
    const own = await seedWorkspace(label);
    const foreign = await seedWorkspace(`${label} Fremd`);
    fx = {
      workspaceId: own.workspaceId,
      otherWorkspaceId: foreign.workspaceId,
      editorId: own.editorId,
      viewerId: own.viewerId,
      projectId: own.projectId,
      siteId: own.siteId,
      foreignEditorId: foreign.editorId,
      foreignProjectId: foreign.projectId,
      foreignSiteId: foreign.siteId,
    };
  });

  it("F303-DB-01: Anlage (flat + per-edge) + lesen je Projekt", async () => {
    await probeRoofTable(fx.workspaceId);
    const sourceId = await seedSelfDrawnSource(
      fx.workspaceId, fx.projectId, fx.siteId, fx.editorId,
    );
    const flatId = await tryInsertRoof(fx.workspaceId, fx.editorId, {
      sourceId, flatSingleTilt: 30,
    });
    expect(typeof flatId).toBe("string");
    const edgeId = await tryInsertRoof(fx.workspaceId, fx.editorId, {
      sourceId, tiltPerEdge: [30, 35, 30, 35],
    });
    expect(typeof edgeId).toBe("string");

    const listed = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select r.id from planning_roof_min r
        join planning_source s on s.id = r.source_id
        where s.project_id = ${fx.projectId}::uuid
      `),
    );
    expect(listed.rows.map((row) => row.id).sort()).toEqual(
      [flatId, edgeId].sort(),
    );
  });

  it("F303-DB-02: tilt 0–90 gilt an den Grenzen, sonst CHECK-Reject (23514)", async () => {
    await probeRoofTable(fx.workspaceId);
    const sourceId = await seedSelfDrawnSource(
      fx.workspaceId, fx.projectId, fx.siteId, fx.editorId,
    );
    for (const tilt of [0, 90]) {
      const id = await tryInsertRoof(fx.workspaceId, fx.editorId, {
        sourceId, flatSingleTilt: tilt,
      });
      expect(typeof id).toBe("string");
    }
    const edgeOk = await tryInsertRoof(fx.workspaceId, fx.editorId, {
      sourceId, tiltPerEdge: [0, 45, 90, 30],
    });
    expect(typeof edgeOk).toBe("string");

    for (const tilt of [-1, -0.1, 90.1, 180]) {
      expect(
        pgCode(await tryInsertRoof(fx.workspaceId, fx.editorId, {
          sourceId, flatSingleTilt: tilt,
        })),
        `flat tilt ${tilt} muss rejectet werden`,
      ).toBe("23514");
    }
    for (const tilts of [[91, 30, 30, 30], [30, 30, 30, -1]]) {
      expect(
        pgCode(await tryInsertRoof(fx.workspaceId, fx.editorId, {
          sourceId, tiltPerEdge: tilts,
        })),
        `per-edge ${JSON.stringify(tilts)} muss rejectet werden`,
      ).toBe("23514");
    }
  });

  it("F303-DB-03: flat-XOR-per-edge (genau eine Neigungsform, sonst 23514)", async () => {
    await probeRoofTable(fx.workspaceId);
    const sourceId = await seedSelfDrawnSource(
      fx.workspaceId, fx.projectId, fx.siteId, fx.editorId,
    );
    expect(
      pgCode(await tryInsertRoof(fx.workspaceId, fx.editorId, { sourceId })),
      "beide Neigungsformen NULL muss rejectet werden",
    ).toBe("23514");
    expect(
      pgCode(await tryInsertRoof(fx.workspaceId, fx.editorId, {
        sourceId, flatSingleTilt: 30, tiltPerEdge: [30, 35, 30, 35],
      })),
      "beide Neigungsformen gesetzt muss rejectet werden",
    ).toBe("23514");
  });

  it("F303-DB-04: Selbstschnitt-reject (App-Contract; DB kennt nur Punktanzahl)", async () => {
    await probeRoofTable(fx.workspaceId);
    // App-Ebene (Contract): Bowtie reject, Rechteck ok — vgl. F303-CON-02.
    const contracts = await import("@/lib/integrations/planning/" + "contracts");
    expect(contracts.planningRoofCreateV1Schema.safeParse({
      schemaVersion: contracts.PLANNING_ROOF_CONTRACT_VERSION,
      polygon: bowtie,
      flatSingleTilt: 30,
    }).success).toBe(false);
    expect(contracts.planningRoofCreateV1Schema.safeParse({
      schemaVersion: contracts.PLANNING_ROOF_CONTRACT_VERSION,
      polygon: rectangle,
      flatSingleTilt: 30,
    }).success).toBe(true);
    // DB-Ebene: nur Punktanzahl-CHECK (2 Punkte -> 23514).
    const sourceId = await seedSelfDrawnSource(
      fx.workspaceId, fx.projectId, fx.siteId, fx.editorId,
    );
    expect(
      pgCode(await tryInsertRoof(fx.workspaceId, fx.editorId, {
        sourceId,
        polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        flatSingleTilt: 30,
      })),
    ).toBe("23514");
  });

  it("F303-DB-05: source-FK-Pflicht (unbekannte Quelle -> 23503)", async () => {
    expect(
      pgCode(await tryInsertRoof(fx.workspaceId, fx.editorId, {
        sourceId: randomUUID(), flatSingleTilt: 30,
      })),
    ).toBe("23503");
  });

  it("F303-DB-06: Fremdquelle-NotFound (App) + RLS-Unsichtbarkeit (DB)", async () => {
    await probeRoofTable(fx.workspaceId);
    const foreignSourceId = await seedSelfDrawnSource(
      fx.otherWorkspaceId, fx.foreignProjectId, fx.foreignSiteId, fx.foreignEditorId,
    );
    const invisible = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_source where id = ${foreignSourceId}::uuid
      `),
    );
    expect(invisible.rows).toHaveLength(0);
    const visible = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_source where id = ${foreignSourceId}::uuid
      `),
    );
    expect(visible.rows).toHaveLength(1);
    // Service-Fläche (GREEN): createRoof mappt die unsichtbare Fremdquelle
    // auf NotFound (Spec F3-03 Umfang).
    const roofs = await import("@/modules/planning/" + "roofs") as Record<string, unknown>;
    for (const name of ["createRoof", "updateRoof", "getRoof", "listRoofs"]) {
      expect(typeof roofs[name]).toBe("function");
    }
  });

  it("F303-DB-07: RBAC (Viewer liest, Viewer schreibt nicht) + RLS/FORCE-Pin", async () => {
    await probeRoofTable(fx.workspaceId);
    const sourceId = await seedSelfDrawnSource(
      fx.workspaceId, fx.projectId, fx.siteId, fx.editorId,
    );
    const roofs = await import("@/modules/planning/" + "roofs");
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        roofs.createRoof(tx, ctx, { sourceId, polygon: rectangle, flatSingleTilt: 30 })),
      "Viewer-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    const created = await withAuthorizedTenantOn(
      testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        roofs.createRoof(tx, ctx, { sourceId, polygon: rectangle, flatSingleTilt: 30 }),
    );
    expect(created).toBeTruthy();
    const listed = await withAuthorizedTenantOn(
      testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        roofs.listRoofs(tx, ctx, { projectId: fx.projectId }),
    );
    expect(Array.isArray(listed)).toBe(true);

    const flags = await testPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where oid = 'public.planning_roof_min'::regclass
    `);
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policy = await testPool.query<{ polname: string }>(`
      select polname from pg_catalog.pg_policy
       where polrelid = 'public.planning_roof_min'::regclass
         and polname = 'tenant_isolation'
    `);
    expect(policy.rows).toHaveLength(1);
  });

  it("F303-DB-08: Fremdtenant-Leere (Isolation je Workspace)", async () => {
    await probeRoofTable(fx.workspaceId);
    const sourceId = await seedSelfDrawnSource(
      fx.workspaceId, fx.projectId, fx.siteId, fx.editorId,
    );
    const id = await tryInsertRoof(fx.workspaceId, fx.editorId, {
      sourceId, flatSingleTilt: 30,
    });
    expect(typeof id).toBe("string");
    const foreign = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_roof_min
        where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreign.rows).toHaveLength(0);
    const cross = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_roof_min where id = ${id as string}::uuid
      `),
    );
    expect(cross.rows).toHaveLength(0);
  });
});
