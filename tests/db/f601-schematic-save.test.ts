// F6-01/W-CORE Save-Service (PostgreSQL): ensureSchematicDiagram sichert den
// Abbild je (Angebot, Varianten-Revision) in `schematic_diagrams` (0300,
// W-DB-Lane) — idempotent (nur Hash-Drift schreibt mit revision+1/CAS),
// fail-closed residential (Scope live aus offer+Board, W-CORE-4-Felder-Modell)
// und tenant-isoliert. Kein History-Append je Key.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  buildResidentialSingleLineSchematic,
  type SchematicSectionInput,
} from "@/lib/integrations/schematic/single-line-v1";
import { PermissionDeniedError } from "@/lib/permissions";
import { duplicateOfferVariant } from "@/modules/offers";
import {
  ensureSchematicDiagram,
  SchematicConflictError,
  SchematicScopeError,
  SchematicValidationError,
  type EnsureSchematicDiagramResult,
} from "@/modules/schematic";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  offerId: string;
  variantId: string;
  projectId: string;
};

const RESIDENTIAL_SCOPE = {
  scope: "residential",
  priceAudience: "b2c",
  boardScope: "residential",
  audience: "b2c",
} as const;

const SECTIONS = [
  { category: "module", title: "PV-Module", quantityLabel: "12 Stück" },
  { category: "inverter", title: "Wechselrichter", quantityLabel: "1 Stück" },
] as const;

function sectionsInput(extra: SchematicSectionInput[] = []): SchematicSectionInput[] {
  return [...SECTIONS.map((section) => ({ ...section })), ...extra];
}

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(
      sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F601 Schematic')`,
    );
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f601.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f601.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tenantFixtures["offer"](tx, workspaceId);
  });
  const ids = await withTenantOn(testPool, workspaceId, async (tx) => {
    const offer = await tx.execute<{ id: string; project_id: string; [key: string]: unknown }>(sql`
      select id, project_id from offer where workspace_id = ${workspaceId}::uuid limit 1
    `);
    const variant = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id from offer_variant
       where workspace_id = ${workspaceId}::uuid
         and offer_id = ${offer.rows[0]!.id}::uuid
       limit 1
    `);
    return {
      offerId: offer.rows[0]!.id,
      projectId: offer.rows[0]!.project_id,
      variantId: variant.rows[0]!.id,
    };
  });
  return { workspaceId, editorId, viewerId, ...ids };
}

async function moveProjectToCommercialBoard(fixture: Fixture): Promise<void> {
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const target = await tx.execute<{ board_id: string; column_id: string; [key: string]: unknown }>(sql`
      select board.id as board_id, intake.id as column_id
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${fixture.workspaceId}::uuid
         and board.scope = 'commercial'
         and board.is_default = true
         and board.archived_at is null
       limit 1
    `);
    await tx.execute(sql`
      update project
         set kanban_board_id = ${target.rows[0]!.board_id}::uuid,
             kanban_column_id = ${target.rows[0]!.column_id}::uuid
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `);
  });
}

type DiagramRow = {
  workspace_id: string;
  offer_id: string;
  variant_revision: number;
  revision: number;
  netlist: {
    nodes: Array<{ id: string; [key: string]: unknown }>;
    edges: Array<{ from: string; to: string; [key: string]: unknown }>;
    unwired?: unknown;
    variantId?: unknown;
    [key: string]: unknown;
  };
  node_count: number | null;
  edge_count: number | null;
  updated_at: Date | string;
  [key: string]: unknown;
};

async function readDiagram(
  tx: TenantTx,
  workspaceId: string,
  offerId: string,
  variantRevision: number,
): Promise<DiagramRow | undefined> {
  const result = await tx.execute<DiagramRow>(sql`
    select workspace_id, offer_id, variant_revision, revision, netlist,
           node_count, edge_count, updated_at
      from schematic_diagrams
     where workspace_id = ${workspaceId}::uuid
       and offer_id = ${offerId}::uuid
       and variant_revision = ${variantRevision}
  `);
  return result.rows[0];
}

async function countDiagrams(tx: TenantTx): Promise<number> {
  const result = await tx.execute<{ n: number; [key: string]: unknown }>(
    sql`select count(*)::int as n from schematic_diagrams`,
  );
  return result.rows[0]?.n ?? 0;
}

describe("F6-01/W-CORE ensureSchematicDiagram", () => {
  it("legt Revision 1 mit Umschlag + Zaehlern an", async () => {
    const fixture = await seedFixture();
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixture.offerId,
          variantId: fixture.variantId,
          variantRevision: 1,
          sections: sectionsInput(),
        }),
    );
    expect(result satisfies EnsureSchematicDiagramResult).toMatchObject({
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      revision: 1,
      previousRevision: null,
      variantRevision: 1,
      changed: true,
    });
    expect(result.netlistSha256).toMatch(/^[0-9a-f]{64}$/u);
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.netlist.variantId).toBe(fixture.variantId);
    expect(row?.netlist.nodes.map((node) => node.id)).toContain("pv");
    expect(row?.node_count).toBe(row?.netlist.nodes.length);
    expect(row?.edge_count).toBe(row?.netlist.edges.length);
  });

  it("ist idempotent ohne Drift (kein Rewrite, updated_at stabil)", async () => {
    const fixture = await seedFixture();
    const value = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    const first = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, value),
    );
    const before = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    const second = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, value),
    );
    expect(second.changed).toBe(false);
    expect(second.revision).toBe(first.revision);
    expect(second.netlistSha256).toBe(first.netlistSha256);
    const after = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(new Date(after!.updated_at).getTime()).toBe(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("schreibt bei Hash-Drift mit revision+1 (CAS, kein Append)", async () => {
    const fixture = await seedFixture();
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, base),
    );
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          ...base,
          sections: sectionsInput([
            { category: "battery", title: "Speicher", quantityLabel: "1 Stück" },
          ]),
        }),
    );
    expect(result).toMatchObject({ changed: true, revision: 2, previousRevision: 1 });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(2);
    expect(row?.netlist.nodes.map((node) => node.id)).toContain("battery");
    const count = await withTenantOn(testPool, fixture.workspaceId, countDiagrams);
    expect(count).toBe(1);
  });

  it("haelt eigene Zeilen je Varianten-Revision", async () => {
    const fixture = await seedFixture();
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      sections: sectionsInput(),
    };
    const first = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, { ...base, variantRevision: 1 }),
    );
    const second = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, { ...base, variantRevision: 2 }),
    );
    expect(first.revision).toBe(1);
    expect(second).toMatchObject({ revision: 1, changed: true });
    const count = await withTenantOn(testPool, fixture.workspaceId, countDiagrams);
    expect(count).toBe(2);
  });

  it("wirft bei veraltetem expectedRevision (CAS-Konflikt, kein Write)", async () => {
    const fixture = await seedFixture();
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, base),
    );
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          ...base,
          sections: sectionsInput([
            { category: "battery", title: "Speicher", quantityLabel: "1 Stück" },
          ]),
        }),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, { ...base, expectedRevision: 1 }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicConflictError);
    expect((failure as SchematicConflictError).currentRevision).toBe(2);
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(2);
  });

  it("akzeptiert passendes expectedRevision", async () => {
    const fixture = await seedFixture();
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, { ...base, expectedRevision: 0 }),
    );
    expect(result.revision).toBe(1);
    const second = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, { ...base, expectedRevision: 1 }),
    );
    expect(second.changed).toBe(false);
  });

  it("verwirft commercial fail-closed ohne Write (Board-Scope live)", async () => {
    const fixture = await seedFixture();
    await moveProjectToCommercialBoard(fixture);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixture.offerId,
          variantId: fixture.variantId,
          variantRevision: 1,
          sections: sectionsInput(),
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicScopeError);
    expect((failure as Error).name).toBe("SchematicScopeError");
    const count = await withTenantOn(testPool, fixture.workspaceId, countDiagrams);
    expect(count).toBe(0);
  });

  it("schuetzt fremd gestempelte Zeilen vor Varianten (kein Ueberschreiben)", async () => {
    const fixture = await seedFixture();
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, base),
    );
    // Zweite Variante ueber den Domaenen-Service (Hand-Inserts kaempfen
    // gegen FK + CHECKs + Spiegel-Trigger — der Service versiegelt korrekt).
    const duplicated = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        duplicateOfferVariant(tx, ctx, {
          schemaVersion: "offer-variant-duplicate-command.v1",
          offerId: fixture.offerId,
          sourceVariantId: fixture.variantId,
          expectedSourceRevision: 1,
          name: "Zweite Variante",
        }),
    );
    const secondVariantId = duplicated.variantId;
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          ...base,
          variantId: secondVariantId,
          sections: sectionsInput([
            { category: "battery", title: "Speicher", quantityLabel: "1 Stück" },
          ]),
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicConflictError);
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.netlist.variantId).toBe(fixture.variantId);
    expect(row?.netlist.nodes.map((node) => node.id)).not.toContain("battery");
  });

  it("adoptiert ungestempelte Action-Zeilen (Match still, Drift im Solo-Angebot)", async () => {
    const fixture = await seedFixture();
    const legacy = buildResidentialSingleLineSchematic(sectionsInput(), {
      ...RESIDENTIAL_SCOPE,
    });
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into schematic_diagrams (
          workspace_id, offer_id, variant_revision, netlist, node_count, edge_count
        ) values (
          ${fixture.workspaceId}::uuid, ${fixture.offerId}::uuid, 1,
          ${JSON.stringify({ nodes: legacy.nodes, edges: legacy.edges })}::jsonb,
          ${legacy.nodes.length}::integer, ${legacy.edges.length}::integer
        )
      `);
    });
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    const adopted = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => ensureSchematicDiagram(tx, ctx, base),
    );
    expect(adopted).toMatchObject({ changed: false, revision: 1 });
    const drifted = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          ...base,
          sections: sectionsInput([
            { category: "battery", title: "Speicher", quantityLabel: "1 Stück" },
          ]),
        }),
    );
    expect(drifted).toMatchObject({ changed: true, revision: 2, previousRevision: 1 });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readDiagram(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.netlist.variantId).toBe(fixture.variantId);
  });

  it("trennt Tenanten (eigene Zeilen, fremde Angebote unsichtbar)", async () => {
    const fixtureA = await seedFixture();
    const fixtureB = await seedFixture();
    await withAuthorizedTenantOn(
      testPool,
      fixtureA.editorId,
      fixtureA.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixtureA.offerId,
          variantId: fixtureA.variantId,
          variantRevision: 1,
          sections: sectionsInput(),
        }),
    );
    // Fremdes Angebot ist im eigenen Tenanten unbekannt (RLS-Scope im Join).
    const crossTenant = await withAuthorizedTenantOn(
      testPool,
      fixtureB.editorId,
      fixtureB.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixtureA.offerId,
          variantId: fixtureA.variantId,
          variantRevision: 1,
          sections: sectionsInput(),
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(crossTenant).toBeInstanceOf(SchematicValidationError);
    expect((crossTenant as SchematicValidationError).paths).toEqual(["/offerId"]);
    const inB = await withAuthorizedTenantOn(
      testPool,
      fixtureB.editorId,
      fixtureB.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixtureB.offerId,
          variantId: fixtureB.variantId,
          variantRevision: 1,
          sections: sectionsInput(),
        }),
    );
    expect(inB).toMatchObject({ revision: 1, changed: true });
    const countB = await withTenantOn(testPool, fixtureB.workspaceId, countDiagrams);
    expect(countB).toBe(1);
    const foreignInB = await withTenantOn(testPool, fixtureB.workspaceId, (tx) =>
      readDiagram(tx, fixtureB.workspaceId, fixtureA.offerId, 1),
    );
    expect(foreignInB).toBeUndefined();
  });

  it("validiert Hülle und Bindungen", async () => {
    const fixture = await seedFixture();
    const base = {
      offerId: fixture.offerId,
      variantId: fixture.variantId,
      variantRevision: 1,
      sections: sectionsInput(),
    };
    for (const value of [
      { ...base, offerId: "keine-uuid" },
      { ...base, sections: "x" },
      { ...base, variantRevision: 0 },
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) =>
          ensureSchematicDiagram(tx, ctx, value).then(
            () => null,
            (error: unknown) => error,
          ),
      );
      expect(failure).toBeInstanceOf(SchematicValidationError);
    }
    const unknownOffer = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, { ...base, offerId: randomUUID() }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(unknownOffer).toBeInstanceOf(SchematicValidationError);
    expect((unknownOffer as SchematicValidationError).paths).toEqual(["/offerId"]);
    const unknownVariant = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, { ...base, variantId: randomUUID() }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(unknownVariant).toBeInstanceOf(SchematicValidationError);
    expect((unknownVariant as SchematicValidationError).paths).toEqual(["/variantId"]);
  });

  it("verlangt project.write (Viewer liest, schreibt aber nicht)", async () => {
    const fixture = await seedFixture();
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixture.offerId,
          variantId: fixture.variantId,
          variantRevision: 1,
          sections: sectionsInput(),
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(PermissionDeniedError);
  });
});
