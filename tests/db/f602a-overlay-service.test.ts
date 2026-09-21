// F6-02a/W-SVC Overlay-Service (PostgreSQL): saveSchematicOverlay/
// readSchematicOverlay sichern das Editor-Overlay je (Angebot,
// Varianten-Revision) in `schematic_overlays` (0301, W-DB-Lane) —
// idempotent (nur Element-Drift schreibt mit revision+1/CAS), Parent-Pin
// gegen veraltetes Auto-Gen, fail-closed residential (Scope live aus
// offer+Board, W-CORE-4-Felder-Modell) und tenant-isoliert. Genau eine
// Zeile je Key; kein History-Append.
//
// Faellt ohne die 0301-Tabelle rot (Vertrag W-DB-Lane); die Integration
// faehrt alles nach Migration gruen.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { SchematicSectionInput } from "@/lib/integrations/schematic/single-line-v1";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ensureSchematicDiagram,
  readSchematicOverlay,
  saveSchematicOverlay,
  SchematicConflictError,
  SchematicScopeError,
  SchematicValidationError,
  type SaveSchematicOverlayResult,
} from "@/modules/schematic";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  offerId: string;
  variantId: string;
  projectId: string;
};

const SECTIONS = [
  { category: "module", title: "PV-Module", quantityLabel: "12 Stück" },
  { category: "inverter", title: "Wechselrichter", quantityLabel: "1 Stück" },
] as const;

function sectionsInput(extra: SchematicSectionInput[] = []): SchematicSectionInput[] {
  return [...SECTIONS.map((section) => ({ ...section })), ...extra];
}

// Gueltige Overlay-Elemente (editor-overlay.v1, Koordinatenraum 640x300).
const EARTHING = { kind: "earthing_point", x: 10, y: 20 } as const;
const TEXTBOX = { kind: "textbox", x: 30, y: 40, text: "Hinweis" } as const;

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(
      sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F602a Overlay')`,
    );
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f602a.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f602a.test`}),
             (${externalId}::uuid, ${`extern-${externalId}@f602a.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'editor', '{"external_only": true}'::jsonb)
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
  return { workspaceId, editorId, viewerId, externalId, ...ids };
}

/** Diagramm-Zeile per Domaenen-Service anlegen (Parent-Pin-Basis). */
async function seedDiagram(fixture: Fixture, variantRevision: number): Promise<number> {
  const result = await withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) =>
      ensureSchematicDiagram(tx, ctx, {
        offerId: fixture.offerId,
        variantId: fixture.variantId,
        variantRevision,
        sections: sectionsInput(),
      }),
  );
  return result.revision;
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

type OverlayRow = {
  workspace_id: string;
  offer_id: string;
  variant_revision: number;
  revision: number;
  parent_revision: number;
  elements: {
    elements: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  element_count: number | null;
  updated_at: Date | string;
  [key: string]: unknown;
};

async function readOverlay(
  tx: TenantTx,
  workspaceId: string,
  offerId: string,
  variantRevision: number,
): Promise<OverlayRow | undefined> {
  const result = await tx.execute<OverlayRow>(sql`
    select workspace_id, offer_id, variant_revision, revision, parent_revision,
           elements, element_count, updated_at
      from schematic_overlays
     where workspace_id = ${workspaceId}::uuid
       and offer_id = ${offerId}::uuid
       and variant_revision = ${variantRevision}
  `);
  return result.rows[0];
}

async function countOverlays(tx: TenantTx): Promise<number> {
  const result = await tx.execute<{ n: number; [key: string]: unknown }>(
    sql`select count(*)::int as n from schematic_overlays`,
  );
  return result.rows[0]?.n ?? 0;
}

describe("F6-02a/W-SVC saveSchematicOverlay/readSchematicOverlay", () => {
  it("legt Revision 1 mit Umschlag + Zähler an", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
          parentRevision,
          elements: [{ ...EARTHING }, { ...TEXTBOX }],
        }),
    );
    expect(result satisfies SaveSchematicOverlayResult).toMatchObject({
      offerId: fixture.offerId,
      variantRevision: 1,
      revision: 1,
      previousRevision: null,
      parentRevision,
      changed: true,
    });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.parent_revision).toBe(parentRevision);
    expect(row?.elements.elements).toHaveLength(2);
    expect(row?.elements.elements[0]).toMatchObject({ kind: "earthing_point", x: 10, y: 20 });
    expect(row?.element_count).toBe(2);
  });

  it("ist idempotent ohne Drift (kein Rewrite, updated_at stabil)", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const value = {
      offerId: fixture.offerId,
      variantRevision: 1,
      parentRevision,
      elements: [{ ...EARTHING }],
    };
    const first = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => saveSchematicOverlay(tx, ctx, value),
    );
    const before = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    const second = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => saveSchematicOverlay(tx, ctx, { ...value, expectedRevision: first.revision }),
    );
    expect(second.changed).toBe(false);
    expect(second.revision).toBe(first.revision);
    expect(second.previousRevision).toBeNull();
    const after = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(new Date(after!.updated_at).getTime()).toBe(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("schreibt bei Element-Drift mit revision+1 (CAS, kein Append)", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const base = {
      offerId: fixture.offerId,
      variantRevision: 1,
      parentRevision,
      elements: [{ ...EARTHING }],
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => saveSchematicOverlay(tx, ctx, base),
    );
    const result = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          ...base,
          expectedRevision: 1,
          elements: [{ ...EARTHING }, { ...TEXTBOX }],
        }),
    );
    expect(result).toMatchObject({ changed: true, revision: 2, previousRevision: 1 });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(2);
    expect(row?.element_count).toBe(2);
    const count = await withTenantOn(testPool, fixture.workspaceId, countOverlays);
    expect(count).toBe(1);
  });

  it("wirft bei veraltetem expectedRevision (CAS-Konflikt, kein Write)", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const base = {
      offerId: fixture.offerId,
      variantRevision: 1,
      parentRevision,
      elements: [{ ...EARTHING }],
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => saveSchematicOverlay(tx, ctx, base),
    );
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          ...base,
          expectedRevision: 1,
          elements: [{ ...EARTHING }, { ...TEXTBOX }],
        }),
    );
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, { ...base, expectedRevision: 1 }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicConflictError);
    expect((failure as SchematicConflictError).currentRevision).toBe(2);
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(2);
    expect(row?.element_count).toBe(2);
  });

  it("verlangt expectedRevision auf dem Update-Pfad (CAS-Pflicht, kein Freifahrtschein)", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const base = {
      offerId: fixture.offerId,
      variantRevision: 1,
      parentRevision,
      elements: [{ ...EARTHING }],
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => saveSchematicOverlay(tx, ctx, base),
    );
    // SPEC (Sperren): Schreiben nur per CAS — fehlender expectedRevision
    // antwortet mit Konflikt statt still zu ueberschreiben.
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          ...base,
          elements: [{ ...EARTHING }, { ...TEXTBOX }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicConflictError);
    expect((failure as SchematicConflictError).currentRevision).toBe(1);
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.element_count).toBe(1);
  });

  it("verwirft Editieren gegen veraltete Diagramm-Revision (Parent-Pin)", async () => {
    const fixture = await seedFixture();
    await seedDiagram(fixture, 1);
    const base = {
      offerId: fixture.offerId,
      variantRevision: 1,
      parentRevision: 1,
      elements: [{ ...EARTHING }],
    };
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => saveSchematicOverlay(tx, ctx, base),
    );
    // Diagramm driftet auf Revision 2 (Neuauslegung per Domaenen-Service).
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        ensureSchematicDiagram(tx, ctx, {
          offerId: fixture.offerId,
          variantId: fixture.variantId,
          variantRevision: 1,
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
        saveSchematicOverlay(tx, ctx, {
          ...base,
          elements: [{ ...EARTHING }, { ...TEXTBOX }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicConflictError);
    expect((failure as SchematicConflictError).currentRevision).toBe(1);
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.element_count).toBe(1);
  });

  it("meldet fehlendes Diagramm als Validierungsfehler (/parentRevision)", async () => {
    const fixture = await seedFixture();
    await seedDiagram(fixture, 1);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 2,
          parentRevision: 1,
          elements: [{ ...EARTHING }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicValidationError);
    expect((failure as SchematicValidationError).paths).toEqual(["/parentRevision"]);
    const count = await withTenantOn(testPool, fixture.workspaceId, countOverlays);
    expect(count).toBe(0);
  });

  it("verwirft commercial fail-closed ohne Write (Board-Scope live)", async () => {
    const fixture = await seedFixture();
    await seedDiagram(fixture, 1);
    await moveProjectToCommercialBoard(fixture);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
          parentRevision: 1,
          elements: [{ ...EARTHING }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicScopeError);
    expect((failure as Error).name).toBe("SchematicScopeError");
    const count = await withTenantOn(testPool, fixture.workspaceId, countOverlays);
    expect(count).toBe(0);
  });

  it("meldet unbekanntes Angebot als Validierungsfehler (/offerId)", async () => {
    const fixture = await seedFixture();
    await seedDiagram(fixture, 1);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: randomUUID(),
          variantRevision: 1,
          parentRevision: 1,
          elements: [{ ...EARTHING }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicValidationError);
    expect((failure as SchematicValidationError).paths).toEqual(["/offerId"]);
  });

  it("trennt Tenanten (fremde Angebote unsichtbar)", async () => {
    const fixtureA = await seedFixture();
    const fixtureB = await seedFixture();
    const parentA = await seedDiagram(fixtureA, 1);
    await withAuthorizedTenantOn(
      testPool,
      fixtureA.editorId,
      fixtureA.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixtureA.offerId,
          variantRevision: 1,
          parentRevision: parentA,
          elements: [{ ...EARTHING }],
        }),
    );
    // Fremdes Angebot ist im eigenen Tenanten unbekannt (RLS-Scope im Join).
    const crossTenant = await withAuthorizedTenantOn(
      testPool,
      fixtureB.editorId,
      fixtureB.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixtureA.offerId,
          variantRevision: 1,
          parentRevision: parentA,
          elements: [{ ...EARTHING }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(crossTenant).toBeInstanceOf(SchematicValidationError);
    expect((crossTenant as SchematicValidationError).paths).toEqual(["/offerId"]);
    const crossRead = await withAuthorizedTenantOn(
      testPool,
      fixtureB.editorId,
      fixtureB.workspaceId,
      (tx, ctx) =>
        readSchematicOverlay(tx, ctx, { offerId: fixtureA.offerId, variantRevision: 1 }),
    );
    expect(crossRead).toBeNull();
    const foreignInB = await withTenantOn(testPool, fixtureB.workspaceId, (tx) =>
      readOverlay(tx, fixtureB.workspaceId, fixtureA.offerId, 1),
    );
    expect(foreignInB).toBeUndefined();
  });

  it("verlangt project.write (Viewer liest, schreibt aber nicht)", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const writeFailure = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
          parentRevision,
          elements: [{ ...EARTHING }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(writeFailure).toBeInstanceOf(PermissionDeniedError);
    const readFailure = await withAuthorizedTenantOn(
      testPool,
      fixture.viewerId,
      fixture.workspaceId,
      (tx, ctx) =>
        readSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(readFailure).toBeInstanceOf(PermissionDeniedError);
  });

  it("sperrt externe Editoren ohne Zuweisung aus", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const writeFailure = await withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
          parentRevision,
          elements: [{ ...EARTHING }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(writeFailure).toBeInstanceOf(PermissionDeniedError);
    expect((writeFailure as PermissionDeniedError).reason).toBe(
      "external_only_without_assignment",
    );
    const readFailure = await withAuthorizedTenantOn(
      testPool,
      fixture.externalId,
      fixture.workspaceId,
      (tx, ctx) =>
        readSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(readFailure).toBeInstanceOf(PermissionDeniedError);
  });

  it("liest Overlay zurück, unbekannte Keys als null", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const missing = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        readSchematicOverlay(tx, ctx, { offerId: fixture.offerId, variantRevision: 1 }),
    );
    expect(missing).toBeNull();
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
          parentRevision,
          elements: [{ ...EARTHING }, { ...TEXTBOX }],
        }),
    );
    const found = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        readSchematicOverlay(tx, ctx, { offerId: fixture.offerId, variantRevision: 1 }),
    );
    expect(found).toMatchObject({
      revision: 1,
      parentRevision,
      elements: [
        { kind: "earthing_point", x: 10, y: 20 },
        { kind: "textbox", x: 30, y: 40, text: "Hinweis" },
      ],
    });
    // Invalide Eingabe faellt fail-closed auf null (kein Throw).
    for (const value of [
      { offerId: "keine-uuid", variantRevision: 1 },
      { offerId: fixture.offerId, variantRevision: 0 },
    ]) {
      const invalid = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => readSchematicOverlay(tx, ctx, value),
      );
      expect(invalid).toBeNull();
    }
  });

  it("wirft beim Lesen unter commercial (Scopefail, kein null)", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
          parentRevision,
          elements: [{ ...EARTHING }],
        }),
    );
    await moveProjectToCommercialBoard(fixture);
    const failure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        readSchematicOverlay(tx, ctx, {
          offerId: fixture.offerId,
          variantRevision: 1,
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).toBeInstanceOf(SchematicScopeError);
  });

  it("validiert Hülle und Elemente", async () => {
    const fixture = await seedFixture();
    const parentRevision = await seedDiagram(fixture, 1);
    const base = {
      offerId: fixture.offerId,
      variantRevision: 1,
      parentRevision,
      elements: [{ ...EARTHING }],
    };
    for (const value of [
      { ...base, offerId: "keine-uuid" },
      { ...base, variantRevision: 0 },
      { ...base, parentRevision: 0 },
      { ...base, elements: "x" },
      {
        ...base,
        elements: Array.from({ length: 33 }, (_, i) => ({
          kind: "earthing_point",
          x: i % 641,
          y: 0,
        })),
      },
    ]) {
      const failure = await withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) =>
          saveSchematicOverlay(tx, ctx, value).then(
            () => null,
            (error: unknown) => error,
          ),
      );
      expect(failure).toBeInstanceOf(SchematicValidationError);
    }
    // Je-Element-Pfade im Format /elements/{i}/... (max 20 Pfade).
    const elementFailure = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) =>
        saveSchematicOverlay(tx, ctx, {
          ...base,
          elements: [{ kind: "generic", x: 1, y: 2 }],
        }).then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(elementFailure).toBeInstanceOf(SchematicValidationError);
    const paths = (elementFailure as SchematicValidationError).paths;
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(20);
    expect(paths[0]!.startsWith("/elements/0")).toBe(true);
  });
});
