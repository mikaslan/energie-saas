CREATE TABLE "signature_attestation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"signature_request_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"signer_name" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_sha256" "bytea" NOT NULL,
	"signing_date" timestamp with time zone,
	"artifact_mime_type" text,
	"artifact_sha256" "bytea",
	"artifact_size_bytes" integer,
	"artifact_bytes" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_attestation_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "signature_attestation_ws_request_uq" UNIQUE("workspace_id","signature_request_id"),
	CONSTRAINT "signature_attestation_mode_ck" CHECK ("signature_attestation"."mode" in (
      'click', 'draw', 'analog'
    )),
	CONSTRAINT "signature_attestation_content_ck" CHECK (
      octet_length("signature_attestation"."content_sha256") = 32
      and length(btrim("signature_attestation"."signer_name")) between 1 and 200),
	CONSTRAINT "signature_attestation_artifact_ck" CHECK ((
      "signature_attestation"."artifact_mime_type" is null
      and "signature_attestation"."artifact_sha256" is null
      and "signature_attestation"."artifact_size_bytes" is null
      and "signature_attestation"."artifact_bytes" is null
      and "signature_attestation"."signing_date" is null
    ) or (
      "signature_attestation"."artifact_mime_type" in ('image/png', 'application/pdf', 'image/jpeg')
      and octet_length("signature_attestation"."artifact_sha256") = 32
      and "signature_attestation"."artifact_size_bytes" between 1 and 8388608
      and octet_length("signature_attestation"."artifact_bytes") = "signature_attestation"."artifact_size_bytes"
      and "signature_attestation"."artifact_sha256" = pg_catalog.sha256("signature_attestation"."artifact_bytes")
      and case
        when "signature_attestation"."mode" = 'draw' then
          "signature_attestation"."artifact_mime_type" = 'image/png'
          and "signature_attestation"."artifact_size_bytes" <= 524288
          and "signature_attestation"."signing_date" is null
        when "signature_attestation"."mode" = 'analog' then
          "signature_attestation"."artifact_mime_type" in ('application/pdf', 'image/jpeg')
          and "signature_attestation"."signing_date" is not null
        else false
      end
    )),
	CONSTRAINT "signature_attestation_click_shape_ck" CHECK (
      "signature_attestation"."mode" <> 'click' or (
        "signature_attestation"."artifact_mime_type" is null
        and "signature_attestation"."artifact_sha256" is null
        and "signature_attestation"."artifact_size_bytes" is null
        and "signature_attestation"."artifact_bytes" is null
        and "signature_attestation"."signing_date" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "signature_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_revision_id" uuid NOT NULL,
	"issuance_id" uuid NOT NULL,
	"payment_option_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"content_sha256" "bytea" NOT NULL,
	"signer_name" text,
	"signed_variant_id" uuid,
	"signed_payment_option_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" uuid,
	"withdrawal_reason" text,
	"revoked_by_customer_at" timestamp with time zone,
	CONSTRAINT "signature_request_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "signature_request_ws_issuance_uq" UNIQUE("workspace_id","issuance_id"),
	CONSTRAINT "signature_request_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "signature_request_status_ck" CHECK ("signature_request"."status" in (
      'pending', 'signed', 'expired', 'withdrawn', 'revoked_by_customer'
    )),
	CONSTRAINT "signature_request_hash_ck" CHECK (
      octet_length("signature_request"."token_hash") = 32
      and octet_length("signature_request"."content_sha256") = 32),
	CONSTRAINT "signature_request_expiry_ck" CHECK ("signature_request"."expires_at" > "signature_request"."created_at"),
	CONSTRAINT "signature_request_payment_ck" CHECK (
      "signature_request"."payment_option_id" is null
      and "signature_request"."signed_payment_option_id" is null),
	CONSTRAINT "signature_request_withdrawal_reason_ck" CHECK (
      "signature_request"."withdrawal_reason" is null or "signature_request"."withdrawal_reason" in (
        'content_error', 'recipient_error', 'commercial_error', 'other'
      )),
	CONSTRAINT "signature_request_shape_ck" CHECK (case "signature_request"."status"
      when 'pending' then
        "signature_request"."signer_name" is null
        and "signature_request"."signed_variant_id" is null
        and "signature_request"."signed_at" is null
        and "signature_request"."withdrawn_at" is null
        and "signature_request"."withdrawn_by" is null
        and "signature_request"."withdrawal_reason" is null
        and "signature_request"."revoked_by_customer_at" is null
      when 'signed' then
        "signature_request"."signer_name" is not null
        and "signature_request"."signed_variant_id" = "signature_request"."variant_id"
        and "signature_request"."signed_at" is not null
        and "signature_request"."withdrawn_at" is null
        and "signature_request"."withdrawn_by" is null
        and "signature_request"."withdrawal_reason" is null
        and "signature_request"."revoked_by_customer_at" is null
      when 'expired' then
        "signature_request"."signer_name" is null
        and "signature_request"."signed_variant_id" is null
        and "signature_request"."signed_at" is null
        and "signature_request"."withdrawn_at" is null
        and "signature_request"."withdrawn_by" is null
        and "signature_request"."withdrawal_reason" is null
        and "signature_request"."revoked_by_customer_at" is null
      when 'withdrawn' then
        "signature_request"."signer_name" is null
        and "signature_request"."signed_variant_id" is null
        and "signature_request"."signed_at" is null
        and "signature_request"."withdrawn_at" is not null
        and "signature_request"."withdrawn_by" is not null
        and "signature_request"."withdrawal_reason" is not null
        and "signature_request"."revoked_by_customer_at" is null
      when 'revoked_by_customer' then
        "signature_request"."signer_name" is not null
        and "signature_request"."signed_variant_id" = "signature_request"."variant_id"
        and "signature_request"."signed_at" is not null
        and "signature_request"."withdrawn_at" is null
        and "signature_request"."withdrawn_by" is null
        and "signature_request"."withdrawal_reason" is null
        and "signature_request"."revoked_by_customer_at" is not null
      else false end)
);
--> statement-breakpoint
CREATE TABLE "signature_view_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"signature_request_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_view_log_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "signature_attestation" ADD CONSTRAINT "signature_attestation_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_attestation" ADD CONSTRAINT "signature_attestation_request_fk" FOREIGN KEY ("workspace_id","signature_request_id") REFERENCES "public"."signature_request"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_variant_fk" FOREIGN KEY ("workspace_id","variant_id") REFERENCES "public"."offer_variant"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_variant_revision_fk" FOREIGN KEY ("workspace_id","variant_revision_id") REFERENCES "public"."offer_variant_revision"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_issuance_fk" FOREIGN KEY ("workspace_id","issuance_id") REFERENCES "public"."offer_issuance"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_withdrawn_by_fk" FOREIGN KEY ("workspace_id","withdrawn_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_view_log" ADD CONSTRAINT "signature_view_log_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_view_log" ADD CONSTRAINT "signature_view_log_request_fk" FOREIGN KEY ("workspace_id","signature_request_id") REFERENCES "public"."signature_request"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signature_attestation_ws_request_idx" ON "signature_attestation" USING btree ("workspace_id","signature_request_id","created_at","id");--> statement-breakpoint
CREATE INDEX "signature_request_ws_offer_idx" ON "signature_request" USING btree ("workspace_id","offer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "signature_request_ws_status_idx" ON "signature_request" USING btree ("workspace_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "signature_view_log_ws_request_idx" ON "signature_view_log" USING btree ("workspace_id","signature_request_id","viewed_at","id");
--> statement-breakpoint
CREATE TABLE "signature_token_locator" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"signature_request_id" uuid NOT NULL,
	CONSTRAINT "signature_token_locator_hash_ck" CHECK (octet_length("signature_token_locator"."token_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "signature_token_locator" ADD CONSTRAINT "signature_token_locator_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_token_locator" ADD CONSTRAINT "signature_token_locator_request_fk" FOREIGN KEY ("workspace_id","signature_request_id") REFERENCES "public"."signature_request"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
REVOKE ALL ON public.signature_token_locator FROM PUBLIC;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- M2-04: E-Signatur — Actor-Helfer, Mutationsguards, RLS, Token-Resolver,
--        Erasure-Graph-Erweiterung (quellgepinnt).
-- ═══════════════════════════════════════════════════════════════════════
--> statement-breakpoint
CREATE FUNCTION public._m204_actor_signature_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m204_actor_role$
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
$m204_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m204_actor_can_read_signatures(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m204_actor_read$
  SELECT COALESCE(
    public._m204_actor_signature_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m204_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m204_actor_can_write_signatures(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m204_actor_write$
DECLARE
  actor_role text;
  actor_id uuid;
  actor_capabilities jsonb;
BEGIN
  actor_role := public._m204_actor_signature_role(requested_workspace_id);
  actor_id := public.app_actor_id();
  IF actor_role IS NULL OR actor_id IS NULL THEN
    RETURN false;
  END IF;
  IF actor_role = 'admin' THEN
    RETURN true;
  END IF;
  IF actor_role <> 'editor' THEN
    RETURN false;
  END IF;
  SELECT membership_record.capabilities INTO actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id
   LIMIT 1;
  RETURN COALESCE(actor_capabilities->>'offer_signature', 'false') = 'true';
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END
$m204_actor_write$;--> statement-breakpoint

CREATE FUNCTION public._m204_erasure_scrub_allowed(
  row_workspace_id uuid,
  row_request_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m204_erasure_allowed$
DECLARE
  erasure_operation uuid;
BEGIN
  BEGIN
    erasure_operation := NULLIF(
      pg_catalog.current_setting('app.erasure_operation_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  IF erasure_operation IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = row_workspace_id
       AND tombstone.graph_ids->'signatureRequestIds' ? row_request_id::text
  ), false);
END
$m204_erasure_allowed$;--> statement-breakpoint

CREATE FUNCTION public._m204_guard_signature_request()
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
       AND issuance_record.state = 'ready_for_approval'
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'signature_request Ausstellungsfassung fehlt oder ist nicht freigegeben'
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
      -- Digital (click/draw) laeuft ueber den Token-Pfad ohne Actor; analog
      -- (Upload) ueber einen internen Editor/Admin. Beides endet in 'signed';
      -- die Modus-Bindung erzwingt der Attestation-Guard.
      IF actor_id IS NOT NULL
         AND NOT public._m204_actor_can_write_signatures(NEW.workspace_id) THEN
        RAISE EXCEPTION 'signature_request Signatur verlangt Token-Pfad oder internen Editor'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.expires_at <= mutation_time THEN
        RAISE EXCEPTION 'signature_request ist abgelaufen'
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

CREATE FUNCTION public._m204_guard_signature_attestation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m204_attestation_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  request_row public.signature_request%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m204_erasure_scrub_allowed(OLD.workspace_id, OLD.signature_request_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'signature_attestation DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'signature_attestation ist append-only'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO request_row
    FROM public.signature_request
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.signature_request_id
   FOR SHARE;
  IF NOT FOUND OR request_row.status <> 'signed' THEN
    RAISE EXCEPTION 'signature_attestation verlangt einen signierten Request'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.mode = 'analog' THEN
    IF NOT public._m204_actor_can_write_signatures(NEW.workspace_id)
       OR public.app_actor_id() IS NULL THEN
      RAISE EXCEPTION 'signature_attestation analog verlangt einen internen Editor oder Admin'
        USING ERRCODE = '23514';
    END IF;
  ELSIF public.app_actor_id() IS NOT NULL THEN
    RAISE EXCEPTION 'signature_attestation click/draw verlangt den Token-Pfad'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.signer_name IS DISTINCT FROM request_row.signer_name
     OR NEW.content_sha256 IS DISTINCT FROM request_row.content_sha256 THEN
    RAISE EXCEPTION 'signature_attestation Bindung weicht vom Request ab'
      USING ERRCODE = '23514';
  END IF;
  NEW.signed_at := request_row.signed_at;
  NEW.created_at := mutation_time;
  RETURN NEW;
END
$m204_attestation_guard$;--> statement-breakpoint

CREATE FUNCTION public._m204_guard_signature_view_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m204_view_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m204_erasure_scrub_allowed(OLD.workspace_id, OLD.signature_request_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'signature_view_log DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'signature_view_log ist append-only'
      USING ERRCODE = '23514';
  END IF;
  NEW.viewed_at := mutation_time;
  RETURN NEW;
END
$m204_view_guard$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m204_actor_signature_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_actor_can_read_signatures(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_actor_can_write_signatures(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_erasure_scrub_allowed(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_guard_signature_request() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_guard_signature_attestation() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m204_guard_signature_view_log() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER signature_request_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.signature_request
FOR EACH ROW EXECUTE FUNCTION public._m204_guard_signature_request();--> statement-breakpoint
CREATE TRIGGER signature_request_no_truncate
BEFORE TRUNCATE ON public.signature_request
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER signature_attestation_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.signature_attestation
FOR EACH ROW EXECUTE FUNCTION public._m204_guard_signature_attestation();--> statement-breakpoint
CREATE TRIGGER signature_attestation_no_truncate
BEFORE TRUNCATE ON public.signature_attestation
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER signature_view_log_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.signature_view_log
FOR EACH ROW EXECUTE FUNCTION public._m204_guard_signature_view_log();--> statement-breakpoint
CREATE TRIGGER signature_view_log_no_truncate
BEFORE TRUNCATE ON public.signature_view_log
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

ALTER TABLE public.signature_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signature_request FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signature_attestation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signature_attestation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signature_view_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.signature_view_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.signature_request
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.signature_attestation
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.signature_view_log
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

DO $m204_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
  delete_predicate text;
BEGIN
  delete_predicate := CASE
    WHEN actor_policy_role = 'app_runtime' THEN 'false'
    ELSE 'public._m204_erasure_scrub_allowed(workspace_id, id)'
  END;
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_request AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m204_actor_can_read_signatures(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'signature_request_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_request AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m204_actor_can_write_signatures(workspace_id))',
    'signature_request_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_request AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m204_actor_can_write_signatures(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)) '
    'WITH CHECK (public._m204_actor_can_write_signatures(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'signature_request_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_request AS RESTRICTIVE FOR DELETE TO %s USING (%s)',
    'signature_request_actor_delete', actor_policy_role, delete_predicate
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_attestation AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m204_actor_can_read_signatures(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'signature_attestation_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_attestation AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (true)',
    'signature_attestation_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_attestation AS RESTRICTIVE FOR DELETE TO %s USING (%s)',
    'signature_attestation_actor_delete', actor_policy_role,
    'public._m204_erasure_scrub_allowed(workspace_id, signature_request_id)'
  );

  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_view_log AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m204_actor_can_read_signatures(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'signature_view_log_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_view_log AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (true)',
    'signature_view_log_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.signature_view_log AS RESTRICTIVE FOR DELETE TO %s USING (%s)',
    'signature_view_log_actor_delete', actor_policy_role,
    'public._m204_erasure_scrub_allowed(workspace_id, signature_request_id)'
  );
END
$m204_actor_policies$;--> statement-breakpoint

REVOKE ALL ON public.signature_request FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.signature_attestation FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.signature_view_log FROM PUBLIC;--> statement-breakpoint

DO $m204_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.signature_request, '
        'public.signature_attestation, public.signature_view_log, '
        'public.signature_token_locator FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m204_actor_signature_role(uuid), '
        'public._m204_actor_can_read_signatures(uuid), '
        'public._m204_actor_can_write_signatures(uuid), '
        'public._m204_erasure_scrub_allowed(uuid,uuid), '
        'public._m204_guard_signature_request(), '
        'public._m204_guard_signature_attestation(), '
        'public._m204_guard_signature_view_log() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.signature_request TO app_runtime;
    GRANT SELECT, INSERT ON public.signature_attestation TO app_runtime;
    GRANT SELECT, INSERT ON public.signature_view_log TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._m204_actor_signature_role(uuid),
      public._m204_actor_can_read_signatures(uuid),
      public._m204_actor_can_write_signatures(uuid)
      TO app_runtime;
  END IF;
END
$m204_acl$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M2-04: Token-Resolver (SECURITY DEFINER). Der öffentliche Signierlink ist
-- rollenlos und durch das hoch-entropische Token geschützt; diese Funktion
-- liefert ausschließlich die öffentliche Sicht inkl. PDF-Bytes. Sie leakt
-- keine internen IDs ueber Fehlermeldungen (leere Menge bei unbekanntem Token).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.resolve_signature_public_view(requested_token_hash bytea)
RETURNS TABLE (
  workspace_id uuid,
  signature_request_id uuid,
  offer_id uuid,
  issuance_id uuid,
  status text,
  expires_at timestamptz,
  content_sha256 bytea,
  signer_name text,
  signed_at timestamptz,
  attestation_mode text,
  document_mime_type text,
  document_sha256 bytea,
  document_size_bytes integer,
  document_bytes bytea
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_resolve_token$
DECLARE
  located_workspace_id uuid;
  located_request_id uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.signature_request_id
    INTO located_workspace_id, located_request_id
    FROM public.signature_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  RETURN QUERY
    SELECT request_record.workspace_id,
           request_record.id,
           request_record.offer_id,
           request_record.issuance_id,
           request_record.status,
           request_record.expires_at,
           request_record.content_sha256,
           request_record.signer_name,
           request_record.signed_at,
           attestation_record.mode,
           issuance_record.artifact_mime_type,
           issuance_record.artifact_sha256,
           issuance_record.artifact_size_bytes,
           issuance_record.artifact_bytes
      FROM public.signature_request AS request_record
      JOIN public.offer_issuance AS issuance_record
        ON issuance_record.workspace_id = request_record.workspace_id
       AND issuance_record.id = request_record.issuance_id
      LEFT JOIN public.signature_attestation AS attestation_record
        ON attestation_record.workspace_id = request_record.workspace_id
       AND attestation_record.signature_request_id = request_record.id
     WHERE request_record.workspace_id = located_workspace_id
       AND request_record.id = located_request_id
     LIMIT 1;
END
$m204_resolve_token$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_signature_public_view(bytea) FROM PUBLIC;--> statement-breakpoint

DO $m204_token_grant$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_signature_public_view(bytea)
      TO app_runtime;
  END IF;
END
$m204_token_grant$;

-- ═══════════════════════════════════════════════════════════════════════
-- M2-04: Erasure-Graph-Erweiterung um signatureRequestIds,
-- signatureAttestationIds und signatureViewLogIds (quellgepinnt, Muster
-- 0038/0041). Die aktuellen Quelltexte werden vor der Erweiterung exakt
-- gehasht; jede parallele Erasure-Aenderung bricht den Migrationslauf ab.
-- ═══════════════════════════════════════════════════════════════════════
--> statement-breakpoint
DO $m204_tombstone_worm$
DECLARE
  worm_source text;
  worm_sha256 text;
  old_optional_keys constant text := $m204_old_optional_keys$
  optional_keys constant text[] := ARRAY[
    'offerPdfDraftIds', 'offerRecipientIds', 'offerRecipientRevisionIds',
    'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds',
    'offerIssuanceIds', 'offerIssuanceApprovalIds',
    'offerIssuanceWithdrawalIds', 'taskIds', 'noteIds', 'appointmentIds'
  ]::text[];
$m204_old_optional_keys$;
  new_optional_keys constant text := $m204_new_optional_keys$
  optional_keys constant text[] := ARRAY[
    'offerPdfDraftIds', 'offerRecipientIds', 'offerRecipientRevisionIds',
    'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds',
    'offerIssuanceIds', 'offerIssuanceApprovalIds',
    'offerIssuanceWithdrawalIds', 'taskIds', 'noteIds', 'appointmentIds',
    'signatureRequestIds', 'signatureAttestationIds', 'signatureViewLogIds'
  ]::text[];
$m204_new_optional_keys$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
           'hex'
         )
    INTO worm_source, worm_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'guard_erasure_tombstone_worm'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = '';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-04 Erasure: guard_erasure_tombstone_worm fehlt';
  END IF;
  IF worm_sha256 IS DISTINCT FROM
       '66dbe75a59c983c1042a498ef086ccfee0f8a2c48b6cef4c3b9bb2892a687663' THEN
    RAISE EXCEPTION 'M2-04 Erasure: unerwarteter tombstone-worm-Quellhash %',
      worm_sha256;
  END IF;
  IF pg_catalog.strpos(worm_source, old_optional_keys) = 0 THEN
    RAISE EXCEPTION 'M2-04 Erasure: gepinnter optional_keys-Anker fehlt';
  END IF;
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm() '
    'RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS %L',
    pg_catalog.replace(worm_source, old_optional_keys, new_optional_keys)
  );
END
$m204_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;--> statement-breakpoint

DO $m204_graph_pin$
DECLARE
  graph_source text;
  graph_sha256 text;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
           'hex'
         )
    INTO graph_source, graph_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'build_inactive_lead_erasure_graph'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M2-04 Erasure: build_inactive_lead_erasure_graph fehlt';
  END IF;
  IF graph_sha256 IS DISTINCT FROM
       '350a4c4f1de2df81dd39da00cfda75505802ddc72b03212975e2ad1c0302dec6' THEN
    RAISE EXCEPTION 'M2-04 Erasure: unerwarteter graph-builder-Quellhash %',
      graph_sha256;
  END IF;
END
$m204_graph_pin$;--> statement-breakpoint

ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m204;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.build_inactive_lead_erasure_graph_m204(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m204_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m204(
           requested_workspace_id, requested_contact_id
         )
         || CASE WHEN signature_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'signatureRequestIds', signature_graph.ids
              )
            END
         || CASE WHEN signature_attestation_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'signatureAttestationIds', signature_attestation_graph.ids
              )
            END
         || CASE WHEN signature_view_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object(
                'signatureViewLogIds', signature_view_graph.ids
              )
            END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(sig_request.id::text ORDER BY sig_request.id),
        '[]'::jsonb
      ) AS ids
        FROM public.signature_request AS sig_request
        JOIN public.project AS project_record
          ON project_record.workspace_id = sig_request.workspace_id
         AND project_record.id = sig_request.project_id
       WHERE sig_request.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ) AS signature_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(sig_attestation.id::text ORDER BY sig_attestation.id),
        '[]'::jsonb
      ) AS ids
        FROM public.signature_attestation AS sig_attestation
        JOIN public.signature_request AS sig_request
          ON sig_request.workspace_id = sig_attestation.workspace_id
         AND sig_request.id = sig_attestation.signature_request_id
        JOIN public.project AS project_record
          ON project_record.workspace_id = sig_request.workspace_id
         AND project_record.id = sig_request.project_id
       WHERE sig_attestation.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ) AS signature_attestation_graph
    CROSS JOIN (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(sig_view.id::text ORDER BY sig_view.id),
        '[]'::jsonb
      ) AS ids
        FROM public.signature_view_log AS sig_view
        JOIN public.signature_request AS sig_request
          ON sig_request.workspace_id = sig_view.workspace_id
         AND sig_request.id = sig_view.signature_request_id
        JOIN public.project AS project_record
          ON project_record.workspace_id = sig_request.workspace_id
         AND project_record.id = sig_request.project_id
       WHERE sig_view.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ) AS signature_view_graph
$m204_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

DO $m204_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_replay_graph constant text := $m204_old_replay_graph$
      'noteIds', COALESCE(graph_document->'noteIds', '[]'::jsonb),
      'appointmentIds', COALESCE(graph_document->'appointmentIds', '[]'::jsonb)
    );
$m204_old_replay_graph$;
  new_replay_graph constant text := $m204_new_replay_graph$
      'noteIds', COALESCE(graph_document->'noteIds', '[]'::jsonb),
      'appointmentIds', COALESCE(graph_document->'appointmentIds', '[]'::jsonb),
      'signatureRequestIds', COALESCE(graph_document->'signatureRequestIds', '[]'::jsonb),
      'signatureAttestationIds', COALESCE(graph_document->'signatureAttestationIds', '[]'::jsonb),
      'signatureViewLogIds', COALESCE(graph_document->'signatureViewLogIds', '[]'::jsonb)
    );
$m204_new_replay_graph$;
  old_signature_lock constant text := $m204_old_signature_lock$
   ORDER BY withdrawal.id FOR UPDATE;

  locked_graph_document := public.build_inactive_lead_erasure_graph(
$m204_old_signature_lock$;
  new_signature_lock constant text := $m204_new_signature_lock$
   ORDER BY withdrawal.id FOR UPDATE;
  PERFORM 1 FROM public.signature_request AS sig_request
   WHERE sig_request.workspace_id = requested_workspace_id
      AND sig_request.id IN (
        SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
          COALESCE(
            operational_graph_document->'signatureRequestIds', '[]'::jsonb
          )
        ) AS value
      )
   ORDER BY sig_request.id FOR UPDATE;
  PERFORM 1 FROM public.signature_attestation AS sig_attestation
   WHERE sig_attestation.workspace_id = requested_workspace_id
      AND sig_attestation.signature_request_id IN (
        SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
          COALESCE(
            operational_graph_document->'signatureRequestIds', '[]'::jsonb
          )
        ) AS value
      )
   ORDER BY sig_attestation.id FOR UPDATE;
  PERFORM 1 FROM public.signature_view_log AS sig_view
   WHERE sig_view.workspace_id = requested_workspace_id
      AND sig_view.signature_request_id IN (
        SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
          COALESCE(
            operational_graph_document->'signatureRequestIds', '[]'::jsonb
          )
        ) AS value
      )
   ORDER BY sig_view.id FOR UPDATE;

  locked_graph_document := public.build_inactive_lead_erasure_graph(
$m204_new_signature_lock$;
  old_signature_delete constant text := $m204_old_signature_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.project_note AS note_record
$m204_old_signature_delete$;
  new_signature_delete constant text := $m204_new_signature_delete$
  -- M2-04: Signatur-Untergraph zuerst loeschen, da signature_request auf
  -- Offer/Issuance/Variant zeigt (FK ohne Cascade) und vor dem Offer-Graph
  -- entfernt werden muss.
  DELETE FROM public.signature_view_log AS sig_view
   WHERE sig_view.workspace_id = requested_workspace_id
      AND sig_view.signature_request_id IN (
        SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
          COALESCE(
            operational_graph_document->'signatureRequestIds', '[]'::jsonb
          )
        ) AS value
      );
  DELETE FROM public.signature_attestation AS sig_attestation
   WHERE sig_attestation.workspace_id = requested_workspace_id
      AND sig_attestation.signature_request_id IN (
        SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
          COALESCE(
            operational_graph_document->'signatureRequestIds', '[]'::jsonb
          )
        ) AS value
      );
  DELETE FROM public.signature_request AS sig_request
   WHERE sig_request.workspace_id = requested_workspace_id
      AND sig_request.id IN (
        SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
          COALESCE(
            operational_graph_document->'signatureRequestIds', '[]'::jsonb
          )
        ) AS value
      );

  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.project_note AS note_record
$m204_new_signature_delete$;
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
    RAISE EXCEPTION 'M2-04 Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       'cec63897e55831166ccb154e07fab02b7b0c381d619597933c3381c74eac70b9' THEN
    RAISE EXCEPTION 'M2-04 Erasure: unerwarteter M1-15-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_replay_graph) = 0
     OR pg_catalog.strpos(erase_source, old_signature_lock) = 0
     OR pg_catalog.strpos(erase_source, old_signature_delete) = 0 THEN
    RAISE EXCEPTION 'M2-04 Erasure: gepinnter Quellanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source, old_replay_graph, new_replay_graph
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_signature_lock, new_signature_lock
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_signature_delete, new_signature_delete
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
$m204_erasure_upgrade$;--> statement-breakpoint

DO $m204_erasure_acl$
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
        'public.build_inactive_lead_erasure_graph(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph_m204(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m204_erasure_acl$;

-- ═══════════════════════════════════════════════════════════════════════
-- M2-04: Oeffentliche Token-Mutationen (SECURITY DEFINER, app_owner-Eigner).
-- Click/Draw-Signatur, Kunden-Widerruf (§356a) und View-Protokoll.
-- ═══════════════════════════════════════════════════════════════════════
--> statement-breakpoint
CREATE FUNCTION public.sign_signature_by_token(
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
REVOKE ALL ON FUNCTION public.sign_signature_by_token(bytea, text, text, bytea)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.revoke_signature_by_customer(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_revoke_token$
DECLARE
  request_row public.signature_request%ROWTYPE;
  located_workspace_id uuid;
  located_request_id uuid;
  revoke_time timestamptz := pg_catalog.statement_timestamp();
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
  IF request_row.status = 'revoked_by_customer' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'revoked_by_customer',
      'requestId', request_row.id, 'replayed', true
    );
  END IF;
  IF request_row.status <> 'signed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', request_row.status, 'requestId', request_row.id
    );
  END IF;
  IF revoke_time > request_row.signed_at + interval '14 days' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'revocation_window_closed'
    );
  END IF;

  UPDATE public.signature_request
     SET status = 'revoked_by_customer',
         revoked_by_customer_at = revoke_time
   WHERE id = request_row.id AND status = 'signed';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'transition_conflict'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'revoked_by_customer',
    'requestId', request_row.id,
    'offerId', request_row.offer_id,
    'revokedByCustomerAt', revoke_time
  );
END
$m204_revoke_token$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revoke_signature_by_customer(bytea) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.record_signature_view(requested_token_hash bytea)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m204_view_token$
DECLARE
  request_row public.signature_request%ROWTYPE;
  located_workspace_id uuid;
  located_request_id uuid;
  view_count integer;
  first_viewed_at timestamptz;
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
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  INSERT INTO public.signature_view_log (
    workspace_id, signature_request_id
  ) VALUES (
    request_row.workspace_id, request_row.id
  );

  IF request_row.status = 'pending'
     AND request_row.expires_at <= pg_catalog.statement_timestamp() THEN
    UPDATE public.signature_request
       SET status = 'expired'
     WHERE id = request_row.id AND status = 'pending';
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.min(view_record.viewed_at)
    INTO view_count, first_viewed_at
    FROM public.signature_view_log AS view_record
   WHERE view_record.workspace_id = request_row.workspace_id
     AND view_record.signature_request_id = request_row.id;

  RETURN pg_catalog.jsonb_build_object(
    'status', request_row.status,
    'requestId', request_row.id,
    'viewCount', view_count,
    'firstViewedAt', first_viewed_at
  );
END
$m204_view_token$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_signature_view(bytea) FROM PUBLIC;--> statement-breakpoint

DO $m204_public_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public.sign_signature_by_token(bytea, text, text, bytea),
      public.revoke_signature_by_customer(bytea),
      public.record_signature_view(bytea)
      TO app_runtime;
  END IF;
END
$m204_public_acl$;

-- ═══════════════════════════════════════════════════════════════════════
-- M2-04: interne Erzeugung (SECURITY DEFINER). Liest die freigegebene
-- Ausstellungsfassung (approved_for_archive_not_issued) und bindet den
-- Content-Hash append-only. Behaelt app.actor_id fuer den Create-Guard bei.
-- ═══════════════════════════════════════════════════════════════════════
--> statement-breakpoint
CREATE FUNCTION public.create_signature_request(
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
  issuance_row public.offer_issuance%ROWTYPE;
  existing_request public.signature_request%ROWTYPE;
  approval_count integer;
  withdrawal_found boolean;
  expires_at timestamptz;
  new_id uuid := pg_catalog.gen_random_uuid();
BEGIN
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


  SELECT * INTO issuance_row
    FROM public.offer_issuance
   WHERE workspace_id = requested_workspace_id
     AND offer_id = requested_offer_id
     AND variant_id = requested_variant_id
     AND state = 'ready_for_approval'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
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

  SELECT * INTO existing_request
    FROM public.signature_request
   WHERE workspace_id = requested_workspace_id
     AND issuance_id = issuance_row.id
   LIMIT 1;
  IF FOUND THEN
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
$m204_create_request$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.create_signature_request(uuid, uuid, uuid, integer, bytea)
  FROM PUBLIC;--> statement-breakpoint

DO $m204_create_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.create_signature_request(
      uuid, uuid, uuid, integer, bytea
    ) TO app_runtime;
  END IF;
END
$m204_create_acl$;
