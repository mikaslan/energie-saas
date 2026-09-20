CREATE TABLE "planning_string_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"string_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"row_from" integer NOT NULL,
	"row_to" integer NOT NULL,
	"col_from" integer NOT NULL,
	"col_to" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_string_member_row_ck" CHECK ("planning_string_member"."row_from" >= 1 AND "planning_string_member"."row_to" >= "planning_string_member"."row_from"),
	CONSTRAINT "planning_string_member_col_ck" CHECK ("planning_string_member"."col_from" >= 1 AND "planning_string_member"."col_to" >= "planning_string_member"."col_from"),
	CONSTRAINT "planning_string_member_timestamps_ck" CHECK ("planning_string_member"."updated_at" >= "planning_string_member"."created_at" and pg_catalog.isfinite("planning_string_member"."created_at") and pg_catalog.isfinite("planning_string_member"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_string_member" ADD CONSTRAINT "planning_string_member_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_string_member" ADD CONSTRAINT "planning_string_member_string_fk" FOREIGN KEY ("workspace_id","string_id") REFERENCES "public"."planning_string"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_string_member" ADD CONSTRAINT "planning_string_member_group_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."planning_panel_group"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_string_member_ws_id_uq" ON "planning_string_member" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_string_member_ws_string_idx" ON "planning_string_member" USING btree ("workspace_id","string_id");--> statement-breakpoint
CREATE INDEX "planning_string_member_ws_group_idx" ON "planning_string_member" USING btree ("workspace_id","group_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-05c: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission; DELETE-Grant analog
-- project_assignment, Member sind frei revidierbar).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_string_member ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_string_member FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_string_member
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint