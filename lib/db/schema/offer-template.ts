import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { discountTemplate } from "./discount-template";
import { paymentOption } from "./payment-option";
import { subsidyTemplate } from "./subsidy-template";

// F16-06 · Angebots-Vorlagen (Zahlart-Preset + Rabatt-Vorlagen-Preset,
// je optional, mindestens eines belegt). Archiv statt Delete (active-Flag,
// F7.3/F16.3-Muster wie F16-04/F16-05). Anwenden heißt: Zahlart an der
// Variante setzen + Rabatt-Vorlage global anwenden (bestehende Commands,
// keine neuen Permissions).
// F16-09 · zusätzlich optionales Förder-Preset (subsidy_template,
// angewandt zwischen Rabatt und Zahlart mit Revisionsverkettung).
export const offerTemplate = pgTable(
  "offer_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    paymentOptionId: uuid("payment_option_id"),
    discountTemplateId: uuid("discount_template_id"),
    subsidyTemplateId: uuid("subsidy_template_id"),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("offer_template_ws_idx").on(t.workspaceId, t.active, t.position),
    uniqueIndex("offer_template_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("offer_template_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.active}`),
    check("offer_template_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 200 and ${t.name} !~ '[[:cntrl:]]'`),
    check("offer_template_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("offer_template_preset_ck", sql`${t.paymentOptionId} is not null or ${t.discountTemplateId} is not null or ${t.subsidyTemplateId} is not null`),
    check("offer_template_position_ck", sql`${t.position} >= 0`),
    check("offer_template_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_template_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.paymentOptionId],
      foreignColumns: [paymentOption.workspaceId, paymentOption.id],
      name: "offer_template_payment_option_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.discountTemplateId],
      foreignColumns: [discountTemplate.workspaceId, discountTemplate.id],
      name: "offer_template_discount_template_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.subsidyTemplateId],
      foreignColumns: [subsidyTemplate.workspaceId, subsidyTemplate.id],
      name: "offer_template_subsidy_template_id_fk",
    }),
  ],
);
