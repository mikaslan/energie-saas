import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
} from "@/lib/integrations/catalog/contract";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  type CreateOfferCommandV1,
} from "@/lib/integrations/offers/contract";
import {
  PACKAGE_TEMPLATE_SCHEMA_VERSION,
  type PackageTemplateLine,
} from "@/lib/integrations/offers/package-contract";
import {
  activateCatalogComponent,
  archiveCatalogComponent,
  reviseCatalogComponentPricing,
} from "@/modules/catalog";
import {
  applyPackageTemplate,
  createOfferFromRequest,
  createPackageTemplate,
  listPackageTemplates,
  OfferConflictError,
  PackageTemplateStaleError,
  PackageTemplateValidationError,
  reviseOfferVariant,
  updatePackageTemplate,
} from "@/modules/offers";
import { seedM201ReadyProject } from "../e2e/m2-01-fixture";
import { testPool } from "../setup/test-db";

/**
 * F16-13 Katalog-Zeilen in Paket-Vorlagen (Katalog F16.2).
 * Zeilen binden optional an eine Katalogkomponente (Id + Revision);
 * Preise/Einheit stammen beim Speichern aus der gebundenen Revision
 * (Fälschungsschutz), Drift (Revision/Archiv/fehlt) scheitert beim
 * Speichern UND beim Einsetzen fail-closed (StaleError). Manuelle
 * Preis-/Einheitsedits lösen die Bindung (Client-Regel). Ohne Migration
 * (package_lines jsonb), ohne neue Permission.
 */

const MODULE_SALES = 25_000;
const MODULE_PURCHASE = 15_000;

type Members = { workspaceId: string; operatorId: string };

async function createMembers(): Promise<Members> {
  const members = { workspaceId: randomUUID(), operatorId: randomUUID() };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F16-13 Katalog-Zeilen')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${members.operatorId}::uuid, ${`${members.operatorId}@f1613.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (
        ${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
        '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
           "discounts":true,"see_purchase_prices":true}'::jsonb
      )
    `);
  });
  return members;
}

type CatalogOffer = {
  members: Members;
  projectId: string;
  moduleId: string;
  offerId: string;
  variantId: string;
};

async function createCatalogOffer(): Promise<CatalogOffer> {
  const members = await createMembers();
  const databaseUrl = process.env.POSTGRES_URL_TEST;
  if (!databaseUrl) throw new Error("POSTGRES_URL_TEST fehlt.");
  const seed = await seedM201ReadyProject(databaseUrl, {
    workspaceId: members.workspaceId,
    editorIdentityId: members.operatorId,
    skuSuffix: `F1613-${randomUUID().slice(0, 8)}`,
  });
  const command: CreateOfferCommandV1 = {
    schemaVersion: OFFER_CREATE_COMMAND_VERSION,
    projectId: seed.projectId,
    expectedRequirementRevision: 1,
    expectedCalculationRevision: 1,
    expectedResolutionRevision: 1,
    forecastValueNetCents: 1_250_000,
    priceAudience: "b2c",
    priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
    taxTreatment: "standard_19",
  };
  const created = await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => createOfferFromRequest(tx, ctx, command),
  );
  return {
    members,
    projectId: seed.projectId,
    moduleId: seed.products.module,
    offerId: created.offerId,
    variantId: created.variantId,
  };
}

function boundLine(overrides: Partial<PackageTemplateLine> = {}): PackageTemplateLine {
  return {
    displayName: "F1613 Modulzeile",
    description: null,
    unit: "piece",
    quantityMilli: 4_000,
    // Absichtlich falsch — der Server stempelt Live-Werte (Fälschungsschutz).
    salesUnitNetCents: 1,
    purchaseUnitNetCents: 1,
    positionType: "required",
    isHidden: false,
    taxTreatment: "standard_19",
    ...overrides,
  };
}

async function createTemplate(
  offer: CatalogOffer,
  name: string,
  lines: PackageTemplateLine[],
): Promise<string> {
  const created = await withAuthorizedTenantOn(
    testPool, offer.members.operatorId, offer.members.workspaceId,
    (tx, ctx) => createPackageTemplate(tx, ctx, {
      schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
      name,
      sectionTitle: "F1613 Sektion",
      category: "module",
      lines,
    }),
  );
  return created.id;
}

async function readTemplateLines(
  offer: CatalogOffer,
  templateId: string,
): Promise<PackageTemplateLine[]> {
  const rows = await withAuthorizedTenantOn(
    testPool, offer.members.operatorId, offer.members.workspaceId,
    (tx, ctx) => listPackageTemplates(tx, ctx).then((all) => all.find((row) => row.id === templateId)!),
  );
  return rows.lines;
}

async function applyTemplate(
  offer: CatalogOffer,
  templateId: string,
  expectedRevision: number,
): Promise<{ revision: number; addedLines: number }> {
  const result = await withAuthorizedTenantOn(
    testPool, offer.members.operatorId, offer.members.workspaceId,
    (tx, ctx) => applyPackageTemplate(tx, ctx, {
      schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
      templateId,
      offerId: offer.offerId,
      variantId: offer.variantId,
      expectedRevision,
      zeroConfirmed: false,
    }),
  );
  return { revision: result.revision, addedLines: result.addedLines };
}

type SnapshotLine = {
  lineDomainId: string;
  quantityMilli: number;
  product: { kind: string; displayName?: string };
  salesPricing: { effectiveUnitNetCents: number };
  purchasePricing: { effectiveUnitNetCents: number };
};

async function readOfferLines(
  offer: CatalogOffer,
  revision: number,
): Promise<SnapshotLine[]> {
  return withTenantOn(testPool, offer.members.workspaceId, async (tx) => {
    const result = await tx.execute<{ sections: unknown }>(sql`
      select revision_snapshot -> 'sections' as sections
        from offer_variant_revision
       where workspace_id = ${offer.members.workspaceId}::uuid
         and offer_id = ${offer.offerId}::uuid
         and variant_id = ${offer.variantId}::uuid
         and revision = ${revision}
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`revision ${revision} not found`);
    const sections = row.sections as Array<{ lines: SnapshotLine[] }>;
    return sections.flatMap((section) => section.lines);
  });
}

const NEW_PRICES = {
  currency: "EUR" as const,
  basis: "net" as const,
  purchasePriceNetCents: 16_000,
  salesPriceNetCents: 26_000,
  purchaseProvenance: {
    sourceKind: "supplier_price_list" as const,
    reference: "F1613-SUPPLIER",
    observedOn: "2026-09-15",
    rightsBasis: "supplier_authorized" as const,
    sourceDocumentSha256: null,
  },
  salesProvenance: {
    sourceKind: "workspace_pricing" as const,
    reference: "F1613-SALES",
    observedOn: "2026-09-15",
    rightsBasis: "workspace_owned" as const,
    sourceDocumentSha256: null,
  },
};

async function driftModulePrice(offer: CatalogOffer): Promise<number> {
  const revised = await withAuthorizedTenantOn(
    testPool, offer.members.operatorId, offer.members.workspaceId,
    (tx, ctx) => reviseCatalogComponentPricing(tx, ctx, {
      schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
      componentId: offer.moduleId,
      expectedRevision: 1,
      commercial: NEW_PRICES,
    }),
  );
  await withAuthorizedTenantOn(
    testPool, offer.members.operatorId, offer.members.workspaceId,
    (tx, ctx) => activateCatalogComponent(tx, ctx, {
      componentId: offer.moduleId,
      expectedRevision: revised.revision,
      expectedStatus: "draft",
    }),
  );
  return revised.revision;
}

describe("F16-13 Katalog-Zeilen (PostgreSQL)", () => {
  it("F1613-DB-01: Bindung stempelt Live-Preise; Einsetzen übernimmt sie", async () => {
    const offer = await createCatalogOffer();
    const templateId = await createTemplate(offer, "F1613 Gebunden", [
      boundLine({ catalogComponentId: offer.moduleId, catalogComponentRevision: 1 }),
    ]);

    const stored = await readTemplateLines(offer, templateId);
    expect(stored).toHaveLength(1);
    // Client schickte 1/1 — gespeichert sind die Live-Werte (Fälschungsschutz).
    expect(stored[0]).toMatchObject({
      salesUnitNetCents: MODULE_SALES,
      purchaseUnitNetCents: MODULE_PURCHASE,
      unit: "piece",
      catalogComponentId: offer.moduleId,
      catalogComponentRevision: 1,
    });

    const applied = await applyTemplate(offer, templateId, 1);
    expect(applied.revision).toBe(2);
    expect(applied.addedLines).toBe(1);
    const lines = await readOfferLines(offer, 2);
    const inserted = lines.find((line) => line.product.displayName === "F1613 Modulzeile");
    expect(inserted).toBeDefined();
    expect(inserted!.salesPricing.effectiveUnitNetCents).toBe(MODULE_SALES);
    expect(inserted!.purchasePricing.effectiveUnitNetCents).toBe(MODULE_PURCHASE);
  });

  it("F1613-DB-02: Preisdrift scheitert beim Einsetzen und beim Speichern", async () => {
    const offer = await createCatalogOffer();
    const templateId = await createTemplate(offer, "F1613 Drift", [
      boundLine({ catalogComponentId: offer.moduleId, catalogComponentRevision: 1 }),
    ]);
    await driftModulePrice(offer);

    await expect(applyTemplate(offer, templateId, 1))
      .rejects.toBeInstanceOf(PackageTemplateStaleError);

    // Reine Umbenennung mit alter Bindung scheitert ebenfalls (kein
    // stiller Preiswechsel über artfremde Edits).
    const stored = await readTemplateLines(offer, templateId);
    await expect(withAuthorizedTenantOn(
      testPool, offer.members.operatorId, offer.members.workspaceId,
      (tx, ctx) => updatePackageTemplate(tx, ctx, {
        schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
        id: templateId,
        name: "F1613 Drift umbenannt",
        sectionTitle: "F1613 Sektion",
        category: "module",
        lines: stored,
        position: 0,
      }),
    )).rejects.toBeInstanceOf(PackageTemplateStaleError);

    // Neu binden (Rev. 2) heilt Vorlage und Einsetzen mit neuen Preisen.
    const rebound = await withAuthorizedTenantOn(
      testPool, offer.members.operatorId, offer.members.workspaceId,
      (tx, ctx) => updatePackageTemplate(tx, ctx, {
        schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
        id: templateId,
        name: "F1613 Drift umbenannt",
        sectionTitle: "F1613 Sektion",
        category: "module",
        lines: stored.map((line) => ({ ...line, catalogComponentRevision: 2 })),
        position: 0,
      }),
    );
    expect(rebound.lines[0]).toMatchObject({
      salesUnitNetCents: NEW_PRICES.salesPriceNetCents,
      purchaseUnitNetCents: NEW_PRICES.purchasePriceNetCents,
      catalogComponentRevision: 2,
    });
    const applied = await applyTemplate(offer, templateId, 1);
    expect(applied.revision).toBe(2);
    const lines = await readOfferLines(offer, 2);
    const inserted = lines.find((line) => line.product.displayName === "F1613 Modulzeile");
    expect(inserted!.salesPricing.effectiveUnitNetCents).toBe(NEW_PRICES.salesPriceNetCents);
  });

  it("F1613-DB-03: Archiv scheitert; freie Zeilen bleiben unberührt", async () => {
    const offer = await createCatalogOffer();
    const templateId = await createTemplate(offer, "F1613 Archiv", [
      boundLine({
        displayName: "F1613 Gebunden",
        catalogComponentId: offer.moduleId,
        catalogComponentRevision: 1,
      }),
      boundLine({ displayName: "F1613 Frei" }),
    ]);
    await withAuthorizedTenantOn(
      testPool, offer.members.operatorId, offer.members.workspaceId,
      (tx, ctx) => archiveCatalogComponent(tx, ctx, {
        componentId: offer.moduleId,
        expectedRevision: 1,
        expectedStatus: "active",
      }),
    );
    await expect(applyTemplate(offer, templateId, 1))
      .rejects.toBeInstanceOf(PackageTemplateStaleError);

    const freeOnly = await createTemplate(offer, "F1613 Nur frei", [
      boundLine({ displayName: "F1613 Frei" }),
    ]);
    const applied = await applyTemplate(offer, freeOnly, 1);
    expect(applied.revision).toBe(2);
    expect(applied.addedLines).toBe(1);
  });

  it("F1613-DB-04: halbe/gefälschte Bindungen sind fail-closed", async () => {
    const offer = await createCatalogOffer();
    // Id ohne Revision.
    await expect(createTemplate(offer, "F1613 Halb", [
      boundLine({ catalogComponentId: offer.moduleId, catalogComponentRevision: undefined }),
    ])).rejects.toBeInstanceOf(PackageTemplateValidationError);
    // Revision ohne Id.
    await expect(createTemplate(offer, "F1613 Halb 2", [
      boundLine({ catalogComponentId: undefined, catalogComponentRevision: 1 }),
    ])).rejects.toBeInstanceOf(PackageTemplateValidationError);
    // Erfundene Revision.
    await expect(createTemplate(offer, "F1613 Gefälscht", [
      boundLine({ catalogComponentId: offer.moduleId, catalogComponentRevision: 99 }),
    ])).rejects.toBeInstanceOf(PackageTemplateStaleError);
    // Fremde Komponente.
    await expect(createTemplate(offer, "F1613 Fremd", [
      boundLine({ catalogComponentId: randomUUID(), catalogComponentRevision: 1 }),
    ])).rejects.toBeInstanceOf(PackageTemplateStaleError);
  });

  it("F1613-DB-05: Einsetzen bleibt revisionsgeschützt (CAS)", async () => {
    const offer = await createCatalogOffer();
    const templateId = await createTemplate(offer, "F1613 CAS", [
      boundLine({ catalogComponentId: offer.moduleId, catalogComponentRevision: 1 }),
    ]);
    await withAuthorizedTenantOn(
      testPool, offer.members.operatorId, offer.members.workspaceId,
      (tx, ctx) => reviseOfferVariant(tx, ctx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: offer.offerId,
        variantId: offer.variantId,
        expectedRevision: 1,
        operations: [{
          operation: "set_variant_description",
          description: "F1613 Nebenläufigkeit",
        }],
      }),
    );
    await expect(applyTemplate(offer, templateId, 1))
      .rejects.toBeInstanceOf(OfferConflictError);
    const applied = await applyTemplate(offer, templateId, 2);
    expect(applied.revision).toBe(3);
  });
});
