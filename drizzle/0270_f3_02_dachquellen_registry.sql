CREATE TABLE "planning_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text,
	"sha256" text,
	"byte_size" integer,
	"scale_ref_json" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_source_kind_ck" CHECK ("planning_source"."kind" in ('upload', 'self_drawn')),
	CONSTRAINT "planning_source_upload_fields_ck" CHECK (("planning_source"."kind" <> 'upload') OR ("planning_source"."storage_key" IS NOT NULL AND "planning_source"."sha256" IS NOT NULL AND "planning_source"."byte_size" IS NOT NULL)),
	CONSTRAINT "planning_source_self_drawn_fields_ck" CHECK (("planning_source"."kind" <> 'self_drawn') OR ("planning_source"."storage_key" IS NULL AND "planning_source"."sha256" IS NULL AND "planning_source"."byte_size" IS NULL AND "planning_source"."scale_ref_json" IS NULL)),
	CONSTRAINT "planning_source_scale_ref_ck" CHECK ("planning_source"."scale_ref_json" IS NULL OR (jsonb_typeof("planning_source"."scale_ref_json") = 'object' AND ("planning_source"."scale_ref_json"->>'meters')::double precision > 0 AND ("planning_source"."scale_ref_json"->>'pixelLength')::double precision > 0)),
	CONSTRAINT "planning_source_timestamps_ck" CHECK ("planning_source"."updated_at" >= "planning_source"."created_at" and pg_catalog.isfinite("planning_source"."created_at") and pg_catalog.isfinite("planning_source"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_source" ADD CONSTRAINT "planning_source_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_source" ADD CONSTRAINT "planning_source_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_source" ADD CONSTRAINT "planning_source_site_fk" FOREIGN KEY ("workspace_id","site_id") REFERENCES "public"."site"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_source_ws_id_uq" ON "planning_source" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_source_ws_project_idx" ON "planning_source" USING btree ("workspace_id","project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_source_project_sha_uq" ON "planning_source" USING btree ("project_id","sha256");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-02: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission, kein DELETE-Grant).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_source ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_source FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_source
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
