CREATE TABLE "commercial_document_render_job" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"input_json" jsonb NOT NULL,
	"input_sha256" "bytea" NOT NULL,
	"template_version" text NOT NULL,
	"renderer_recipe" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_render_job_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_render_job_ws_doc_tpl_uq" UNIQUE("workspace_id","document_id","template_version","renderer_recipe"),
	CONSTRAINT "commercial_document_render_job_status_ck" CHECK ("commercial_document_render_job"."status" = 'requested'),
	CONSTRAINT "commercial_document_render_job_template_ck" CHECK ("commercial_document_render_job"."template_version" = 'invoice-pdf-template.v1'),
	CONSTRAINT "commercial_document_render_job_recipe_ck" CHECK ("commercial_document_render_job"."renderer_recipe" = 'invoice-pdf-renderer-recipe.v1'),
	CONSTRAINT "commercial_document_render_job_input_ck" CHECK (jsonb_typeof("commercial_document_render_job"."input_json") = 'object'),
	CONSTRAINT "commercial_document_render_job_sha_ck" CHECK (octet_length("commercial_document_render_job"."input_sha256") = 32)
);
--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_document_render_job_ws_doc_idx" ON "commercial_document_render_job" USING btree ("workspace_id","document_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-02b: RLS-Vertrag (Muster M3-01 0046 / F8-01 0083): permissive
-- tenant_isolation ueber app.workspace_id + restriktive Actor-Policies
-- fuer app_runtime. Jobs sind versiegelte Inputs (GoBD-nah): DELETE nur
-- app_owner ohne Actor, kein Writer-Delete.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.commercial_document_render_job ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_render_job FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_render_job
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
DO $m302b_actor_policies$
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
    'commercial_document_render_job_actor_select', 'commercial_document_render_job', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_render_job_actor_insert', 'commercial_document_render_job', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_render_job_actor_update', 'commercial_document_render_job', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO %s '
    'USING (CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL)',
    'commercial_document_render_job_actor_delete', 'commercial_document_render_job', actor_policy_role
  );
END
$m302b_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER commercial_document_render_job_no_truncate
BEFORE TRUNCATE ON public.commercial_document_render_job
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();