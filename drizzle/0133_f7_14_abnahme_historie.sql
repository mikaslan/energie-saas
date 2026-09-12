CREATE TABLE "installation_handover" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"by_name" text NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_handover_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "installation_handover_by_name_ck" CHECK (pg_catalog.length(pg_catalog.btrim("installation_handover"."by_name")) between 1 and 160 and "installation_handover"."by_name" = pg_catalog.btrim("installation_handover"."by_name")),
	CONSTRAINT "installation_handover_note_ck" CHECK ("installation_handover"."note" is null or (pg_catalog.length("installation_handover"."note") between 1 and 500 and "installation_handover"."note" = pg_catalog.btrim("installation_handover"."note"))),
	CONSTRAINT "installation_handover_recorded_ck" CHECK (pg_catalog.isfinite("installation_handover"."recorded_at"))
);
--> statement-breakpoint
ALTER TABLE "installation_handover" ADD CONSTRAINT "installation_handover_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_handover" ADD CONSTRAINT "installation_handover_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."installation"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installation_handover_ws_installation_idx" ON "installation_handover" USING btree ("workspace_id","installation_id","recorded_at","id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7-14: RLS-Vertrag im F13-11/F13-01-Muster (tenant_isolation + FORCE).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.installation_handover ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.installation_handover FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.installation_handover
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
