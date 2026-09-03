CREATE TABLE "workspace_document_number_format" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"format_template" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_document_number_format_workspace_id_type_pk" PRIMARY KEY("workspace_id","type"),
	CONSTRAINT "workspace_document_number_format_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_document_number_format_type_ck" CHECK ("workspace_document_number_format"."type" in ('invoice', 'credit_note', 'order_confirmation', 'purchase_order', 'delivery_note', 'letter')),
	CONSTRAINT "workspace_document_number_format_template_ck" CHECK (length(btrim("workspace_document_number_format"."format_template")) between 1 and 120
        and "workspace_document_number_format"."format_template" like '%{NUMBER}%'
        and "workspace_document_number_format"."format_template" ~ '^([^{}]|\{YEAR\}|\{MONTH\}|\{DAY\}|\{NUMBER\})*$'),
	CONSTRAINT "workspace_document_number_format_counter_ck" CHECK ("workspace_document_number_format"."counter" >= 0),
	CONSTRAINT "workspace_document_number_format_updated_at_ck" CHECK (isfinite("workspace_document_number_format"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_invoicing_settings" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"company_email" text NOT NULL,
	"company_authority" text,
	"company_register_number" text,
	"company_tax_id" text,
	"company_address_line1" text NOT NULL,
	"company_address_line2" text,
	"company_postal_code" text NOT NULL,
	"company_city" text NOT NULL,
	"company_country" text NOT NULL,
	"accounting_method" text DEFAULT 'accrual' NOT NULL,
	"payment_account_holder" text,
	"payment_iban" text,
	"payment_bic" text,
	"goebd_retention_default_days" integer DEFAULT 3650 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invoicing_settings_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_invoicing_settings_company_name_ck" CHECK (length(btrim("workspace_invoicing_settings"."company_name")) between 1 and 160),
	CONSTRAINT "workspace_invoicing_settings_company_email_ck" CHECK (length(btrim("workspace_invoicing_settings"."company_email")) between 3 and 254
        and "workspace_invoicing_settings"."company_email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "workspace_invoicing_settings_company_authority_ck" CHECK ("workspace_invoicing_settings"."company_authority" is null or length(btrim("workspace_invoicing_settings"."company_authority")) between 1 and 80),
	CONSTRAINT "workspace_invoicing_settings_company_register_number_ck" CHECK ("workspace_invoicing_settings"."company_register_number" is null or length(btrim("workspace_invoicing_settings"."company_register_number")) between 1 and 64),
	CONSTRAINT "workspace_invoicing_settings_company_tax_id_ck" CHECK ("workspace_invoicing_settings"."company_tax_id" is null or length(btrim("workspace_invoicing_settings"."company_tax_id")) between 1 and 64),
	CONSTRAINT "workspace_invoicing_settings_company_address_line1_ck" CHECK (length(btrim("workspace_invoicing_settings"."company_address_line1")) between 1 and 160),
	CONSTRAINT "workspace_invoicing_settings_company_address_line2_ck" CHECK ("workspace_invoicing_settings"."company_address_line2" is null or length(btrim("workspace_invoicing_settings"."company_address_line2")) between 1 and 160),
	CONSTRAINT "workspace_invoicing_settings_company_postal_code_ck" CHECK (length(btrim("workspace_invoicing_settings"."company_postal_code")) between 1 and 20),
	CONSTRAINT "workspace_invoicing_settings_company_city_ck" CHECK (length(btrim("workspace_invoicing_settings"."company_city")) between 1 and 120),
	CONSTRAINT "workspace_invoicing_settings_company_country_ck" CHECK ("workspace_invoicing_settings"."company_country" in ('DE', 'AT', 'CH', 'FR', 'UK', 'JE')),
	CONSTRAINT "workspace_invoicing_settings_accounting_method_ck" CHECK ("workspace_invoicing_settings"."accounting_method" in ('accrual', 'cash')),
	CONSTRAINT "workspace_invoicing_settings_payment_account_holder_ck" CHECK ("workspace_invoicing_settings"."payment_account_holder" is null or length(btrim("workspace_invoicing_settings"."payment_account_holder")) between 1 and 160),
	CONSTRAINT "workspace_invoicing_settings_payment_iban_ck" CHECK ("workspace_invoicing_settings"."payment_iban" is null or char_length(btrim("workspace_invoicing_settings"."payment_iban")) between 15 and 34),
	CONSTRAINT "workspace_invoicing_settings_payment_bic_ck" CHECK ("workspace_invoicing_settings"."payment_bic" is null or char_length(btrim("workspace_invoicing_settings"."payment_bic")) in (8, 11)),
	CONSTRAINT "workspace_invoicing_settings_payment_complete_ck" CHECK ((
        "workspace_invoicing_settings"."payment_account_holder" is null
        and "workspace_invoicing_settings"."payment_iban" is null
        and "workspace_invoicing_settings"."payment_bic" is null
      ) or (
        "workspace_invoicing_settings"."payment_account_holder" is not null
        and "workspace_invoicing_settings"."payment_iban" is not null
        and "workspace_invoicing_settings"."payment_bic" is not null
      )),
	CONSTRAINT "workspace_invoicing_settings_goebd_days_ck" CHECK ("workspace_invoicing_settings"."goebd_retention_default_days" between 1 and 36500),
	CONSTRAINT "workspace_invoicing_settings_revision_ck" CHECK ("workspace_invoicing_settings"."revision" between 1 and 2147483647),
	CONSTRAINT "workspace_invoicing_settings_timestamps_ck" CHECK ("workspace_invoicing_settings"."updated_at" >= "workspace_invoicing_settings"."created_at"
        and isfinite("workspace_invoicing_settings"."created_at")
        and isfinite("workspace_invoicing_settings"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "workspace_document_number_format" ADD CONSTRAINT "workspace_document_number_format_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invoicing_settings" ADD CONSTRAINT "workspace_invoicing_settings_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-00: Invoicing-Actor-Helfer (Muster M1-13 _m113_actor_note_role /
-- M1-15 _m115_actor_appointment_role). Die Rolle wird NUR aus der
-- Membership abgeleitet; der Capability-Check (invoicing.read/write) liegt
-- im Service-Vertrag (lib/permissions.ts), die Helfer liefern die
-- tenant-gebundene Rolle für RLS-Policies.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m300_actor_invoicing_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m300_actor_role$
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
$m300_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m300_actor_can_read_invoicing(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m300_actor_read$
  SELECT COALESCE(
    public._m300_actor_invoicing_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m300_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m300_actor_can_write_invoicing(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m300_actor_write$
  SELECT COALESCE(
    public._m300_actor_invoicing_role(requested_workspace_id)
      IN ('editor', 'admin'),
    false
  )
$m300_actor_write$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-00: RLS-Vertrag (Muster M1-15 0043): permissive tenant_isolation über
-- app.workspace_id + restriktive Actor-Policies für app_runtime.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.workspace_invoicing_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workspace_invoicing_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workspace_document_number_format ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workspace_document_number_format FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.workspace_invoicing_settings
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.workspace_document_number_format
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

DO $m300_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_invoicing_settings AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m300_actor_can_read_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_invoicing_settings_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_invoicing_settings AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m300_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_invoicing_settings_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_invoicing_settings AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m300_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_invoicing_settings_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_document_number_format AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m300_actor_can_read_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_document_number_format_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_document_number_format AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m300_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_document_number_format_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_document_number_format AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m300_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_document_number_format_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_document_number_format AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'workspace_document_number_format_actor_delete', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_invoicing_settings AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'workspace_invoicing_settings_actor_delete', actor_policy_role
  );
END
$m300_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER workspace_invoicing_settings_no_truncate
BEFORE TRUNCATE ON public.workspace_invoicing_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER workspace_document_number_format_no_truncate
BEFORE TRUNCATE ON public.workspace_document_number_format
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
