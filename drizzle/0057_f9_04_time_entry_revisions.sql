CREATE TABLE "time_entry_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"type_id" uuid,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"working_time_minutes" integer,
	"break_duration_minutes" integer DEFAULT 0 NOT NULL,
	"comment" text,
	"revised_by" uuid NOT NULL,
	"revised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entry_revision_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "time_entry_revision" ADD CONSTRAINT "time_entry_revision_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entry_revision" ADD CONSTRAINT "time_entry_revision_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."time_entry"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entry_revision_ws_entry_idx" ON "time_entry_revision" USING btree ("workspace_id","entry_id","revised_at");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F9.4 Slice B: RLS-Vertrag im 0050-Muster (contact/project/time_entry):
-- permissive tenant_isolation ueber app.workspace_id + FORCE. Rollen-
-- Pruefung im Service-Layer (time.read = Viewer, time.write = Editor).
-- Revisionen sind operative CRM-Arbeit ohne Geldfluss — restriktive
-- Actor-Policies (0047-Muster) sind hier nicht angezeigt (DECIDED,
-- konsistent mit F1.8 Lead-Sources und 0050-Zeiterfassung).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.time_entry_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.time_entry_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.time_entry_revision
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);