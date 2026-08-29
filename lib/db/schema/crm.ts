import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
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
    emailPrimary: text("email_primary"),
    emailNormalized: text("email_normalized"),
    phoneRaw: text("phone_raw"),
    phoneE164: text("phone_e164"),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    marketingConsentSource: text("marketing_consent_source"),
    dedupeReviewRequired: boolean("dedupe_review_required").notNull().default(false),
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
  ],
);
