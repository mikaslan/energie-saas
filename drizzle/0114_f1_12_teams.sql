-- ═══════════════════════════════════════════════════════════════════════
-- F1-12 Teams (Slice 1: Stammdaten + Termin-Bindung): benannte Teams mit
-- Mitgliedern (Membership-Bindung, M1-09-Muster); Archiv statt Delete.
-- project_appointment.team_id wird per Composite-FK angebunden
-- (ON DELETE SET NULL); nur aktive Teams sind zuweisbar (Service-Guard).
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_name_ck" CHECK ("team"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("team"."name") <= 120 and "team"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "team_name_normalized_ck" CHECK ("team"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("team"."name_normalized"))),
	CONSTRAINT "team_revision_ck" CHECK ("team"."revision" between 1 and 2147483647),
	CONSTRAINT "team_timestamps_ck" CHECK ("team"."updated_at" >= "team"."created_at" and pg_catalog.isfinite("team"."created_at") and pg_catalog.isfinite("team"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "team_ws_active_idx" ON "team" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "team_ws_id_uq" ON "team" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_ws_active_name_uq" ON "team" USING btree ("workspace_id","name_normalized") WHERE "team"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "team_member_ws_id_uq" ON "team_member" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_member_ws_team_membership_uq" ON "team_member" USING btree ("workspace_id","team_id","membership_id");--> statement-breakpoint
CREATE INDEX "team_member_ws_membership_idx" ON "team_member" USING btree ("workspace_id","membership_id");--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-12: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: settings.manage (Verwaltung) / calendar.read (Optionen) /
-- appointment.write (Termin-Bindung) im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.team ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.team FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.team
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE public.team_member ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.team_member FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.team_member
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
