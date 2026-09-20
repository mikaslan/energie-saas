CREATE TABLE "planning_inverter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"label" text NOT NULL,
	"mpp_trackers" integer NOT NULL,
	"max_string_modules" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_inverter_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "planning_inverter_label_ck" CHECK (char_length("planning_inverter"."label") > 0),
	CONSTRAINT "planning_inverter_mpp_ck" CHECK ("planning_inverter"."mpp_trackers" >= 1 AND "planning_inverter"."mpp_trackers" <= 12),
	CONSTRAINT "planning_inverter_max_ck" CHECK ("planning_inverter"."max_string_modules" IS NULL OR "planning_inverter"."max_string_modules" >= 1),
	CONSTRAINT "planning_inverter_timestamps_ck" CHECK ("planning_inverter"."updated_at" >= "planning_inverter"."created_at" and pg_catalog.isfinite("planning_inverter"."created_at") and pg_catalog.isfinite("planning_inverter"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "planning_string" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"inverter_id" uuid NOT NULL,
	"tracker_slot" integer NOT NULL,
	"label" text NOT NULL,
	"member_json" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planning_string_label_ck" CHECK (char_length("planning_string"."label") > 0),
	CONSTRAINT "planning_string_slot_ck" CHECK ("planning_string"."tracker_slot" >= 1),
	CONSTRAINT "planning_string_member_ck" CHECK (jsonb_typeof("planning_string"."member_json") = 'array'
        AND jsonb_array_length("planning_string"."member_json") >= 1
        AND jsonb_array_length("planning_string"."member_json") <= 200),
	CONSTRAINT "planning_string_timestamps_ck" CHECK ("planning_string"."updated_at" >= "planning_string"."created_at" and pg_catalog.isfinite("planning_string"."created_at") and pg_catalog.isfinite("planning_string"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "planning_inverter" ADD CONSTRAINT "planning_inverter_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_inverter" ADD CONSTRAINT "planning_inverter_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_string" ADD CONSTRAINT "planning_string_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_string" ADD CONSTRAINT "planning_string_inverter_fk" FOREIGN KEY ("workspace_id","inverter_id") REFERENCES "public"."planning_inverter"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planning_inverter_ws_project_idx" ON "planning_inverter" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_string_ws_id_uq" ON "planning_string" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "planning_string_ws_inverter_idx" ON "planning_string" USING btree ("workspace_id","inverter_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F3-05a: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- Rechte im Service-Layer (keine neue Permission; DELETE-Grant analog
-- project_assignment, WR + Strings sind frei revidierbar).
-- Policy-Formulierung bytegleich zu 0086 (Pin-Stabilität).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.planning_inverter ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_inverter FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_inverter
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE public.planning_string ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.planning_string FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.planning_string
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- F3-05a: Member-Einträge tragen je eine group_id (Array-Form sichert
-- der Inline-CHECK). CHECKs dulden keine Subqueries — daher immutable
-- plpgsql-Kapsel nach 0271-Muster (STRICT: Spalte ist NOT NULL).
CREATE FUNCTION public.planning_string_members_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $f305_members_valid$
DECLARE
  element jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(value) < 1 OR jsonb_array_length(value) > 200 THEN
    RETURN FALSE;
  END IF;
  FOR element IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(element) <> 'object' THEN
      RETURN FALSE;
    END IF;
    IF NOT (element ? 'group_id') THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END
$f305_members_valid$;--> statement-breakpoint
ALTER TABLE public.planning_string ADD CONSTRAINT planning_string_members_valid_ck CHECK (public.planning_string_members_valid(member_json));