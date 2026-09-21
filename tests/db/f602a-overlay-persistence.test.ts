// F6-02a/W-DB-TEST Editor-Overlay-Persistenz (PostgreSQL): Tabelle
// `schematic_overlays` (0301, Muster 0300) haelt je
// (Workspace, Angebot, Varianten-Revision) genau eine Overlay-Huelle
// (JSONB-Objekt mit `elements`-Array), pinnt `parent_revision` (Revision der
// `schematic_diagrams`-Zeile beim Anlegen) und ist tenant-isoliert.
// RED-first-Konstruktion: Ohne Migration 0301 schlaegt jeder Live-Fall fehl —
// fehlende Tabelle (42P01 statt 23505/23514/42501). Der Grant-Fall ist ein
// M109-Textvertrag (Datei fehlt ohne Slice) statt Live-Abfrage.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  createSchematicOverlayFixture,
  tenantFixtures,
} from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  offerId: string;
  variantId: string;
  projectId: string;
};

// Harness exakt wie F6-01 (f601-schematic-save.test.ts): Tenant-Setup,
// residential Offer+Variante ueber die Tenant-Fixture, dazu eine
// Diagramm-Zeile als Parent der Overlay-Pins.
async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(
      sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F602a Overlay')`,
    );
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f602a.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f602a.test`})
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
  // Diagramm-Zeile (0300-Spalten): Parent des Overlay-Pins, leere Netzliste.
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into schematic_diagrams (
        workspace_id, offer_id, variant_revision, netlist, node_count, edge_count
      ) values (
        ${workspaceId}::uuid, ${ids.offerId}::uuid, 1,
        '{"nodes":[],"edges":[]}'::jsonb, 0, 0
      )
    `);
  });
  return { workspaceId, editorId, viewerId, ...ids };
}

type OverlayRow = {
  workspace_id: string;
  offer_id: string;
  variant_revision: number;
  parent_revision: number;
  revision: number;
  elements: { elements: Array<Record<string, unknown>>; [key: string]: unknown };
  element_count: number | null;
  editor_version: string;
  [key: string]: unknown;
};

async function readOverlay(
  tx: TenantTx,
  workspaceId: string,
  offerId: string,
  variantRevision: number,
): Promise<OverlayRow | undefined> {
  const result = await tx.execute<OverlayRow>(sql`
    select workspace_id, offer_id, variant_revision, parent_revision, revision,
           elements, element_count, editor_version
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

// Gueltige Hülle (editor-overlay.v1): Objekt mit `elements`-Array.
function validElements(): { elements: Array<Record<string, unknown>> } {
  return {
    elements: [
      { kind: "textbox", x: 10, y: 20, text: "Erdung prüfen" },
      { kind: "earthing_point", x: 12, y: 24 },
    ],
  };
}

type OverlayInsert = {
  workspaceId: string;
  offerId: string;
  variantRevision?: number;
  parentRevision?: number;
  revision?: number | null;
  elements?: unknown;
  elementCount?: number | null;
  editorVersion?: string | null;
};

async function insertOverlay(tx: TenantTx, value: OverlayInsert): Promise<void> {
  const envelope = value.elements === undefined ? validElements() : value.elements;
  const columns = ["workspace_id", "offer_id", "variant_revision", "parent_revision", "elements"];
  const holders: ReturnType<typeof sql>[] = [
    sql`${value.workspaceId}::uuid`,
    sql`${value.offerId}::uuid`,
    sql`${value.variantRevision ?? 1}`,
    sql`${value.parentRevision ?? 1}`,
    sql`${JSON.stringify(envelope)}::jsonb`,
  ];
  if (value.revision !== undefined && value.revision !== null) {
    columns.push("revision");
    holders.push(sql`${value.revision}`);
  }
  if (value.elementCount !== undefined && value.elementCount !== null) {
    columns.push("element_count");
    holders.push(sql`${value.elementCount}`);
  }
  if (value.editorVersion !== undefined && value.editorVersion !== null) {
    columns.push("editor_version");
    holders.push(sql`${value.editorVersion}`);
  }
  const columnList = sql.join(
    columns.map((column) => sql.identifier(column)),
    sql`, `,
  );
  const valueList = sql.join(holders, sql`, `);
  await tx.execute(sql`insert into schematic_overlays (${columnList}) values (${valueList})`);
}

// Harte SQLSTATE-Prüfung statt bloßem "wirft": Ohne 0301 meldet Postgres
// 42P01 (fehlende Tabelle) statt des erwarteten Constraint-/RLS-States —
// der Fall bleibt RED statt vakuum-grün.
function pgCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    return (cause as { code?: unknown }).code;
  }
  return undefined;
}

async function expectSqlState(promise: Promise<unknown>, state: string): Promise<void> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).not.toBeNull();
  expect(pgCode(failure)).toBe(state);
}

describe("F6-02a/W-DB-TEST schematic_overlays", () => {
  it("legt Overlay mit Hülle, parent_revision und revision=1 an", async () => {
    const fixture = await seedFixture();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await insertOverlay(tx, {
        workspaceId: fixture.workspaceId,
        offerId: fixture.offerId,
        elementCount: 2,
      });
    });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.parent_revision).toBe(1);
    expect(row?.element_count).toBe(2);
    expect(row?.editor_version).toBe("editor-overlay.v1");
    expect(row?.elements.elements).toHaveLength(2);
    expect(row?.elements.elements[0]).toMatchObject({ kind: "textbox", x: 10, y: 20 });
  });

  it("setzt editor_version-Default ohne explizite Spalte", async () => {
    const fixture = await seedFixture();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await insertOverlay(tx, {
        workspaceId: fixture.workspaceId,
        offerId: fixture.offerId,
      });
    });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.editor_version).toBe("editor-overlay.v1");
  });

  it("legt je Varianten-Revision eigene Zeilen an", async () => {
    const fixture = await seedFixture();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await insertOverlay(tx, {
        workspaceId: fixture.workspaceId,
        offerId: fixture.offerId,
        variantRevision: 1,
      });
      await insertOverlay(tx, {
        workspaceId: fixture.workspaceId,
        offerId: fixture.offerId,
        variantRevision: 2,
      });
    });
    const count = await withTenantOn(testPool, fixture.workspaceId, countOverlays);
    expect(count).toBe(2);
  });

  it("trennt Tenanten (fremder Workspace sieht/schreibt nichts)", async () => {
    const fixtureA = await seedFixture();
    const fixtureB = await seedFixture();
    await withTenantOn(testPool, fixtureA.workspaceId, async (tx) => {
      await insertOverlay(tx, {
        workspaceId: fixtureA.workspaceId,
        offerId: fixtureA.offerId,
      });
    });
    // Lesen: fremde Zeile ist im eigenen Tenanten unsichtbar.
    const foreign = await withTenantOn(testPool, fixtureB.workspaceId, (tx) =>
      readOverlay(tx, fixtureB.workspaceId, fixtureA.offerId, 1),
    );
    expect(foreign).toBeUndefined();
    const countB = await withTenantOn(testPool, fixtureB.workspaceId, countOverlays);
    expect(countB).toBe(0);
    // Schreiben: fremd gestempelte Zeile scheitert am RLS-WITH-CHECK.
    await expectSqlState(
      withTenantOn(testPool, fixtureB.workspaceId, async (tx) => {
        await insertOverlay(tx, {
          workspaceId: fixtureA.workspaceId,
          offerId: fixtureA.offerId,
        });
      }),
      "42501",
    );
  });

  it("verletzt Unique bei Duplikat je (Workspace, Angebot, Revision)", async () => {
    const fixture = await seedFixture();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await insertOverlay(tx, {
        workspaceId: fixture.workspaceId,
        offerId: fixture.offerId,
        variantRevision: 1,
      });
    });
    await expectSqlState(
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await insertOverlay(tx, {
          workspaceId: fixture.workspaceId,
          offerId: fixture.offerId,
          variantRevision: 1,
        });
      }),
      "23505",
    );
    const count = await withTenantOn(testPool, fixture.workspaceId, countOverlays);
    expect(count).toBe(1);
  });

  it.each([
    ["Hülle ist kein Objekt", []],
    ["Hülle ohne elements-Schlüssel", { foo: 1 }],
    ["elements ist kein Array", { elements: {} }],
  ])("verwirft CHECK-widrige Hülle: %s", async (_label, elements) => {
    const fixture = await seedFixture();
    await expectSqlState(
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await insertOverlay(tx, {
          workspaceId: fixture.workspaceId,
          offerId: fixture.offerId,
          elements,
        });
      }),
      "23514",
    );
  });

  it("verwirft parent_revision 0 (CHECK)", async () => {
    const fixture = await seedFixture();
    await expectSqlState(
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await insertOverlay(tx, {
          workspaceId: fixture.workspaceId,
          offerId: fixture.offerId,
          parentRevision: 0,
        });
      }),
      "23514",
    );
  });

  it("verwirft revision 0 (CHECK)", async () => {
    const fixture = await seedFixture();
    await expectSqlState(
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await insertOverlay(tx, {
          workspaceId: fixture.workspaceId,
          offerId: fixture.offerId,
          revision: 0,
        });
      }),
      "23514",
    );
  });

  it("verwirft negatives element_count (CHECK)", async () => {
    const fixture = await seedFixture();
    await expectSqlState(
      withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await insertOverlay(tx, {
          workspaceId: fixture.workspaceId,
          offerId: fixture.offerId,
          elementCount: -1,
        });
      }),
      "23514",
    );
  });

  it("gibt app_runtime SELECT/INSERT/UPDATE ohne DELETE (Migrationsvertrag)", async () => {
    // M109-Muster: Grants haengen an der app_runtime-Rolle, die in der
    // Test-DB nicht existiert — Textvertrag statt Live-Abfrage (die
    // Laufzeit-Seite prueft db:roles:verify mit Pins).
    const migration = await readFile(
      "drizzle/0301_f6_02a_schematic_overlays.sql",
      "utf8",
    );
    expect(migration).toContain("ALTER TABLE public.schematic_overlays ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE public.schematic_overlays FORCE ROW LEVEL SECURITY");
    expect(
      migration.match(/CREATE POLICY tenant_isolation ON public\.schematic_overlays/g),
    ).toHaveLength(1);
    expect(migration).toContain("to_regrole('app_runtime')");
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON public.schematic_overlays TO app_runtime",
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*schematic_overlays/iu);
  });

  it("Fixture-Helper legt gültige Zeile an", async () => {
    const fixture = await seedFixture();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await createSchematicOverlayFixture(tx, fixture.workspaceId);
    });
    const row = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      readOverlay(tx, fixture.workspaceId, fixture.offerId, 1),
    );
    expect(row?.revision).toBe(1);
    expect(row?.parent_revision).toBe(1);
    expect(row?.editor_version).toBe("editor-overlay.v1");
    expect(row?.elements.elements).toHaveLength(1);
  });
});
