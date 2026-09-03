import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";

export const contact = pgTable(
  "contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    displayName: text("display_name").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    salutation: text("salutation"),
    isBusiness: boolean("is_business").notNull().default(false),
    emailPrimary: text("email_primary"),
    emailNormalized: text("email_normalized"),
    emailSecondary: text("email_secondary"),
    phoneRaw: text("phone_raw"),
    phoneE164: text("phone_e164"),
    phoneMobile: text("phone_mobile"),
    phoneReachability: text("phone_reachability"),
    addressStreet: text("address_street"),
    addressHouseNumber: text("address_house_number"),
    addressPostalCode: text("address_postal_code"),
    addressCity: text("address_city"),
    addressCountry: text("address_country"),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    marketingConsentSource: text("marketing_consent_source"),
    marketingConsentPolicyVersion: text("marketing_consent_policy_version"),
    marketingConsentText: text("marketing_consent_text"),
    marketingConsentDataProtectionLink: text("marketing_consent_data_protection_link"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    dedupeReviewRequired: boolean("dedupe_review_required").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contact_ws_email_idx").on(t.workspaceId, t.emailNormalized),
    index("contact_ws_phone_idx").on(t.workspaceId, t.phoneE164),
    unique("contact_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "contact_workspace_id_fk",
    }),
    check(
      "contact_display_name_ck",
      sql`length(btrim(${t.displayName})) between 1 and 200`,
    ),
    check(
      "contact_email_pair_ck",
      sql`(${t.emailPrimary} is null) = (${t.emailNormalized} is null)`,
    ),
    check(
      "contact_email_normalized_ck",
      sql`${t.emailNormalized} is null or (
        ${t.emailNormalized} = lower(btrim(${t.emailPrimary}))
        and length(${t.emailNormalized}) between 3 and 254
      )`,
    ),
    check(
      "contact_phone_pair_ck",
      sql`${t.phoneE164} is null or ${t.phoneRaw} is not null`,
    ),
    check(
      "contact_phone_e164_ck",
      sql`${t.phoneE164} is null or ${t.phoneE164} ~ '^\\+[1-9][0-9]{1,14}$'`,
    ),
    check(
      "contact_active_identity_ck",
      sql`${t.deletedAt} is not null or ${t.emailPrimary} is not null or ${t.phoneRaw} is not null`,
    ),
    check(
      "contact_marketing_consent_ck",
      sql`(
        ${t.marketingConsent} = false
        and ${t.marketingConsentAt} is null
        and ${t.marketingConsentSource} is null
      ) or (
        ${t.marketingConsent} = true
        and ${t.marketingConsentAt} is not null
        and length(btrim(${t.marketingConsentSource})) > 0
      )`,
    ),
    // P1-2/M114-CONTRACT-04: consent=true ⇒ Policy-Version gesetzt. Legt die
    // Version als Pflichtfeld fest, sobald die Einwilligung erteilt ist. In der
    // Migration als NOT VALID angelegt, damit Altbestand ohne Version (Vor-
    // Versions-Tracking) die Migration nicht bricht; neue/geänderte Zeilen
    // erzwingen die Invariante.
    check(
      "contact_marketing_consent_version_ck",
      sql`${t.marketingConsent} = false or ${t.marketingConsentPolicyVersion} is not null`,
    ),
    check("contact_first_name_ck", sql`length(btrim(${t.firstName})) between 1 and 200`),
    check("contact_last_name_ck", sql`length(btrim(${t.lastName})) between 1 and 200`),
    check(
      "contact_salutation_ck",
      sql`${t.salutation} is null or ${t.salutation} in ('female', 'male', 'diverse', 'family', 'business')`,
    ),
    check(
      "contact_is_business_ck",
      sql`${t.salutation} is distinct from 'business' or ${t.isBusiness} = true`,
    ),
    check(
      "contact_email_secondary_ck",
      sql`${t.emailSecondary} is null or (
        ${t.emailSecondary} = lower(btrim(${t.emailSecondary}))
        and ${t.emailSecondary} ~ '^[^@[:space:]]+@[^@[:space:]]+$'
        and length(${t.emailSecondary}) between 3 and 254
      )`,
    ),
    check(
      "contact_phone_mobile_ck",
      sql`${t.phoneMobile} is null or ${t.phoneMobile} ~ '^\\+[1-9][0-9]{1,14}$'`,
    ),
    check(
      "contact_phone_reachability_ck",
      sql`${t.phoneReachability} is null or ${t.phoneReachability} in ('morning', 'afternoon', 'evening', 'fulltime', 'weekend_only', 'email_only')`,
    ),
    check(
      "contact_address_street_ck",
      sql`${t.addressStreet} is null or length(btrim(${t.addressStreet})) between 1 and 200`,
    ),
    check(
      "contact_address_house_number_ck",
      sql`${t.addressHouseNumber} is null or length(btrim(${t.addressHouseNumber})) between 1 and 30`,
    ),
    check(
      "contact_address_postal_code_ck",
      sql`${t.addressPostalCode} is null or (
        (
          (${t.addressCountry} = 'DE' or ${t.addressCountry} is null)
          and ${t.addressPostalCode} ~ '^[0-9]{5}$'
        ) or (
          ${t.addressCountry} is not null
          and ${t.addressCountry} <> 'DE'
          and length(btrim(${t.addressPostalCode})) between 1 and 20
        )
      )`,
    ),
    check(
      "contact_address_city_ck",
      sql`${t.addressCity} is null or length(btrim(${t.addressCity})) between 1 and 200`,
    ),
    check(
      "contact_address_country_ck",
      sql`${t.addressCountry} is null or length(btrim(${t.addressCountry})) between 1 and 20`,
    ),
    check(
      "contact_marketing_consent_policy_version_ck",
      sql`${t.marketingConsentPolicyVersion} is null or length(btrim(${t.marketingConsentPolicyVersion})) between 1 and 100`,
    ),
    check(
      "contact_marketing_consent_data_protection_link_ck",
      sql`${t.marketingConsentDataProtectionLink} is null or ${t.marketingConsentDataProtectionLink} ~ '^https://'`,
    ),
    check(
      "contact_utm_source_ck",
      sql`${t.utmSource} is null or length(btrim(${t.utmSource})) between 1 and 1000`,
    ),
    check(
      "contact_utm_medium_ck",
      sql`${t.utmMedium} is null or length(btrim(${t.utmMedium})) between 1 and 1000`,
    ),
    check(
      "contact_utm_campaign_ck",
      sql`${t.utmCampaign} is null or length(btrim(${t.utmCampaign})) between 1 and 1000`,
    ),
    check(
      "contact_utm_term_ck",
      sql`${t.utmTerm} is null or length(btrim(${t.utmTerm})) between 1 and 1000`,
    ),
    check(
      "contact_utm_content_ck",
      sql`${t.utmContent} is null or length(btrim(${t.utmContent})) between 1 and 1000`,
    ),
    check("contact_revision_ck", sql`${t.revision} between 1 and 2147483647`),
  ],
);
