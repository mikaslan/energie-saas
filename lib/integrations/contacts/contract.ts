import { z } from "zod";

export const CONTACT_DATASET_VERSION = "contact-dataset.v1" as const;
export const CONTACT_UPDATE_COMMAND_VERSION = "contact-update-command.v1" as const;
export const CONTACT_MAX_REVISION = 2_147_483_647 as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const canonicalUuidSchema = z.uuid().refine(
  (value) => value === value.toLowerCase(),
  "UUID must be canonical lowercase",
);
const revisionSchema = z.number().int().min(1).max(CONTACT_MAX_REVISION);

const salutationSchema = z.enum(["female", "male", "diverse", "family", "business"]);
const phoneReachabilitySchema = z.enum([
  "morning",
  "afternoon",
  "evening",
  "fulltime",
  "weekend_only",
  "email_only",
]);

// P2-2: NOT-NULL-Spalten (first_name/last_name) dürfen nicht auf reine
// Leerzeichen kollabieren — sonst entstünde ein Phantom-Revisions-Bump. Das
// Schema verlangt deshalb einen nicht-leeren Trim (deckungsgleich mit dem
// DB-CHECK length(btrim(...)) between 1 and 200).
const nameSchema = z.string().min(1).max(200).refine(
  (value) => value.trim().length >= 1,
  "name must not be blank",
);
const emailSchema = z.string().min(3).max(254);

// E-Mail wird serverseitig auf lower(btrim) normalisiert. Das Schema akzeptiert
// den Rohwert; der Service normalisiert vor dem Schreiben und prüft die Form.
const emailSecondarySchema = emailSchema.superRefine((value, ctx) => {
  if (!/^[^@\s]+@[^@\s]+$/u.test(value)) {
    ctx.addIssue({ code: "custom", message: "email secondary has invalid form" });
  }
});

// E.164 (wie contact.phone_e164); der Service normalisiert Mobilnummern.
const phoneE164Schema = z.string().regex(/^\+[1-9][0-9]{1,14}$/u);

const trimmedText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(
    (value) => value === value.trim(),
    "value must be trimmed",
  );

// PLZ-Muster nur bei country IN ('DE', null): ^[0-9]{5}$; sonst freie,
// getrimmte Form (1–20). Geprüft wird hier nur die freie Form; die
// country-abhängige DB-Invariante erzwingt der CHECK-Constraint.
const postalCodeSchema = trimmedText(1, 20);

const httpsUrlSchema = z.string().min(8).max(2000).refine(
  (value) => value.startsWith("https://"),
  "link must start with https://",
);

const utmFieldSchema = z.string().min(1).max(1000).refine(
  (value) => value === value.trim(),
  "value must be trimmed",
);

export const contactNameV1Schema = z.strictObject({
  displayName: nameSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  salutation: salutationSchema.nullable(),
  isBusiness: z.boolean(),
});
export type ContactNameV1 = z.infer<typeof contactNameV1Schema>;

export const contactWaysV1Schema = z.strictObject({
  primaryEmail: emailSchema.nullable(),
  secondaryEmail: emailSchema.nullable(),
  phone: phoneE164Schema.nullable(),
  phoneMobile: phoneE164Schema.nullable(),
  phoneReachability: phoneReachabilitySchema.nullable(),
});
export type ContactWaysV1 = z.infer<typeof contactWaysV1Schema>;

export const contactAddressV1Schema = z.strictObject({
  street: trimmedText(1, 200).nullable(),
  houseNumber: trimmedText(1, 30).nullable(),
  postalCode: postalCodeSchema.nullable(),
  city: trimmedText(1, 200).nullable(),
  country: trimmedText(1, 20).nullable(),
});
export type ContactAddressV1 = z.infer<typeof contactAddressV1Schema>;

export const contactMarketingConsentV1Schema = z.strictObject({
  granted: z.boolean(),
  grantedAt: z.string().nullable(),
  source: trimmedText(1, 200).nullable(),
  policyVersion: trimmedText(1, 100).nullable(),
  text: z.string().max(20000).nullable(),
  dataProtectionLink: httpsUrlSchema.nullable(),
});
export type ContactMarketingConsentV1 = z.infer<typeof contactMarketingConsentV1Schema>;

export const contactUtmV1Schema = z.strictObject({
  source: utmFieldSchema.nullable(),
  medium: utmFieldSchema.nullable(),
  campaign: utmFieldSchema.nullable(),
  term: utmFieldSchema.nullable(),
  content: utmFieldSchema.nullable(),
});
export type ContactUtmV1 = z.infer<typeof contactUtmV1Schema>;

// Minimiertes Lesemodell (Spec §5): kein workspace_id, keine Fremd-IDs, keine
// domain_events-/audit_log-Daten, keine Erasure-Interna. deletedAt ist der
// DSGVO-Löschmarker und steuert den UI-Löschzustand (kein Edit-Angebot).
export const contactDatasetV1Schema = z.strictObject({
  schemaVersion: z.literal(CONTACT_DATASET_VERSION),
  contactId: canonicalUuidSchema,
  revision: revisionSchema,
  deletedAt: z.string().nullable(),
  name: contactNameV1Schema,
  contactWays: contactWaysV1Schema,
  address: contactAddressV1Schema,
  marketingConsent: contactMarketingConsentV1Schema,
  utm: contactUtmV1Schema,
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type ContactDatasetV1 = z.infer<typeof contactDatasetV1Schema>;

// Allowlist des Edit-Patches (Spec §5): Name, Anrede, B2B, Sekundär-E-Mail,
// Mobil, Erreichbarkeit, Kontaktadresse, Consent-Felder, UTM-Felder. Primär-
// E-Mail/Festnetz und der Consent-Boolean (At/Source) sind intake-owned und
// nicht Teil des Patches.
export const contactUpdatePatchV1Schema = z
  .strictObject({
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    salutation: salutationSchema.nullable().optional(),
    isBusiness: z.boolean().optional(),
    emailSecondary: emailSecondarySchema.nullable().optional(),
    phoneMobile: phoneE164Schema.nullable().optional(),
    phoneReachability: phoneReachabilitySchema.nullable().optional(),
    addressStreet: trimmedText(1, 200).nullable().optional(),
    addressHouseNumber: trimmedText(1, 30).nullable().optional(),
    addressPostalCode: postalCodeSchema.nullable().optional(),
    addressCity: trimmedText(1, 200).nullable().optional(),
    addressCountry: trimmedText(1, 20).nullable().optional(),
    marketingConsentPolicyVersion: trimmedText(1, 100).nullable().optional(),
    marketingConsentText: z.string().max(20000).nullable().optional(),
    marketingConsentDataProtectionLink: httpsUrlSchema.nullable().optional(),
    utmSource: utmFieldSchema.nullable().optional(),
    utmMedium: utmFieldSchema.nullable().optional(),
    utmCampaign: utmFieldSchema.nullable().optional(),
    utmTerm: utmFieldSchema.nullable().optional(),
    utmContent: utmFieldSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "patch must not be empty");

export type ContactUpdatePatchV1 = z.infer<typeof contactUpdatePatchV1Schema>;

export const contactUpdateCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(CONTACT_UPDATE_COMMAND_VERSION),
  projectId: uuidSchema,
  expectedRevision: revisionSchema,
  patch: contactUpdatePatchV1Schema,
});
export type ContactUpdateCommandV1 = z.infer<typeof contactUpdateCommandV1Schema>;

export type ContactUpdateResult = {
  contactId: string;
  revision: number;
  changedFields: string[];
};
