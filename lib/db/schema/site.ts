import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contact } from "./crm";
import { workspace } from "./core";
import { bytea } from "./types";

// Site (Standort) — schmale Referenz-Entität für M0. Contact-FK kommt in M1
// (Contact-Tabelle existiert dort noch nicht) als additive Spalte nach.
//
// Tenant-sichere Verknüpfbarkeit (Codex-Review #7): site hatte weder einen
// Workspace-FK noch einen tenantgebundenen Schlüssel. Ein späteres Modul mit
// einem einfachen site_id-FK hätte damit aus Workspace A auf eine Site aus B
// zeigen können — FK-Prüfungen verwenden RLS NICHT als Sichtbarkeitsfilter.
// Deshalb: FK auf workspace UND UNIQUE (workspace_id, id) als Ziel für
// künftige ZUSAMMENGESETZTE FKs. Das Muster ist in modules/README.md
// festgeschrieben und gilt für jede weitere Tenant-Entität.
export const site = pgTable("site", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  contactId: uuid("contact_id"),
  label: text("label"),
  formattedAddress: text("formatted_address"),
  addressFingerprint: bytea("address_fingerprint"),
  addressFingerprintVersion: smallint("address_fingerprint_version"),
  addressMode: text("address_mode").notNull().default("legacy"),
  street: text("street"),
  houseNumber: text("house_number"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country").notNull().default("DE"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  geocodeSource: text("geocode_source"),
  geocodePrecision: text("geocode_precision"),
  geocodePlaceId: text("geocode_place_id"),
  addressFollowUpRequired: boolean("address_follow_up_required").notNull().default(false),
  addressRevision: integer("address_revision").notNull().default(1),
  pinConfirmed: boolean("pin_confirmed").notNull().default(false), // Blaupause F1.3: Pin zählt fürs Planen
  pinConfirmedAddressRevision: integer("pin_confirmed_address_revision"),
  pinAdjusted: boolean("pin_adjusted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("site_ws_idx").on(t.workspaceId),
  uniqueIndex("site_ws_id_uq").on(t.workspaceId, t.id),
  unique("site_ws_contact_id_uq").on(t.workspaceId, t.contactId, t.id),
  uniqueIndex("site_ws_contact_address_fingerprint_uq")
    .on(t.workspaceId, t.contactId, t.addressFingerprintVersion, t.addressFingerprint)
    .where(sql`${t.addressMode} = 'selected'`),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "site_workspace_id_fk" }),
  foreignKey({
    columns: [t.workspaceId, t.contactId],
    foreignColumns: [contact.workspaceId, contact.id],
    name: "site_contact_fk",
  }),
  check("site_address_mode_ck", sql`${t.addressMode} in ('legacy', 'selected', 'regional_estimate')`),
  check(
    "site_geocode_precision_ck",
    sql`${t.geocodePrecision} is null or ${t.geocodePrecision} in ('house', 'street', 'locality', 'region')`,
  ),
  check("site_address_revision_ck", sql`${t.addressRevision} > 0`),
  check(
    "site_pin_adjusted_ck",
    sql`(
      ${t.pinAdjusted} = false
      or (
        ${t.addressMode} = 'selected'
        and ${t.geocodeSource} = 'geoapify'
        and ${t.geocodePrecision} = 'house'
        and ${t.geocodePlaceId} is not null
      )
    ) is true`,
  ),
  check(
    "site_pin_confirmation_revision_ck",
    sql`(
      (${t.pinConfirmed} = false and ${t.pinConfirmedAddressRevision} is null)
      or (
        ${t.pinConfirmed} = true
        and ${t.pinConfirmedAddressRevision} is not null
        and ${t.pinConfirmedAddressRevision} = ${t.addressRevision}
        and ${t.addressMode} = 'selected'
        and ${t.addressFollowUpRequired} = false
        and ${t.formattedAddress} is not null
        and length(btrim(${t.formattedAddress})) between 1 and 200
        and ${t.street} is not null
        and length(btrim(${t.street})) between 1 and 200
        and ${t.houseNumber} is not null
        and length(btrim(${t.houseNumber})) between 1 and 30
        and ${t.postalCode} is not null
        and ${t.postalCode} ~ '^[0-9]{5}$'
        and ${t.city} is not null
        and length(btrim(${t.city})) between 1 and 200
        and ${t.country} = 'DE'
        and ${t.lat} is not null
        and ${t.lat} between -90 and 90
        and ${t.lng} is not null
        and ${t.lng} between -180 and 180
        and ${t.geocodePrecision} = 'house'
      )
    ) is true`,
  ),
  check(
    "site_intake_address_shape_ck",
    sql`(${t.addressMode} = 'legacy' and ${t.geocodePlaceId} is null) or (
      ${t.contactId} is not null
      and ${t.formattedAddress} is not null
      and length(btrim(${t.formattedAddress})) between 1 and 200
      and ${t.country} = 'DE'
      and ${t.lat} is not null
      and ${t.lat} between -90 and 90
      and ${t.lng} is not null
      and ${t.lng} between -180 and 180
      and ${t.geocodeSource} is not null
      and ${t.geocodePrecision} is not null
      and (
        (${t.addressMode} = 'selected'
          and ${t.addressFingerprint} is not null
          and octet_length(${t.addressFingerprint}) = 32
          and ${t.addressFingerprintVersion} = 1
          and ${t.addressFollowUpRequired} = false
          and ${t.street} is not null
          and length(btrim(${t.street})) between 1 and 200
          and ${t.houseNumber} is not null
          and length(btrim(${t.houseNumber})) between 1 and 30
          and ${t.postalCode} is not null
          and ${t.postalCode} ~ '^[0-9]{5}$'
          and ${t.city} is not null
          and length(btrim(${t.city})) between 1 and 200
          and ${t.geocodePrecision} = 'house'
          and (
            (${t.geocodeSource} = 'photon' and ${t.geocodePlaceId} is null)
            or (
              ${t.geocodeSource} = 'geoapify'
              and ${t.geocodePlaceId} is not null
              and length(btrim(${t.geocodePlaceId})) between 1 and 300
            )
          ))
        or
        (${t.addressMode} = 'regional_estimate'
          and ${t.addressFingerprint} is null
          and ${t.addressFingerprintVersion} is null
          and ${t.addressFollowUpRequired} = true
          and ${t.street} is null
          and ${t.houseNumber} is null
          and ${t.postalCode} is null
          and ${t.city} is null
          and ${t.geocodeSource} = 'regional_default'
          and ${t.geocodePlaceId} is null
          and ${t.geocodePrecision} = 'region')
      )
    ) is true`,
  ),
]);
