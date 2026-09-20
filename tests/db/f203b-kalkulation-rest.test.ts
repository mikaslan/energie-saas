import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { CATALOG_COMPONENT_PRICING_COMMAND_VERSION } from "@/lib/integrations/catalog/contract";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  type CreateOfferCommandV1,
  type OfferVariantSnapshotV1,
} from "@/lib/integrations/offers/contract";
import { calculateOfferPricing } from "@/lib/integrations/offers/money";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  archiveCatalogComponent,
  getCatalogComponent,
  reviseCatalogComponentPricing,
} from "@/modules/catalog";
import {
  createOfferFromRequest,
  OfferConflictError,
  OfferValidationError,
  reviseOfferVariant,
} from "@/modules/offers";
import { seedM201ReadyProject } from "../e2e/m2-01-fixture";
import { testPool } from "../setup/test-db";

/**
 * F2-03b Kalkulations-Rest (PostgreSQL, RED-first je Markierung).
 *
 * Bindung: `docs/spec/F2-03b-kalkulation-rest.md` (Abschnitt Tests).
 * Muster: `tests/db/m201-offer-service.test.ts` (Revise-Op-Tests).
 *
 * Markierung je Test:
 * - RED: scheitert ohne Implementierung (neue Ops existieren nicht in
 *   Contract/Service; Guard-Pfade werden per `paths` auf die
 *   Service-Konvention `/operations/<feld>` festgelegt, damit eine
 *   Contract-Ablehnung (`/operations/0/...`) NICHT fälschlich grün wird).
 * - PIN: Verhalten existiert bereits; der Test pinnt es (D3-06 Lückenschluss).
 *
 * O1 (verifiziert am Deferred-Trigger `0032_m2_01_offer_schema.sql`):
 * Weder der Mirror-CHECK `offer_bom_line_source_ck` noch die Funktion
 * `validate_offer_variant_snapshot_mirrors` referenzieren `resolutionLineId`;
 * der Trigger vergleicht nur kind/ComponentId/Revision/SHA. `null` im
 * Snapshot-Body wird daher auf DB-Ebene akzeptiert — kein STOPP.
 */

type Members = {
  workspaceId: string;
  operatorId: string;
  plainEditorId: string;
  viewerId: string;
};

type F203BFixture = {
  members: Members;
  projectId: string;
  products: Record<"module" | "inverter" | "battery" | "wallbox", string>;
  offerId: string;
  basisVariantId: string;
};

type RevisionRow = {
  revision: number;
  revision_snapshot: OfferVariantSnapshotV1;
  [key: string]: unknown;
};

type SectionMirrorRow = {
  section_domain_id: string;
  position: number;
  title: string;
  discount_bps: number;
  [key: string]: unknown;
};

type BomMirrorRow = {
  line_domain_id: string;
  source_kind: string;
  catalog_component_id: string | null;
  catalog_component_revision: number | null;
  component_sha256_hex: string | null;
  [key: string]: unknown;
};

async function createMembers(): Promise<Members> {
  const members = {
    workspaceId: randomUUID(),
    operatorId: randomUUID(),
    plainEditorId: randomUUID(),
    viewerId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F2-03b Kalkulations-Rest')
    `);
    for (const userId of [members.operatorId, members.plainEditorId, members.viewerId]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@f203b.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
             "discounts":true,"see_purchase_prices":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.plainEditorId}::uuid, 'editor', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return members;
}

async function createF203BFixture(): Promise<F203BFixture> {
  const members = await createMembers();
  const databaseUrl = process.env.POSTGRES_URL_TEST;
  if (!databaseUrl) throw new Error("POSTGRES_URL_TEST fehlt.");
  const seed = await seedM201ReadyProject(databaseUrl, {
    workspaceId: members.workspaceId,
    editorIdentityId: members.operatorId,
    skuSuffix: `F203B-${randomUUID().slice(0, 8)}`,
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
    products: seed.products,
    offerId: created.offerId,
    basisVariantId: created.variantId,
  };
}

function reviseAs(
  fixture: F203BFixture,
  actorId: string,
  variantId: string,
  expectedRevision: number,
  operations: unknown[],
) {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.members.workspaceId,
    (tx, ctx) => reviseOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
      offerId: fixture.offerId,
      variantId,
      expectedRevision,
      operations,
    }),
  );
}

async function readRevision(
  workspaceId: string,
  variantId: string,
  revision: number,
): Promise<RevisionRow> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<RevisionRow>(sql`
      select revision, revision_snapshot
        from offer_variant_revision
       where workspace_id = ${workspaceId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`Erwartete Revision ${revision} fehlt.`);
    return row;
  });
}

async function readSectionMirrors(
  workspaceId: string,
  variantId: string,
  revision: number,
): Promise<SectionMirrorRow[]> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<SectionMirrorRow>(sql`
      select section_domain_id, position, title, discount_bps
        from offer_variant_section
       where workspace_id = ${workspaceId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
       order by position
    `);
    return result.rows;
  });
}

async function readBomMirror(
  workspaceId: string,
  variantId: string,
  revision: number,
  lineDomainId: string,
): Promise<BomMirrorRow> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<BomMirrorRow>(sql`
      select line_domain_id, source_kind, catalog_component_id,
             catalog_component_revision,
             encode(component_snapshot_sha256, 'hex') as component_sha256_hex
        from offer_bom_line
       where workspace_id = ${workspaceId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
         and line_domain_id = ${lineDomainId}::uuid
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwartete BOM-Mirrorzeile fehlt.");
    return row;
  });
}

async function readCatalogSha(workspaceId: string, componentId: string, revision: number) {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ sha: string }>(sql`
      select encode(snapshot_sha256, 'hex') as sha
        from catalog_component_revision
       where workspace_id = ${workspaceId}::uuid
         and component_id = ${componentId}::uuid
         and revision = ${revision}
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwartete Katalogrevision fehlt.");
    return row.sha;
  });
}

/** Service-Guard-Fehler (M2-01-Konvention `/operations/<feld>`), kein Contract-Pfad. */
async function expectGuardRejection(promise: Promise<unknown>, path: string): Promise<void> {
  const error = await promise.then(
    () => { throw new Error(`Erwartete Ablehnung mit Pfad ${path}, aber Op gelang.`); },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(OfferValidationError);
  expect((error as OfferValidationError).paths).toContain(path);
}

function pricingInputFromSnapshot(snapshot: OfferVariantSnapshotV1) {
  return {
    currency: snapshot.currency,
    priceBasis: snapshot.priceBasis,
    globalDiscountBps: snapshot.globalDiscountBps,
    globalDiscountCapCents: snapshot.globalDiscountCapCents,
    globalFixDiscountCents: snapshot.globalFixDiscountCents,
    customDealNetCents: snapshot.customDealNetCents,
    sections: snapshot.sections.map((section) => ({
      sectionDomainId: section.sectionDomainId,
      position: section.position,
      discountBps: section.discountBps,
      lines: section.lines.map((line) => ({
        lineDomainId: line.lineDomainId,
        position: line.position,
        unit: line.product.unit,
        positionType: line.positionType,
        isHidden: line.isHidden,
        quantityMilli: line.quantityMilli,
        salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
        purchaseUnitNetCents: line.purchasePricing.effectiveUnitNetCents,
        lineDiscountBps: line.lineDiscountBps,
        taxRateBps: line.taxRateBps,
      })),
    })),
  };
}

function findLine(snapshot: OfferVariantSnapshotV1, lineDomainId: string) {
  const line = snapshot.sections
    .flatMap((section) => section.lines)
    .find((candidate) => candidate.lineDomainId === lineDomainId);
  if (!line) throw new Error("Erwartete Snapshot-Zeile fehlt.");
  return line;
}

function findSection(snapshot: OfferVariantSnapshotV1, sectionDomainId: string) {
  const section = snapshot.sections.find(
    (candidate) => candidate.sectionDomainId === sectionDomainId,
  );
  if (!section) throw new Error("Erwartete Snapshot-Sektion fehlt.");
  return section;
}

describe("F2-03b Kalkulations-Rest", () => {
  it("F203B-01 [RED] benennt eine Custom-Sektion revisionspflichtig um (Snapshot + Mirror, stale CAS → Conflict)", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;
    const basis = await readRevision(members.workspaceId, fixture.basisVariantId, 1);
    const sectionDomainId = randomUUID();
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [
      {
        operation: "add_custom_section",
        sectionDomainId,
        position: basis.revision_snapshot.sections.length + 1,
        title: "Alter Sektionstitel",
        category: "other",
      },
      {
        operation: "add_custom_line",
        lineDomainId: randomUUID(),
        sectionDomainId,
        position: 1,
        displayName: "Custom-Zeile",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 4_000,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      },
    ]);

    const revised = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "set_custom_section_title",
      sectionDomainId,
      title: "Neuer Sektionstitel",
    }]);
    expect(revised.revision).toBe(3);
    const after = await readRevision(members.workspaceId, fixture.basisVariantId, 3);
    expect(findSection(after.revision_snapshot, sectionDomainId).title)
      .toBe("Neuer Sektionstitel");
    const mirrors = await readSectionMirrors(members.workspaceId, fixture.basisVariantId, 3);
    expect(mirrors.find((row) => row.section_domain_id === sectionDomainId)?.title)
      .toBe("Neuer Sektionstitel");

    await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "set_custom_section_title",
      sectionDomainId,
      title: "Veralteter Titel",
    }])).rejects.toBeInstanceOf(OfferConflictError);
  });

  it("F203B-02 [RED] verweigert Rename für Seed-/Katalog-Sektionen, leere/überlange Titel und Viewer", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;
    const basis = await readRevision(members.workspaceId, fixture.basisVariantId, 1);
    const seedSection = basis.revision_snapshot.sections[0]!;
    expect(seedSection.lines[0]!.source.kind).toBe("catalog");

    // Seed-Sektion: Custom-Guard (derselbe Nachweis wie remove_custom_section).
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
        operation: "set_custom_section_title",
        sectionDomainId: seedSection.sectionDomainId,
        title: "Seed umbenennen",
      }]),
      "/operations/sectionDomainId",
    );

    // Custom-Sektion mit Katalogzeile verliert den Custom-Status.
    // Die Seed-Sektion hat genau eine Zeile; Sektionen brauchen min(1) Zeile
    // (Contract), daher erst eine Füllzeile in die Quelle legen.
    const mixedSectionId = randomUUID();
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [
      {
        operation: "add_custom_section",
        sectionDomainId: mixedSectionId,
        position: basis.revision_snapshot.sections.length + 1,
        title: "Gemischte Sektion",
        category: seedSection.category,
      },
      {
        operation: "add_custom_line",
        lineDomainId: randomUUID(),
        sectionDomainId: seedSection.sectionDomainId,
        position: seedSection.lines.length + 1,
        displayName: "Füllzeile",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 4_000,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      },
      {
        operation: "move_line",
        lineDomainId: seedSection.lines[0]!.lineDomainId,
        sectionDomainId: mixedSectionId,
        position: 1,
      },
    ]);
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
        operation: "set_custom_section_title",
        sectionDomainId: mixedSectionId,
        title: "Gemischt umbenennen",
      }]),
      "/operations/sectionDomainId",
    );

    // Form: leer und >120 Zeichen werden vom Contract abgelehnt (Titel-Pfad).
    for (const title of ["   ", "x".repeat(121)]) {
      const error = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
        operation: "set_custom_section_title",
        sectionDomainId: mixedSectionId,
        title,
      }]).then(
        () => { throw new Error("Erwartete Titel-Ablehnung, aber Op gelang."); },
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(OfferValidationError);
      expect((error as OfferValidationError).paths).toContain("/operations/0/title");
    }

    // Recht: project.write — Viewer scheitert vor dem Parse (PIN-Anteil, heute schon grün).
    await expect(reviseAs(fixture, members.viewerId, fixture.basisVariantId, 2, [{
      operation: "set_custom_section_title",
      sectionDomainId: mixedSectionId,
      title: "Viewer-Titel",
    }])).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F203B-03 [RED] legt ad-hoc eine Katalog-Snapshotkopie in die BOM (fail-closed bei Drift/inaktiv/preislos)", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;
    const basis = await readRevision(members.workspaceId, fixture.basisVariantId, 1);
    const targetSection = basis.revision_snapshot.sections[0]!;
    const component = await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => getCatalogComponent(tx, ctx, fixture.products.wallbox),
    );
    if (!component || component.currentRevision !== 1 || component.current.commercial === null) {
      throw new Error("Erwartete aktive Wallbox-Komponente mit Preis fehlt.");
    }
    const catalogSha = await readCatalogSha(members.workspaceId, fixture.products.wallbox, 1);

    const lineDomainId = randomUUID();
    const revised = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
      operation: "add_catalog_line",
      lineDomainId,
      sectionDomainId: targetSection.sectionDomainId,
      position: targetSection.lines.length + 1,
      catalogComponentId: fixture.products.wallbox,
      expectedCatalogRevision: 1,
      quantityMilli: 2_000,
      taxTreatment: "standard_19",
    }]);
    expect(revised.revision).toBe(2);
    const after = await readRevision(members.workspaceId, fixture.basisVariantId, 2);
    const line = findLine(after.revision_snapshot, lineDomainId);
    expect(line.source).toMatchObject({
      kind: "catalog",
      catalogComponentId: fixture.products.wallbox,
      catalogComponentRevision: 1,
      componentSnapshotSha256: catalogSha,
      resolutionLineId: null,
    });
    expect(line.salesPricing.effectiveUnitNetCents)
      .toBe(component.current.commercial.salesPriceNetCents);
    expect(line.purchasePricing.effectiveUnitNetCents)
      .toBe(component.current.commercial.purchasePriceNetCents);
    expect(line.salesPricing.provenance).toMatchObject({ kind: "catalog_seed" });
    expect(line.product).toMatchObject({
      kind: "catalog",
      displayName: component.current.presentation.displayName,
      unit: component.current.presentation.unit,
    });
    const mirror = await readBomMirror(members.workspaceId, fixture.basisVariantId, 2, lineDomainId);
    expect(mirror.source_kind).toBe("catalog");
    expect(mirror.catalog_component_id).toBe(fixture.products.wallbox);
    expect(mirror.catalog_component_revision).toBe(1);
    expect(mirror.component_sha256_hex).toBe(catalogSha);

    // Katalogdrift: Batterie auf Rev. 2, Add mit erwarteter Rev. 1 → fail-closed.
    await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => reviseCatalogComponentPricing(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: fixture.products.battery,
        expectedRevision: 1,
        commercial: {
          currency: "EUR",
          basis: "net",
          purchasePriceNetCents: 255_000,
          salesPriceNetCents: 410_000,
          purchaseProvenance: {
            sourceKind: "supplier_price_list",
            reference: "PRIVATE-F203B-PURCHASE-battery-2",
            observedOn: "2026-08-30",
            rightsBasis: "supplier_authorized",
            sourceDocumentSha256: null,
          },
          salesProvenance: {
            sourceKind: "workspace_pricing",
            reference: "SYNTHETIC-F203B-SALES-battery-2",
            observedOn: "2026-08-30",
            rightsBasis: "workspace_owned",
            sourceDocumentSha256: null,
          },
        },
      }),
    );
    await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "add_catalog_line",
      lineDomainId: randomUUID(),
      sectionDomainId: targetSection.sectionDomainId,
      position: 1,
      catalogComponentId: fixture.products.battery,
      expectedCatalogRevision: 1,
      quantityMilli: 1_000,
      taxTreatment: "standard_19",
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Inaktiv: archivierter Wechselrichter → fail-closed.
    await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => archiveCatalogComponent(tx, ctx, {
        componentId: fixture.products.inverter,
        expectedRevision: 1,
        expectedStatus: "active",
      }),
    );
    await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "add_catalog_line",
      lineDomainId: randomUUID(),
      sectionDomainId: targetSection.sectionDomainId,
      position: 1,
      catalogComponentId: fixture.products.inverter,
      expectedCatalogRevision: 1,
      quantityMilli: 1_000,
      taxTreatment: "standard_19",
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Preislos: Modul auf Rev. 2 ohne commercial → fail-closed.
    await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => reviseCatalogComponentPricing(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: fixture.products.module,
        expectedRevision: 1,
        commercial: null,
      }),
    );
    await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "add_catalog_line",
      lineDomainId: randomUUID(),
      sectionDomainId: targetSection.sectionDomainId,
      position: 1,
      catalogComponentId: fixture.products.module,
      expectedCatalogRevision: 2,
      quantityMilli: 1_000,
      taxTreatment: "standard_19",
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Clientpreise sind kein Op-Feld (strictObject lehnt Fälschung ab).
    await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "add_catalog_line",
      lineDomainId: randomUUID(),
      sectionDomainId: targetSection.sectionDomainId,
      position: 1,
      catalogComponentId: fixture.products.wallbox,
      expectedCatalogRevision: 1,
      quantityMilli: 1_000,
      taxTreatment: "standard_19",
      salesUnitNetCents: 1,
    }])).rejects.toBeInstanceOf(OfferValidationError);
  });

  it("F203B-04 [RED] entfernt nur Ad-hoc-Katalogzeilen (Seed fail-closed, Dependenten fail-closed)", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;
    const basis = await readRevision(members.workspaceId, fixture.basisVariantId, 1);
    const targetSection = basis.revision_snapshot.sections[0]!;
    const seedLine = targetSection.lines.find((line) => line.source.kind === "catalog")!;
    expect(seedLine.source).not.toMatchObject({ resolutionLineId: null });

    // Seed-Zeile ist unberührbar (Guard-Pfad analog remove_custom_line).
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
        operation: "remove_catalog_line",
        lineDomainId: seedLine.lineDomainId,
      }]),
      "/operations/lineDomainId",
    );

    // Roundtrip: Ad-hoc-Add (Rev. 2) + Remove (Rev. 3) mit Reindex.
    const lineDomainId = randomUUID();
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
      operation: "add_catalog_line",
      lineDomainId,
      sectionDomainId: targetSection.sectionDomainId,
      position: targetSection.lines.length + 1,
      catalogComponentId: fixture.products.wallbox,
      expectedCatalogRevision: 1,
      quantityMilli: 2_000,
      taxTreatment: "standard_19",
    }]);
    const removed = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "remove_catalog_line",
      lineDomainId,
    }]);
    expect(removed.revision).toBe(3);
    const after = await readRevision(members.workspaceId, fixture.basisVariantId, 3);
    expect(after.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .map((line) => line.lineDomainId)).not.toContain(lineDomainId);
    expect(findSection(after.revision_snapshot, targetSection.sectionDomainId).lines
      .map((line) => line.position))
      .toEqual(findSection(after.revision_snapshot, targetSection.sectionDomainId).lines
        .map((_, index) => index + 1));

    // Dependenten: verknüpfte Ad-hoc-Zeile erst lösen, dann löschen.
    const linkedAdhocId = randomUUID();
    const dependentCustomId = randomUUID();
    const customSectionId = randomUUID();
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 3, [
      {
        operation: "add_custom_section",
        sectionDomainId: customSectionId,
        position: after.revision_snapshot.sections.length + 1,
        title: "Dependenten-Sektion",
        category: "other",
      },
      {
        operation: "add_catalog_line",
        lineDomainId: linkedAdhocId,
        sectionDomainId: targetSection.sectionDomainId,
        position: 1,
        catalogComponentId: fixture.products.wallbox,
        expectedCatalogRevision: 1,
        quantityMilli: 1_000,
        taxTreatment: "standard_19",
      },
      {
        operation: "add_custom_line",
        lineDomainId: dependentCustomId,
        sectionDomainId: customSectionId,
        position: 1,
        displayName: "Abhängige Pauschale",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 4_000,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      },
      {
        operation: "set_line_quantity_link",
        lineDomainId: dependentCustomId,
        sourceLineDomainId: linkedAdhocId,
        factorMilli: 1_000,
      },
    ]);
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 4, [{
        operation: "remove_catalog_line",
        lineDomainId: linkedAdhocId,
      }]),
      "/operations/lineDomainId",
    );
  });

  it("F203B-05 [PIN] belegt set_section_discount (discount-Guard, Sektions-Allokation, Audit)", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;
    const basis = await readRevision(members.workspaceId, fixture.basisVariantId, 1);
    const targetSection = basis.revision_snapshot.sections[0]!;

    // Guard: ohne discount.apply scheitert die Op.
    await expect(reviseAs(fixture, members.plainEditorId, fixture.basisVariantId, 1, [{
      operation: "set_section_discount",
      sectionDomainId: targetSection.sectionDomainId,
      discountBps: 1_000,
    }])).rejects.toBeInstanceOf(PermissionDeniedError);

    const revised = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
      operation: "set_section_discount",
      sectionDomainId: targetSection.sectionDomainId,
      discountBps: 1_000,
    }]);
    expect(revised.revision).toBe(2);
    const after = await readRevision(members.workspaceId, fixture.basisVariantId, 2);
    expect(findSection(after.revision_snapshot, targetSection.sectionDomainId).discountBps)
      .toBe(1_000);
    const mirrors = await readSectionMirrors(members.workspaceId, fixture.basisVariantId, 2);
    expect(mirrors.find((row) => row.section_domain_id === targetSection.sectionDomainId)
      ?.discount_bps).toBe(1_000);

    // Allokation: 10 % Sektionsrabatt mindert genau diese Sektion; Totals = Engine.
    const recalculated = calculateOfferPricing(pricingInputFromSnapshot(after.revision_snapshot));
    expect(after.revision_snapshot.totals).toEqual(recalculated.totals);
    for (const line of findSection(after.revision_snapshot, targetSection.sectionDomainId).lines) {
      expect(line.computed.sectionDiscountedNetCents).toBeLessThanOrEqual(
        line.computed.lineDiscountedNetCents,
      );
    }
    expect(after.revision_snapshot.totals.basisGrossCents)
      .toBeLessThan(basis.revision_snapshot.totals.basisGrossCents);

    // Audit: Event + Auditzeile mit changeClasses.
    const events = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`
        select event_type, payload from domain_events
         where workspace_id = ${members.workspaceId}::uuid
           and aggregate_id = ${fixture.offerId}::uuid
           and event_type = 'offer.variant_revised'
         order by occurred_at desc limit 1
      `));
    expect(events.rows[0]?.payload).toMatchObject({
      variantId: fixture.basisVariantId,
      previousRevision: 1,
      newRevision: 2,
      changeClasses: ["set_section_discount"],
    });
    const audits = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{ action: string; details: Record<string, unknown> }>(sql`
        select action, details from audit_log
         where workspace_id = ${members.workspaceId}::uuid
           and action = 'project.write'
           and details->>'variantId' = ${fixture.basisVariantId}
         order by occurred_at desc limit 1
      `));
    expect(audits.rows[0]?.details).toMatchObject({ newRevision: 2 });

    // Range: >10 000 bps lehnt der Contract ab.
    await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "set_section_discount",
      sectionDomainId: targetSection.sectionDomainId,
      discountBps: 10_001,
    }])).rejects.toBeInstanceOf(OfferValidationError);
  });

  it("F203B-06 [PIN] belegt remove_custom_section (Custom-Guard, gemischt, Dependenten, Reindex)", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;
    const basis = await readRevision(members.workspaceId, fixture.basisVariantId, 1);
    const seedSection = basis.revision_snapshot.sections[0]!;

    // Custom-Guard: Seed-Sektion und unbekannte Sektion.
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
        operation: "remove_custom_section",
        sectionDomainId: seedSection.sectionDomainId,
      }]),
      "/operations/sectionDomainId",
    );
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
        operation: "remove_custom_section",
        sectionDomainId: randomUUID(),
      }]),
      "/operations/sectionDomainId",
    );

    // Gemischte Sektion (Custom + einsortierte Katalogzeile) wird abgelehnt.
    // Die Seed-Sektion hat genau eine Zeile; Sektionen brauchen min(1) Zeile
    // (Contract), daher erst eine Füllzeile in die Quelle legen.
    const mixedSectionId = randomUUID();
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [
      {
        operation: "add_custom_section",
        sectionDomainId: mixedSectionId,
        position: basis.revision_snapshot.sections.length + 1,
        title: "Gemischte Sektion",
        category: seedSection.category,
      },
      {
        operation: "add_custom_line",
        lineDomainId: randomUUID(),
        sectionDomainId: seedSection.sectionDomainId,
        position: seedSection.lines.length + 1,
        displayName: "Füllzeile",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 4_000,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      },
      {
        operation: "move_line",
        lineDomainId: seedSection.lines[0]!.lineDomainId,
        sectionDomainId: mixedSectionId,
        position: 1,
      },
    ]);
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
        operation: "remove_custom_section",
        sectionDomainId: mixedSectionId,
      }]),
      "/operations/sectionDomainId",
    );

    // Dependenten: Zeile in Sektion B verknüpft auf Zeile in Sektion A → Remove von A fail-closed.
    const sectionA = randomUUID();
    const sectionB = randomUUID();
    const lineA = randomUUID();
    const lineB = randomUUID();
    const withSections = await readRevision(members.workspaceId, fixture.basisVariantId, 2);
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [
      {
        operation: "add_custom_section",
        sectionDomainId: sectionA,
        position: withSections.revision_snapshot.sections.length + 1,
        title: "Sektion A",
        category: "other",
      },
      {
        operation: "add_custom_section",
        sectionDomainId: sectionB,
        position: withSections.revision_snapshot.sections.length + 2,
        title: "Sektion B",
        category: "other",
      },
      {
        operation: "add_custom_line",
        lineDomainId: lineA,
        sectionDomainId: sectionA,
        position: 1,
        displayName: "Quellzeile A",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 4_000,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      },
      {
        operation: "add_custom_line",
        lineDomainId: lineB,
        sectionDomainId: sectionB,
        position: 1,
        displayName: "Abhängige Zeile B",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 10_000,
        purchaseUnitNetCents: 4_000,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      },
      {
        operation: "set_line_quantity_link",
        lineDomainId: lineB,
        sourceLineDomainId: lineA,
        factorMilli: 1_000,
      },
    ]);
    await expectGuardRejection(
      reviseAs(fixture, members.operatorId, fixture.basisVariantId, 3, [{
        operation: "remove_custom_section",
        sectionDomainId: sectionA,
      }]),
      "/operations/lineDomainId",
    );

    // Erfolgspfad: B entfernen (kein Dependent), Positionen lückenlos reindiziert.
    const removed = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 3, [{
      operation: "remove_custom_section",
      sectionDomainId: sectionB,
    }]);
    expect(removed.revision).toBe(4);
    const after = await readRevision(members.workspaceId, fixture.basisVariantId, 4);
    expect(after.revision_snapshot.sections.map((section) => section.sectionDomainId))
      .not.toContain(sectionB);
    expect(after.revision_snapshot.sections.map((section) => section.position))
      .toEqual(after.revision_snapshot.sections.map((_, index) => index + 1));
  });

  it("F203B-07 [PIN] belegt Fix-Rabatt-Setpfad mit Deckel-Kombi sowie Description-Form/Null/Normalisierung", async () => {
    const fixture = await createF203BFixture();
    const { members } = fixture;

    // Fix-Rabatt Set-Pfad: Snapshot + Engine stimmen überein.
    const withFix = await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 1, [{
      operation: "set_global_fix_discount",
      fixDiscountCents: 50_000,
    }]);
    expect(withFix.revision).toBe(2);
    const fixSnapshot = await readRevision(members.workspaceId, fixture.basisVariantId, 2);
    expect(fixSnapshot.revision_snapshot.globalFixDiscountCents).toBe(50_000);
    expect(fixSnapshot.revision_snapshot.totals).toEqual(
      calculateOfferPricing(pricingInputFromSnapshot(fixSnapshot.revision_snapshot)).totals,
    );

    // Deckel-Kombi: 50 % Prozentrabatt mit 1.000-Cent-Deckel + Fix-Rabatt.
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 2, [{
      operation: "set_global_discount",
      discountBps: 5_000,
      capCents: 1_000,
    }]);
    const capped = await readRevision(members.workspaceId, fixture.basisVariantId, 3);
    expect(capped.revision_snapshot.globalDiscountCapCents).toBe(1_000);
    expect(capped.revision_snapshot.globalFixDiscountCents).toBe(50_000);
    expect(capped.revision_snapshot.totals).toEqual(
      calculateOfferPricing(pricingInputFromSnapshot(capped.revision_snapshot)).totals,
    );
    const uncappedInput = pricingInputFromSnapshot(capped.revision_snapshot);
    uncappedInput.globalDiscountCapCents = null;
    expect(capped.revision_snapshot.totals.basisGrossCents).toBeGreaterThan(
      calculateOfferPricing(uncappedInput).totals.basisGrossCents,
    );

    // Fix-Rabatt aufheben (null) kehrt zum reinen Prozentpfad zurück.
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 3, [{
      operation: "set_global_fix_discount",
      fixDiscountCents: null,
    }]);
    const cleared = await readRevision(members.workspaceId, fixture.basisVariantId, 4);
    expect(cleared.revision_snapshot.globalFixDiscountCents).toBeNull();

    // Description: Trimm/Normalisierung, null löscht, leer/>1000 lehnt ab.
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 4, [{
      operation: "set_variant_description",
      description: "  Kalkulation mit Umlauten: Grüße  ",
    }]);
    const described = await readRevision(members.workspaceId, fixture.basisVariantId, 5);
    expect(described.revision_snapshot.description).toBe("Kalkulation mit Umlauten: Grüße");
    await reviseAs(fixture, members.operatorId, fixture.basisVariantId, 5, [{
      operation: "set_variant_description",
      description: null,
    }]);
    const nulled = await readRevision(members.workspaceId, fixture.basisVariantId, 6);
    expect(nulled.revision_snapshot.description).toBeNull();
    for (const description of ["   ", "y".repeat(1_001)]) {
      await expect(reviseAs(fixture, members.operatorId, fixture.basisVariantId, 6, [{
        operation: "set_variant_description",
        description,
      }])).rejects.toBeInstanceOf(OfferValidationError);
    }
  });

});
