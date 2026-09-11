CREATE TABLE "subsidy_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'vorbereitung' NOT NULL,
	"program" text,
	"bza_number" text,
	"bza_submitted_at" timestamp with time zone,
	"bza_approved_at" timestamp with time zone,
	"bnd_submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subsidy_case_status_ck" CHECK ("subsidy_case"."status" in (
        'vorbereitung', 'bza_eingereicht', 'korrektur', 'bza_bewilligt',
        'bnd_eingereicht', 'abgeschlossen', 'storniert'
      )),
	CONSTRAINT "subsidy_case_program_ck" CHECK ("subsidy_case"."program" is null or "subsidy_case"."program" in (
        'kfw', 'bafa', 'sonstige'
      )),
	CONSTRAINT "subsidy_case_bza_number_ck" CHECK ("subsidy_case"."bza_number" is null or pg_catalog.length(pg_catalog.btrim("subsidy_case"."bza_number")) between 1 and 64)
);--> statement-breakpoint
ALTER TABLE "subsidy_case" ADD CONSTRAINT "subsidy_case_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subsidy_case" ADD CONSTRAINT "subsidy_case_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subsidy_case" ADD CONSTRAINT "subsidy_case_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subsidy_case_ws_id_uq" ON "subsidy_case" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subsidy_case_ws_project_uq" ON "subsidy_case" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "subsidy_case_ws_project_idx" ON "subsidy_case" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
ALTER TABLE public.subsidy_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.subsidy_case FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subsidy_case
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-03 Foerderservice-Akte (KfW/BAFA, Katalog F13.2 Slice 1): EIN
-- Datensatz je Projekt (UNIQUE, v1-Grenze). Maschine vorbereitung →
-- bza_eingereicht → bza_bewilligt → bnd_eingereicht → abgeschlossen;
-- korrektur aus bza/bnd_eingereicht mit Wiedereinstieg je Phase;
-- storniert aus jedem nicht-abgeschlossenen Zustand, terminal.
-- Programm (kfw/bafa/sonstige, ESTIMATE-Wortschatz) + manuelle
-- BzA-Nummern-Verknuepfung pflegbar; Zeiten je Uebergang.
-- RLS-Vertrag tenant_isolation + FORCE (Muster 0103). Rechte:
-- installation.read/installation.write im Service-Layer (keine neue
-- Permission, keine Grants — Rollenvertrag wie 0103).
-- Portal-Sicht und BnD-Beleg-Upload sind Folgeslices (F10-04-Muster).
-- ═══════════════════════════════════════════════════════════════════════
