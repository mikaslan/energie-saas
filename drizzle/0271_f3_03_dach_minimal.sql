CREATE TABLE "planning_roof_min" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"polygon_json" jsonb NOT NULL,
	"tilt_per_edge_json" jsonb,
	"flat_single_tilt" double precision,
	"edge_margins_json" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_roof_min_polygon_ck" CHECK (jsonb_typeof("planning_roof_min"."polygon_json") = 'array' AND jsonb_array_length("planning_roof_min"."polygon_json") between 3 and 64),
	CONSTRAINT "planning_roof_min_tilt_xor_ck" CHECK (("planning_roof_min"."tilt_per_edge_json" IS NULL) <> ("planning_roof_min"."flat_single_tilt" IS NULL)),
	CONSTRAINT "planning_roof_min_flat_tilt_ck" CHECK ("planning_roof_min"."flat_single_tilt" IS NULL OR ("planning_roof_min"."flat_single_tilt" >= 0 AND "planning_roof_min"."flat_single_tilt" <= 90)),
	CONSTRAINT "planning_roof_min_timestamps_ck" CHECK ("planning_roof_min"."updated_at" >= "planning_roof_min"."created_at" and pg_catalog.isfinite("planning_roof_min"."created_at") and pg_catalog.isfinite("planning_roof_min"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_roof_min" ADD CONSTRAINT "planning_roof_min_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_roof_min" ADD CONSTRAINT "planning_roof_min_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."planning_source"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_roof_min_ws_id_uq" ON "planning_roof_min" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_roof_min_ws_source_idx" ON "planning_roof_min" USING btree ("workspace_id","source_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-03: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission, kein DELETE-Grant).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_roof_min ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_roof_min FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_roof_min
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- F3-03: Neigung-pro-Kante liegt als JSON-Array vor (eine Zahl je
-- Kante, 0-90). CHECKs dulden keine Subqueries — daher immutable
-- plpgsql-Kapsel ( STRICT: NULL passiert, XOR-CHECK regelt NULL).
CREATE FUNCTION public.planning_roof_min_tilt_per_edge_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $f303_tilt_valid$
DECLARE
  element jsonb;
  degrees double precision;
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  FOR element IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(element) <> 'number' THEN
      RETURN FALSE;
    END IF;
    degrees := element::text::double precision;
    IF degrees < 0 OR degrees > 90 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END
$f303_tilt_valid$;--> statement-breakpoint
ALTER TABLE public.planning_roof_min ADD CONSTRAINT planning_roof_min_tilt_per_edge_ck CHECK (public.planning_roof_min_tilt_per_edge_valid(tilt_per_edge_json));
