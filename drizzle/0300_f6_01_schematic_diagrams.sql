CREATE TABLE "schematic_diagrams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"variant_revision" integer NOT NULL,
	"netlist" jsonb NOT NULL,
	"node_count" integer,
	"edge_count" integer,
	"builder_version" text DEFAULT 'single-line-v1' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schematic_diagrams_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "schematic_diagrams_ws_offer_revision_uq" UNIQUE("workspace_id","offer_id","variant_revision"),
	CONSTRAINT "schematic_diagrams_revision_ck" CHECK ("schematic_diagrams"."revision" >= 1),
	CONSTRAINT "schematic_diagrams_counts_ck" CHECK ("schematic_diagrams"."node_count" >= 0 and "schematic_diagrams"."edge_count" >= 0),
	CONSTRAINT "schematic_diagrams_netlist_ck" CHECK (pg_catalog.jsonb_typeof("schematic_diagrams"."netlist") = 'object' and pg_catalog.jsonb_typeof("schematic_diagrams"."netlist"->'nodes') = 'array' and pg_catalog.jsonb_typeof("schematic_diagrams"."netlist"->'edges') = 'array')
);
--> statement-breakpoint
ALTER TABLE "schematic_diagrams" ADD CONSTRAINT "schematic_diagrams_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schematic_diagrams" ADD CONSTRAINT "schematic_diagrams_offer_fk" FOREIGN KEY ("workspace_id","offer_id") REFERENCES "public"."offer"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F6-01: RLS-Vertrag im 0068-Muster (tenant_isolation + FORCE, bytegleiche
-- Policy-Formulierung für Pin-Stabilität). Persistierte Schaltbilder sind
-- lesbare Angebots-Snapshots ohne Geldfluss: keine Actor-Policies.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.schematic_diagrams ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.schematic_diagrams FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.schematic_diagrams
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F6-01: app_runtime legt Diagramme an, liest und schreibt neu aus
-- (SELECT/INSERT/UPDATE — kein DELETE: Neuauslegung ist UPDATE mit
-- Revisions-Bump, Muster 0099). Der Rollenvertrag normalisiert die ACL.
-- ═══════════════════════════════════════════════════════════════════════
DO $schematic_diagrams_grants$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.schematic_diagrams TO app_runtime;
  END IF;
END
$schematic_diagrams_grants$;