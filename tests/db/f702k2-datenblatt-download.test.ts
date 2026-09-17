import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// F7-02K2: lokales Backend je Worker (F10-04-Muster; Factory liest die
// Umgebung je Aufruf). Katalog-Keys sind NICHT immutable-praefiziert →
// Seeding via `put`, nie putImmutable (local.ts).
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f702k2-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { CatalogComponentRevisionV1 } from "@/lib/integrations/catalog/contract";
import {
  canonicalizeOfferJson,
  validateOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import {
  calculateOfferPricing,
  type OfferPricingSectionInput,
} from "@/lib/integrations/offers/money";
import { PermissionDeniedError } from "@/lib/permissions";
import { resolveObjectStorage } from "@/lib/storage";
import {
  createInstallation,
  InstallationNotFoundError,
  InstallationValidationError,
  readWorkbookDatasheet,
  setInstallationVariant,
} from "@/modules/installations";
import { OfferIntegrityError } from "@/modules/offers/errors";
import { testPool } from "../setup/test-db";
import { seedOfferFixtures, type OfferGraph } from "../setup/f806-offer-import-seed";

/**
 * F7-02K2 Datenblatt Byte-Download (Katalog F7.2) — Service-Op
 * `readWorkbookDatasheet` gegen echte Test-DB.
 *
 * Seeding (M2-01/02k-Muster): signierter Angebots-Graph (F7-08-Muster) +
 * ehrliche Revision 2 mit Katalog-Batteriezeile (echte Katalog-Revision,
 * echte Resolution-Bindung, Preise aus dem Katalog-Snapshot, Totals aus
 * der Engine) + Installation + Bindung + Storage-Objekt via `put`.
 * Revision 1 ist unveraenderlich (M2-01-Trigger), darum gaert die Zeile
 * in Revision 2; Negativ-Seeds (D-07/D-08/D-10) sind absichtlich
 * zod-ungueltig — der DB-Spiegel prueft nur Siegel + Projektion.
 */

const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n",
  "utf8",
);
const DATASHEET_FILENAME = "hersteller-datenblatt-batterie.pdf";

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  viewerId: string;
};

type SeedLine = {
  lineDomainId: string;
  position: number;
  componentCategory: string;
  positionType: "required" | "additional" | "optional";
  isHidden: boolean;
  quantityMilli: number;
  product: Record<string, unknown> & { kind: string; unit: string };
  source: Record<string, unknown> & { kind: string };
  salesPricing: { originalUnitNetCents: number; effectiveUnitNetCents: number; provenance: unknown };
  purchasePricing: { originalUnitNetCents: number; effectiveUnitNetCents: number; provenance: unknown };
  lineDiscountBps: number;
  taxTreatment: string;
  taxRateBps: number;
  taxDecision: unknown;
  computed: Record<string, number>;
};

type SeedSection = {
  sectionDomainId: string;
  position: number;
  category: string;
  title: string;
  discountBps: number;
  lines: SeedLine[];
};

type SeedSnapshot = Record<string, unknown> & {
  revision: number;
  sections: SeedSection[];
  createdAt: string;
  createdBy: string;
  sourceBindings: Record<string, unknown> & {
    resolutionId: string;
    resolutionRevision: number;
    resolutionSha256: string;
  };
  totals: {
    basisNetCents: number;
    basisTaxCents: number;
    basisGrossCents: number;
    optionalNetCents: number;
    optionalTaxCents: number;
    optionalGrossCents: number;
  };
};

type DatasheetSeed = {
  graph: OfferGraph;
  componentId: string;
  objectKey: string;
  sha256: string;
  filename: string;
  snapshot: Record<string, unknown>;
};

type DatasheetSeedOptions = {
  role?: string;
  mediaType?: string;
  keyWorkspaceId?: string;
  sha256?: string;
  hidden?: boolean;
  // null = kein Storage-Objekt (D-05-Normalfall: kein Produktiv-Writer).
  storageBytes?: Buffer | null;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702k2.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702k2.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f702k2.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, adminId, viewerId };
}

async function seedBoundDatasheet(
  fixture: Fixture,
  options: DatasheetSeedOptions = {},
): Promise<DatasheetSeed> {
  // Unsigierter Graph (M2-01-Muster): Die signierte Variante ist per
  // DB-Guard gegen Revision 2 gesperrt; der Download braucht kein Siegel.
  const graph = await seedOfferFixtures(testPool, {
    workspaceId: fixture.workspaceId,
    adminId: fixture.adminId,
  });
  const storageBytes = options.storageBytes === undefined ? PDF_BYTES : options.storageBytes;
  const assetSha = options.sha256
    ?? createHash("sha256").update(storageBytes ?? PDF_BYTES).digest("hex");

  const seed = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const rev = await tx.execute<{
      revision_snapshot: SeedSnapshot & { snapshotSha256: string };
      schema_version: string;
      canonicalization_version: string;
      [key: string]: unknown;
    }>(sql`
      select revision.revision_snapshot, revision.schema_version,
             revision.canonicalization_version
        from offer_variant_revision as revision
       where revision.workspace_id = ${fixture.workspaceId}::uuid
         and revision.variant_id = ${graph.variantId}::uuid
         and revision.revision = 1
    `);
    const rev1 = rev.rows[0];
    if (!rev1) throw new Error("F7-02K2-Seed: Revision 1 fehlt.");
    const catalog = await tx.execute<{
      component_id: string;
      revision: number;
      revision_snapshot: CatalogComponentRevisionV1;
      snapshot_sha256_hex: string;
      [key: string]: unknown;
    }>(sql`
      select component.id as component_id, component.current_revision as revision,
             revision.revision_snapshot,
             encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
        from catalog_component as component
        join catalog_component_revision as revision
          on revision.workspace_id = component.workspace_id
         and revision.component_id = component.id
         and revision.revision = component.current_revision
       where component.workspace_id = ${fixture.workspaceId}::uuid
       limit 1
    `);
    const battery = catalog.rows[0];
    if (!battery) {
      throw new Error("F7-02K2-Seed: Katalog-Batterie fehlt.");
    }
    const line = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id from project_catalog_resolution_line
       where workspace_id = ${fixture.workspaceId}::uuid
         and catalog_component_id = ${battery.component_id}::uuid
       limit 1
    `);
    if (!line.rows[0]) throw new Error("F7-02K2-Seed: Resolution-Zeile fehlt.");
    return { rev1, battery, resolutionLineId: line.rows[0].id };
  });

  const commercial = seed.battery.revision_snapshot.commercial;
  if (!commercial) throw new Error("F7-02K2-Seed: Katalog-Preise fehlen.");
  const presentation = seed.battery.revision_snapshot.presentation;
  const objectKey = [
    "catalog",
    options.keyWorkspaceId ?? fixture.workspaceId,
    seed.battery.component_id,
    `${assetSha}.pdf`,
  ].join("/");
  const batteryLine: SeedLine = {
    lineDomainId: randomUUID(),
    position: 1,
    componentCategory: "battery",
    positionType: "required",
    isHidden: options.hidden ?? false,
    quantityMilli: 1_000,
    product: {
      kind: "catalog",
      internalSku: seed.battery.revision_snapshot.identity.internalSku,
      displayName: presentation.displayName,
      manufacturer: presentation.manufacturer,
      model: presentation.model,
      unit: "piece",
      technicalData: seed.battery.revision_snapshot.technicalData,
      image: null,
      datasheet: {
        role: options.role ?? "datasheet",
        objectKey,
        sha256: assetSha,
        mediaType: options.mediaType ?? "application/pdf",
        originalFilename: DATASHEET_FILENAME,
      },
      technicalProvenance: seed.battery.revision_snapshot.technicalProvenance,
    },
    source: {
      kind: "catalog",
      catalogComponentId: seed.battery.component_id,
      catalogComponentRevision: seed.battery.revision,
      componentSnapshotSha256: seed.battery.snapshot_sha256_hex,
      resolutionLineId: seed.resolutionLineId,
      resolutionId: seed.rev1.revision_snapshot.sourceBindings.resolutionId,
      resolutionRevision: seed.rev1.revision_snapshot.sourceBindings.resolutionRevision,
      resolutionSha256: seed.rev1.revision_snapshot.sourceBindings.resolutionSha256,
      catalogSalesUnitNetCents: commercial.salesPriceNetCents,
      catalogPurchaseUnitNetCents: commercial.purchasePriceNetCents,
    },
    salesPricing: {
      originalUnitNetCents: commercial.salesPriceNetCents,
      effectiveUnitNetCents: commercial.salesPriceNetCents,
      provenance: { kind: "catalog_seed", catalogProvenance: commercial.salesProvenance },
    },
    purchasePricing: {
      originalUnitNetCents: commercial.purchasePriceNetCents,
      effectiveUnitNetCents: commercial.purchasePriceNetCents,
      provenance: { kind: "catalog_seed", catalogProvenance: commercial.purchaseProvenance },
    },
    lineDiscountBps: 0,
    taxTreatment: "standard_19",
    taxRateBps: 1_900,
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: fixture.adminId,
      selectedAt: seed.rev1.revision_snapshot.createdAt,
    },
    computed: {
      lineBaseNetCents: 0,
      lineDiscountedNetCents: 0,
      sectionDiscountedNetCents: 0,
      finalSalesNetCents: 0,
      salesTaxCents: 0,
      salesGrossCents: 0,
      purchaseNetCents: 0,
    },
  };
  const sections: SeedSection[] = [
    ...seed.rev1.revision_snapshot.sections,
    {
      sectionDomainId: randomUUID(),
      position: 2,
      category: "battery",
      title: "Batteriespeicher",
      discountBps: 0,
      lines: [batteryLine],
    },
  ];
  const pricingSections: OfferPricingSectionInput[] = sections.map((section) => ({
    sectionDomainId: section.sectionDomainId,
    position: section.position,
    discountBps: section.discountBps,
    lines: section.lines.map((line) => ({
      lineDomainId: line.lineDomainId,
      position: line.position,
      unit: line.product.unit as "piece" | "set" | "meter",
      positionType: line.positionType,
      isHidden: line.isHidden,
      quantityMilli: line.quantityMilli,
      salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
      purchaseUnitNetCents: line.purchasePricing.effectiveUnitNetCents,
      lineDiscountBps: line.lineDiscountBps,
      taxRateBps: line.taxRateBps,
    })),
  }));
  const calculated = calculateOfferPricing({
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    globalDiscountCapCents: null,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: pricingSections,
  });
  const calculatedById = new Map(calculated.lines.map((line) => [line.lineDomainId, line]));
  for (const section of sections) {
    for (const line of section.lines) {
      const priced = calculatedById.get(line.lineDomainId);
      if (!priced) throw new Error("F7-02K2-Seed: Engine-Zeile fehlt.");
      line.computed = {
        lineBaseNetCents: priced.lineBaseNetCents,
        lineDiscountedNetCents: priced.lineDiscountedNetCents,
        sectionDiscountedNetCents: priced.sectionDiscountedNetCents,
        finalSalesNetCents: priced.finalSalesNetCents,
        salesTaxCents: priced.salesTaxCents,
        salesGrossCents: priced.salesGrossCents,
        purchaseNetCents: priced.purchaseNetCents,
      };
    }
  }
  const rev1Rest: Record<string, unknown> = { ...seed.rev1.revision_snapshot };
  delete rev1Rest.snapshotSha256;
  const body = { ...rev1Rest, revision: 2, sections, totals: calculated.totals };
  const snapshotSha256 = createHash("sha256")
    .update(canonicalizeOfferJson(body), "utf8")
    .digest("hex");
  const snapshot = { ...body, snapshotSha256 };

  const revisionId = randomUUID();
  const bindings = seed.rev1.revision_snapshot.sourceBindings;
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into offer_variant_revision (
        id, workspace_id, offer_id, variant_id, project_id, revision,
        schema_version, canonicalization_version, revision_snapshot,
        snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
        basis_net_cents, basis_tax_cents, basis_gross_cents,
        optional_net_cents, optional_tax_cents, optional_gross_cents,
        created_by, created_at
      ) values (
        ${revisionId}::uuid, ${fixture.workspaceId}::uuid, ${graph.offerId}::uuid,
        ${graph.variantId}::uuid, ${graph.projectId}::uuid, 2,
        ${seed.rev1.schema_version}, ${seed.rev1.canonicalization_version},
        ${JSON.stringify(snapshot)}::jsonb, decode(${snapshotSha256}, 'hex'),
        ${bindings.resolutionId}::uuid, ${bindings.resolutionRevision},
        decode(${bindings.resolutionSha256}, 'hex'),
        ${calculated.totals.basisNetCents}, ${calculated.totals.basisTaxCents},
        ${calculated.totals.basisGrossCents}, ${calculated.totals.optionalNetCents},
        ${calculated.totals.optionalTaxCents}, ${calculated.totals.optionalGrossCents},
        ${seed.rev1.revision_snapshot.createdBy}::uuid,
        ${seed.rev1.revision_snapshot.createdAt}::timestamptz
      )
    `);
    for (const section of sections) {
      const sectionId = randomUUID();
      await tx.execute(sql`
        insert into offer_variant_section (
          id, workspace_id, offer_id, variant_id, project_id,
          revision_id, revision, section_domain_id, position,
          category, title, discount_bps, section_snapshot
        ) values (
          ${sectionId}::uuid, ${fixture.workspaceId}::uuid, ${graph.offerId}::uuid,
          ${graph.variantId}::uuid, ${graph.projectId}::uuid, ${revisionId}::uuid, 2,
          ${section.sectionDomainId}::uuid, ${section.position}, ${section.category},
          ${section.title}, ${section.discountBps}, ${JSON.stringify(section)}::jsonb
        )
      `);
      for (const line of section.lines) {
        const isCatalog = line.source.kind === "catalog";
        await tx.execute(sql`
          insert into offer_bom_line (
            id, workspace_id, offer_id, variant_id, project_id,
            revision_id, revision, section_id, section_domain_id, line_domain_id,
            position, component_category, position_type, is_hidden,
            quantity_milli, unit, source_kind,
            catalog_component_id, catalog_component_revision, component_snapshot_sha256,
            original_sales_unit_net_cents, effective_sales_unit_net_cents,
            original_purchase_unit_net_cents, effective_purchase_unit_net_cents,
            line_discount_bps, tax_treatment, tax_rate_bps,
            line_base_net_cents, line_discounted_net_cents,
            section_discounted_net_cents, final_sales_net_cents,
            sales_tax_cents, sales_gross_cents, purchase_net_cents, line_snapshot
          ) values (
            ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${graph.offerId}::uuid,
            ${graph.variantId}::uuid, ${graph.projectId}::uuid, ${revisionId}::uuid, 2,
            ${sectionId}::uuid, ${section.sectionDomainId}::uuid, ${line.lineDomainId}::uuid,
            ${line.position}, ${line.componentCategory}, ${line.positionType}, ${line.isHidden},
            ${line.quantityMilli}, ${line.product.unit}, ${line.source.kind},
            ${isCatalog ? seed.battery.component_id : null}::uuid,
            ${isCatalog ? seed.battery.revision : null},
            decode(${isCatalog ? seed.battery.snapshot_sha256_hex : null}, 'hex'),
            ${line.salesPricing.originalUnitNetCents}, ${line.salesPricing.effectiveUnitNetCents},
            ${line.purchasePricing.originalUnitNetCents}, ${line.purchasePricing.effectiveUnitNetCents},
            ${line.lineDiscountBps}, ${line.taxTreatment}, ${line.taxRateBps},
            ${line.computed.lineBaseNetCents}, ${line.computed.lineDiscountedNetCents},
            ${line.computed.sectionDiscountedNetCents}, ${line.computed.finalSalesNetCents},
            ${line.computed.salesTaxCents}, ${line.computed.salesGrossCents},
            ${line.computed.purchaseNetCents}, ${JSON.stringify(line)}::jsonb
          )
        `);
      }
    }
    await tx.execute(sql`
      update offer_variant set current_revision = 2
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${graph.variantId}::uuid
    `);
  });

  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createInstallation(tx, ctx, { projectId: graph.projectId }),
  );
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => setInstallationVariant(tx, ctx, {
      projectId: graph.projectId,
      variantId: graph.variantId,
    }),
  );
  if (storageBytes !== null) {
    await resolveObjectStorage().put(objectKey, storageBytes, "application/pdf");
  }
  return {
    graph,
    componentId: seed.battery.component_id,
    objectKey,
    sha256: assetSha,
    filename: DATASHEET_FILENAME,
    snapshot,
  };
}

function expectNoKeyLeak(error: unknown, seed: DatasheetSeed): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toContain(seed.objectKey);
  expect(message).not.toContain(seed.sha256);
  expect(message).not.toContain("catalog/");
}

describe("F7-02K2 Datenblatt Byte-Download (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture("F7-02K2 Datenblatt-Download");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F702K2-D-01: Happy Path — bytegleiche Bytes + Dateiname, kein Key im DTO", async () => {
    const seed = await seedBoundDatasheet(fixture);
    // Ehrlicher Siegel-Beleg: Der Happy-Seed ist ein gueltiger Snapshot.
    expect(validateOfferVariantSnapshot(seed.snapshot).ok).toBe(true);
    const result = await asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    }));
    expect(result.filename).toBe(DATASHEET_FILENAME);
    expect(result.body.equals(PDF_BYTES)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["body", "filename"]);
    expect(JSON.stringify({ filename: result.filename })).not.toContain(seed.sha256);
  });

  it("F702K2-D-02: ohne Bindung → NotFound (keine Installation / ungebunden)", async () => {
    const graph = await seedOfferFixtures(testPool, {
      workspaceId: fixture.workspaceId,
      adminId: fixture.adminId,
    });
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: graph.projectId,
      componentId: randomUUID(),
    }))).rejects.toBeInstanceOf(InstallationNotFoundError);
    await asEditor(fixture, (tx, ctx) => createInstallation(tx, ctx, { projectId: graph.projectId }));
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: graph.projectId,
      componentId: randomUUID(),
    }))).rejects.toBeInstanceOf(InstallationNotFoundError);
  });

  it("F702K2-D-03: fremde/versteckte componentId → NotFound, ungueltige UUID → Validation", async () => {
    const seed = await seedBoundDatasheet(fixture);
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: randomUUID(),
    }))).rejects.toBeInstanceOf(InstallationNotFoundError);
    try {
      await asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
        projectId: seed.graph.projectId,
        componentId: randomUUID(),
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationNotFoundError);
      expectNoKeyLeak(error, seed);
    }
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: "keine-uuid",
      componentId: seed.componentId,
    }))).rejects.toBeInstanceOf(InstallationValidationError);
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: "keine-uuid",
    }))).rejects.toBeInstanceOf(InstallationValidationError);
  });

  it("F702K2-D-03b: versteckte Zeile → NotFound (keine Bytes ohne sichtbare Ref)", async () => {
    const seed = await seedBoundDatasheet(fixture, { hidden: true });
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    }))).rejects.toBeInstanceOf(InstallationNotFoundError);
  });

  it("F702K2-D-04: fremder Workspace → NotFound ohne Leak", async () => {
    const seed = await seedBoundDatasheet(fixture);
    const other = await seedFixture("F7-02K2 Fremd-Workspace");
    try {
      await asEditor(other, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
        projectId: seed.graph.projectId,
        componentId: seed.componentId,
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationNotFoundError);
      expectNoKeyLeak(error, seed);
    }
  });

  it("F702K2-D-05: fehlendes Storage-Objekt → NotFound (Normalfall, kein Writer)", async () => {
    const seed = await seedBoundDatasheet(fixture, { storageBytes: null });
    try {
      await asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
        projectId: seed.graph.projectId,
        componentId: seed.componentId,
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationNotFoundError);
      expectNoKeyLeak(error, seed);
    }
  });

  it("F702K2-D-06: sha-Mismatch → Integrity", async () => {
    const seed = await seedBoundDatasheet(fixture, {
      sha256: createHash("sha256").update("f702k2-fremde-bytes").digest("hex"),
    });
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    }))).rejects.toBeInstanceOf(OfferIntegrityError);
  });

  it("F702K2-D-07: MIME-/Rollen-Pin — mediaType/role-Mismatch → Validation", async () => {
    const pngMedia = await seedBoundDatasheet(fixture, { mediaType: "image/png" });
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: pngMedia.graph.projectId,
      componentId: pngMedia.componentId,
    }))).rejects.toBeInstanceOf(InstallationValidationError);
    // Eigener Workspace: Revision 2 ist je Variante einmalig.
    const other = await seedFixture("F7-02K2 Rollen-Pin");
    const imageRole = await seedBoundDatasheet(other, { role: "image" });
    await expect(asEditor(other, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: imageRole.graph.projectId,
      componentId: imageRole.componentId,
    }))).rejects.toBeInstanceOf(InstallationValidationError);
  });

  it("F702K2-D-08: Key-Rebuild-Mismatch (fremde Workspace-ID) → Validation", async () => {
    const seed = await seedBoundDatasheet(fixture, { keyWorkspaceId: randomUUID() });
    try {
      await asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
        projectId: seed.graph.projectId,
        componentId: seed.componentId,
      }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationValidationError);
      expectNoKeyLeak(error, seed);
    }
  });

  it("F702K2-D-09: Uebergroesse (>25 MiB) → Integrity", async () => {
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "utf8"),
      Buffer.alloc(26_214_401 - 9),
    ]);
    const seed = await seedBoundDatasheet(fixture, { storageBytes: oversized });
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    }))).rejects.toBeInstanceOf(OfferIntegrityError);
  });

  it("F702K2-D-10: fehlende Magic-Bytes → Integrity", async () => {
    const seed = await seedBoundDatasheet(fixture, {
      storageBytes: Buffer.from("KEIN-PDF-SONDERN-PLAINTEXT", "utf8"),
    });
    await expect(asEditor(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    }))).rejects.toBeInstanceOf(OfferIntegrityError);
  });

  it("F702K2-D-11: ohne installation.read → Permission; Viewer lesend gruen", async () => {
    const seed = await seedBoundDatasheet(fixture);
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update membership set capabilities = '{"external_only":true}'::jsonb
         where workspace_id = ${fixture.workspaceId}::uuid
           and user_id = ${fixture.viewerId}::uuid
      `);
    });
    const denied = await asViewer(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    })).then(
      () => null,
      (error: unknown) => error,
    );
    expect(denied).toBeInstanceOf(PermissionDeniedError);
    expect((denied as PermissionDeniedError).action).toBe("installation.read");
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update membership set capabilities = '{}'::jsonb
         where workspace_id = ${fixture.workspaceId}::uuid
           and user_id = ${fixture.viewerId}::uuid
      `);
    });
    const viewerRead = await asViewer(fixture, (tx, ctx) => readWorkbookDatasheet(tx, ctx, {
      projectId: seed.graph.projectId,
      componentId: seed.componentId,
    }));
    expect(viewerRead.body.equals(PDF_BYTES)).toBe(true);
  });
});
