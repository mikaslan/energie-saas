ALTER TABLE "site" DROP CONSTRAINT "site_intake_address_shape_ck";--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "geocode_place_id" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "address_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "pin_confirmed_address_revision" integer;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "pin_adjusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- M1-06 bindet bestehende Pin-Bestaetigungen erstmals an eine positive
-- Adressrevision. `site` steht unter FORCE RLS; der Migrations-Owner braucht
-- fuer diesen eng begrenzten, schemaweiten Backfill daher dieselbe explizite
-- Ausnahme wie die bisherigen Tenant-Backfills. ENABLE RLS bleibt aktiv und
-- FORCE wird noch vor Aktivierung der neuen Constraints wiederhergestellt.
ALTER TABLE public.site NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE public.site
SET pin_confirmed_address_revision = address_revision
WHERE pin_confirmed = true
  AND address_mode = 'selected'
  AND contact_id is not null
  AND address_fingerprint is not null
  AND octet_length(address_fingerprint) = 32
  AND address_fingerprint_version = 1
  AND address_follow_up_required = false
  AND formatted_address is not null
  AND length(btrim(formatted_address)) between 1 and 200
  AND street is not null
  AND length(btrim(street)) between 1 and 200
  AND house_number is not null
  AND length(btrim(house_number)) between 1 and 30
  AND postal_code is not null
  AND postal_code ~ '^[0-9]{5}$'
  AND city is not null
  AND length(btrim(city)) between 1 and 200
  AND country = 'DE'
  AND lat is not null
  AND lat between -90 and 90
  AND lng is not null
  AND lng between -180 and 180
  AND geocode_source = 'photon'
  AND geocode_precision = 'house'
  AND geocode_place_id is null;--> statement-breakpoint
UPDATE public.site
SET pin_confirmed = false,
    pin_confirmed_address_revision = null
WHERE pin_confirmed = true
  AND pin_confirmed_address_revision is null;--> statement-breakpoint
ALTER TABLE public.site FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "site" ADD CONSTRAINT "site_address_revision_ck" CHECK ("site"."address_revision" > 0);--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_pin_adjusted_ck" CHECK ((
      "site"."pin_adjusted" = false
      or (
        "site"."address_mode" = 'selected'
        and "site"."geocode_source" = 'geoapify'
        and "site"."geocode_precision" = 'house'
        and "site"."geocode_place_id" is not null
      )
    ) is true);--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_pin_confirmation_revision_ck" CHECK ((
      ("site"."pin_confirmed" = false and "site"."pin_confirmed_address_revision" is null)
      or (
        "site"."pin_confirmed" = true
        and "site"."pin_confirmed_address_revision" is not null
        and "site"."pin_confirmed_address_revision" = "site"."address_revision"
        and "site"."address_mode" = 'selected'
        and "site"."address_follow_up_required" = false
        and "site"."formatted_address" is not null
        and length(btrim("site"."formatted_address")) between 1 and 200
        and "site"."street" is not null
        and length(btrim("site"."street")) between 1 and 200
        and "site"."house_number" is not null
        and length(btrim("site"."house_number")) between 1 and 30
        and "site"."postal_code" is not null
        and "site"."postal_code" ~ '^[0-9]{5}$'
        and "site"."city" is not null
        and length(btrim("site"."city")) between 1 and 200
        and "site"."country" = 'DE'
        and "site"."lat" is not null
        and "site"."lat" between -90 and 90
        and "site"."lng" is not null
        and "site"."lng" between -180 and 180
        and "site"."geocode_precision" = 'house'
      )
    ) is true);--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_intake_address_shape_ck" CHECK (("site"."address_mode" = 'legacy' and "site"."geocode_place_id" is null) or (
      "site"."contact_id" is not null
      and "site"."formatted_address" is not null
      and length(btrim("site"."formatted_address")) between 1 and 200
      and "site"."country" = 'DE'
      and "site"."lat" is not null
      and "site"."lat" between -90 and 90
      and "site"."lng" is not null
      and "site"."lng" between -180 and 180
      and "site"."geocode_source" is not null
      and "site"."geocode_precision" is not null
      and (
        ("site"."address_mode" = 'selected'
          and "site"."address_fingerprint" is not null
          and octet_length("site"."address_fingerprint") = 32
          and "site"."address_fingerprint_version" = 1
          and "site"."address_follow_up_required" = false
          and "site"."street" is not null
          and length(btrim("site"."street")) between 1 and 200
          and "site"."house_number" is not null
          and length(btrim("site"."house_number")) between 1 and 30
          and "site"."postal_code" is not null
          and "site"."postal_code" ~ '^[0-9]{5}$'
          and "site"."city" is not null
          and length(btrim("site"."city")) between 1 and 200
          and "site"."geocode_precision" = 'house'
          and (
            ("site"."geocode_source" = 'photon' and "site"."geocode_place_id" is null)
            or (
              "site"."geocode_source" = 'geoapify'
              and "site"."geocode_place_id" is not null
              and length(btrim("site"."geocode_place_id")) between 1 and 300
            )
          ))
        or
        ("site"."address_mode" = 'regional_estimate'
          and "site"."address_fingerprint" is null
          and "site"."address_fingerprint_version" is null
          and "site"."address_follow_up_required" = true
          and "site"."street" is null
          and "site"."house_number" is null
          and "site"."postal_code" is null
          and "site"."city" is null
          and "site"."geocode_source" = 'regional_default'
          and "site"."geocode_place_id" is null
          and "site"."geocode_precision" = 'region')
      )
    ) is true);
