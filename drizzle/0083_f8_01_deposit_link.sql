CREATE TABLE "commercial_document_link" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"final_id" uuid NOT NULL,
	"deposit_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_document_link_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commercial_document_link_ws_pair_uq" UNIQUE("workspace_id","final_id","deposit_id"),
	CONSTRAINT "commercial_document_link_no_self_ck" CHECK ("commercial_document_link"."final_id" <> "commercial_document_link"."deposit_id")
);
--> statement-breakpoint
ALTER TABLE "commercial_document_link" ADD CONSTRAINT "commercial_document_link_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_link" ADD CONSTRAINT "commercial_document_link_final_fk" FOREIGN KEY ("workspace_id","final_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_link" ADD CONSTRAINT "commercial_document_link_deposit_fk" FOREIGN KEY ("workspace_id","deposit_id") REFERENCES "public"."commercial_document"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_document_link" ADD CONSTRAINT "commercial_document_link_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_document_link_ws_final_idx" ON "commercial_document_link" USING btree ("workspace_id","final_id","created_at","id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F8-01: RLS-Vertrag (Muster M3-01 0046): permissive tenant_isolation ueber
-- app.workspace_id + restriktive Actor-Policies fuer app_runtime.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.commercial_document_link ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.commercial_document_link FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.commercial_document_link
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
DO $f801_actor_policies$
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
    'commercial_document_link_actor_select', 'commercial_document_link', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_link_actor_insert', 'commercial_document_link', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_link_actor_update', 'commercial_document_link', actor_policy_role
  );
  -- Links sind operativ (wie Mention/Assignee), kein GoBD-Beleg: Writer
  -- duerfen entfernen, Tenant-Isolation bleibt permissiv davor.
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO %s '
    'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_link_actor_delete', 'commercial_document_link', actor_policy_role
  );
END
$f801_actor_policies$;
--> statement-breakpoint
CREATE TRIGGER commercial_document_link_no_truncate
BEFORE TRUNCATE ON public.commercial_document_link
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();