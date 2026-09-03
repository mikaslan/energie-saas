ALTER TABLE "contact" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "salutation" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "is_business" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "email_secondary" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "phone_mobile" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "phone_reachability" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "address_street" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "address_house_number" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "address_country" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "marketing_consent_policy_version" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "marketing_consent_text" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "marketing_consent_data_protection_link" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "utm_medium" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "utm_term" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "utm_content" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_marketing_consent_version_ck" CHECK ("contact"."marketing_consent" = false or "contact"."marketing_consent_policy_version" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_first_name_ck" CHECK (length(btrim("contact"."first_name")) between 1 and 200);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_last_name_ck" CHECK (length(btrim("contact"."last_name")) between 1 and 200);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_salutation_ck" CHECK ("contact"."salutation" is null or "contact"."salutation" in ('female', 'male', 'diverse', 'family', 'business'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_is_business_ck" CHECK ("contact"."salutation" is distinct from 'business' or "contact"."is_business" = true);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_email_secondary_ck" CHECK ("contact"."email_secondary" is null or (
        "contact"."email_secondary" = lower(btrim("contact"."email_secondary"))
        and "contact"."email_secondary" ~ '^[^@[:space:]]+@[^@[:space:]]+$'
        and length("contact"."email_secondary") between 3 and 254
      ));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_phone_mobile_ck" CHECK ("contact"."phone_mobile" is null or "contact"."phone_mobile" ~ '^\+[1-9][0-9]{1,14}$');--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_phone_reachability_ck" CHECK ("contact"."phone_reachability" is null or "contact"."phone_reachability" in ('morning', 'afternoon', 'evening', 'fulltime', 'weekend_only', 'email_only'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_address_street_ck" CHECK ("contact"."address_street" is null or length(btrim("contact"."address_street")) between 1 and 200);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_address_house_number_ck" CHECK ("contact"."address_house_number" is null or length(btrim("contact"."address_house_number")) between 1 and 30);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_address_postal_code_ck" CHECK ("contact"."address_postal_code" is null or (
        (
          ("contact"."address_country" = 'DE' or "contact"."address_country" is null)
          and "contact"."address_postal_code" ~ '^[0-9]{5}$'
        ) or (
          "contact"."address_country" is not null
          and "contact"."address_country" <> 'DE'
          and length(btrim("contact"."address_postal_code")) between 1 and 20
        )
      ));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_address_city_ck" CHECK ("contact"."address_city" is null or length(btrim("contact"."address_city")) between 1 and 200);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_address_country_ck" CHECK ("contact"."address_country" is null or length(btrim("contact"."address_country")) between 1 and 20);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_marketing_consent_policy_version_ck" CHECK ("contact"."marketing_consent_policy_version" is null or length(btrim("contact"."marketing_consent_policy_version")) between 1 and 100);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_marketing_consent_data_protection_link_ck" CHECK ("contact"."marketing_consent_data_protection_link" is null or "contact"."marketing_consent_data_protection_link" ~ '^https://');--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_utm_source_ck" CHECK ("contact"."utm_source" is null or length(btrim("contact"."utm_source")) between 1 and 1000);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_utm_medium_ck" CHECK ("contact"."utm_medium" is null or length(btrim("contact"."utm_medium")) between 1 and 1000);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_utm_campaign_ck" CHECK ("contact"."utm_campaign" is null or length(btrim("contact"."utm_campaign")) between 1 and 1000);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_utm_term_ck" CHECK ("contact"."utm_term" is null or length(btrim("contact"."utm_term")) between 1 and 1000);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_utm_content_ck" CHECK ("contact"."utm_content" is null or length(btrim("contact"."utm_content")) between 1 and 1000);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_revision_ck" CHECK ("contact"."revision" between 1 and 2147483647);--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-14: geteilte Namens-Normalisierung (Vertragsteil, ADR 0020 Entsch. 7).
-- Determinismus: btrim + Whitespace-Kollabierung auf genau ein Leerzeichen,
-- Split am ersten Lauf, Eintoken => first = last = token. Wird vom Backfill
-- verwendet; der TS-Vertrag contactNameSplitV1 (lib/db/schema/contact-name-split.ts)
-- implementiert exakt dieselben Regeln und ist in M114-CONTRACT-07 gepinnt.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.contact_name_split_v1(raw_name text)
RETURNS TABLE(first_name text, last_name text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $m114_name_split$
  WITH normalized AS (
    SELECT pg_catalog.regexp_replace(
             pg_catalog.btrim(raw_name), '[ \t\r\n]+', ' ', 'g'
           ) AS collapsed
  )
  SELECT pg_catalog.split_part(normalized.collapsed, ' ', 1),
         CASE
           WHEN pg_catalog.strpos(normalized.collapsed, ' ') > 0
             THEN pg_catalog.btrim(pg_catalog.substr(
               normalized.collapsed,
               pg_catalog.strpos(normalized.collapsed, ' ') + 1
             ))
           ELSE normalized.collapsed
         END
    FROM normalized
$m114_name_split$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.contact_name_split_v1(text) FROM PUBLIC;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-14: deterministischer Backfill (Spec §4 / ADR 0020 Entsch. 7).
-- first_name/last_name sind nullable angelegt (expand) und werden erst nach
-- dem Backfill auf NOT NULL gesetzt (contract). Der Bestand liegt unter FORCE
-- RLS; nur der Tabellen-Owner sieht in diesem engen Fenster alle Zeilen.
-- ═══════════════════════════════════════════════════════════════════════
LOCK TABLE public.contact IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE public.contact NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
WITH split AS (
  SELECT contact_record.id,
         split.first_name,
         split.last_name
    FROM public.contact AS contact_record
   CROSS JOIN LATERAL
         public.contact_name_split_v1(contact_record.display_name) AS split
)
UPDATE public.contact AS contact_record
   SET first_name = split.first_name,
       last_name = split.last_name
  FROM split
 WHERE split.id = contact_record.id;--> statement-breakpoint
ALTER TABLE public.contact ALTER COLUMN "first_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.contact ALTER COLUMN "last_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.contact FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-14: Erasure-Scrub-Erweiterung (quellgepinnt, Muster 0039/0041).
-- Nur echte PII wird gescrubbt: first/last erhalten das Pseudonym
-- 'geloescht-<id>' (NOT NULL), alle nullable PII-Spalten werden genullt.
-- is_business, revision und phone_reachability bleiben unveraendert.
-- ═══════════════════════════════════════════════════════════════════════
DO $m114_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_contact_scrub constant text := $m114_old_contact_scrub$
  UPDATE public.contact AS contact_record
     SET display_name = 'geloescht-' || contact_record.id::text,
         email_primary = NULL, email_normalized = NULL, phone_raw = NULL,
         phone_e164 = NULL, marketing_consent = false,
         marketing_consent_at = NULL, marketing_consent_source = NULL,
         dedupe_review_required = false, deleted_at = erase_time,
         updated_at = erase_time
   WHERE contact_record.workspace_id = requested_workspace_id
     AND contact_record.id = requested_contact_id;
$m114_old_contact_scrub$;
  new_contact_scrub constant text := $m114_new_contact_scrub$
  UPDATE public.contact AS contact_record
     SET display_name = 'geloescht-' || contact_record.id::text,
         first_name = 'geloescht-' || contact_record.id::text,
         last_name = 'geloescht-' || contact_record.id::text,
         salutation = NULL,
         email_primary = NULL, email_normalized = NULL, email_secondary = NULL,
         phone_raw = NULL, phone_e164 = NULL, phone_mobile = NULL,
         address_street = NULL, address_house_number = NULL,
         address_postal_code = NULL, address_city = NULL, address_country = NULL,
         marketing_consent = false,
         marketing_consent_at = NULL, marketing_consent_source = NULL,
         marketing_consent_policy_version = NULL,
         marketing_consent_text = NULL,
         marketing_consent_data_protection_link = NULL,
         utm_source = NULL, utm_medium = NULL, utm_campaign = NULL,
         utm_term = NULL, utm_content = NULL,
         dedupe_review_required = false, deleted_at = erase_time,
         updated_at = erase_time
   WHERE contact_record.workspace_id = requested_workspace_id
     AND contact_record.id = requested_contact_id;
$m114_new_contact_scrub$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
           'hex'
         )
    INTO erase_source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'erase_inactive_lead'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-14 Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '891d9914094e8b0b9b42716813dd957f24301a048b95b91049e4d0f8029da3bb' THEN
    RAISE EXCEPTION 'M1-14 Erasure: unerwarteter M1-13-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_contact_scrub) = 0 THEN
    RAISE EXCEPTION 'M1-14 Erasure: gepinnter Contact-Scrub-Anker fehlt';
  END IF;
  upgraded_source := pg_catalog.replace(
    erase_source, old_contact_scrub, new_contact_scrub
  );
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION public.erase_inactive_lead('
    'requested_workspace_id uuid, requested_contact_id uuid, '
    'requested_operation_id uuid) '
    'RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER '
    'SET search_path = pg_catalog AS %L',
    upgraded_source
  );
END
$m114_erasure_upgrade$;--> statement-breakpoint

DO $m114_erasure_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public.contact_name_split_v1(text) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m114_erasure_acl$;