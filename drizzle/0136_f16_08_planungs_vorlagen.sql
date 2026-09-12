-- ═══════════════════════════════════════════════════════════════════════
-- F16-08 Planungs-Vorlagen (Katalog F16.3 „Vorlagentyp Planung"): benannte
-- Planungsmodus-Presets (quick/2d/3d) je Workspace, Verwaltung in den
-- Einstellungen, Anwenden an einer Angebotsvariante (set_planning_mode).
-- Archiv statt Delete (active-Flag, F7.3/F16.3-Muster wie F16-05/06/07).
-- Rechte: planning.settings.read/settings.manage im Service-Layer
-- (keine neue Permission); Anwenden prüft der Angebots-Pfad
-- (project.write) selbst.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "planning_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"mode" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_template_name_ck" CHECK ("planning_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("planning_template"."name") <= 200 and "planning_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "planning_template_name_normalized_ck" CHECK ("planning_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("planning_template"."name_normalized"))),
	CONSTRAINT "planning_template_mode_ck" CHECK ("planning_template"."mode" in ('quick', '2d', '3d')),
	CONSTRAINT "planning_template_position_ck" CHECK ("planning_template"."position" >= 0),
	CONSTRAINT "planning_template_timestamps_ck" CHECK ("planning_template"."updated_at" >= "planning_template"."created_at" and pg_catalog.isfinite("planning_template"."created_at") and pg_catalog.isfinite("planning_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_template" ADD CONSTRAINT "planning_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planning_template_ws_idx" ON "planning_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_template_ws_id_uq" ON "planning_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_template_ws_active_name_uq" ON "planning_template" USING btree ("workspace_id","name_normalized") WHERE "planning_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-08: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: planning.settings.read/settings.manage im Service-Layer
-- (keine neue Permission, kein DELETE-Grant).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.planning_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
