import { createHash } from "node:crypto";
import { z } from "zod";
import {
  catalogAssetV1Schema,
  catalogProvenanceV1Schema,
  catalogTechnicalDataV1Schema,
} from "@/lib/integrations/catalog/contract";
import {
  calculateOfferPricing,
  type OfferPricingInput,
} from "./money";

export const OFFER_CREATE_COMMAND_VERSION = "offer-create-command.v1" as const;
export const OFFER_VARIANT_REVISE_COMMAND_VERSION =
  "offer-variant-revise-command.v1" as const;
export const OFFER_VARIANT_DUPLICATE_COMMAND_VERSION =
  "offer-variant-duplicate-command.v1" as const;
export const OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION =
  "offer-variant-from-resolution-command.v1" as const;
export const OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION =
  "offer-variant-set-primary-command.v1" as const;
export const OFFER_TOTAL_OVERRIDE_COMMAND_VERSION =
  "offer-total-override-command.v1" as const;
export const OFFER_VARIANT_BUNDLES_COMMAND_VERSION =
  "offer-variant-bundles-command.v1" as const;
export const OFFER_CANONICALIZATION_VERSION = "offer-jcs.v1" as const;
export const OFFER_CREATE_DIGEST_MATERIAL_VERSION =
  "offer-create-digest-material.v1" as const;
export const OFFER_VARIANT_SNAPSHOT_VERSION = "offer-variant-snapshot.v1" as const;

// Gepinnter Hash des ausschliesslich aus den Runtime-Schemas erzeugten
// Artefakts. Der Generator und der Contract-Test verhindern eine zweite
// Vertragswahrheit.
export const OFFER_SCHEMA_SHA256 =
  "875117092d0a0e3060a210d1325fbc51e347a60cf87e2b6df98f1ac2fa8f7bfb" as const;

export const OFFER_MAX_MONEY_CENTS = 9_000_000_000_000_000 as const;
export const OFFER_MAX_PATCH_OPERATIONS = 500 as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const positiveRevisionSchema = z.int().safe().min(1);
const moneyCentsSchema = z.int().safe().min(0).max(OFFER_MAX_MONEY_CENTS);
const basisPointsSchema = z.int().safe().min(0).max(10_000);
const sectionPositionSchema = z.int().safe().min(1).max(25);
const linePositionSchema = z.int().safe().min(1).max(500);

function hasWellFormedUnicode(value: string): boolean {
  // PostgreSQL jsonb cannot represent U+0000. Reject it at the shared command
  // and snapshot boundary so free text yields a field validation result
  // instead of failing later as a persistence/500 error.
  if (value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function normalizeOfferSnapshotText(value: string): string {
  if (typeof value !== "string" || !hasWellFormedUnicode(value)) {
    throw new TypeError("Snapshot-Text muss wohlgeformtes Unicode sein.");
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0) {
    throw new TypeError("Snapshot-Text darf nicht leer sein.");
  }
  return normalized;
}

function normalizedRequiredText(max: number) {
  return z.string().superRefine((value, context) => {
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "Text enthaelt ungueltiges Unicode." });
      return;
    }
    const normalized = value.normalize("NFC").trim();
    if (normalized.length === 0 || normalized.length > max) {
      context.addIssue({ code: "custom", message: `Text muss 1 bis ${max} Zeichen lang sein.` });
    }
  }).transform((value) => value.normalize("NFC").trim());
}

function normalizedOptionalText(max: number) {
  return z.string().superRefine((value, context) => {
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "Text enthaelt ungueltiges Unicode." });
      return;
    }
    const normalized = value.normalize("NFC").trim();
    if (normalized.length === 0 || normalized.length > max) {
      context.addIssue({ code: "custom", message: `Text muss 1 bis ${max} Zeichen lang sein.` });
    }
  }).transform((value) => value.normalize("NFC").trim()).nullable();
}

const emailSchema = normalizedRequiredText(320).pipe(z.email().max(320));
const phoneE164Schema = normalizedRequiredText(16).pipe(
  z.string().regex(/^\+[1-9][0-9]{1,14}$/u),
);

export const offerContactContextV1Schema = z.strictObject({
  displayName: normalizedRequiredText(200),
  emailPrimary: emailSchema.nullable(),
  phoneE164: phoneE164Schema.nullable(),
});
export type OfferContactContextV1 = z.infer<typeof offerContactContextV1Schema>;

export const offerInstallationSiteContextV1Schema = z.strictObject({
  addressRevision: positiveRevisionSchema,
  formattedAddress: normalizedRequiredText(360),
  street: normalizedRequiredText(160),
  houseNumber: normalizedRequiredText(32),
  postalCode: normalizedRequiredText(16),
  city: normalizedRequiredText(160),
  country: normalizedRequiredText(2).pipe(z.string().regex(/^[A-Z]{2}$/u)),
});
export type OfferInstallationSiteContextV1 = z.infer<
  typeof offerInstallationSiteContextV1Schema
>;

const priceAudienceConfirmationSchema = z.strictObject({
  code: z.literal("b2c_operator_confirmed"),
  confirmed: z.literal(true),
});

const zeroTaxConfirmationSchema = z.strictObject({
  code: z.literal("zero_tax_draft_operator_confirmed"),
  confirmed: z.literal(true),
});

const createCommandBaseSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_CREATE_COMMAND_VERSION),
  projectId: uuidSchema,
  expectedRequirementRevision: positiveRevisionSchema,
  expectedCalculationRevision: positiveRevisionSchema,
  expectedResolutionRevision: positiveRevisionSchema,
  forecastValueNetCents: moneyCentsSchema.nullable().optional()
    .transform((value) => value ?? null),
  priceAudience: z.literal("b2c"),
  priceAudienceConfirmation: priceAudienceConfirmationSchema,
});

export const createOfferCommandV1Schema = z.discriminatedUnion("taxTreatment", [
  createCommandBaseSchema.extend({
    taxTreatment: z.literal("standard_19"),
  }),
  createCommandBaseSchema.extend({
    taxTreatment: z.literal("zero_operator_confirmed"),
    zeroConfirmation: zeroTaxConfirmationSchema,
  }),
]);
export type CreateOfferCommandV1 = z.infer<typeof createOfferCommandV1Schema>;

const overrideReasonSchema = z.enum([
  "customer_specific_pricing",
  "negotiated",
  "correction",
  "other",
]);

const componentCategorySchema = z.enum([
  "module",
  "inverter",
  "battery",
  "wallbox",
  "heat_pump",
  "mounting",
  "other",
]);
const unitSchema = z.enum(["piece", "set", "meter"]);
const positionTypeSchema = z.enum(["required", "additional", "optional"]);

const setLineTaxOperationSchema = z.discriminatedUnion("taxTreatment", [
  z.strictObject({
    operation: z.literal("set_line_tax"),
    lineDomainId: uuidSchema,
    taxTreatment: z.literal("standard_19"),
  }),
  z.strictObject({
    operation: z.literal("set_line_tax"),
    lineDomainId: uuidSchema,
    taxTreatment: z.literal("zero_operator_confirmed"),
    zeroConfirmation: zeroTaxConfirmationSchema,
  }),
]);

const reviseOperationSchema = z.union([
  z.strictObject({
    operation: z.literal("set_variant_name"),
    name: normalizedRequiredText(120),
  }),
  z.strictObject({
    operation: z.literal("set_variant_description"),
    description: normalizedOptionalText(1_000),
  }),
  z.strictObject({
    operation: z.literal("set_global_discount"),
    discountBps: basisPointsSchema,
  }),
  z.strictObject({
    operation: z.literal("set_custom_deal"),
    customDealNetCents: moneyCentsSchema.nullable(),
  }),
  z.strictObject({
    operation: z.literal("set_section_discount"),
    sectionDomainId: uuidSchema,
    discountBps: basisPointsSchema,
  }),
  z.strictObject({
    operation: z.literal("move_section"),
    sectionDomainId: uuidSchema,
    position: sectionPositionSchema,
  }),
  z.strictObject({
    operation: z.literal("move_line"),
    lineDomainId: uuidSchema,
    sectionDomainId: uuidSchema,
    position: linePositionSchema,
  }),
  z.strictObject({
    operation: z.literal("set_line_quantity"),
    lineDomainId: uuidSchema,
    quantityMilli: z.int().safe().min(1).max(100_000_000),
  }),
  z.strictObject({
    operation: z.literal("set_custom_line_details"),
    lineDomainId: uuidSchema,
    displayName: normalizedRequiredText(200),
    description: normalizedOptionalText(1_000),
    unit: unitSchema,
  }),
  z.strictObject({
    operation: z.literal("set_line_position_type"),
    lineDomainId: uuidSchema,
    positionType: z.enum(["required", "additional", "optional"]),
  }),
  z.strictObject({
    operation: z.literal("set_line_visibility"),
    lineDomainId: uuidSchema,
    isHidden: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal("set_line_sales_price"),
    lineDomainId: uuidSchema,
    salesUnitNetCents: moneyCentsSchema,
    reasonCode: overrideReasonSchema,
  }),
  z.strictObject({
    operation: z.literal("set_line_purchase_price"),
    lineDomainId: uuidSchema,
    purchaseUnitNetCents: moneyCentsSchema,
    reasonCode: overrideReasonSchema,
  }),
  z.strictObject({
    operation: z.literal("set_line_discount"),
    lineDomainId: uuidSchema,
    discountBps: basisPointsSchema,
  }),
  z.strictObject({
    operation: z.literal("remove_custom_line"),
    lineDomainId: uuidSchema,
  }),
  z.strictObject({
    operation: z.literal("add_custom_section"),
    sectionDomainId: uuidSchema,
    position: sectionPositionSchema,
    title: normalizedRequiredText(120),
    category: componentCategorySchema,
  }),
  z.strictObject({
    operation: z.literal("remove_custom_section"),
    sectionDomainId: uuidSchema,
  }),
  z.strictObject({
    operation: z.literal("add_custom_line"),
    lineDomainId: uuidSchema,
    sectionDomainId: uuidSchema,
    position: linePositionSchema,
    displayName: normalizedRequiredText(200),
    description: normalizedOptionalText(1_000),
    unit: unitSchema,
    quantityMilli: z.int().safe().min(1).max(100_000_000),
    salesUnitNetCents: moneyCentsSchema,
    purchaseUnitNetCents: moneyCentsSchema,
    positionType: positionTypeSchema,
    isHidden: z.boolean(),
    taxTreatment: z.enum(["standard_19", "zero_operator_confirmed"]),
    zeroConfirmation: zeroTaxConfirmationSchema.optional(),
  }).superRefine((value, context) => {
    if (value.unit !== "meter" && value.quantityMilli % 1_000 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["quantityMilli"],
        message: "piece und set erlauben nur ganze Einheiten.",
      });
    }
    if (
      (value.taxTreatment === "zero_operator_confirmed" && value.zeroConfirmation === undefined)
      || (value.taxTreatment === "standard_19" && value.zeroConfirmation !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["zeroConfirmation"],
        message: "0-Prozent-Steuer braucht eine frische strukturierte Bestaetigung.",
      });
    }
  }),
  setLineTaxOperationSchema,
]);
export type ReviseOfferVariantOperationV1 = z.infer<typeof reviseOperationSchema>;

export const reviseOfferVariantCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_VARIANT_REVISE_COMMAND_VERSION),
  offerId: uuidSchema,
  variantId: uuidSchema,
  expectedRevision: positiveRevisionSchema,
  operations: z.array(reviseOperationSchema).min(1).max(OFFER_MAX_PATCH_OPERATIONS),
});
export type ReviseOfferVariantCommandV1 = z.infer<
  typeof reviseOfferVariantCommandV1Schema
>;

export const duplicateOfferVariantCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_VARIANT_DUPLICATE_COMMAND_VERSION),
  offerId: uuidSchema,
  sourceVariantId: uuidSchema,
  expectedSourceRevision: positiveRevisionSchema,
  name: normalizedRequiredText(120),
});
export type DuplicateOfferVariantCommandV1 = z.infer<
  typeof duplicateOfferVariantCommandV1Schema
>;

export const optionalBundleSchema = z.strictObject({
  name: normalizedRequiredText(120),
  position: z.int().safe().min(0).max(999),
});
export type OptionalBundleV1 = z.infer<typeof optionalBundleSchema>;

export const optionalBundlesSchema = z
  .array(optionalBundleSchema)
  .max(50)
  .superRefine((bundles, context) => {
    const seen = new Set<number>();
    bundles.forEach((bundle, index) => {
      if (seen.has(bundle.position)) {
        context.addIssue({
          code: "custom",
          path: [index, "position"],
          message: "Bundle-Position ist je Variante nur einmal zulaessig.",
        });
      }
      seen.add(bundle.position);
    });
  });
export type OptionalBundlesV1 = z.infer<typeof optionalBundlesSchema>;

export const setPrimaryVariantCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION),
  offerId: uuidSchema,
  variantId: uuidSchema,
});
export type SetPrimaryVariantCommandV1 = z.infer<
  typeof setPrimaryVariantCommandV1Schema
>;

export const setTotalPriceOverrideCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_TOTAL_OVERRIDE_COMMAND_VERSION),
  offerId: uuidSchema,
  totalPriceOverrideNetCents: moneyCentsSchema.nullable(),
});
export type SetTotalPriceOverrideCommandV1 = z.infer<
  typeof setTotalPriceOverrideCommandV1Schema
>;

export const setOptionalBundlesCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_VARIANT_BUNDLES_COMMAND_VERSION),
  offerId: uuidSchema,
  variantId: uuidSchema,
  bundles: optionalBundlesSchema,
});
export type SetOptionalBundlesCommandV1 = z.infer<
  typeof setOptionalBundlesCommandV1Schema
>;

const fromResolutionBaseSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION),
  offerId: uuidSchema,
  expectedRequirementRevision: positiveRevisionSchema,
  expectedCalculationRevision: positiveRevisionSchema,
  expectedResolutionRevision: positiveRevisionSchema,
  name: normalizedRequiredText(120),
});

export const createVariantFromResolutionCommandV1Schema = z.discriminatedUnion(
  "taxTreatment",
  [
    fromResolutionBaseSchema.extend({ taxTreatment: z.literal("standard_19") }),
    fromResolutionBaseSchema.extend({
      taxTreatment: z.literal("zero_operator_confirmed"),
      zeroConfirmation: zeroTaxConfirmationSchema,
    }),
  ],
);
export type CreateVariantFromResolutionCommandV1 = z.infer<
  typeof createVariantFromResolutionCommandV1Schema
>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/u);

export const offerSourceBindingsV1Schema = z.strictObject({
  projectId: uuidSchema,
  contactId: uuidSchema,
  siteId: uuidSchema,
  inboundReceiptId: uuidSchema,
  inboundPayloadSha256: sha256Schema,
  requirementId: uuidSchema,
  requirementRevision: positiveRevisionSchema,
  calculationRevisionId: uuidSchema,
  calculationRevision: positiveRevisionSchema,
  calculationInputSha256: sha256Schema,
  calculationResultSha256: sha256Schema,
  resolutionId: uuidSchema,
  resolutionRevision: positiveRevisionSchema,
  resolutionSha256: sha256Schema,
});
export type OfferSourceBindingsV1 = z.infer<typeof offerSourceBindingsV1Schema>;

export const offerCreateDigestMaterialV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_CREATE_DIGEST_MATERIAL_VERSION),
  command: createOfferCommandV1Schema,
  sourceBindings: offerSourceBindingsV1Schema,
  contactContext: offerContactContextV1Schema,
  installationSiteContext: offerInstallationSiteContextV1Schema,
});
export type OfferCreateDigestMaterialV1 = z.infer<
  typeof offerCreateDigestMaterialV1Schema
>;

export const offerPriceAudienceDecisionV1Schema = z.strictObject({
  audience: z.literal("b2c"),
  confirmationCode: z.literal("b2c_operator_confirmed"),
  confirmedBy: uuidSchema,
  confirmedAt: utcDateTimeSchema,
});
export type OfferPriceAudienceDecisionV1 = z.infer<
  typeof offerPriceAudienceDecisionV1Schema
>;

const standardTaxDecisionSchema = z.strictObject({
  treatment: z.literal("standard_19"),
  rateBps: z.literal(1_900),
  selectedBy: uuidSchema,
  selectedAt: utcDateTimeSchema,
});
const zeroTaxDecisionSchema = z.strictObject({
  treatment: z.literal("zero_operator_confirmed"),
  rateBps: z.literal(0),
  selectedBy: uuidSchema,
  selectedAt: utcDateTimeSchema,
  confirmationCode: z.literal("zero_tax_draft_operator_confirmed"),
  confirmedBy: uuidSchema,
  confirmedAt: utcDateTimeSchema,
});
const taxDecisionSchema = z.discriminatedUnion("treatment", [
  standardTaxDecisionSchema,
  zeroTaxDecisionSchema,
]);

const catalogProductSnapshotSchema = z.strictObject({
  kind: z.literal("catalog"),
  internalSku: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u),
  displayName: normalizedRequiredText(200),
  manufacturer: normalizedRequiredText(200),
  model: normalizedRequiredText(200),
  unit: unitSchema,
  technicalData: catalogTechnicalDataV1Schema,
  image: catalogAssetV1Schema.nullable(),
  datasheet: catalogAssetV1Schema.nullable(),
  technicalProvenance: catalogProvenanceV1Schema,
});

const customProductSnapshotSchema = z.strictObject({
  kind: z.literal("custom"),
  displayName: normalizedRequiredText(200),
  description: normalizedOptionalText(1_000),
  unit: unitSchema,
});

const productSnapshotSchema = z.discriminatedUnion("kind", [
  catalogProductSnapshotSchema,
  customProductSnapshotSchema,
]);

const catalogLineSourceSchema = z.strictObject({
  kind: z.literal("catalog"),
  catalogComponentId: uuidSchema,
  catalogComponentRevision: positiveRevisionSchema,
  componentSnapshotSha256: sha256Schema,
  resolutionLineId: uuidSchema,
  resolutionId: uuidSchema,
  resolutionRevision: positiveRevisionSchema,
  resolutionSha256: sha256Schema,
  catalogSalesUnitNetCents: moneyCentsSchema,
  catalogPurchaseUnitNetCents: moneyCentsSchema,
});

const customLineSourceSchema = z.strictObject({
  kind: z.literal("custom"),
  enteredBy: uuidSchema,
  enteredAt: utcDateTimeSchema,
});

const catalogSeedPricingProvenanceSchema = z.strictObject({
  kind: z.literal("catalog_seed"),
  catalogProvenance: catalogProvenanceV1Schema,
});
const manualPricingProvenanceSchema = z.strictObject({
  kind: z.literal("manual_override"),
  reasonCode: overrideReasonSchema,
  overriddenBy: uuidSchema,
  overriddenAt: utcDateTimeSchema,
});
const customPricingProvenanceSchema = z.strictObject({
  kind: z.literal("custom"),
  enteredBy: uuidSchema,
  enteredAt: utcDateTimeSchema,
});
const originalPricingProvenanceSchema = z.discriminatedUnion("kind", [
  catalogSeedPricingProvenanceSchema,
  customPricingProvenanceSchema,
]);
const offerPricingProvenanceSchema = z.discriminatedUnion("kind", [
  catalogSeedPricingProvenanceSchema,
  manualPricingProvenanceSchema.extend({
    originalProvenance: originalPricingProvenanceSchema,
  }),
  customPricingProvenanceSchema,
]);

const effectiveUnitPricingSchema = z.strictObject({
  originalUnitNetCents: moneyCentsSchema,
  effectiveUnitNetCents: moneyCentsSchema,
  provenance: offerPricingProvenanceSchema,
});

const computedLinePricingSchema = z.strictObject({
  lineBaseNetCents: moneyCentsSchema,
  lineDiscountedNetCents: moneyCentsSchema,
  sectionDiscountedNetCents: moneyCentsSchema,
  finalSalesNetCents: moneyCentsSchema,
  salesTaxCents: moneyCentsSchema,
  salesGrossCents: moneyCentsSchema,
  purchaseNetCents: moneyCentsSchema,
});

const technicalCategoryBySchemaVersion: Record<
  z.infer<typeof catalogTechnicalDataV1Schema>["schemaVersion"],
  z.infer<typeof componentCategorySchema>
> = {
  "module.v1": "module",
  "inverter.v1": "inverter",
  "battery.v1": "battery",
  "wallbox.v1": "wallbox",
  "heat_pump.v1": "heat_pump",
  "mounting.v1": "mounting",
  "other.v1": "other",
};

function originalProvenanceKind(
  provenance: z.infer<typeof offerPricingProvenanceSchema>,
): "catalog_seed" | "custom" {
  return provenance.kind === "manual_override"
    ? provenance.originalProvenance.kind
    : provenance.kind;
}

function addCatalogAssetIssues(
  product: z.infer<typeof catalogProductSnapshotSchema>,
  context: z.RefinementCtx,
): void {
  for (const field of ["image", "datasheet"] as const) {
    const asset = product[field];
    if (asset === null) continue;
    const roleMatches = asset.role === field;
    const mediaMatches = field === "datasheet"
      ? asset.mediaType === "application/pdf"
      : asset.mediaType.startsWith("image/");
    if (!roleMatches || !mediaMatches) {
      context.addIssue({
        code: "custom",
        path: ["product", field],
        message: "Assetrolle und Medientyp muessen zum Produktfeld passen.",
      });
    }
  }
}

const offerVariantLineSnapshotSchema = z.strictObject({
  lineDomainId: uuidSchema,
  position: linePositionSchema,
  componentCategory: componentCategorySchema,
  positionType: positionTypeSchema,
  isHidden: z.boolean(),
  quantityMilli: z.int().safe().min(1).max(100_000_000),
  product: productSnapshotSchema,
  source: z.discriminatedUnion("kind", [catalogLineSourceSchema, customLineSourceSchema]),
  salesPricing: effectiveUnitPricingSchema,
  purchasePricing: effectiveUnitPricingSchema,
  lineDiscountBps: basisPointsSchema,
  taxTreatment: z.enum(["standard_19", "zero_operator_confirmed"]),
  taxRateBps: z.union([z.literal(0), z.literal(1_900)]),
  taxDecision: taxDecisionSchema,
  computed: computedLinePricingSchema,
}).superRefine((value, context) => {
  if (value.product.unit !== "meter" && value.quantityMilli % 1_000 !== 0) {
    context.addIssue({
      code: "custom",
      path: ["quantityMilli"],
      message: "piece und set erlauben nur ganze Einheiten.",
    });
  }
  if (
    (value.taxTreatment === "standard_19" && value.taxRateBps !== 1_900)
    || (value.taxTreatment === "zero_operator_confirmed" && value.taxRateBps !== 0)
    || value.taxDecision.treatment !== value.taxTreatment
    || value.taxDecision.rateBps !== value.taxRateBps
  ) {
    context.addIssue({
      code: "custom",
      path: ["taxRateBps"],
      message: "Steuerbehandlung und Basispunkte stimmen nicht ueberein.",
    });
  }
  const originalProvenanceKinds = [
    originalProvenanceKind(value.salesPricing.provenance),
    originalProvenanceKind(value.purchasePricing.provenance),
  ];
  if (value.product.kind !== value.source.kind) {
    context.addIssue({
      code: "custom",
      path: ["product", "kind"],
      message: "Produkt- und Quellart muessen uebereinstimmen.",
    });
  }
  if (value.source.kind === "catalog" && originalProvenanceKinds.includes("custom")) {
    context.addIssue({ code: "custom", path: ["source"], message: "Katalogzeile braucht Katalogprovenienz." });
  }
  if (value.source.kind === "custom" && originalProvenanceKinds.some((kind) => kind !== "custom")) {
    context.addIssue({ code: "custom", path: ["source"], message: "Freie Zeile braucht Custom-Provenienz." });
  }
  for (const field of ["salesPricing", "purchasePricing"] as const) {
    const pricing = value[field];
    if (
      pricing.provenance.kind !== "manual_override"
      && pricing.originalUnitNetCents !== pricing.effectiveUnitNetCents
    ) {
      context.addIssue({
        code: "custom",
        path: [field, "effectiveUnitNetCents"],
        message: "Nur ein dokumentierter manueller Override darf den Effektivpreis aendern.",
      });
    }
  }
  if (value.source.kind === "catalog") {
    if (value.salesPricing.originalUnitNetCents !== value.source.catalogSalesUnitNetCents) {
      context.addIssue({
        code: "custom",
        path: ["salesPricing", "originalUnitNetCents"],
        message: "VK-Originalpreis muss dem gebundenen Katalogpreis entsprechen.",
      });
    }
    if (value.purchasePricing.originalUnitNetCents !== value.source.catalogPurchaseUnitNetCents) {
      context.addIssue({
        code: "custom",
        path: ["purchasePricing", "originalUnitNetCents"],
        message: "EK-Originalpreis muss dem gebundenen Katalogpreis entsprechen.",
      });
    }
  }
  if (value.product.kind === "catalog") {
    const expectedCategory = technicalCategoryBySchemaVersion[value.product.technicalData.schemaVersion];
    if (value.componentCategory !== expectedCategory) {
      context.addIssue({
        code: "custom",
        path: ["product", "technicalData", "schemaVersion"],
        message: "Technisches Schema und Komponentenkategorie stimmen nicht ueberein.",
      });
    }
    if (
      value.componentCategory !== "mounting"
      && value.componentCategory !== "other"
      && value.product.unit !== "piece"
    ) {
      context.addIssue({
        code: "custom",
        path: ["product", "unit"],
        message: "Dieser Katalogtyp wird in v1 stueckweise gefuehrt.",
      });
    }
    addCatalogAssetIssues(value.product, context);
  }
});

const offerVariantSectionSnapshotSchema = z.strictObject({
  sectionDomainId: uuidSchema,
  position: sectionPositionSchema,
  category: componentCategorySchema,
  title: normalizedRequiredText(120),
  discountBps: basisPointsSchema,
  lines: z.array(offerVariantLineSnapshotSchema).min(1).max(500),
});

const offerTotalsSchema = z.strictObject({
  basisNetCents: moneyCentsSchema,
  basisTaxCents: moneyCentsSchema,
  basisGrossCents: moneyCentsSchema,
  optionalNetCents: moneyCentsSchema,
  optionalTaxCents: moneyCentsSchema,
  optionalGrossCents: moneyCentsSchema,
});

const offerVariantSnapshotBaseSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_VARIANT_SNAPSHOT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  variantId: uuidSchema,
  revision: positiveRevisionSchema,
  variantName: normalizedRequiredText(120),
  description: normalizedOptionalText(1_000),
  contactContext: offerContactContextV1Schema,
  installationSiteContext: offerInstallationSiteContextV1Schema,
  sourceBindings: offerSourceBindingsV1Schema,
  priceAudienceDecision: offerPriceAudienceDecisionV1Schema,
  taxDecision: taxDecisionSchema,
  currency: z.literal("EUR"),
  priceBasis: z.literal("net"),
  globalDiscountBps: basisPointsSchema,
  customDealNetCents: moneyCentsSchema.nullable(),
  sections: z.array(offerVariantSectionSnapshotSchema).min(1).max(25),
  totals: offerTotalsSchema,
  createdBy: uuidSchema,
  createdAt: utcDateTimeSchema,
});
type OfferVariantSnapshotBodyV1 = z.infer<typeof offerVariantSnapshotBaseSchema>;

function semanticSnapshotPaths(value: OfferVariantSnapshotBodyV1): string[] {
  const paths: string[] = [];
  const sectionIds = new Set<string>();
  const sectionPositions = new Set<number>();
  const lineIds = new Set<string>();
  let lineCount = 0;
  for (const [sectionIndex, section] of value.sections.entries()) {
    if (sectionIds.has(section.sectionDomainId)) paths.push(`/sections/${sectionIndex}/sectionDomainId`);
    if (sectionPositions.has(section.position)) paths.push(`/sections/${sectionIndex}/position`);
    sectionIds.add(section.sectionDomainId);
    sectionPositions.add(section.position);
    const linePositions = new Set<number>();
    for (const [lineIndex, line] of section.lines.entries()) {
      lineCount += 1;
      if (lineIds.has(line.lineDomainId)) {
        paths.push(`/sections/${sectionIndex}/lines/${lineIndex}/lineDomainId`);
      }
      lineIds.add(line.lineDomainId);
      if (linePositions.has(line.position)) {
        paths.push(`/sections/${sectionIndex}/lines/${lineIndex}/position`);
      }
      linePositions.add(line.position);
      if (line.componentCategory !== section.category) {
        paths.push(`/sections/${sectionIndex}/lines/${lineIndex}/componentCategory`);
      }
      if (line.source.kind === "catalog" && (
        line.source.resolutionId !== value.sourceBindings.resolutionId
        || line.source.resolutionRevision !== value.sourceBindings.resolutionRevision
        || line.source.resolutionSha256 !== value.sourceBindings.resolutionSha256
      )) {
        paths.push(`/sections/${sectionIndex}/lines/${lineIndex}/source`);
      }
      if (line.source.kind === "catalog" && line.product.kind === "catalog") {
        for (const field of ["image", "datasheet"] as const) {
          const asset = line.product[field];
          if (asset === null) continue;
          const extension = asset.role === "datasheet"
            ? "pdf"
            : asset.mediaType === "image/jpeg" ? "jpg"
              : asset.mediaType === "image/png" ? "png" : "webp";
          const expectedObjectKey = [
            "catalog",
            value.workspaceId,
            line.source.catalogComponentId,
            `${asset.sha256}.${extension}`,
          ].join("/");
          if (asset.objectKey !== expectedObjectKey) {
            paths.push(`/sections/${sectionIndex}/lines/${lineIndex}/product/${field}`);
          }
        }
      }
    }
  }
  if (lineCount > 500) paths.push("/sections");

  if (paths.length === 0) {
    try {
      const pricingInput: OfferPricingInput = {
        currency: value.currency,
        priceBasis: value.priceBasis,
        globalDiscountBps: value.globalDiscountBps,
        customDealNetCents: value.customDealNetCents,
        sections: value.sections.map((section) => ({
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
      const calculated = calculateOfferPricing(pricingInput);
      if (canonicalizeOfferJson(calculated.totals) !== canonicalizeOfferJson(value.totals)) {
        paths.push("/totals");
      }
      const calculatedById = new Map(calculated.lines.map((line) => [line.lineDomainId, line]));
      for (const [sectionIndex, section] of value.sections.entries()) {
        for (const [lineIndex, line] of section.lines.entries()) {
          const calculatedLine = calculatedById.get(line.lineDomainId);
          const expected = calculatedLine && {
            lineBaseNetCents: calculatedLine.lineBaseNetCents,
            lineDiscountedNetCents: calculatedLine.lineDiscountedNetCents,
            sectionDiscountedNetCents: calculatedLine.sectionDiscountedNetCents,
            finalSalesNetCents: calculatedLine.finalSalesNetCents,
            salesTaxCents: calculatedLine.salesTaxCents,
            salesGrossCents: calculatedLine.salesGrossCents,
            purchaseNetCents: calculatedLine.purchaseNetCents,
          };
          if (!expected || canonicalizeOfferJson(expected) !== canonicalizeOfferJson(line.computed)) {
            paths.push(`/sections/${sectionIndex}/lines/${lineIndex}/computed`);
          }
        }
      }
    } catch {
      paths.push("/sections");
    }
  }
  return [...new Set(paths)].slice(0, 20);
}

function addSnapshotSemanticIssues(
  value: OfferVariantSnapshotBodyV1,
  context: z.RefinementCtx,
): void {
  for (const path of semanticSnapshotPaths(value)) {
    context.addIssue({
      code: "custom",
      path: path === "/" ? [] : path.slice(1).split("/"),
      message: "Snapshot und serverautoritatives Preisresultat stimmen nicht ueberein.",
    });
  }
}

const offerVariantSnapshotBodySchema = offerVariantSnapshotBaseSchema
  .superRefine(addSnapshotSemanticIssues);
export const offerVariantSnapshotV1Schema = offerVariantSnapshotBaseSchema.extend({
  snapshotSha256: sha256Schema,
}).superRefine(addSnapshotSemanticIssues);
export type OfferVariantSnapshotV1 = z.infer<typeof offerVariantSnapshotV1Schema>;

export type OfferContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; paths: string[] };

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

function withoutSnapshotHash(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Offer-Snapshot muss ein Objekt sein.");
  }
  const body = { ...(value as Record<string, unknown>) };
  delete body.snapshotSha256;
  return body;
}

type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

function normalizeCanonicalValue(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Offer-JSON erlaubt nur sichere Ganzzahlen.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) {
      throw new TypeError("Ungepaartes Unicode-Surrogat im Offer-JSON.");
    }
    return value.normalize("NFC");
  }
  if (typeof value !== "object") {
    throw new TypeError("Nicht persistierbarer Wert im Offer-JSON.");
  }
  if (seen.has(value)) throw new TypeError("Zyklus im Offer-JSON.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeCanonicalValue(entry, seen));
    }
    const result: Record<string, JsonValue> = {};
    for (const [rawKey, entry] of Object.entries(value)) {
      if (!hasWellFormedUnicode(rawKey)) {
        throw new TypeError("Ungepaartes Unicode-Surrogat im Offer-JSON-Schluessel.");
      }
      const key = rawKey.normalize("NFC");
      if (Object.hasOwn(result, key)) {
        throw new TypeError("Kollidierende normalisierte Offer-JSON-Schluessel.");
      }
      result[key] = normalizeCanonicalValue(entry, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Gepinnte RFC-8785/JCS-Teilmenge fuer sichere Ganzzahlen plus NFC. */
export function canonicalizeOfferJson(value: unknown): string {
  const normalized = normalizeCanonicalValue(value, new Set());
  const serialize = (current: JsonValue): string => {
    if (current === null || typeof current !== "object") {
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      return `[${current.map(serialize).join(",")}]`;
    }
    const keys = Object.keys(current).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(current[key]!)}`).join(",")}}`;
  };
  return serialize(normalized);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashOfferCreateDigest(value: unknown): string {
  const parsed = offerCreateDigestMaterialV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Ungueltiges Create-Digest-Material: ${validationPaths(parsed.error).join(", ")}`);
  }
  return sha256(canonicalizeOfferJson(parsed.data));
}

export function hashOfferVariantSnapshot(value: unknown): string {
  const parsed = offerVariantSnapshotBodySchema.safeParse(withoutSnapshotHash(value));
  if (!parsed.success) {
    throw new TypeError(`Ungueltiger Offer-Snapshot: ${validationPaths(parsed.error).join(", ")}`);
  }
  return sha256(canonicalizeOfferJson(parsed.data));
}

export function sealOfferVariantSnapshot(value: unknown): OfferVariantSnapshotV1 {
  const parsed = offerVariantSnapshotBodySchema.safeParse(withoutSnapshotHash(value));
  if (!parsed.success) {
    throw new TypeError(`Ungueltiger Offer-Snapshot: ${validationPaths(parsed.error).join(", ")}`);
  }
  return offerVariantSnapshotV1Schema.parse({
    ...parsed.data,
    snapshotSha256: sha256(canonicalizeOfferJson(parsed.data)),
  });
}

export function validateOfferVariantSnapshot(
  value: unknown,
): OfferContractResult<OfferVariantSnapshotV1> {
  const parsed = offerVariantSnapshotV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  if (hashOfferVariantSnapshot(parsed.data) !== parsed.data.snapshotSha256) {
    return { ok: false, paths: ["/snapshotSha256"] };
  }
  return { ok: true, value: parsed.data };
}

export interface OfferVariantViewOptions {
  canReadPurchasePrice: boolean;
  canReadPrivateHashes: boolean;
}

export interface OfferVariantViewV1 {
  schemaVersion: "offer-variant-view.v1";
  snapshot: Record<string, unknown>;
}

const publicOfferViewKeys: ReadonlySet<string> = new Set([
  // Snapshot, Kontexte und Entscheidungen.
  "schemaVersion", "canonicalizationVersion", "workspaceId", "offerId", "variantId",
  "revision", "variantName", "description", "contactContext", "installationSiteContext",
  "sourceBindings", "priceAudienceDecision", "taxDecision", "currency", "priceBasis",
  "globalDiscountBps", "customDealNetCents", "sections", "totals", "createdBy", "createdAt",
  "displayName", "emailPrimary", "phoneE164", "addressRevision", "formattedAddress",
  "street", "houseNumber", "postalCode", "city", "country", "projectId", "contactId",
  "siteId", "inboundReceiptId", "requirementId", "requirementRevision",
  "calculationRevisionId", "calculationRevision", "resolutionId", "resolutionRevision",
  "audience", "confirmationCode", "confirmedBy", "confirmedAt", "treatment", "rateBps",
  "selectedBy", "selectedAt",
  // BOM-Struktur und oeffentliche VK-Informationen.
  "sectionDomainId", "position", "category", "title", "discountBps", "lines",
  "lineDomainId", "componentCategory", "positionType", "isHidden", "quantityMilli",
  "product", "source", "salesPricing", "lineDiscountBps", "taxTreatment", "taxRateBps",
  "computed", "kind", "internalSku", "manufacturer", "model", "unit", "technicalData",
  "image", "datasheet", "technicalProvenance", "catalogComponentId",
  "catalogComponentRevision", "resolutionLineId", "catalogSalesUnitNetCents", "enteredBy",
  "enteredAt", "originalUnitNetCents", "effectiveUnitNetCents", "provenance",
  "catalogProvenance", "originalProvenance", "reasonCode", "overriddenBy", "overriddenAt",
  "lineBaseNetCents", "lineDiscountedNetCents", "sectionDiscountedNetCents",
  "finalSalesNetCents", "salesTaxCents", "salesGrossCents",
  "basisNetCents", "basisTaxCents", "basisGrossCents", "optionalNetCents",
  "optionalTaxCents", "optionalGrossCents",
  // Technische Katalogdaten, Asset-Metadaten und Provenienz ohne private Vollhashes/Keys.
  "nominalPowerWatts", "nominalAcPowerWatts", "phaseCount", "mpptTrackerCount",
  "nominalCapacityWh", "usableCapacityWh", "maxContinuousPowerWatts",
  "roundTripEfficiencyBasisPoints", "backupCapability", "maxChargingPowerWatts",
  "connector", "bidirectionalCapability", "nominalHeatingPowerWatts", "scopHundredths",
  "systemName", "roofTypes", "attributes", "name", "value", "role", "mediaType",
  "originalFilename", "sourceKind", "reference", "observedOn", "rightsBasis",
]);

const purchaseOfferViewKeys: ReadonlySet<string> = new Set([
  ...publicOfferViewKeys,
  "purchasePricing",
  "purchaseUnitNetCents",
  "catalogPurchaseUnitNetCents",
  "purchaseNetCents",
]);

function projectOfferValue(value: unknown, allowedKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => projectOfferValue(entry, allowedKeys));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => allowedKeys.has(key))
    .map(([key, entry]) => [key, projectOfferValue(entry, allowedKeys)]));
}

export function toOfferVariantView(
  value: unknown,
  options: OfferVariantViewOptions,
): OfferVariantViewV1 {
  if (options.canReadPrivateHashes && !options.canReadPurchasePrice) {
    throw new TypeError("Private Vollhashes setzen die EK-Berechtigung voraus.");
  }
  const validated = validateOfferVariantSnapshot(value);
  if (!validated.ok) {
    throw new TypeError(`Ungueltiger Offer-Snapshot: ${validated.paths.join(", ")}`);
  }
  const snapshot = (options.canReadPrivateHashes
    ? structuredClone(validated.value)
    : projectOfferValue(
        validated.value,
        options.canReadPurchasePrice ? purchaseOfferViewKeys : publicOfferViewKeys,
      )) as Record<string, unknown>;
  const sections = snapshot.sections as Array<Record<string, unknown>>;
  for (const section of sections) {
    const lines = section.lines as Array<Record<string, unknown>>;
    for (const line of lines) {
      const computed = line.computed as Record<string, unknown>;
      if (options.canReadPurchasePrice) {
        computed.marginNetCents = Number(computed.finalSalesNetCents)
          - Number(computed.purchaseNetCents);
      } else {
        delete line.purchasePricing;
        delete computed.purchaseNetCents;
      }
    }
  }
  return {
    schemaVersion: "offer-variant-view.v1",
    snapshot,
  };
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    cycles: "ref",
    reused: "ref",
  }) as Record<string, unknown>;
  const body = { ...generated };
  delete body.$schema;
  return body;
}

export function renderOfferJsonSchema(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://contracts.wmee.internal/offer.v1.schema.json",
    title: "WMEE offer commands and privacy contexts v1",
    oneOf: [
      { $ref: "#/$defs/createCommand" },
      { $ref: "#/$defs/reviseCommand" },
      { $ref: "#/$defs/duplicateCommand" },
      { $ref: "#/$defs/fromResolutionCommand" },
      { $ref: "#/$defs/setPrimaryCommand" },
      { $ref: "#/$defs/setTotalOverrideCommand" },
      { $ref: "#/$defs/setBundlesCommand" },
      { $ref: "#/$defs/contactContext" },
      { $ref: "#/$defs/installationSiteContext" },
      { $ref: "#/$defs/createDigestMaterial" },
      { $ref: "#/$defs/variantSnapshot" },
    ],
    $defs: {
      createCommand: jsonSchemaFor(createOfferCommandV1Schema),
      reviseCommand: jsonSchemaFor(reviseOfferVariantCommandV1Schema),
      duplicateCommand: jsonSchemaFor(duplicateOfferVariantCommandV1Schema),
      fromResolutionCommand: jsonSchemaFor(createVariantFromResolutionCommandV1Schema),
      setPrimaryCommand: jsonSchemaFor(setPrimaryVariantCommandV1Schema),
      setTotalOverrideCommand: jsonSchemaFor(setTotalPriceOverrideCommandV1Schema),
      setBundlesCommand: jsonSchemaFor(setOptionalBundlesCommandV1Schema),
      contactContext: jsonSchemaFor(offerContactContextV1Schema),
      installationSiteContext: jsonSchemaFor(offerInstallationSiteContextV1Schema),
      createDigestMaterial: jsonSchemaFor(offerCreateDigestMaterialV1Schema),
      variantSnapshot: jsonSchemaFor(offerVariantSnapshotV1Schema),
    },
    "x-semantic-invariants": [
      "browser commands never contain workspace, actor, timestamps, snapshots, totals, provenance, or integrity hashes",
      "create is limited to operator-confirmed B2C and an explicit tax treatment",
      "zero_operator_confirmed always carries a fresh command-bound structured confirmation",
      "contact and installation-site contexts are NFC-normalized strict allowlists loaded by the server",
      "revision commands contain at most 500 compact operations and never client-computed totals",
      "offer-jcs.v1 canonicalizes all strings and object keys to NFC before JCS ordering",
      "UUID values are canonicalized to lowercase and an omitted forecast is canonicalized to null before hashing",
      "variant snapshots contain one to 25 sections and one to 500 total immutable BOM lines",
      "section positions are unique in 1..25 and line positions are unique per section in 1..500",
      "catalog and custom lines use disjoint product and source shapes with matching original pricing provenance",
      "catalog prices, technical families, units, asset roles, and asset object keys remain bound to their exact source",
      "every line carries a matching tax decision; a zero-tax choice always contains its structured confirmation",
      "all monetary values are recalculated from line inputs with BigInt half-up and largest-remainder allocation before sealing",
      "allowlisted public views structurally omit purchase pricing, margin, private object keys, and all private full hashes",
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
