CREATE TABLE "commercial_document_delivery" (
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"invoice_job_id" uuid NOT NULL,
	"invoice_artifact_sha256" "bytea" NOT NULL,
	"payment_job_id" uuid,
	"payment_artifact_sha256" "bytea",
	"sent_by" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commercial_document_delivery_ws_doc_uq" UNIQUE("workspace_id","document_id"),
	CONSTRAINT "commercial_document_delivery_channel_ck" CHECK ("commercial_document_delivery"."channel" in ('manual')),
	CONSTRAINT "commercial_document_delivery_sha_ck" CHECK (octet_length("commercial_document_delivery"."invoice_artifact_sha256") = 32 and ("commercial_document_delivery"."payment_artifact_sha256" is null or octet_length("commercial_document_delivery"."payment_artifact_sha256") = 32)),
	CONSTRAINT "commercial_document_delivery_payment_ck" CHECK (("commercial_document_delivery"."payment_job_id" is null) = ("commercial_document_delivery"."payment_artifact_sha256" is null))
);
--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD CONSTRAINT "commercial_document_delivery_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD CONSTRAINT "commercial_document_delivery_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD CONSTRAINT "commercial_document_delivery_invoice_job_fk" FOREIGN KEY ("workspace_id","invoice_job_id") REFERENCES "public"."commercial_document_render_job"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD CONSTRAINT "commercial_document_delivery_payment_job_fk" FOREIGN KEY ("workspace_id","payment_job_id") REFERENCES "public"."commercial_document_render_job"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_delivery" ADD CONSTRAINT "commercial_document_delivery_sent_by_fk" FOREIGN KEY ("workspace_id","sent_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_document_delivery_ws_doc_idx" ON "commercial_document_delivery" USING btree ("workspace_id","document_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F8-19: RLS-Vertrag (Muster M3-02b 0192): permissive tenant_isolation
-- ueber app.workspace_id + restriktive Actor-Policies fuer app_runtime.
-- Delivery-Zeilen sind Versand-Nachweise (GoBD-nah): DELETE nur
-- app_owner ohne Actor, kein Writer-Delete.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.commercial_document_delivery ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_delivery FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_delivery
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
DO $f819_actor_policies$
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
    'commercial_document_delivery_actor_select', 'commercial_document_delivery', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_delivery_actor_insert', 'commercial_document_delivery', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_delivery_actor_update', 'commercial_document_delivery', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'commercial_document_delivery_actor_delete', 'commercial_document_delivery', actor_policy_role
  );
END
$f819_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER commercial_document_delivery_no_truncate
BEFORE TRUNCATE ON public.commercial_document_delivery
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();