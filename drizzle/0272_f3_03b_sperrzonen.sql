CREATE TABLE "planning_roof_restriction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"roof_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"rect_json" jsonb NOT NULL,
	"height_m" double precision,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_roof_restriction_kind_ck" CHECK ("planning_roof_restriction"."kind" in ('chimney', 'window', 'other')),
	CONSTRAINT "planning_roof_restriction_rect_ck" CHECK (jsonb_typeof("planning_roof_restriction"."rect_json") = 'object'
        AND ("planning_roof_restriction"."rect_json"->>'width')::double precision > 0
        AND ("planning_roof_restriction"."rect_json"->>'height')::double precision > 0),
	CONSTRAINT "planning_roof_restriction_height_ck" CHECK ("planning_roof_restriction"."height_m" IS NULL OR ("planning_roof_restriction"."height_m" >= 0 AND "planning_roof_restriction"."height_m" <= 50)),
	CONSTRAINT "planning_roof_restriction_label_ck" CHECK (char_length("planning_roof_restriction"."label") > 0),
	CONSTRAINT "planning_roof_restriction_timestamps_ck" CHECK ("planning_roof_restriction"."updated_at" >= "planning_roof_restriction"."created_at" and pg_catalog.isfinite("planning_roof_restriction"."created_at") and pg_catalog.isfinite("planning_roof_restriction"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_roof_restriction" ADD CONSTRAINT "planning_roof_restriction_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_roof_restriction" ADD CONSTRAINT "planning_roof_restriction_roof_fk" FOREIGN KEY ("workspace_id","roof_id") REFERENCES "public"."planning_roof_min"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_roof_restriction_ws_id_uq" ON "planning_roof_restriction" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_roof_restriction_ws_roof_idx" ON "planning_roof_restriction" USING btree ("workspace_id","roof_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-03b: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission; DELETE-Grant analog
-- project_assignment, Sperrzonen sind frei revidierbar).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_roof_restriction ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_roof_restriction FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_roof_restriction
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
