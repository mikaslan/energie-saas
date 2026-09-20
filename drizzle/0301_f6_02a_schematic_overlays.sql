CREATE TABLE "schematic_overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_revision" integer NOT NULL,
	"parent_revision" integer NOT NULL,
	"elements" jsonb NOT NULL,
	"element_count" integer,
	"editor_version" text DEFAULT 'editor-overlay.v1' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schematic_overlays_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "schematic_overlays_ws_offer_revision_uq" UNIQUE("workspace_id","offer_id","variant_revision"),
	CONSTRAINT "schematic_overlays_revision_ck" CHECK ("schematic_overlays"."revision" >= 1),
	CONSTRAINT "schematic_overlays_parent_revision_ck" CHECK ("schematic_overlays"."parent_revision" >= 1),
	CONSTRAINT "schematic_overlays_counts_ck" CHECK ("schematic_overlays"."element_count" >= 0),
	CONSTRAINT "schematic_overlays_elements_ck" CHECK (pg_catalog.jsonb_typeof("schematic_overlays"."elements") = 'object' and ("schematic_overlays"."elements" ? 'elements') and pg_catalog.jsonb_typeof("schematic_overlays"."elements"->'elements') = 'array')
);
--> statement-breakpoint
ALTER TABLE "schematic_overlays" ADD CONSTRAINT "schematic_overlays_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schematic_overlays" ADD CONSTRAINT "schematic_overlays_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F6-02a: RLS-Vertrag im 0068-Muster (tenant_isolation + FORCE, bytegleiche
-- Policy-Formulierung für Pin-Stabilität). Editor-Overlays sind lesbare
-- Angebots-Ergänzungen ohne Geldfluss: keine Actor-Policies.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.schematic_overlays ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.schematic_overlays FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.schematic_overlays
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F6-02a: app_runtime legt Overlays an, liest und schreibt neu aus
-- (SELECT/INSERT/UPDATE — kein DELETE: Neuauslegung ist UPDATE mit
-- Revisions-Bump, Muster 0099). Der Rollenvertrag normalisiert die ACL.
-- ═══════════════════════════════════════════════════════════════════════
DO $schematic_overlays_grants$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.schematic_overlays TO app_runtime;
  END IF;
END
$schematic_overlays_grants$;
