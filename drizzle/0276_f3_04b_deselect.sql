CREATE TABLE "planning_panel_deselect" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"row" integer NOT NULL,
	"col" integer NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_panel_deselect_row_ck" CHECK ("planning_panel_deselect"."row" >= 1),
	CONSTRAINT "planning_panel_deselect_col_ck" CHECK ("planning_panel_deselect"."col" >= 1),
	CONSTRAINT "planning_panel_deselect_reason_ck" CHECK ("planning_panel_deselect"."reason" IS NULL OR (char_length("planning_panel_deselect"."reason") >= 1 AND char_length("planning_panel_deselect"."reason") <= 280)),
	CONSTRAINT "planning_panel_deselect_timestamps_ck" CHECK ("planning_panel_deselect"."updated_at" >= "planning_panel_deselect"."created_at" and pg_catalog.isfinite("planning_panel_deselect"."created_at") and pg_catalog.isfinite("planning_panel_deselect"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_panel_deselect" ADD CONSTRAINT "planning_panel_deselect_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_panel_deselect" ADD CONSTRAINT "planning_panel_deselect_group_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."planning_panel_group"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_panel_deselect_ws_id_uq" ON "planning_panel_deselect" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_panel_deselect_cell_uq" ON "planning_panel_deselect" USING btree ("group_id","row","col");--> statement-breakpoint
CREATE INDEX "planning_panel_deselect_ws_group_idx" ON "planning_panel_deselect" USING btree ("workspace_id","group_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-04b: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission; DELETE-Grant analog
-- project_assignment, Abwahlen sind frei revidierbar).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_panel_deselect ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_panel_deselect FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_panel_deselect
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint