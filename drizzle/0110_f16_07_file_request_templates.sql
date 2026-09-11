CREATE TABLE "file_request_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_request_template_name_ck" CHECK ("file_request_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("file_request_template"."name") <= 200 and "file_request_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "file_request_template_name_normalized_ck" CHECK ("file_request_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("file_request_template"."name_normalized"))),
	CONSTRAINT "file_request_template_title_ck" CHECK (pg_catalog.length(pg_catalog.btrim("file_request_template"."title")) between 1 and 160),
	CONSTRAINT "file_request_template_description_ck" CHECK ("file_request_template"."description" IS NULL OR (pg_catalog.length(pg_catalog.btrim("file_request_template"."description")) between 1 and 2000)),
	CONSTRAINT "file_request_template_position_ck" CHECK ("file_request_template"."position" >= 0),
	CONSTRAINT "file_request_template_timestamps_ck" CHECK ("file_request_template"."updated_at" >= "file_request_template"."created_at" and pg_catalog.isfinite("file_request_template"."created_at") and pg_catalog.isfinite("file_request_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "file_request_template" ADD CONSTRAINT "file_request_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_request_template_ws_idx" ON "file_request_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "file_request_template_ws_id_uq" ON "file_request_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_request_template_ws_active_name_uq" ON "file_request_template" USING btree ("workspace_id","name_normalized") WHERE "file_request_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-07: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: project.read/project.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.file_request_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.file_request_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.file_request_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
