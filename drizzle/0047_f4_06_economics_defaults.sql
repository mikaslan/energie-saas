CREATE TABLE "workspace_economics_settings" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"electricity_price_net_cents_per_kwh" bigint,
	"escalation_rate_bps" integer,
	"oil_price_net_cents_per_liter" bigint,
	"gas_price_net_cents_per_kwh" bigint,
	"cashflow_horizon_years" integer DEFAULT 20 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_economics_settings_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_economics_settings_prices_ck" CHECK (("workspace_economics_settings"."electricity_price_net_cents_per_kwh" is null
        or "workspace_economics_settings"."electricity_price_net_cents_per_kwh" between 0 and 1000000)
        and ("workspace_economics_settings"."oil_price_net_cents_per_liter" is null
        or "workspace_economics_settings"."oil_price_net_cents_per_liter" between 0 and 1000000)
        and ("workspace_economics_settings"."gas_price_net_cents_per_kwh" is null
        or "workspace_economics_settings"."gas_price_net_cents_per_kwh" between 0 and 1000000)),
	CONSTRAINT "workspace_economics_settings_escalation_ck" CHECK ("workspace_economics_settings"."escalation_rate_bps" is null
        or "workspace_economics_settings"."escalation_rate_bps" between 0 and 2000),
	CONSTRAINT "workspace_economics_settings_horizon_ck" CHECK ("workspace_economics_settings"."cashflow_horizon_years" between 1 and 50),
	CONSTRAINT "workspace_economics_settings_revision_ck" CHECK ("workspace_economics_settings"."revision" between 1 and 2147483647),
	CONSTRAINT "workspace_economics_settings_timestamps_ck" CHECK ("workspace_economics_settings"."updated_at" >= "workspace_economics_settings"."created_at"
        and isfinite("workspace_economics_settings"."created_at")
        and isfinite("workspace_economics_settings"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "workspace_economics_settings" ADD CONSTRAINT "workspace_economics_settings_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F4.6: Economics-Actor-Helfer (Muster M3-00 _m300_actor_invoicing_role).
-- Rolle wird NUR aus der Membership abgeleitet; der Capability-Check
-- (economics.read/write) liegt im Service-Vertrag (lib/permissions.ts).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._f406_actor_economics_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f406_actor_role$
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
$f406_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._f406_actor_can_read_economics(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f406_actor_read$
  SELECT COALESCE(
    public._f406_actor_economics_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$f406_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._f406_actor_can_write_economics(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f406_actor_write$
DECLARE
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  -- Spec F4.6: schreiben darf ein Admin oder ein Editor mit Economics-Recht
  -- (capability 'economics' = true). Spiegelt die App-Permission
  -- 'economics.write' (minRole editor, capability economics, Admin-Bypass)
  -- auf der RLS-Ebene wider (M3-00-Muster).
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
  RETURN COALESCE(actor_capabilities->>'economics' = 'true', false);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$f406_actor_write$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F4.6: RLS-Vertrag (Muster 0045): permissive tenant_isolation über
-- app.workspace_id + restriktive Actor-Policies für app_runtime.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.workspace_economics_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.workspace_economics_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.workspace_economics_settings
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

DO $f406_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_economics_settings AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._f406_actor_can_read_economics(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_economics_settings_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_economics_settings AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._f406_actor_can_write_economics(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_economics_settings_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_economics_settings AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._f406_actor_can_write_economics(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'workspace_economics_settings_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.workspace_economics_settings AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'workspace_economics_settings_actor_delete', actor_policy_role
  );
END
$f406_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER workspace_economics_settings_no_truncate
BEFORE TRUNCATE ON public.workspace_economics_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
-- ACL-Vertrag (REVOKE ALL + GRANT SELECT/INSERT/UPDATE an app_runtime, kein
-- DELETE; EXECUTE nur fuer die drei _f406-Routinen) wird NICHT hier, sondern
-- idempotent von scripts/db-role-contract.mts (applyRoleContract) angewendet
-- und von der Live-Rollenprobe verifiziert (Muster 0045).
