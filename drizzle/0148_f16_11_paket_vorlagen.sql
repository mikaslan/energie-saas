-- ═══════════════════════════════════════════════════════════════════════
-- F16-11 Paket-Vorlagen (Katalog F16.2 „Pakete/Planning Packages",
-- erster Offshoot: ersetzende Positions-Presets): benannte Pakete je
-- Workspace — eine Sektion (Titel + Kategorie) mit freien Positionen
-- (Name, Menge, Einheit, VK/EK, Positionsart, Sichtbarkeit) als
-- JSON-Array. Anwenden ersetzt die frei editierbare (Custom-)Ebene
-- einer Angebotsvariante via Revise-Ops; Katalog-Seed-Zeilen bleiben
-- durch die M2-Invariante unangetastet (remove_custom_* verweigert
-- Nicht-Custom). Steuer: standard_19 (0-%-Pakete bleiben offen).
-- Archiv statt Delete (active-Flag, F7.3/F16.3-Muster wie F16-05–10).
-- Rechte: discount_template.read/discount_template.write im
-- Service-Layer (gleiche Einstellungs-Familie wie F16-06, keine neue
-- Permission); Anwenden prüft der Angebots-Pfad (project.write +
-- price.edit/price.read_purchase) selbst.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "package_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"section_title" text NOT NULL,
	"category" text NOT NULL,
	"package_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_template_name_ck" CHECK ("package_template"."name" ~ '^[^[:space:]].*$' and pg_catalog.length("package_template"."name") <= 200 and "package_template"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "package_template_name_normalized_ck" CHECK ("package_template"."name_normalized" = pg_catalog.lower(pg_catalog.btrim("package_template"."name_normalized"))),
	CONSTRAINT "package_template_section_title_ck" CHECK (pg_catalog.length(pg_catalog.btrim("package_template"."section_title")) between 1 and 120),
	CONSTRAINT "package_template_category_ck" CHECK ("package_template"."category" in ('module', 'inverter', 'battery', 'wallbox', 'heat_pump', 'mounting', 'other')),
	CONSTRAINT "package_template_lines_ck" CHECK (jsonb_typeof("package_template"."package_lines") = 'array' and jsonb_array_length("package_template"."package_lines") <= 50),
	CONSTRAINT "package_template_position_ck" CHECK ("package_template"."position" >= 0),
	CONSTRAINT "package_template_timestamps_ck" CHECK ("package_template"."updated_at" >= "package_template"."created_at" and pg_catalog.isfinite("package_template"."created_at") and pg_catalog.isfinite("package_template"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "package_template" ADD CONSTRAINT "package_template_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_template_ws_idx" ON "package_template" USING btree ("workspace_id","active","position");--> statement-breakpoint
CREATE UNIQUE INDEX "package_template_ws_id_uq" ON "package_template" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_template_ws_active_name_uq" ON "package_template" USING btree ("workspace_id","name_normalized") WHERE "package_template"."active";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F16-11: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte: discount_template.read/discount_template.write im
-- Service-Layer (keine neue Permission, kein DELETE-Grant).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.package_template ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.package_template FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.package_template
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
