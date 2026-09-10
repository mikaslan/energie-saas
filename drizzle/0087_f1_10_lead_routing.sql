CREATE TABLE "project_lead_routing_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_source_id" uuid NOT NULL,
	"assignee_membership_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_lead_routing_rule_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_lead_source_fk" FOREIGN KEY ("workspace_id","lead_source_id") REFERENCES "public"."lead_source"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lead_routing_rule" ADD CONSTRAINT "project_lead_routing_rule_membership_fk" FOREIGN KEY ("workspace_id","assignee_membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_lead_routing_rule_ws_source_uq" ON "project_lead_routing_rule" USING btree ("workspace_id","lead_source_id");--> statement-breakpoint
CREATE INDEX "project_lead_routing_rule_ws_membership_idx" ON "project_lead_routing_rule" USING btree ("workspace_id","assignee_membership_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-10: RLS-Vertrag im F7.1-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0069 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.project_lead_routing_rule ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_lead_routing_rule FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_lead_routing_rule
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);