import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_MAX_MONEY_CENTS,
  canonicalizeOfferJson,
  type OfferContractResult,
  type OfferVariantSnapshotV1,
  validateOfferVariantSnapshot,
} from "./contract";

export const OFFER_PDF_DRAFT_INPUT_VERSION = "offer-pdf-draft-input.v1" as const;
export const OFFER_PDF_DRAFT_TEMPLATE_VERSION = "offer-pdf-draft-template.v1" as const;
export const OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION =
  "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac" as const;

const MAX_PDF_LINES = 500;
const basisPointsSchema = z.int().safe().min(0).max(10_000);
const moneyCentsSchema = z.int().safe().min(0).max(OFFER_MAX_MONEY_CENTS);
const positiveRevisionSchema = z.int().safe().min(1);
const sectionPositionSchema = z.int().safe().min(1).max(25);
const linePositionSchema = z.int().safe().min(1).max(MAX_PDF_LINES);

function hasWellFormedUnicode(value: string): boolean {
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

function normalizedRequiredText(maxLength: number) {
  return z.string().superRefine((value, context) => {
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "Text enthaelt ungueltiges Unicode." });
      return;
    }
    const normalized = value.normalize("NFC").trim();
    if (normalized.length < 1 || normalized.length > maxLength) {
      context.addIssue({
        code: "custom",
        message: `Text muss 1 bis ${maxLength} Zeichen lang sein.`,
      });
    }
  }).transform((value) => value.normalize("NFC").trim());
}

function normalizedOptionalText(maxLength: number) {
  return normalizedRequiredText(maxLength).nullable();
}

const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/u);
const unitSchema = z.enum(["piece", "set", "meter"]);
const positionTypeSchema = z.enum(["required", "additional", "optional"]);

const pdfLineSchema = z.strictObject({
  position: linePositionSchema,
  title: normalizedRequiredText(200),
  description: normalizedOptionalText(1_000),
  quantityMilli: z.int().safe().min(1).max(100_000_000),
  unit: unitSchema,
  positionType: positionTypeSchema,
  isHidden: z.boolean(),
  salesUnitNetCents: moneyCentsSchema,
  lineDiscountBps: basisPointsSchema,
  taxRateBps: z.union([z.literal(0), z.literal(1_900)]),
  finalNetCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
}).superRefine((line, context) => {
  if (line.unit !== "meter" && line.quantityMilli % 1_000 !== 0) {
    context.addIssue({
      code: "custom",
      path: ["quantityMilli"],
      message: "piece und set erlauben nur ganze Einheiten.",
    });
  }
  const expectedTaxCents = (
    BigInt(line.finalNetCents) * BigInt(line.taxRateBps) + BigInt(5_000)
  ) / BigInt(10_000);
  if (expectedTaxCents !== BigInt(line.taxCents)) {
    context.addIssue({
      code: "custom",
      path: ["taxCents"],
      message: "Steuer muss dem Satz und dem serverautoritativen Nettoendwert entsprechen.",
    });
  }
  if (BigInt(line.finalNetCents) + BigInt(line.taxCents) !== BigInt(line.grossCents)) {
    context.addIssue({
      code: "custom",
      path: ["grossCents"],
      message: "Brutto muss der Summe aus Netto und Steuer entsprechen.",
    });
  }
});

const pdfSectionSchema = z.strictObject({
  position: sectionPositionSchema,
  title: normalizedRequiredText(120),
  discountBps: basisPointsSchema,
  lines: z.array(pdfLineSchema).min(1).max(MAX_PDF_LINES),
});

const pdfTotalsSchema = z.strictObject({
  basisNetCents: moneyCentsSchema,
  basisTaxCents: moneyCentsSchema,
  basisGrossCents: moneyCentsSchema,
  optionalNetCents: moneyCentsSchema,
  optionalTaxCents: moneyCentsSchema,
  optionalGrossCents: moneyCentsSchema,
}).superRefine((totals, context) => {
  for (const prefix of ["basis", "optional"] as const) {
    const net = totals[`${prefix}NetCents`];
    const tax = totals[`${prefix}TaxCents`];
    const gross = totals[`${prefix}GrossCents`];
    if (BigInt(net) + BigInt(tax) !== BigInt(gross)) {
      context.addIssue({
        code: "custom",
        path: [`${prefix}GrossCents`],
        message: "Brutto muss der Summe aus Netto und Steuer entsprechen.",
      });
    }
  }
});

export const offerPdfDraftInputV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_PDF_DRAFT_INPUT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  templateVersion: z.literal(OFFER_PDF_DRAFT_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION),
  offerNumber: normalizedRequiredText(120).pipe(
    z.string().regex(/^ANG-[0-9]{4}-[0-9]{6}$/u),
  ),
  preparedAt: utcDateTimeSchema,
  recipient: z.strictObject({
    displayName: normalizedRequiredText(200),
  }),
  installationSite: z.strictObject({
    formattedAddress: normalizedRequiredText(360),
  }),
  variant: z.strictObject({
    name: normalizedRequiredText(120),
    revision: positiveRevisionSchema,
  }),
  commercialTerms: z.strictObject({
    globalDiscountBps: basisPointsSchema,
    customDealNetCents: moneyCentsSchema.nullable(),
  }),
  sections: z.array(pdfSectionSchema).min(1).max(25),
  totals: pdfTotalsSchema,
}).superRefine((input, context) => {
  const sectionPositions = new Set<number>();
  let lineCount = 0;
  const calculatedTotals = {
    basisNetCents: BigInt(0),
    basisTaxCents: BigInt(0),
    basisGrossCents: BigInt(0),
    optionalNetCents: BigInt(0),
    optionalTaxCents: BigInt(0),
    optionalGrossCents: BigInt(0),
  };
  for (const [sectionIndex, section] of input.sections.entries()) {
    if (sectionPositions.has(section.position)) {
      context.addIssue({
        code: "custom",
        path: ["sections", sectionIndex, "position"],
        message: "Sektionspositionen muessen eindeutig sein.",
      });
    }
    sectionPositions.add(section.position);
    const linePositions = new Set<number>();
    for (const [lineIndex, line] of section.lines.entries()) {
      lineCount += 1;
      const prefix = line.positionType === "optional" ? "optional" : "basis";
      calculatedTotals[`${prefix}NetCents`] += BigInt(line.finalNetCents);
      calculatedTotals[`${prefix}TaxCents`] += BigInt(line.taxCents);
      calculatedTotals[`${prefix}GrossCents`] += BigInt(line.grossCents);
      if (linePositions.has(line.position)) {
        context.addIssue({
          code: "custom",
          path: ["sections", sectionIndex, "lines", lineIndex, "position"],
          message: "Zeilenpositionen muessen je Sektion eindeutig sein.",
        });
      }
      linePositions.add(line.position);
    }
  }
  if (lineCount > MAX_PDF_LINES) {
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: "Ein PDF-Dokumentstand darf hoechstens 500 Zeilen enthalten.",
    });
  }
  const totalKeys = [
    "basisNetCents",
    "basisTaxCents",
    "basisGrossCents",
    "optionalNetCents",
    "optionalTaxCents",
    "optionalGrossCents",
  ] as const;
  if (totalKeys.some((key) => calculatedTotals[key] !== BigInt(input.totals[key]))) {
    context.addIssue({
      code: "custom",
      path: ["totals"],
      message: "Dokumentsummen muessen exakt den serverautoritativen Zeilenendwerten entsprechen.",
    });
  }
});

export type OfferPdfDraftInputV1 = z.infer<typeof offerPdfDraftInputV1Schema>;

export interface BuildOfferPdfDraftInputOptions {
  offerNumber: string;
  preparedAt: string;
  variantSnapshot: unknown;
}

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part)
      .replaceAll("~", "~0")
      .replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

export function validateOfferPdfDraftInput(
  value: unknown,
): OfferContractResult<OfferPdfDraftInputV1> {
  const parsed = offerPdfDraftInputV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  return { ok: true, value: parsed.data };
}

function pdfLineFromSnapshot(
  line: OfferVariantSnapshotV1["sections"][number]["lines"][number],
): z.input<typeof pdfLineSchema> {
  return {
    position: line.position,
    title: line.product.displayName,
    description: line.product.kind === "custom" ? line.product.description : null,
    quantityMilli: line.quantityMilli,
    unit: line.product.unit,
    positionType: line.positionType,
    isHidden: line.isHidden,
    salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
    lineDiscountBps: line.lineDiscountBps,
    taxRateBps: line.taxRateBps,
    finalNetCents: line.computed.finalSalesNetCents,
    taxCents: line.computed.salesTaxCents,
    grossCents: line.computed.salesGrossCents,
  };
}

/**
 * Builds the complete render boundary from a hash-valid immutable snapshot.
 * IDs, hashes, contact channels and purchase data never cross it. The hidden
 * flag must cross the boundary because hidden M2-01 lines still contribute to
 * server-authoritative totals and need an honest internal-draft disclosure.
 */
export function buildOfferPdfDraftInput({
  offerNumber,
  preparedAt,
  variantSnapshot,
}: BuildOfferPdfDraftInputOptions): OfferPdfDraftInputV1 {
  const snapshotResult = validateOfferVariantSnapshot(variantSnapshot);
  if (!snapshotResult.ok) {
    throw new TypeError(`Ungueltiger Offer-Snapshot: ${snapshotResult.paths.join(", ")}`);
  }
  const snapshot = snapshotResult.value;
  const sections = [...snapshot.sections]
    .sort((left, right) => left.position - right.position)
    .map((section) => ({
      position: section.position,
      title: section.title,
      discountBps: section.discountBps,
      lines: [...section.lines]
        .sort((left, right) => left.position - right.position)
        .map(pdfLineFromSnapshot),
    }))
    .filter((section) => section.lines.length > 0);

  const candidate = {
    schemaVersion: OFFER_PDF_DRAFT_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
    offerNumber,
    preparedAt,
    recipient: { displayName: snapshot.contactContext.displayName },
    installationSite: {
      formattedAddress: snapshot.installationSiteContext.formattedAddress,
    },
    variant: {
      name: snapshot.variantName,
      revision: snapshot.revision,
    },
    commercialTerms: {
      globalDiscountBps: snapshot.globalDiscountBps,
      customDealNetCents: snapshot.customDealNetCents,
    },
    sections,
    totals: snapshot.totals,
  };
  const parsed = offerPdfDraftInputV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError(`Ungueltiger PDF-Dokumentinput: ${validationPaths(parsed.error).join(", ")}`);
  }
  return parsed.data;
}

export function hashOfferPdfDraftInput(value: unknown): string {
  const parsed = offerPdfDraftInputV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Ungueltiger PDF-Dokumentinput: ${validationPaths(parsed.error).join(", ")}`);
  }
  return createHash("sha256")
    .update(canonicalizeOfferJson(parsed.data), "utf8")
    .digest("hex");
}
