CREATE TABLE "planning_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"deadline_kind" text DEFAULT 'standard_48h' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_request_status_ck" CHECK ("planning_request"."status" in ('requested', 'in_progress', 'finished', 'accepted')),
	CONSTRAINT "planning_request_deadline_kind_ck" CHECK ("planning_request"."deadline_kind" in ('express_24h', 'standard_48h', 'date')),
	CONSTRAINT "planning_request_deadline_ck" CHECK ("planning_request"."deadline_at" >= "planning_request"."created_at" and pg_catalog.isfinite("planning_request"."deadline_at")),
	CONSTRAINT "planning_request_timestamps_ck" CHECK ("planning_request"."updated_at" >= "planning_request"."created_at" and pg_catalog.isfinite("planning_request"."created_at") and pg_catalog.isfinite("planning_request"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_request" ADD CONSTRAINT "planning_request_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_request" ADD CONSTRAINT "planning_request_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_request" ADD CONSTRAINT "planning_request_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_request_ws_id_uq" ON "planning_request" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_request_ws_offer_uq" ON "planning_request" USING btree ("workspace_id","offer_id");--> statement-breakpoint
CREATE INDEX "planning_request_ws_project_idx" ON "planning_request" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-11: RLS-Vertrag im F13-01-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_request FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_request
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
