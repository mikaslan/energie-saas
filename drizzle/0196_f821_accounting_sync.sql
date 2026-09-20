CREATE TABLE "accounting_sync_record" (
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"state" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"external_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_sync_record_ws_doc_vendor_uq" UNIQUE("workspace_id","document_id","vendor"),
	CONSTRAINT "accounting_sync_record_vendor_ck" CHECK ("accounting_sync_record"."vendor" in ('lexoffice', 'sevdesk', 'bexio')),
	CONSTRAINT "accounting_sync_record_state_ck" CHECK ("accounting_sync_record"."state" in ('queued', 'exported', 'acknowledged', 'failed')),
	CONSTRAINT "accounting_sync_record_sha_ck" CHECK ("accounting_sync_record"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_sync_record_external_ck" CHECK ("accounting_sync_record"."external_id" is null or char_length("accounting_sync_record"."external_id") <= 200),
	CONSTRAINT "accounting_sync_record_attempts_ck" CHECK ("accounting_sync_record"."attempts" >= 0),
	CONSTRAINT "accounting_sync_record_error_ck" CHECK ("accounting_sync_record"."last_error" is null or char_length("accounting_sync_record"."last_error") <= 500)
);
--> statement-breakpoint
ALTER TABLE "accounting_sync_record" ADD CONSTRAINT "accounting_sync_record_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_sync_record" ADD CONSTRAINT "accounting_sync_record_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_sync_record_ws_doc_idx" ON "accounting_sync_record" USING btree ("workspace_id","document_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F8-21: RLS-Vertrag (Muster M3-02b 0192): permissive tenant_isolation
-- ueber app.workspace_id + restriktive Actor-Policies fuer app_runtime.
-- Sync-Saetze tragen State-Machine + Hash (GoBD-nah): DELETE nur
-- app_owner ohne Actor, kein Writer-Delete.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.accounting_sync_record ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.accounting_sync_record FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.accounting_sync_record
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
DO $f821_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m301_actor_can_read_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'accounting_sync_record_actor_select', 'accounting_sync_record', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'accounting_sync_record_actor_insert', 'accounting_sync_record', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'accounting_sync_record_actor_update', 'accounting_sync_record', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'accounting_sync_record_actor_delete', 'accounting_sync_record', actor_policy_role
  );
END
$f821_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER accounting_sync_record_no_truncate
BEFORE TRUNCATE ON public.accounting_sync_record
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();