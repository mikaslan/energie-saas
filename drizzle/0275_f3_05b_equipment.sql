CREATE TABLE "planning_string_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"string_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"panel_ref_json" jsonb,
	"equipment" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_string_equipment_scope_ck" CHECK ("planning_string_equipment"."scope" in ('string', 'panel')),
	CONSTRAINT "planning_string_equipment_type_ck" CHECK ("planning_string_equipment"."equipment" in ('optimizer', 'micro_inverter')),
	CONSTRAINT "planning_string_equipment_ref_ck" CHECK (("planning_string_equipment"."scope" = 'string' AND "planning_string_equipment"."panel_ref_json" IS NULL)
        OR ("planning_string_equipment"."scope" = 'panel'
          AND "planning_string_equipment"."panel_ref_json" IS NOT NULL
          AND jsonb_typeof("planning_string_equipment"."panel_ref_json") = 'object'
          AND ("planning_string_equipment"."panel_ref_json" ? 'group_id')
          AND ("planning_string_equipment"."panel_ref_json"->>'row')::integer >= 1
          AND ("planning_string_equipment"."panel_ref_json"->>'col')::integer >= 1)),
	CONSTRAINT "planning_string_equipment_micro_ck" CHECK ("planning_string_equipment"."equipment" <> 'micro_inverter' OR "planning_string_equipment"."scope" = 'panel'),
	CONSTRAINT "planning_string_equipment_timestamps_ck" CHECK ("planning_string_equipment"."updated_at" >= "planning_string_equipment"."created_at" and pg_catalog.isfinite("planning_string_equipment"."created_at") and pg_catalog.isfinite("planning_string_equipment"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_string_equipment" ADD CONSTRAINT "planning_string_equipment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_string_equipment" ADD CONSTRAINT "planning_string_equipment_string_fk" FOREIGN KEY ("workspace_id","string_id") REFERENCES "public"."planning_string"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_string_equipment_ws_id_uq" ON "planning_string_equipment" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_string_equipment_ws_string_idx" ON "planning_string_equipment" USING btree ("workspace_id","string_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-05b: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission; DELETE-Grant analog
-- project_assignment, Equipment ist frei revidierbar).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_string_equipment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_string_equipment FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_string_equipment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint