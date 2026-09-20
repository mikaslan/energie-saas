CREATE TABLE "planning_panel_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"roof_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"origin_json" jsonb NOT NULL,
	"rows" integer NOT NULL,
	"cols" integer NOT NULL,
	"module_w_m" double precision NOT NULL,
	"module_h_m" double precision NOT NULL,
	"gap_m" double precision NOT NULL,
	"tilt_deg" double precision,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_panel_group_kind_ck" CHECK ("planning_panel_group"."kind" in ('h', 'v')),
	CONSTRAINT "planning_panel_group_label_ck" CHECK (char_length("planning_panel_group"."label") > 0),
	CONSTRAINT "planning_panel_group_origin_ck" CHECK (jsonb_typeof("planning_panel_group"."origin_json") = 'object'
        AND ("planning_panel_group"."origin_json" ? 'x')
        AND ("planning_panel_group"."origin_json" ? 'y')),
	CONSTRAINT "planning_panel_group_rows_ck" CHECK ("planning_panel_group"."rows" >= 1 AND "planning_panel_group"."rows" <= 200),
	CONSTRAINT "planning_panel_group_cols_ck" CHECK ("planning_panel_group"."cols" >= 1 AND "planning_panel_group"."cols" <= 200),
	CONSTRAINT "planning_panel_group_module_ck" CHECK ("planning_panel_group"."module_w_m" >= 0.1 AND "planning_panel_group"."module_w_m" <= 5 AND "planning_panel_group"."module_h_m" >= 0.1 AND "planning_panel_group"."module_h_m" <= 5),
	CONSTRAINT "planning_panel_group_gap_ck" CHECK ("planning_panel_group"."gap_m" >= 0 AND "planning_panel_group"."gap_m" <= 2),
	CONSTRAINT "planning_panel_group_tilt_ck" CHECK ("planning_panel_group"."tilt_deg" IS NULL OR ("planning_panel_group"."tilt_deg" >= 0 AND "planning_panel_group"."tilt_deg" <= 90)),
	CONSTRAINT "planning_panel_group_rect_ck" CHECK (("planning_panel_group"."cols" * "planning_panel_group"."module_w_m" + ("planning_panel_group"."cols" - 1) * "planning_panel_group"."gap_m") > 0
        AND ("planning_panel_group"."rows" * "planning_panel_group"."module_h_m" + ("planning_panel_group"."rows" - 1) * "planning_panel_group"."gap_m") > 0),
	CONSTRAINT "planning_panel_group_timestamps_ck" CHECK ("planning_panel_group"."updated_at" >= "planning_panel_group"."created_at" and pg_catalog.isfinite("planning_panel_group"."created_at") and pg_catalog.isfinite("planning_panel_group"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_panel_group" ADD CONSTRAINT "planning_panel_group_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_panel_group" ADD CONSTRAINT "planning_panel_group_roof_fk" FOREIGN KEY ("workspace_id","roof_id") REFERENCES "public"."planning_roof_min"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_panel_group_ws_id_uq" ON "planning_panel_group" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_panel_group_ws_roof_idx" ON "planning_panel_group" USING btree ("workspace_id","roof_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-04a: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission; DELETE-Grant analog
-- project_assignment, Gruppen sind frei revidierbar).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_panel_group ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_panel_group FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_panel_group
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint