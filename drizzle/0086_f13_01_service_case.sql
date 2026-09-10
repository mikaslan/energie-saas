CREATE TABLE "service_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"due_date" text,
	"completed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_case_status_ck" CHECK ("service_case"."status" in ('open', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "service_case_title_ck" CHECK (pg_catalog.length(pg_catalog.btrim("service_case"."title")) between 1 and 160),
	CONSTRAINT "service_case_description_ck" CHECK ("service_case"."description" is null or (pg_catalog.length("service_case"."description") between 1 and 2000 and "service_case"."description" = pg_catalog.btrim("service_case"."description"))),
	CONSTRAINT "service_case_completed_ck" CHECK (("service_case"."status" = 'done' and "service_case"."completed_at" is not null) or ("service_case"."status" <> 'done' and "service_case"."completed_at" is null)),
	CONSTRAINT "service_case_timestamps_ck" CHECK ("service_case"."updated_at" >= "service_case"."created_at" and pg_catalog.isfinite("service_case"."created_at") and pg_catalog.isfinite("service_case"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "service_case" ADD CONSTRAINT "service_case_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_case" ADD CONSTRAINT "service_case_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_case_ws_id_uq" ON "service_case" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "service_case_ws_project_idx" ON "service_case" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-01: RLS-Vertrag im F7.1-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0069 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.service_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.service_case FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.service_case
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);