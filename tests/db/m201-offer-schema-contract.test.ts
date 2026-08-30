import { getTableConfig } from "drizzle-orm/pg-core";
import {
  offer,
  offerBomLine,
  offerMutationRateWindow,
  offerNumberSeries,
  offerVariant,
  offerVariantRevision,
  offerVariantSection,
} from "@/lib/db/schema";
import { describe, expect, it } from "vitest";

const tables = [
  offerNumberSeries,
  offer,
  offerVariant,
  offerVariantRevision,
  offerVariantSection,
  offerBomLine,
  offerMutationRateWindow,
] as const;

describe("M2-01 declarative offer schema", () => {
  it("deklariert exakt die sieben tenantgebundenen Tabellen", () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      "offer_number_series",
      "offer",
      "offer_variant",
      "offer_variant_revision",
      "offer_variant_section",
      "offer_bom_line",
      "offer_mutation_rate_window",
    ]);
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["id", "workspace_id"]),
      );
      expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
        `${config.name}_workspace_id_fk`,
      );
      expect([
        ...config.indexes.map((index) => index.config.name),
        ...config.uniqueConstraints.map((constraint) => constraint.name),
      ]).toContain(`${config.name}_ws_id_uq`);
    }
  });

  it("modelliert Head, append-only Revision und vollstaendige Mirrorprojektionen", () => {
    expect(Object.keys(offer)).toEqual(expect.arrayContaining([
      "projectId",
      "contactId",
      "siteId",
      "offerNumber",
      "createDigest",
      "contactContext",
      "installationSiteContext",
      "sourceBindings",
      "priceAudienceDecision",
    ]));
    expect(Object.keys(offerVariant)).toEqual(expect.arrayContaining([
      "offerId",
      "ordinal",
      "currentRevision",
    ]));
    expect(Object.keys(offerVariantRevision)).toEqual(expect.arrayContaining([
      "offerId",
      "variantId",
      "revision",
      "revisionSnapshot",
      "snapshotSha256",
      "basisNetCents",
      "optionalNetCents",
    ]));
    expect(Object.keys(offerVariantSection)).toEqual(expect.arrayContaining([
      "revisionId",
      "sectionDomainId",
      "position",
      "sectionSnapshot",
    ]));
    expect(Object.keys(offerBomLine)).toEqual(expect.arrayContaining([
      "revisionId",
      "sectionId",
      "lineDomainId",
      "position",
      "quantityMilli",
      "effectiveSalesUnitNetCents",
      "finalSalesNetCents",
      "lineSnapshot",
    ]));
  });

  it("verwendet bigint statt integer fuer jeden persistierten Geldwert", () => {
    for (const column of [
      offer.forecastValueNetCents,
      offerVariantRevision.basisNetCents,
      offerVariantRevision.basisTaxCents,
      offerVariantRevision.basisGrossCents,
      offerVariantRevision.optionalNetCents,
      offerVariantRevision.optionalTaxCents,
      offerVariantRevision.optionalGrossCents,
      offerBomLine.originalSalesUnitNetCents,
      offerBomLine.effectiveSalesUnitNetCents,
      offerBomLine.originalPurchaseUnitNetCents,
      offerBomLine.effectivePurchaseUnitNetCents,
      offerBomLine.finalSalesNetCents,
      offerBomLine.purchaseNetCents,
    ]) {
      expect(column.getSQLType()).toBe("bigint");
    }
  });
});
