CREATE TABLE "commercial_document" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"group_id" uuid,
	"project_id" uuid,
	"contact_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"archived_at" timestamp with time zone,
	"name" text NOT NULL,
	"number" text,
	"number_year" integer,
	"number_sequence" integer,
	"issued_at" timestamp with time zone,
	"credit_note_type" text,
	"goebd_retention_until" date,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"net_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"payment_status" text,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"due_date" date,
	"delivery_date" date,
	"validity_date" date,
	"planned_delivery_date" date,
	"planned_service_date" date,
	"recipient_snapshot" jsonb,
	"issued_snapshot" jsonb,
	"snapshot_sha256" "bytea",
	"issued_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_ws_number_uq" UNIQUE("workspace_id","type","number_year","number_sequence"),
	CONSTRAINT "commercial_document_type_ck" CHECK ("commercial_document"."type" in (
  'invoice', 'credit_note', 'order_confirmation', 'purchase_order', 'delivery_note', 'letter'
)),
	CONSTRAINT "commercial_document_status_ck" CHECK ("commercial_document"."status" in ('draft', 'issued', 'voided')),
	CONSTRAINT "commercial_document_name_ck" CHECK (length(btrim("commercial_document"."name")) between 1 and 160),
	CONSTRAINT "commercial_document_currency_ck" CHECK ("commercial_document"."currency" = 'EUR'),
	CONSTRAINT "commercial_document_money_ck" CHECK ("commercial_document"."net_cents" between 0 and 9000000000000000
        and "commercial_document"."tax_cents" between 0 and 9000000000000000
        and "commercial_document"."gross_cents" between 0 and 9000000000000000
        and "commercial_document"."paid_cents" between 0 and 9000000000000000
        and "commercial_document"."gross_cents" = "commercial_document"."net_cents" + "commercial_document"."tax_cents"),
	CONSTRAINT "commercial_document_credit_note_type_ck" CHECK ("commercial_document"."credit_note_type" is null
        or "commercial_document"."credit_note_type" in ('minderleistung', 'empfehlungspraemie')),
	CONSTRAINT "commercial_document_credit_note_type_scope_ck" CHECK ("commercial_document"."credit_note_type" is null or "commercial_document"."type" = 'credit_note'),
	CONSTRAINT "commercial_document_letter_ck" CHECK ("commercial_document"."type" <> 'letter' or (
        "commercial_document"."net_cents" = 0 and "commercial_document"."tax_cents" = 0 and "commercial_document"."gross_cents" = 0
        and "commercial_document"."payment_status" is null and "commercial_document"."paid_cents" = 0
      )),
	CONSTRAINT "commercial_document_payment_status_ck" CHECK ("commercial_document"."type" = 'letter' or "commercial_document"."payment_status" in (
        'unpaid', 'partially_paid', 'paid', 'overdue', 'uncollectable'
      )),
	CONSTRAINT "commercial_document_partial_paid_ck" CHECK ("commercial_document"."payment_status" is distinct from 'partially_paid'
        or ("commercial_document"."paid_cents" > 0 and "commercial_document"."paid_cents" < "commercial_document"."gross_cents")),
	CONSTRAINT "commercial_document_paid_ck" CHECK ("commercial_document"."payment_status" is distinct from 'paid'
        or "commercial_document"."paid_cents" >= "commercial_document"."gross_cents"),
	CONSTRAINT "commercial_document_unpaid_ck" CHECK ("commercial_document"."payment_status" is distinct from 'unpaid' or "commercial_document"."paid_cents" = 0),
	CONSTRAINT "commercial_document_void_ck" CHECK (("commercial_document"."status" = 'voided')
        = ("commercial_document"."void_reason" is not null and "commercial_document"."voided_at" is not null)),
	CONSTRAINT "commercial_document_void_reason_ck" CHECK ("commercial_document"."void_reason" is null or "commercial_document"."void_reason" in (
        'created_in_error', 'duplicate', 'superseded', 'cancelled', 'other'
      )),
	CONSTRAINT "commercial_document_sent_ck" CHECK ("commercial_document"."sent_at" is null or "commercial_document"."status" <> 'draft'),
	CONSTRAINT "commercial_document_issued_gate_ck" CHECK ("commercial_document"."status" <> 'issued' or (
        "commercial_document"."number" is not null
        and "commercial_document"."number_year" is not null
        and "commercial_document"."number_sequence" is not null
        and "commercial_document"."issued_at" is not null
        and "commercial_document"."issued_snapshot" is not null
        and "commercial_document"."snapshot_sha256" is not null
        and "commercial_document"."goebd_retention_until" is not null
        and "commercial_document"."issued_by" is not null
      )),
	CONSTRAINT "commercial_document_snapshot_hash_ck" CHECK ("commercial_document"."snapshot_sha256" is null or octet_length("commercial_document"."snapshot_sha256") = 32),
	CONSTRAINT "commercial_document_issued_snapshot_ck" CHECK ("commercial_document"."issued_snapshot" is null or jsonb_typeof("commercial_document"."issued_snapshot") = 'object'),
	CONSTRAINT "commercial_document_recipient_snapshot_ck" CHECK ("commercial_document"."recipient_snapshot" is null or jsonb_typeof("commercial_document"."recipient_snapshot") = 'object'),
	CONSTRAINT "commercial_document_dates_ck" CHECK (case "commercial_document"."type"
        when 'invoice' then "commercial_document"."due_date" is not null
        when 'credit_note' then "commercial_document"."delivery_date" is not null
        when 'order_confirmation' then "commercial_document"."planned_delivery_date" is not null
          and "commercial_document"."planned_service_date" is not null
        when 'purchase_order' then "commercial_document"."validity_date" is not null
        when 'delivery_note' then "commercial_document"."delivery_date" is not null
        when 'letter' then "commercial_document"."validity_date" is not null
        else true
      end),
	CONSTRAINT "commercial_document_timestamps_ck" CHECK (isfinite("commercial_document"."created_at") and isfinite("commercial_document"."updated_at")
        and "commercial_document"."updated_at" >= "commercial_document"."created_at")
);
--> statement-breakpoint
CREATE TABLE "commercial_document_group" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_group_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_group_ws_name_uq" UNIQUE("workspace_id","name"),
	CONSTRAINT "commercial_document_group_name_ck" CHECK (length(btrim("commercial_document_group"."name")) between 1 and 120),
	CONSTRAINT "commercial_document_group_archive_ck" CHECK ("commercial_document_group"."archived_at" is null or isfinite("commercial_document_group"."archived_at")),
	CONSTRAINT "commercial_document_group_timestamps_ck" CHECK (isfinite("commercial_document_group"."created_at") and isfinite("commercial_document_group"."updated_at")
        and "commercial_document_group"."updated_at" >= "commercial_document_group"."created_at")
);
--> statement-breakpoint
CREATE TABLE "commercial_document_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"quantity_milli" integer NOT NULL,
	"unit" text NOT NULL,
	"net_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"gross_cents" bigint NOT NULL,
	"tax_rate_bps" integer NOT NULL,
	"line_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_line_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_line_ws_doc_pos_uq" UNIQUE("workspace_id","document_id","position"),
	CONSTRAINT "commercial_document_line_position_ck" CHECK ("commercial_document_line"."position" between 1 and 500),
	CONSTRAINT "commercial_document_line_name_ck" CHECK (length(btrim("commercial_document_line"."name")) between 1 and 300),
	CONSTRAINT "commercial_document_line_quantity_ck" CHECK ("commercial_document_line"."quantity_milli" between 1 and 100000000),
	CONSTRAINT "commercial_document_line_unit_ck" CHECK ("commercial_document_line"."unit" in ('piece', 'set', 'meter')),
	CONSTRAINT "commercial_document_line_money_ck" CHECK ("commercial_document_line"."net_cents" between 0 and 9000000000000000 and "commercial_document_line"."tax_cents" between 0 and 9000000000000000
        and "commercial_document_line"."gross_cents" between 0 and 9000000000000000
        and "commercial_document_line"."gross_cents" = "commercial_document_line"."net_cents" + "commercial_document_line"."tax_cents"),
	CONSTRAINT "commercial_document_line_tax_rate_ck" CHECK ("commercial_document_line"."tax_rate_bps" in (0, 1900)),
	CONSTRAINT "commercial_document_line_snapshot_ck" CHECK ("commercial_document_line"."line_snapshot" is null or jsonb_typeof("commercial_document_line"."line_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "commercial_document_number_series" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"series_year" integer NOT NULL,
	"prefix" text NOT NULL,
	"padding" integer NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_number_series_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_number_series_ws_type_year_uq" UNIQUE("workspace_id","type","series_year"),
	CONSTRAINT "commercial_document_number_series_type_ck" CHECK ("commercial_document_number_series"."type" in (
  'invoice', 'credit_note', 'order_confirmation', 'purchase_order', 'delivery_note', 'letter'
)),
	CONSTRAINT "commercial_document_number_series_year_ck" CHECK ("commercial_document_number_series"."series_year" between 2000 and 9999),
	CONSTRAINT "commercial_document_number_series_prefix_ck" CHECK (length(btrim("commercial_document_number_series"."prefix")) between 1 and 40),
	CONSTRAINT "commercial_document_number_series_padding_ck" CHECK ("commercial_document_number_series"."padding" between 1 and 12),
	CONSTRAINT "commercial_document_number_series_sequence_ck" CHECK ("commercial_document_number_series"."last_sequence" between 0 and 999999)
);
--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_group_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."commercial_document_group"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contact"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document" ADD CONSTRAINT "commercial_document_issued_by_fk" FOREIGN KEY ("workspace_id","issued_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_group" ADD CONSTRAINT "commercial_document_group_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_group" ADD CONSTRAINT "commercial_document_group_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_line" ADD CONSTRAINT "commercial_document_line_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_line" ADD CONSTRAINT "commercial_document_line_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_number_series" ADD CONSTRAINT "commercial_document_number_series_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_document_ws_list_idx" ON "commercial_document" USING btree ("workspace_id","type","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "commercial_document_ws_type_issued_idx" ON "commercial_document" USING btree ("workspace_id","type","issued_at");
-- ═══════════════════════════════════════════════════════════════════════
-- M3-01: Invoicing-Actor-Helfer (Muster M3-00 _m300_actor_invoicing_role).
-- Rolle wird NUR aus der Membership abgeleitet; der Capability-Check
-- (invoicing.read/write) liegt im Service-Vertrag (lib/permissions.ts).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m301_actor_invoicing_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m301_actor_role$
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
$m301_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m301_actor_can_read_invoicing(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m301_actor_read$
  SELECT COALESCE(
    public._m301_actor_invoicing_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m301_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m301_actor_can_write_invoicing(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m301_actor_write$
DECLARE
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  actor_id := public.app_actor_id();
  IF actor_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id
   LIMIT 1;
  IF NOT FOUND
     OR actor_role NOT IN ('editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) <> 'object'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each(actor_capabilities) AS capability(key, value)
        WHERE pg_catalog.jsonb_typeof(capability.value) <> 'boolean'
     )
     OR (
       actor_capabilities ? 'external_only'
       AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
     ) THEN
    RETURN false;
  END IF;
  IF actor_role = 'admin' THEN
    RETURN true;
  END IF;
  RETURN COALESCE(actor_capabilities->>'invoicing' = 'true', false);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$m301_actor_write$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-01: issued-Immutable-Guard (Spec §12). Nach Ausstellung duerfen nur
-- Versand-/Zahlungs-/Void-Achse sowie Archiv-/Zeitstempel-Felder mutieren;
-- Content und Snapshot sind eingefroren.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m301_guard_issued_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m301_issued_immutable$
BEGIN
  IF OLD.status = 'issued' THEN
    IF NEW.type IS DISTINCT FROM OLD.type
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.number_year IS DISTINCT FROM OLD.number_year
       OR NEW.number_sequence IS DISTINCT FROM OLD.number_sequence
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.credit_note_type IS DISTINCT FROM OLD.credit_note_type
       OR NEW.goebd_retention_until IS DISTINCT FROM OLD.goebd_retention_until
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.net_cents IS DISTINCT FROM OLD.net_cents
       OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
       OR NEW.gross_cents IS DISTINCT FROM OLD.gross_cents
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.delivery_date IS DISTINCT FROM OLD.delivery_date
       OR NEW.validity_date IS DISTINCT FROM OLD.validity_date
       OR NEW.planned_delivery_date IS DISTINCT FROM OLD.planned_delivery_date
       OR NEW.planned_service_date IS DISTINCT FROM OLD.planned_service_date
       OR NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot
       OR NEW.issued_snapshot IS DISTINCT FROM OLD.issued_snapshot
       OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'issued_document_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$m301_issued_immutable$;--> statement-breakpoint

CREATE TRIGGER commercial_document_issued_immutable
BEFORE UPDATE ON public.commercial_document
FOR EACH ROW EXECUTE FUNCTION public._m301_guard_issued_immutable();--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-01: RLS-Vertrag (Muster M3-00 0045): permissive tenant_isolation ueber
-- app.workspace_id + restriktive Actor-Policies fuer app_runtime.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.commercial_document_group ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_group FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_number_series ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_number_series FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.commercial_document_group
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_number_series
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_line
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

DO $m301_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_document_group',
    'commercial_document_number_series',
    'commercial_document',
    'commercial_document_line'
  ]::text[] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO %s '
      'USING (public._m301_actor_can_read_invoicing(workspace_id) OR '
      '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
      table_name || '_actor_select', table_name, actor_policy_role
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO %s '
      'WITH CHECK (public._m301_actor_can_write_invoicing(workspace_id) OR '
      '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
      table_name || '_actor_insert', table_name, actor_policy_role
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO %s '
      'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
      '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
      table_name || '_actor_update', table_name, actor_policy_role
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO %s '
      'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
      table_name || '_actor_delete', table_name, actor_policy_role
    );
  END LOOP;
END
$m301_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER commercial_document_group_no_truncate
BEFORE TRUNCATE ON public.commercial_document_group
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER commercial_document_number_series_no_truncate
BEFORE TRUNCATE ON public.commercial_document_number_series
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER commercial_document_no_truncate
BEFORE TRUNCATE ON public.commercial_document
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER commercial_document_line_no_truncate
BEFORE TRUNCATE ON public.commercial_document_line
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
