CREATE TABLE "workspace_planning_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"default_planning_mode" text DEFAULT '3d' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_planning_settings_mode_ck" CHECK ("workspace_planning_settings"."default_planning_mode" in ('quick', '2d', '3d')),
	CONSTRAINT "workspace_planning_settings_revision_ck" CHECK ("workspace_planning_settings"."revision" between 1 and 2147483647),
	CONSTRAINT "workspace_planning_settings_timestamps_ck" CHECK ("workspace_planning_settings"."updated_at" >= "workspace_planning_settings"."created_at"
        and isfinite("workspace_planning_settings"."created_at")
        and isfinite("workspace_planning_settings"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "offer_variant_revision" DROP CONSTRAINT "offer_variant_revision_version_ck";--> statement-breakpoint
ALTER TABLE "offer_variant_revision" DROP CONSTRAINT "offer_variant_revision_json_ck";--> statement-breakpoint
ALTER TABLE "workspace_planning_settings" ADD CONSTRAINT "workspace_planning_settings_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_planning_settings" ADD CONSTRAINT "workspace_planning_settings_updated_by_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_version_ck" CHECK ("offer_variant_revision"."schema_version" in ('offer-variant-snapshot.v1', 'offer-variant-snapshot.v2', 'offer-variant-snapshot.v3', 'offer-variant-snapshot.v4')
      and "offer_variant_revision"."canonicalization_version" = 'offer-jcs.v1');--> statement-breakpoint
ALTER TABLE "offer_variant_revision" ADD CONSTRAINT "offer_variant_revision_json_ck" CHECK (jsonb_typeof("offer_variant_revision"."revision_snapshot") = 'object'
      and "offer_variant_revision"."revision_snapshot"->>'schemaVersion' = "offer_variant_revision"."schema_version"
      and "offer_variant_revision"."revision_snapshot"->>'canonicalizationVersion' = "offer_variant_revision"."canonicalization_version"
      and "offer_variant_revision"."revision_snapshot"->>'workspaceId' = "offer_variant_revision"."workspace_id"::text
      and "offer_variant_revision"."revision_snapshot"->>'offerId' = "offer_variant_revision"."offer_id"::text
      and "offer_variant_revision"."revision_snapshot"->>'variantId' = "offer_variant_revision"."variant_id"::text
      and ("offer_variant_revision"."revision_snapshot"->>'revision')::integer = "offer_variant_revision"."revision"
      and "offer_variant_revision"."revision_snapshot"->>'snapshotSha256' = encode("offer_variant_revision"."snapshot_sha256", 'hex')
      and jsonb_typeof("offer_variant_revision"."revision_snapshot"->'sections') = 'array'
      and jsonb_array_length("offer_variant_revision"."revision_snapshot"->'sections') between 1 and 25
      and (
        ("offer_variant_revision"."schema_version" = 'offer-variant-snapshot.v4'
          and "offer_variant_revision"."revision_snapshot" ? 'planningMode'
          and jsonb_typeof("offer_variant_revision"."revision_snapshot"->'planningMode') = 'string'
          and "offer_variant_revision"."revision_snapshot"->>'planningMode' in ('quick', '2d', '3d'))
        or
        ("offer_variant_revision"."schema_version" in ('offer-variant-snapshot.v1', 'offer-variant-snapshot.v2', 'offer-variant-snapshot.v3')
          and not ("offer_variant_revision"."revision_snapshot" ? 'planningMode'))
      ));--> statement-breakpoint

-- F3.1: interne Workspace-Einstellungen. Die Rollenwahrheit wird aus der
-- Membership gelesen; malformed Capabilities und External-Mitglieder bleiben
-- fail-closed. Schreiben darf ausschliesslich ein interner Admin.
CREATE FUNCTION public._f301_actor_planning_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f301_actor_role$
DECLARE
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  actor_id := public.app_actor_id();
  IF actor_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id
   LIMIT 1;
  IF NOT FOUND
     OR actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) <> 'object'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_each(actor_capabilities) AS capability(key, value)
        WHERE pg_catalog.jsonb_typeof(capability.value) <> 'boolean'
     )
     OR (
       actor_capabilities ? 'external_only'
       AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
     ) THEN
    RETURN NULL;
  END IF;
  RETURN actor_role;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$f301_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._f301_actor_can_read_planning(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f301_actor_read$
  SELECT COALESCE(
    public._f301_actor_planning_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$f301_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._f301_actor_can_write_planning(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f301_actor_write$
  SELECT COALESCE(
    public._f301_actor_planning_role(requested_workspace_id) = 'admin',
    false
  )
$f301_actor_write$;--> statement-breakpoint

ALTER TABLE public.workspace_planning_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workspace_planning_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.workspace_planning_settings
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

DO $f301_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_planning_settings AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._f301_actor_can_read_planning(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_planning_settings_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_planning_settings AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._f301_actor_can_write_planning(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_planning_settings_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_planning_settings AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._f301_actor_can_write_planning(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_planning_settings_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_planning_settings AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'workspace_planning_settings_actor_delete', actor_policy_role
  );
END
$f301_actor_policies$;--> statement-breakpoint

CREATE TRIGGER workspace_planning_settings_no_truncate
BEFORE TRUNCATE ON public.workspace_planning_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- F3.1: eine laufende bzw. terminal gebundene Signatur sperrt nur den
-- revisionsgebundenen Varianteninhalt. Zahlart, Primaer-Markierung und
-- optionale Bundles bleiben revisionslos und duerfen fortgeschrieben werden.
DO $f301_offer_guard_owner_prepare$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app <> 'app_owner' THEN
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    GRANT SELECT ON public.signature_request, public.erasure_tombstone TO app_owner;
    ALTER FUNCTION public.guard_offer_erasure_mutation() OWNER TO app_owner;
  END IF;
END
$f301_offer_guard_owner_prepare$;--> statement-breakpoint
SET ROLE app_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_offer_erasure_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m2_01_offer_erasure_guard$
DECLARE
  caller_actor_setting text := pg_catalog.current_setting('app.actor_id', true);
  erasure_setting text;
  erasure_operation uuid;
  graph_key text;
  old_row jsonb;
BEGIN
  -- PG18 verlangt fuer unbekannte Custom-GUCs in proconfig ein separates
  -- Parameter-ACL. Die engere Alternative setzt den Actor nur waehrend des
  -- owner-gekapselten Triggerlaufs und stellt ihn auf jedem Pfad wieder her.
  PERFORM pg_catalog.set_config('app.actor_id', '', true);
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'offer' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at', 'total_price_override_net_cents']::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at', 'total_price_override_net_cents']::text[]) THEN
        RAISE EXCEPTION 'offer ist immutable; nur updated_at darf fortgeschrieben werden';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer.updated_at muss monoton sein';
      END IF;
      PERFORM pg_catalog.set_config('app.actor_id', caller_actor_setting, true);
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_variant' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY[
            'current_revision', 'name', 'description', 'updated_at',
            'is_primary', 'optional_bundles', 'payment_option_id'
          ]::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'current_revision', 'name', 'description', 'updated_at',
             'is_primary', 'optional_bundles', 'payment_option_id'
           ]::text[]) THEN
        RAISE EXCEPTION 'offer_variant: stabile Identitaet ist immutable';
      END IF;
      IF (
        NEW.current_revision IS DISTINCT FROM OLD.current_revision
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.description IS DISTINCT FROM OLD.description
      ) AND EXISTS (
        SELECT 1
          FROM public.signature_request AS request_record
         WHERE request_record.workspace_id = OLD.workspace_id
           AND request_record.offer_id = OLD.offer_id
           AND request_record.variant_id = OLD.id
           AND (
             request_record.status IN ('signed', 'revoked_by_customer')
             OR (
               request_record.status = 'pending'
               AND request_record.expires_at > pg_catalog.statement_timestamp()
             )
           )
      ) THEN
        RAISE EXCEPTION 'offer_variant: signaturgebundener Inhalt ist gesperrt'
          USING ERRCODE = '23514';
      END IF;
      IF (NEW.current_revision IS DISTINCT FROM OLD.current_revision
          AND NEW.current_revision <> OLD.current_revision + 1)
         OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer_variant: Revision und updated_at muessen monoton fortschreiten';
      END IF;
      PERFORM pg_catalog.set_config('app.actor_id', caller_actor_setting, true);
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_number_series' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY['last_sequence', 'updated_at']::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'last_sequence', 'updated_at'
           ]::text[])
         OR NEW.last_sequence <> OLD.last_sequence + 1
         OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer_number_series darf nur monoton um eins fortschreiten';
      END IF;
      PERFORM pg_catalog.set_config('app.actor_id', caller_actor_setting, true);
      RETURN NEW;
    ELSIF TG_TABLE_NAME = 'offer_mutation_rate_window' THEN
      IF (pg_catalog.to_jsonb(NEW) - ARRAY['attempts', 'updated_at']::text[])
           IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY[
             'attempts', 'updated_at'
           ]::text[])
         OR NEW.attempts <> OLD.attempts + 1
         OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'offer_mutation_rate_window darf nur monoton um eins fortschreiten';
      END IF;
      PERFORM pg_catalog.set_config('app.actor_id', caller_actor_setting, true);
      RETURN NEW;
    ELSE
      RAISE EXCEPTION '% ist immutable; UPDATE ist verboten', TG_TABLE_NAME;
    END IF;
  ELSIF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION '% ist immutable; UPDATE ist verboten', TG_TABLE_NAME;
  END IF;

  graph_key := CASE TG_TABLE_NAME
    WHEN 'offer' THEN 'offerIds'
    WHEN 'offer_variant' THEN 'offerVariantIds'
    WHEN 'offer_variant_revision' THEN 'offerVariantRevisionIds'
    WHEN 'offer_variant_section' THEN 'offerVariantSectionIds'
    WHEN 'offer_bom_line' THEN 'offerBomLineIds'
    ELSE NULL
  END;
  IF graph_key IS NULL THEN
    RAISE EXCEPTION 'offer erasure guard: unbekannte Tabelle %', TG_TABLE_NAME;
  END IF;

  erasure_setting := pg_catalog.current_setting('app.erasure_operation_id', true);
  BEGIN
    erasure_operation := NULLIF(erasure_setting, '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  old_row := pg_catalog.to_jsonb(OLD);
  IF erasure_operation IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = (old_row->>'workspace_id')::uuid
       AND tombstone.graph_ids->graph_key ? (old_row->>'id')
  ) THEN
    PERFORM pg_catalog.set_config('app.actor_id', caller_actor_setting, true);
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%: DELETE ist nur im Erasurevertrag erlaubt', TG_TABLE_NAME;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.actor_id', caller_actor_setting, true);
  RAISE;
END
$m2_01_offer_erasure_guard$;--> statement-breakpoint

RESET ROLE;--> statement-breakpoint
DO $f301_offer_guard_owner_restore$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app <> 'app_owner' THEN
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f301_offer_guard_owner_restore$;--> statement-breakpoint

-- Direkte SQL-Pfade muessen dieselbe exakte Variantenrevision binden wie
-- Service und Token-Kapseln. FOR UPDATE schliesst die Signatur-vs.-Revision-
-- Race auch fuer analoge und rollenlose Signaturen.
CREATE OR REPLACE FUNCTION public._m204_guard_signature_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m204_request_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m204_erasure_scrub_allowed(OLD.workspace_id, OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'signature_request DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT public._m204_actor_can_write_signatures(NEW.workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'signature_request verlangt einen internen Editor oder Admin'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'signature_request Projekt-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.offer AS offer_record
     WHERE offer_record.workspace_id = NEW.workspace_id
       AND offer_record.id = NEW.offer_id
       AND offer_record.project_id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'signature_request Offer-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.offer_issuance AS issuance_record
     WHERE issuance_record.workspace_id = NEW.workspace_id
       AND issuance_record.id = NEW.issuance_id
       AND issuance_record.offer_id = NEW.offer_id
       AND issuance_record.project_id = NEW.project_id
       AND issuance_record.variant_id = NEW.variant_id
       AND issuance_record.variant_revision_id = NEW.variant_revision_id
       AND issuance_record.state = 'ready_for_approval'
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'signature_request Ausstellungsfassung fehlt oder ist nicht freigegeben'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.offer_variant AS variant_record
      JOIN public.offer_variant_revision AS revision_record
        ON revision_record.workspace_id = variant_record.workspace_id
       AND revision_record.offer_id = variant_record.offer_id
       AND revision_record.variant_id = variant_record.id
       AND revision_record.revision = variant_record.current_revision
     WHERE variant_record.workspace_id = NEW.workspace_id
       AND variant_record.offer_id = NEW.offer_id
       AND variant_record.id = NEW.variant_id
       AND revision_record.id = NEW.variant_revision_id
     FOR UPDATE OF variant_record;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'signature_request Variantenrevision ist nicht mehr aktuell'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'pending'
       OR NEW.created_by IS DISTINCT FROM actor_id
       OR NEW.signer_name IS NOT NULL
       OR NEW.signed_variant_id IS NOT NULL
       OR NEW.signed_at IS NOT NULL
       OR NEW.withdrawn_at IS NOT NULL
       OR NEW.withdrawn_by IS NOT NULL
       OR NEW.withdrawal_reason IS NOT NULL
       OR NEW.revoked_by_customer_at IS NOT NULL
       OR NEW.expires_at <= mutation_time THEN
      RAISE EXCEPTION 'signature_request Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
     OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.variant_revision_id IS DISTINCT FROM OLD.variant_revision_id
     OR NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'signature_request immutable Bindung verletzt'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.status = 'signed' THEN
      IF actor_id IS NOT NULL
         AND NOT public._m204_actor_can_write_signatures(NEW.workspace_id) THEN
        RAISE EXCEPTION 'signature_request Signatur verlangt Token-Pfad oder internen Editor'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.expires_at <= mutation_time THEN
        RAISE EXCEPTION 'signature_request ist abgelaufen'
          USING ERRCODE = '23514';
      END IF;
      PERFORM 1
        FROM public.offer_variant AS variant_record
        JOIN public.offer_variant_revision AS revision_record
          ON revision_record.workspace_id = variant_record.workspace_id
         AND revision_record.offer_id = variant_record.offer_id
         AND revision_record.variant_id = variant_record.id
         AND revision_record.revision = variant_record.current_revision
       WHERE variant_record.workspace_id = OLD.workspace_id
         AND variant_record.offer_id = OLD.offer_id
         AND variant_record.id = OLD.variant_id
         AND revision_record.id = OLD.variant_revision_id
       FOR UPDATE OF variant_record;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'signature_request Variantenrevision ist nicht mehr aktuell'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.signed_at IS NULL
         OR NEW.signer_name IS NULL
         OR NEW.signed_variant_id IS DISTINCT FROM OLD.variant_id
         OR NEW.withdrawn_at IS NOT NULL
         OR NEW.withdrawn_by IS NOT NULL
         OR NEW.withdrawal_reason IS NOT NULL
         OR NEW.revoked_by_customer_at IS NOT NULL THEN
        RAISE EXCEPTION 'signature_request Signatur-Vertrag verletzt'
          USING ERRCODE = '23514';
      END IF;
      NEW.signed_at := mutation_time;
      RETURN NEW;
    END IF;
    IF NEW.status = 'expired' THEN
      IF actor_id IS NOT NULL THEN
        RAISE EXCEPTION 'signature_request Ablauf verlangt den Token-Pfad'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.expires_at > mutation_time THEN
        RAISE EXCEPTION 'signature_request ist noch nicht abgelaufen'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.signed_at IS NOT NULL
         OR NEW.signer_name IS NOT NULL
         OR NEW.signed_variant_id IS NOT NULL
         OR NEW.withdrawn_at IS NOT NULL
         OR NEW.withdrawn_by IS NOT NULL
         OR NEW.withdrawal_reason IS NOT NULL
         OR NEW.revoked_by_customer_at IS NOT NULL THEN
        RAISE EXCEPTION 'signature_request Ablauf-Vertrag verletzt'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'withdrawn' THEN
      IF NOT public._m204_actor_can_write_signatures(NEW.workspace_id)
         OR actor_id IS NULL THEN
        RAISE EXCEPTION 'signature_request Widerruf verlangt einen internen Editor oder Admin'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.expires_at <= mutation_time THEN
        RAISE EXCEPTION 'signature_request ist abgelaufen und kann nicht widerrufen werden'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.withdrawn_by IS DISTINCT FROM actor_id
         OR NEW.withdrawn_at IS NULL
         OR NEW.withdrawal_reason IS NULL
         OR NEW.signed_at IS NOT NULL
         OR NEW.signer_name IS NOT NULL
         OR NEW.signed_variant_id IS NOT NULL
         OR NEW.revoked_by_customer_at IS NOT NULL THEN
        RAISE EXCEPTION 'signature_request Widerruf-Vertrag verletzt'
          USING ERRCODE = '23514';
      END IF;
      NEW.withdrawn_at := mutation_time;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'signature_request ungueltiger Uebergang aus pending'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'signed' AND NEW.status = 'revoked_by_customer' THEN
    IF actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'signature_request Kunden-Widerruf verlangt den Token-Pfad'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.signer_name IS DISTINCT FROM OLD.signer_name
       OR NEW.signed_variant_id IS DISTINCT FROM OLD.signed_variant_id
       OR NEW.withdrawn_at IS NOT NULL
       OR NEW.withdrawn_by IS NOT NULL
       OR NEW.withdrawal_reason IS NOT NULL
       OR NEW.revoked_by_customer_at IS NULL
       OR NEW.revoked_by_customer_at <= OLD.signed_at
       OR NEW.revoked_by_customer_at > OLD.signed_at + interval '14 days' THEN
      RAISE EXCEPTION 'signature_request Kunden-Widerruf-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'signature_request ist terminal und nicht umkehrbar'
    USING ERRCODE = '23514';
END
$m204_request_guard$;--> statement-breakpoint

-- Seit 0064 gehoert der rollenlose Signatur-DEFINER auch im Ein-Rollen-
-- Testmodus app_owner. Fuer CREATE OR REPLACE wird die Rolle eng begrenzt
-- wieder setzbar gemacht; danach wird SET sofort erneut entzogen.
DO $f301_signature_owner_prepare$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app <> 'app_owner' THEN
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    GRANT SELECT, UPDATE ON public.offer_variant TO app_owner;
    GRANT SELECT ON public.offer_variant_revision TO app_owner;
  END IF;
END
$f301_signature_owner_prepare$;--> statement-breakpoint
SET ROLE app_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.sign_signature_by_token(
  requested_token_hash bytea,
  requested_mode text,
  requested_artifact_mime_type text,
  requested_artifact_bytes bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_sign_token$
DECLARE
  request_row public.signature_request%ROWTYPE;
  located_workspace_id uuid;
  located_request_id uuid;
  resolved_signer_name text;
  signing_time timestamptz := pg_catalog.statement_timestamp();
  attestation_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.signature_request_id
    INTO located_workspace_id, located_request_id
    FROM public.signature_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT * INTO request_row
    FROM public.signature_request
   WHERE workspace_id = located_workspace_id
     AND id = located_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF request_row.status = 'signed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_signed', 'requestId', request_row.id
    );
  END IF;
  IF request_row.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', request_row.status, 'requestId', request_row.id
    );
  END IF;
  IF request_row.expires_at <= signing_time THEN
    UPDATE public.signature_request
       SET status = 'expired'
     WHERE id = request_row.id AND status = 'pending';
    RETURN pg_catalog.jsonb_build_object(
      'status', 'expired', 'requestId', request_row.id
    );
  END IF;

  PERFORM 1
    FROM public.offer_variant AS variant_record
    JOIN public.offer_variant_revision AS revision_record
      ON revision_record.workspace_id = variant_record.workspace_id
     AND revision_record.offer_id = variant_record.offer_id
     AND revision_record.variant_id = variant_record.id
     AND revision_record.revision = variant_record.current_revision
   WHERE variant_record.workspace_id = request_row.workspace_id
     AND variant_record.offer_id = request_row.offer_id
     AND variant_record.id = request_row.variant_id
     AND revision_record.id = request_row.variant_revision_id
   FOR UPDATE OF variant_record;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'variant_revision_changed'
    );
  END IF;

  SELECT contact_record.display_name INTO resolved_signer_name
    FROM public.offer AS offer_record
    JOIN public.contact AS contact_record
      ON contact_record.workspace_id = offer_record.workspace_id
     AND contact_record.id = offer_record.contact_id
   WHERE offer_record.workspace_id = request_row.workspace_id
     AND offer_record.id = request_row.offer_id
   LIMIT 1;
  IF resolved_signer_name IS NULL OR pg_catalog.btrim(resolved_signer_name) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'signer_missing'
    );
  END IF;

  UPDATE public.signature_request
     SET status = 'signed',
         signer_name = resolved_signer_name,
         signed_variant_id = variant_id,
         signed_at = signing_time
   WHERE id = request_row.id AND status = 'pending';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'transition_conflict'
    );
  END IF;

  INSERT INTO public.signature_attestation (
    id, workspace_id, signature_request_id, mode, signer_name,
    content_sha256, artifact_mime_type, artifact_sha256,
    artifact_size_bytes, artifact_bytes
  ) VALUES (
    attestation_id, request_row.workspace_id, request_row.id, requested_mode,
    resolved_signer_name, request_row.content_sha256,
    requested_artifact_mime_type,
    CASE WHEN requested_artifact_bytes IS NULL THEN NULL
         ELSE pg_catalog.sha256(requested_artifact_bytes) END,
    CASE WHEN requested_artifact_bytes IS NULL THEN NULL
         ELSE pg_catalog.octet_length(requested_artifact_bytes) END,
    requested_artifact_bytes
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'signed',
    'requestId', request_row.id,
    'offerId', request_row.offer_id,
    'attestationId', attestation_id,
    'signerName', resolved_signer_name,
    'signedAt', signing_time
  );
END
$m204_sign_token$;--> statement-breakpoint

RESET ROLE;--> statement-breakpoint
DO $f301_signature_owner_restore$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app <> 'app_owner' THEN
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f301_signature_owner_restore$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.create_signature_request(
  requested_workspace_id uuid,
  requested_offer_id uuid,
  requested_variant_id uuid,
  requested_ttl_days integer,
  requested_token_hash bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_create_request$
DECLARE
  located_project_id uuid;
  issuance_row public.offer_issuance%ROWTYPE;
  existing_request public.signature_request%ROWTYPE;
  approval_count integer;
  withdrawal_found boolean;
  expires_at timestamptz;
  new_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF public.app_actor_id() IS NULL
     OR NOT public._m204_actor_can_write_signatures(requested_workspace_id) THEN
    RAISE EXCEPTION 'signature_request verlangt internen Editor oder Admin'
      USING ERRCODE = '42501';
  END IF;
  IF requested_ttl_days < 1 OR requested_ttl_days > 60 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_ttl'
    );
  END IF;
  IF pg_catalog.octet_length(requested_token_hash) <> 32 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_binding'
    );
  END IF;

  -- Kanonische Offer-Mutationsreihenfolge: project vor offer vor variant.
  -- Die spaeteren FK-Checks duerfen keinen bisher ungesperrten Vorlaeufer
  -- nachfordern, waehrend ein paralleler Varianten-Write rueckwaerts wartet.
  SELECT offer_record.project_id INTO located_project_id
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id = requested_offer_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = located_project_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM 1
    FROM public.offer AS offer_record
   WHERE offer_record.workspace_id = requested_workspace_id
     AND offer_record.id = requested_offer_id
     AND offer_record.project_id = located_project_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO issuance_row
    FROM public.offer_issuance
   WHERE workspace_id = requested_workspace_id
     AND offer_id = requested_offer_id
     AND variant_id = requested_variant_id
     AND state = 'ready_for_approval'
   ORDER BY created_at DESC, id DESC
   LIMIT 1
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT pg_catalog.count(*) INTO approval_count
    FROM public.offer_issuance_approval
   WHERE workspace_id = requested_workspace_id
     AND issuance_id = issuance_row.id;
  SELECT EXISTS (
    SELECT 1 FROM public.offer_issuance_withdrawal
     WHERE workspace_id = requested_workspace_id
       AND issuance_id = issuance_row.id
  ) INTO withdrawal_found;

  IF approval_count < 2 OR withdrawal_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'issuance_not_approved'
    );
  END IF;
  IF pg_catalog.octet_length(issuance_row.artifact_bytes) = 0
     OR issuance_row.artifact_bytes IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'artifact_missing'
    );
  END IF;

  PERFORM 1
    FROM public.offer_variant AS variant_record
    JOIN public.offer_variant_revision AS revision_record
      ON revision_record.workspace_id = variant_record.workspace_id
     AND revision_record.offer_id = variant_record.offer_id
     AND revision_record.variant_id = variant_record.id
     AND revision_record.revision = variant_record.current_revision
   WHERE variant_record.workspace_id = requested_workspace_id
     AND variant_record.offer_id = requested_offer_id
     AND variant_record.id = requested_variant_id
     AND revision_record.id = issuance_row.variant_revision_id
   FOR UPDATE OF variant_record;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'variant_revision_changed'
    );
  END IF;

  SELECT * INTO existing_request
    FROM public.signature_request
   WHERE workspace_id = requested_workspace_id
     AND issuance_id = issuance_row.id
   LIMIT 1;
  IF FOUND THEN
    -- Nur ein echter Retry desselben geheimen Inputs darf replayen. Ein neu
    -- erzeugter Token darf nie fuer einen Locator des alten Hashes ausgegeben
    -- werden; der Aufrufer erhaelt stattdessen einen stabilen Konflikt.
    IF existing_request.token_hash IS DISTINCT FROM requested_token_hash THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'conflict', 'code', 'request_already_exists'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', existing_request.status,
      'requestId', existing_request.id,
      'offerId', existing_request.offer_id,
      'issuanceId', existing_request.issuance_id,
      'expiresAt', existing_request.expires_at,
      'replayed', true
    );
  END IF;

  expires_at := pg_catalog.statement_timestamp()
    + (requested_ttl_days * interval '1 day');

  INSERT INTO public.signature_request (
    id, workspace_id, project_id, offer_id, variant_id, variant_revision_id,
    issuance_id, status, token_hash, expires_at, content_sha256, created_by
  ) VALUES (
    new_id, requested_workspace_id, issuance_row.project_id, requested_offer_id,
    requested_variant_id, issuance_row.variant_revision_id, issuance_row.id,
    'pending', requested_token_hash, expires_at,
    pg_catalog.sha256(issuance_row.artifact_bytes),
    public.app_actor_id()
  );

  INSERT INTO public.signature_token_locator (
    token_hash, workspace_id, signature_request_id
  ) VALUES (
    requested_token_hash, requested_workspace_id, new_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'pending',
    'requestId', new_id,
    'offerId', requested_offer_id,
    'issuanceId', issuance_row.id,
    'expiresAt', expires_at,
    'replayed', false
  );
END
$m204_create_request$;
