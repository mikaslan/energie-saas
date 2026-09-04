CREATE TABLE "calendar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"category_id" uuid,
	"calendar_type" text NOT NULL,
	"membership_id" uuid,
	"team_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "calendar_type_ck" CHECK ("calendar"."calendar_type" in ('team', 'tenancy', 'user', 'client')),
	CONSTRAINT "calendar_name_ck" CHECK (length(btrim("calendar"."name")) between 1 and 200
        and "calendar"."name" = normalize("calendar"."name", NFKC)
        and "calendar"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "calendar_color_ck" CHECK ("calendar"."color" is null or "calendar"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "calendar_scope_user_ck" CHECK ("calendar"."calendar_type" <> 'user'
        or ("calendar"."membership_id" is not null and "calendar"."team_id" is null)),
	CONSTRAINT "calendar_scope_team_ck" CHECK ("calendar"."calendar_type" <> 'team'
        or ("calendar"."team_id" is not null and "calendar"."membership_id" is null)),
	CONSTRAINT "calendar_scope_tenancy_ck" CHECK ("calendar"."calendar_type" <> 'tenancy'
        or ("calendar"."membership_id" is null and "calendar"."team_id" is null)),
	CONSTRAINT "calendar_scope_client_ck" CHECK ("calendar"."calendar_type" <> 'client'
        or ("calendar"."membership_id" is null and "calendar"."team_id" is null)),
	CONSTRAINT "calendar_revision_ck" CHECK ("calendar"."revision" between 1 and 2147483647),
	CONSTRAINT "calendar_timestamps_ck" CHECK ("calendar"."updated_at" >= "calendar"."created_at"
        and isfinite("calendar"."created_at")
        and isfinite("calendar"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "project_appointment" DROP CONSTRAINT "project_appointment_category_fk";
--> statement-breakpoint
DROP INDEX "project_appointment_ws_category_idx";--> statement-breakpoint
ALTER TABLE "project_appointment" ADD COLUMN "calendar_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."calendar_category"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar" ADD CONSTRAINT "calendar_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_ws_name_uq" ON "calendar" USING btree ("workspace_id",lower(btrim("name")));--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_ws_membership_user_uniq" ON "calendar" USING btree ("workspace_id","membership_id") WHERE "calendar"."calendar_type" = 'user';--> statement-breakpoint
CREATE INDEX "calendar_ws_type_active_idx" ON "calendar" USING btree ("workspace_id","calendar_type","active","name","id");--> statement-breakpoint
CREATE INDEX "calendar_ws_membership_idx" ON "calendar" USING btree ("workspace_id","membership_id");--> statement-breakpoint
CREATE INDEX "calendar_ws_team_idx" ON "calendar" USING btree ("workspace_id","team_id");--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_calendar_fk" FOREIGN KEY ("workspace_id","calendar_id") REFERENCES "public"."calendar"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_appointment_ws_calendar_range_idx" ON "project_appointment" USING btree ("workspace_id","calendar_id","start_at","end_at","id");--> statement-breakpoint
ALTER TABLE "project_appointment" DROP COLUMN "category_id";
-- ═══════════════════════════════════════════════════════════════════════
-- M1-15b: RLS-Vertrag Kalender (M1-CRM-Muster): tenant_isolation + FORCE.
-- Scope-Sichtbarkeit regelt der SERVICE (RBAC §7); RLS zieht die
-- Mandantengrenze. Persönliche Kalender werden LAZY provisioniert
-- (ensure_personal_calendar) — M1-15-Bestand ist leer (kein Kategorie-
-- CRUD), deshalb kein SQL-Backfill (ACCEPTED_EXCEPTION, Spec §4.2).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.calendar ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calendar FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.calendar
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
