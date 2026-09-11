CREATE TABLE "grid_registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'vorbereitung' NOT NULL,
	"operator_name" text,
	"meter_number" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_registration_status_ck" CHECK ("grid_registration"."status" in (
        'vorbereitung', 'eingereicht', 'genehmigt',
        'fertiggemeldet', 'abgeschlossen', 'storniert'
      )),
	CONSTRAINT "grid_registration_operator_ck" CHECK ("grid_registration"."operator_name" is null or pg_catalog.length(pg_catalog.btrim("grid_registration"."operator_name")) between 1 and 160),
	CONSTRAINT "grid_registration_meter_ck" CHECK ("grid_registration"."meter_number" is null or pg_catalog.length(pg_catalog.btrim("grid_registration"."meter_number")) between 1 and 64)
);--> statement-breakpoint
ALTER TABLE "grid_registration" ADD CONSTRAINT "grid_registration_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD CONSTRAINT "grid_registration_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD CONSTRAINT "grid_registration_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grid_registration_ws_id_uq" ON "grid_registration" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "grid_registration_ws_project_uq" ON "grid_registration" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "grid_registration_ws_project_idx" ON "grid_registration" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
ALTER TABLE public.grid_registration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.grid_registration FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.grid_registration
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F13-02 Netzanmeldung: ein Datensatz je Projekt (UNIQUE, v1-Grenze),
-- Maschine vorbereitung→…→abgeschlossen (+storniert terminal).
-- RLS-Vertrag tenant_isolation + FORCE (Muster 0094). Rechte:
-- installation.read/installation.write im Service-Layer (keine neue
-- Permission, keine Grants — Rollenvertrag wie 0094).
-- ═══════════════════════════════════════════════════════════════════════
