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

export const OFFER_RELEASE_PROFILE_SNAPSHOT_VERSION =
  "offer-release-profile-snapshot.v1" as const;
export const OFFER_RECIPIENT_SNAPSHOT_VERSION =
  "offer-recipient-snapshot.v1" as const;
export const OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION =
  "offer-release-profile-revise-command.v1" as const;
export const OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION =
  "offer-release-profile-activate-command.v1" as const;
export const OFFER_RECIPIENT_REVISE_COMMAND_VERSION =
  "offer-recipient-revise-command.v1" as const;
export const OFFER_RELEASE_CANDIDATE_REQUEST_VERSION =
  "offer-release-candidate-request.v1" as const;
export const OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION =
  "offer-release-candidate-dispatch.v1" as const;
export const OFFER_RELEASE_CANDIDATE_INPUT_VERSION =
  "offer-release-candidate-input.v1" as const;
export const OFFER_RELEASE_APPROVAL_COMMAND_VERSION =
  "offer-release-approval-command.v1" as const;
export const OFFER_RELEASE_CANDIDATE_APPROVAL_VERSION =
  "offer-release-candidate-approval.v1" as const;
export const OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION =
  "offer-release-candidate-template.v1" as const;
export const OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION =
  "offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac" as const;

const MAX_DOCUMENT_LINES = 500;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OFFER_NUMBER_PATTERN = /^ANG-[0-9]{4}-[0-9]{6}$/u;
const E164_PATTERN = /^\+[1-9][0-9]{1,14}$/u;
const POSTAL_CODE_PATTERN = /^[0-9]{5}$/u;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const nonnegativeRevisionSchema = z.int().safe().min(0);
const positiveRevisionSchema = z.int().safe().min(1);
const moneyCentsSchema = z.int().safe().min(0).max(OFFER_MAX_MONEY_CENTS);
const basisPointsSchema = z.int().safe().min(0).max(10_000);
const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/u);
const calendarDateSchema = z.iso.date();

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

function normalizedMultilineText(maxLength: number) {
  return z.string().superRefine((value, context) => {
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "Text enthaelt ungueltiges Unicode." });
      return;
    }
    const normalized = value.normalize("NFC").replaceAll("\r\n", "\n").trim();
    if (normalized.length < 1 || normalized.length > maxLength) {
      context.addIssue({
        code: "custom",
        message: `Text muss 1 bis ${maxLength} Zeichen lang sein.`,
      });
    }
  }).transform((value) => value.normalize("NFC").replaceAll("\r\n", "\n").trim());
}

const nullableText = (maxLength: number) => normalizedRequiredText(maxLength).nullable();
const emailSchema = normalizedRequiredText(254)
  .transform((value) => value.toLowerCase())
  .pipe(z.email().max(254));

const httpsUrlSchema = normalizedRequiredText(500).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) context.addIssue({ code: "custom", message: "Nur eine reine HTTPS-URL ist erlaubt." });
  } catch {
    context.addIssue({ code: "custom", message: "Ungueltige HTTPS-URL." });
  }
}).nullable();

const addressSchema = z.strictObject({
  street: normalizedRequiredText(160),
  houseNumber: normalizedRequiredText(32),
  postalCode: normalizedRequiredText(16).pipe(z.string().regex(POSTAL_CODE_PATTERN)),
  city: normalizedRequiredText(160),
  country: z.literal("DE"),
});

const senderSchema = z.strictObject({
  legalName: normalizedRequiredText(200),
  tradingName: nullableText(120),
  representedBy: normalizedRequiredText(200),
  address: addressSchema,
  email: emailSchema,
  phoneE164: z.string().regex(E164_PATTERN).nullable(),
  websiteHttpsUrl: httpsUrlSchema,
  registerCourt: nullableText(200),
  registerNumber: nullableText(100),
  vatId: nullableText(32),
}).superRefine((sender, context) => {
  if ((sender.registerCourt === null) !== (sender.registerNumber === null)) {
    context.addIssue({
      code: "custom",
      path: [sender.registerCourt === null ? "registerCourt" : "registerNumber"],
      message: "Registergericht und Registernummer muessen gemeinsam gesetzt sein.",
    });
  }
});

const legalDocumentSchema = z.strictObject({
  title: normalizedRequiredText(120),
  plainText: normalizedMultilineText(40_000),
});

const legalDocumentsSchema = z.strictObject({
  terms: legalDocumentSchema,
  withdrawalInformation: legalDocumentSchema,
  privacyNotice: legalDocumentSchema,
});

export const offerReleaseProfileReviseCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION),
  workspaceId: uuidSchema,
  expectedCurrentRevision: nonnegativeRevisionSchema,
  profileName: normalizedRequiredText(120),
  sender: senderSchema,
  legalDocuments: legalDocumentsSchema,
});

export type OfferReleaseProfileReviseCommandV1 = z.infer<
  typeof offerReleaseProfileReviseCommandV1Schema
>;

export const offerReleaseProfileActivateCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION),
  workspaceId: uuidSchema,
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  expectedProfileRevision: positiveRevisionSchema,
});

export type OfferReleaseProfileActivateCommandV1 = z.infer<
  typeof offerReleaseProfileActivateCommandV1Schema
>;

const profilePayloadSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_PROFILE_SNAPSHOT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  workspaceId: uuidSchema,
  revision: positiveRevisionSchema,
  profileName: normalizedRequiredText(120),
  locale: z.literal("de-DE"),
  currency: z.literal("EUR"),
  sender: senderSchema,
  legalDocuments: legalDocumentsSchema,
  createdBy: uuidSchema,
  createdAt: utcDateTimeSchema,
});

function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeOfferJson(value), "utf8")
    .digest("hex");
}

export const offerReleaseProfileSnapshotV1Schema = profilePayloadSchema.extend({
  snapshotSha256: z.string().regex(SHA256_PATTERN),
}).superRefine((snapshot, context) => {
  const { snapshotSha256, ...payload } = snapshot;
  if (canonicalHash(payload) !== snapshotSha256) {
    context.addIssue({
      code: "custom",
      path: ["snapshotSha256"],
      message: "Profilhash stimmt nicht mit dem kanonischen Inhalt ueberein.",
    });
  }
});

export type OfferReleaseProfileSnapshotV1 = z.infer<
  typeof offerReleaseProfileSnapshotV1Schema
>;

const profileBuildSchema = z.strictObject({
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  workspaceId: uuidSchema,
  revision: positiveRevisionSchema,
  profileName: normalizedRequiredText(120),
  sender: senderSchema,
  legalDocuments: legalDocumentsSchema,
  createdBy: uuidSchema,
  createdAt: utcDateTimeSchema,
});

export function buildOfferReleaseProfileSnapshot(
  value: unknown,
): OfferReleaseProfileSnapshotV1 {
  const parsed = profileBuildSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger Angebotsprofilstand.");
  const payload = profilePayloadSchema.parse({
    schemaVersion: OFFER_RELEASE_PROFILE_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    locale: "de-DE",
    currency: "EUR",
    ...parsed.data,
  });
  return offerReleaseProfileSnapshotV1Schema.parse({
    ...payload,
    snapshotSha256: canonicalHash(payload),
  });
}

export function hashOfferReleaseProfileSnapshot(value: unknown): string {
  const parsed = offerReleaseProfileSnapshotV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger Angebotsprofilstand.");
  return canonicalHash(Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => key !== "snapshotSha256"),
  ));
}

const recipientPayloadSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RECIPIENT_SNAPSHOT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  recipientRevisionId: uuidSchema,
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  revision: positiveRevisionSchema,
  displayName: normalizedRequiredText(200),
  company: nullableText(200),
  email: emailSchema,
  billingAddress: addressSchema,
  confirmation: z.strictObject({
    code: z.literal("recipient_billing_operator_confirmed"),
    confirmed: z.literal(true),
    confirmedBy: uuidSchema,
    confirmedAt: utcDateTimeSchema,
  }),
  createdBy: uuidSchema,
  createdAt: utcDateTimeSchema,
});

export const offerRecipientSnapshotV1Schema = recipientPayloadSchema.extend({
  snapshotSha256: z.string().regex(SHA256_PATTERN),
}).superRefine((snapshot, context) => {
  const { snapshotSha256, ...payload } = snapshot;
  if (canonicalHash(payload) !== snapshotSha256) {
    context.addIssue({
      code: "custom",
      path: ["snapshotSha256"],
      message: "Empfaengerhash stimmt nicht mit dem kanonischen Inhalt ueberein.",
    });
  }
});

export type OfferRecipientSnapshotV1 = z.infer<typeof offerRecipientSnapshotV1Schema>;

const recipientBuildSchema = z.strictObject({
  recipientRevisionId: uuidSchema,
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  revision: positiveRevisionSchema,
  displayName: normalizedRequiredText(200),
  company: nullableText(200),
  email: emailSchema,
  billingAddress: addressSchema,
  confirmationCode: z.literal("recipient_billing_operator_confirmed"),
  confirmedBy: uuidSchema,
  confirmedAt: utcDateTimeSchema,
  createdBy: uuidSchema,
  createdAt: utcDateTimeSchema,
});

export function buildOfferRecipientSnapshot(value: unknown): OfferRecipientSnapshotV1 {
  const parsed = recipientBuildSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger Empfaengerstand.");
  const { confirmationCode, confirmedBy, confirmedAt, ...fields } = parsed.data;
  const payload = recipientPayloadSchema.parse({
    schemaVersion: OFFER_RECIPIENT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    ...fields,
    confirmation: {
      code: confirmationCode,
      confirmed: true,
      confirmedBy,
      confirmedAt,
    },
  });
  return offerRecipientSnapshotV1Schema.parse({
    ...payload,
    snapshotSha256: canonicalHash(payload),
  });
}

export function hashOfferRecipientSnapshot(value: unknown): string {
  const parsed = offerRecipientSnapshotV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger Empfaengerstand.");
  return canonicalHash(Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => key !== "snapshotSha256"),
  ));
}

export const offerRecipientReviseCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RECIPIENT_REVISE_COMMAND_VERSION),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  expectedCurrentRevision: nonnegativeRevisionSchema,
  displayName: normalizedRequiredText(200),
  company: nullableText(200),
  email: emailSchema,
  billingAddress: addressSchema,
  billingDetailsConfirmed: z.literal(true),
});

export type OfferRecipientReviseCommandV1 = z.infer<
  typeof offerRecipientReviseCommandV1Schema
>;

export const offerReleaseCandidateRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_CANDIDATE_REQUEST_VERSION),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  variantId: uuidSchema,
  expectedVariantRevision: positiveRevisionSchema,
  sourcePdfDraftId: uuidSchema,
  documentProfileId: uuidSchema,
  documentProfileRevisionId: uuidSchema,
  expectedDocumentProfileRevision: positiveRevisionSchema,
  recipientRevisionId: uuidSchema,
  expectedRecipientRevision: positiveRevisionSchema,
  validThrough: calendarDateSchema,
});

export type OfferReleaseCandidateRequestV1 = z.infer<
  typeof offerReleaseCandidateRequestV1Schema
>;

export const offerReleaseCandidateDispatchV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION),
  workspaceId: uuidSchema,
  candidateId: uuidSchema,
});

export type OfferReleaseCandidateDispatchV1 = z.infer<
  typeof offerReleaseCandidateDispatchV1Schema
>;

export const offerReleaseApprovalCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_APPROVAL_COMMAND_VERSION),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  candidateId: uuidSchema,
  expectedArtifactVersion: uuidSchema,
  recipientBillingReviewed: z.literal(true),
  commercialContentReviewed: z.literal(true),
  activeProfileReviewed: z.literal(true),
  notIssuedStatusUnderstood: z.literal(true),
  zeroTaxTreatmentReviewed: z.literal(true).optional(),
});

export type OfferReleaseApprovalCommandV1 = z.infer<
  typeof offerReleaseApprovalCommandV1Schema
>;

const documentSenderSchema = z.strictObject({
  legalName: normalizedRequiredText(200),
  tradingName: nullableText(120),
  representedBy: normalizedRequiredText(200),
  address: addressSchema,
  contactEmail: emailSchema,
  contactPhone: z.string().regex(E164_PATTERN).nullable(),
  website: httpsUrlSchema,
  registerCourt: nullableText(200),
  registerNumber: nullableText(100),
  vatId: nullableText(32),
});

const documentLineSchema = z.strictObject({
  position: z.int().safe().min(1).max(MAX_DOCUMENT_LINES),
  title: normalizedRequiredText(200),
  description: nullableText(1_000),
  quantityMilli: z.int().safe().min(1).max(100_000_000),
  unit: z.enum(["piece", "set", "meter"]),
  positionType: z.enum(["required", "additional", "optional"]),
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
  const expectedTax = (
    BigInt(line.finalNetCents) * BigInt(line.taxRateBps) + BigInt(5_000)
  ) / BigInt(10_000);
  if (expectedTax !== BigInt(line.taxCents)) {
    context.addIssue({
      code: "custom",
      path: ["taxCents"],
      message: "Steuer stimmt nicht mit Netto und Steuersatz ueberein.",
    });
  }
  if (BigInt(line.finalNetCents) + BigInt(line.taxCents) !== BigInt(line.grossCents)) {
    context.addIssue({
      code: "custom",
      path: ["grossCents"],
      message: "Brutto muss Netto plus Steuer entsprechen.",
    });
  }
});

const documentSectionSchema = z.strictObject({
  position: z.int().safe().min(1).max(25),
  title: normalizedRequiredText(120),
  discountBps: basisPointsSchema,
  lines: z.array(documentLineSchema).min(1).max(MAX_DOCUMENT_LINES),
});

const documentTotalsSchema = z.strictObject({
  basisNetCents: moneyCentsSchema,
  basisTaxCents: moneyCentsSchema,
  basisGrossCents: moneyCentsSchema,
  optionalNetCents: moneyCentsSchema,
  optionalTaxCents: moneyCentsSchema,
  optionalGrossCents: moneyCentsSchema,
}).superRefine((totals, context) => {
  for (const prefix of ["basis", "optional"] as const) {
    if (
      BigInt(totals[`${prefix}NetCents`]) + BigInt(totals[`${prefix}TaxCents`])
      !== BigInt(totals[`${prefix}GrossCents`])
    ) {
      context.addIssue({
        code: "custom",
        path: [`${prefix}GrossCents`],
        message: "Brutto muss Netto plus Steuer entsprechen.",
      });
    }
  }
});

function calendarDaysBetween(start: string, end: string): number {
  return (
    Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  ) / 86_400_000;
}

const BERLIN_CALENDAR_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function berlinCalendarDate(instant: string): string {
  const parts = new Map(
    BERLIN_CALENDAR_DATE_FORMATTER
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

export const offerReleaseCandidateInputV1Schema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_CANDIDATE_INPUT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  templateVersion: z.literal(OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION),
  documentStatus: z.literal("not_issued"),
  preparedAt: utcDateTimeSchema,
  documentDate: calendarDateSchema,
  validThrough: calendarDateSchema,
  offerNumber: normalizedRequiredText(120).pipe(z.string().regex(OFFER_NUMBER_PATTERN)),
  profile: z.strictObject({
    name: normalizedRequiredText(120),
    revision: positiveRevisionSchema,
  }),
  sender: documentSenderSchema,
  recipient: z.strictObject({
    displayName: normalizedRequiredText(200),
    company: nullableText(200),
    billingAddress: addressSchema.extend({
      formattedAddress: normalizedRequiredText(360),
    }),
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
    // F16.3 Slice E: Cap (null = ungedeckelt, nur Carry, keine Anzeige).
    globalDiscountCapCents: moneyCentsSchema.nullable(),
    // F16.3 Slice D: globaler Fix-Rabatt (null = keiner).
    globalFixDiscountCents: moneyCentsSchema.nullable(),
    customDealNetCents: moneyCentsSchema.nullable(),
  }),
  sections: z.array(documentSectionSchema).min(1).max(25),
  totals: documentTotalsSchema,
  legalDocuments: legalDocumentsSchema,
}).superRefine((input, context) => {
  const validityDays = calendarDaysBetween(input.documentDate, input.validThrough);
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 60) {
    context.addIssue({
      code: "custom",
      path: ["validThrough"],
      message: "Gueltigkeit muss 1 bis 60 Kalendertage nach Dokumentdatum liegen.",
    });
  }
  if (berlinCalendarDate(input.preparedAt) !== input.documentDate) {
    context.addIssue({
      code: "custom",
      path: ["documentDate"],
      message: "Dokumentdatum muss dem versiegelten DB-Zeitpunkt entsprechen.",
    });
  }

  const sectionPositions = new Set<number>();
  let lineCount = 0;
  const calculated = {
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
      if (linePositions.has(line.position)) {
        context.addIssue({
          code: "custom",
          path: ["sections", sectionIndex, "lines", lineIndex, "position"],
          message: "Zeilenpositionen muessen je Sektion eindeutig sein.",
        });
      }
      linePositions.add(line.position);
      const prefix = line.positionType === "optional" ? "optional" : "basis";
      calculated[`${prefix}NetCents`] += BigInt(line.finalNetCents);
      calculated[`${prefix}TaxCents`] += BigInt(line.taxCents);
      calculated[`${prefix}GrossCents`] += BigInt(line.grossCents);
    }
  }
  if (lineCount > MAX_DOCUMENT_LINES) {
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: "Ein Kandidat darf hoechstens 500 Zeilen enthalten.",
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
  if (totalKeys.some((key) => calculated[key] !== BigInt(input.totals[key]))) {
    context.addIssue({
      code: "custom",
      path: ["totals"],
      message: "Dokumentsummen muessen exakt den Zeilenendwerten entsprechen.",
    });
  }
});

export type OfferReleaseCandidateInputV1 = z.infer<
  typeof offerReleaseCandidateInputV1Schema
>;

export class OfferReleaseHiddenLineError extends Error {
  constructor() {
    super("offer release candidate contains a hidden line");
    this.name = "OfferReleaseHiddenLineError";
  }
}

export class OfferReleaseSourceBindingError extends Error {
  constructor() {
    super("offer release candidate sources do not share one tenant graph");
    this.name = "OfferReleaseSourceBindingError";
  }
}

export type BuildOfferReleaseCandidateInputOptions = {
  offerNumber: string;
  preparedAt: string;
  documentDate: string;
  validThrough: string;
  profileSnapshot: unknown;
  recipientSnapshot: unknown;
  variantSnapshot: unknown;
};

function documentLineFromSnapshot(
  line: OfferVariantSnapshotV1["sections"][number]["lines"][number],
): z.input<typeof documentLineSchema> {
  return {
    position: line.position,
    title: line.product.displayName,
    description: line.product.kind === "custom" ? line.product.description : null,
    quantityMilli: line.quantityMilli,
    unit: line.product.unit,
    positionType: line.positionType,
    salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
    lineDiscountBps: line.lineDiscountBps,
    taxRateBps: line.taxRateBps,
    finalNetCents: line.computed.finalSalesNetCents,
    taxCents: line.computed.salesTaxCents,
    grossCents: line.computed.salesGrossCents,
  };
}

function formatBillingAddress(address: z.infer<typeof addressSchema>): string {
  return `${address.street} ${address.houseNumber}, ${address.postalCode} ${address.city}`;
}

export function buildOfferReleaseCandidateInput({
  offerNumber,
  preparedAt,
  documentDate,
  validThrough,
  profileSnapshot,
  recipientSnapshot,
  variantSnapshot,
}: BuildOfferReleaseCandidateInputOptions): OfferReleaseCandidateInputV1 {
  const profile = offerReleaseProfileSnapshotV1Schema.safeParse(profileSnapshot);
  if (!profile.success) throw new TypeError("Ungueltiger Angebotsprofilstand.");
  const recipient = offerRecipientSnapshotV1Schema.safeParse(recipientSnapshot);
  if (!recipient.success) throw new TypeError("Ungueltiger Empfaengerstand.");
  const variant = validateOfferVariantSnapshot(variantSnapshot);
  if (!variant.ok) throw new TypeError("Ungueltiger Angebotsvariantenstand.");
  if (
    profile.data.workspaceId !== variant.value.workspaceId
    || recipient.data.workspaceId !== variant.value.workspaceId
    || recipient.data.offerId !== variant.value.offerId
  ) throw new OfferReleaseSourceBindingError();
  if (variant.value.sections.some((section) => section.lines.some((line) => line.isHidden))) {
    throw new OfferReleaseHiddenLineError();
  }

  const sections = [...variant.value.sections]
    .sort((left, right) => left.position - right.position)
    .map((section) => ({
      position: section.position,
      title: section.title,
      discountBps: section.discountBps,
      lines: [...section.lines]
        .sort((left, right) => left.position - right.position)
        .map(documentLineFromSnapshot),
    }));
  const sender = profile.data.sender;
  const billingAddress = recipient.data.billingAddress;
  const candidate = {
    schemaVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    documentStatus: "not_issued",
    preparedAt,
    documentDate,
    validThrough,
    offerNumber,
    profile: {
      name: profile.data.profileName,
      revision: profile.data.revision,
    },
    sender: {
      legalName: sender.legalName,
      tradingName: sender.tradingName,
      representedBy: sender.representedBy,
      address: sender.address,
      contactEmail: sender.email,
      contactPhone: sender.phoneE164,
      website: sender.websiteHttpsUrl,
      registerCourt: sender.registerCourt,
      registerNumber: sender.registerNumber,
      vatId: sender.vatId,
    },
    recipient: {
      displayName: recipient.data.displayName,
      company: recipient.data.company,
      billingAddress: {
        ...billingAddress,
        formattedAddress: formatBillingAddress(billingAddress),
      },
    },
    installationSite: {
      formattedAddress: variant.value.installationSiteContext.formattedAddress,
    },
    variant: {
      name: variant.value.variantName,
      revision: variant.value.revision,
    },
    commercialTerms: {
      globalDiscountBps: variant.value.globalDiscountBps,
      globalDiscountCapCents: variant.value.globalDiscountCapCents ?? null,
      globalFixDiscountCents: variant.value.globalFixDiscountCents,
      customDealNetCents: variant.value.customDealNetCents,
    },
    sections,
    totals: variant.value.totals,
    legalDocuments: profile.data.legalDocuments,
  };
  const parsed = offerReleaseCandidateInputV1Schema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Ungueltiger Freigabekandidaten-Input.");
  return parsed.data;
}

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part)
      .replaceAll("~", "~0")
      .replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

export function validateOfferReleaseCandidateInput(
  value: unknown,
): OfferContractResult<OfferReleaseCandidateInputV1> {
  const parsed = offerReleaseCandidateInputV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  return { ok: true, value: parsed.data };
}

export function hashOfferReleaseCandidateInput(value: unknown): string {
  const parsed = offerReleaseCandidateInputV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger Freigabekandidaten-Input.");
  return canonicalHash(parsed.data);
}
