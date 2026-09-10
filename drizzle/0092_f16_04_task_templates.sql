CREATE TABLE "task_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"title" text NOT NULL,
	"due_offset_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_template_name_ck" CHECK ("task_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("task_template"."name") <= 200 and "task_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "task_template_name_normalized_ck" CHECK ("task_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("task_template"."name_normalized"))),
	CONSTRAINT "task_template_title_ck" CHECK (pg_catalog.length(pg_catalog.btrim("task_template"."title")) between 1 and 200),
	CONSTRAINT "task_template_due_offset_ck" CHECK ("task_template"."due_offset_days" is null or ("task_template"."due_offset_days" between 0 and 3650)),
	CONSTRAINT "task_template_position_ck" CHECK ("task_template"."position" >= 0),
	CONSTRAINT "task_template_timestamps_ck" CHECK ("task_template"."updated_at" >= "task_template"."created_at" and pg_catalog.isfinite("task_template"."created_at") and pg_catalog.isfinite("task_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "task_template" ADD CONSTRAINT "task_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_template_ws_idx" ON "task_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "task_template_ws_id_uq" ON "task_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_template_ws_active_name_uq" ON "task_template" USING btree ("workspace_id","name_normalized") WHERE "task_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-04: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: task.read/task.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.task_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.task_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.task_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
