CREATE TABLE "appointment_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"title" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_template_name_ck" CHECK ("appointment_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("appointment_template"."name") <= 200 and "appointment_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "appointment_template_name_normalized_ck" CHECK ("appointment_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("appointment_template"."name_normalized"))),
	CONSTRAINT "appointment_template_title_ck" CHECK (pg_catalog.length(pg_catalog.btrim("appointment_template"."title")) between 1 and 200),
	CONSTRAINT "appointment_template_duration_ck" CHECK ("appointment_template"."duration_minutes" between 1 and 2880),
	CONSTRAINT "appointment_template_position_ck" CHECK ("appointment_template"."position" >= 0),
	CONSTRAINT "appointment_template_timestamps_ck" CHECK ("appointment_template"."updated_at" >= "appointment_template"."created_at" and pg_catalog.isfinite("appointment_template"."created_at") and pg_catalog.isfinite("appointment_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "appointment_template" ADD CONSTRAINT "appointment_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_template_ws_idx" ON "appointment_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_template_ws_id_uq" ON "appointment_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_template_ws_active_name_uq" ON "appointment_template" USING btree ("workspace_id","name_normalized") WHERE "appointment_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-05: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: appointment.read/appointment.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.appointment_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.appointment_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.appointment_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
