CREATE TABLE "kanban_board" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kanban_board_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "kanban_board_name_ck" CHECK (length(btrim("kanban_board"."name")) between 1 and 120),
	CONSTRAINT "kanban_board_scope_ck" CHECK ("kanban_board"."scope" in ('residential', 'commercial')),
	CONSTRAINT "kanban_board_default_active_ck" CHECK ("kanban_board"."is_default" = false or "kanban_board"."archived_at" is null)
);
--> statement-breakpoint
CREATE TABLE "kanban_column" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"column_type" text NOT NULL,
	"position" integer NOT NULL,
	"color" text DEFAULT 'neutral' NOT NULL,
	"is_intake" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kanban_column_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "kanban_column_ws_board_id_uq" UNIQUE("workspace_id","board_id","id"),
	CONSTRAINT "kanban_column_name_ck" CHECK (length(btrim("kanban_column"."name")) between 1 and 120),
	CONSTRAINT "kanban_column_type_ck" CHECK ("kanban_column"."column_type" in ('lead', 'offer', 'won', 'lost')),
	CONSTRAINT "kanban_column_position_ck" CHECK ("kanban_column"."position" > 0),
	CONSTRAINT "kanban_column_color_ck" CHECK ("kanban_column"."color" in ('neutral', 'blue', 'amber', 'green')),
	CONSTRAINT "kanban_column_intake_lead_ck" CHECK ("kanban_column"."is_intake" = false or "kanban_column"."column_type" = 'lead')
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "kanban_board_id" uuid;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "kanban_column_id" uuid;
--> statement-breakpoint
ALTER TABLE "kanban_board" ADD CONSTRAINT "kanban_board_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kanban_column" ADD CONSTRAINT "kanban_column_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kanban_column" ADD CONSTRAINT "kanban_column_board_fk" FOREIGN KEY ("workspace_id","board_id") REFERENCES "public"."kanban_board"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "kanban_board_ws_scope_idx" ON "kanban_board" USING btree ("workspace_id","scope");
--> statement-breakpoint
CREATE UNIQUE INDEX "kanban_board_ws_scope_default_uq" ON "kanban_board" USING btree ("workspace_id","scope") WHERE "kanban_board"."is_default" = true and "kanban_board"."archived_at" is null;
--> statement-breakpoint
CREATE INDEX "kanban_column_ws_board_idx" ON "kanban_column" USING btree ("workspace_id","board_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "kanban_column_ws_board_position_active_uq" ON "kanban_column" USING btree ("workspace_id","board_id","position") WHERE "kanban_column"."archived_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "kanban_column_ws_board_intake_active_uq" ON "kanban_column" USING btree ("workspace_id","board_id") WHERE "kanban_column"."is_intake" = true and "kanban_column"."archived_at" is null;
--> statement-breakpoint

-- M1-05 ist vor dem ersten produktiven Deploy noch lokal. Trotzdem wird der
-- Upgradepfad laut und fail-closed gehalten: ein unbekannter Project-Zustand
-- darf nicht still als Lead in "Eingang" umgedeutet werden.
-- workspace/project stehen bereits unter FORCE RLS. Der Migrations-Owner muss
-- für diesen rein schemaweiten Backfill alle Bestandszeilen sehen; ohne das
-- enge NO-FORCE-Fenster wären die SELECTs still leer und ein befüllter Upgrade-
-- Bestand würde erst am SET NOT NULL unspezifisch scheitern. ENABLE bleibt an,
-- nur der Tabellen-Owner darf während derselben Migration vorbeisehen.
ALTER TABLE public.workspace NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.project NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $m1_05_project_precondition$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project
    WHERE phase <> 'request' OR outcome <> 'open'
  ) THEN
    RAISE EXCEPTION
      'M1-05 kann Bestands-Projects ausserhalb request/open nicht automatisch einem Lead-Board zuordnen';
  END IF;
END
$m1_05_project_precondition$;
--> statement-breakpoint

INSERT INTO public.kanban_board (
  id, workspace_id, name, scope, is_default, created_at, updated_at
)
SELECT gen_random_uuid(), id, 'Anfragen', 'residential', true, now(), now()
FROM public.workspace;
--> statement-breakpoint
INSERT INTO public.kanban_column (
  id, workspace_id, board_id, name, column_type, position, color, is_intake,
  created_at, updated_at
)
SELECT gen_random_uuid(), workspace_id, id, 'Eingang', 'lead', 1, 'blue', true,
       now(), now()
FROM public.kanban_board
WHERE scope = 'residential' AND is_default = true AND archived_at IS NULL
UNION ALL
SELECT gen_random_uuid(), workspace_id, id, 'In Prüfung', 'lead', 2, 'amber', false,
       now(), now()
FROM public.kanban_board
WHERE scope = 'residential' AND is_default = true AND archived_at IS NULL
UNION ALL
SELECT gen_random_uuid(), workspace_id, id, 'Qualifiziert', 'lead', 3, 'green', false,
       now(), now()
FROM public.kanban_board
WHERE scope = 'residential' AND is_default = true AND archived_at IS NULL;
--> statement-breakpoint
UPDATE public.project AS project_row
SET kanban_board_id = board_row.id,
    kanban_column_id = column_row.id
FROM public.kanban_board AS board_row
JOIN public.kanban_column AS column_row
  ON column_row.workspace_id = board_row.workspace_id
 AND column_row.board_id = board_row.id
 AND column_row.is_intake = true
 AND column_row.archived_at IS NULL
WHERE project_row.workspace_id = board_row.workspace_id
  AND board_row.scope = 'residential'
  AND board_row.is_default = true
  AND board_row.archived_at IS NULL;
--> statement-breakpoint
DO $m1_05_project_backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.project
    WHERE kanban_board_id IS NULL OR kanban_column_id IS NULL
  ) THEN
    RAISE EXCEPTION 'M1-05 Project-Board-Backfill ist unvollstaendig';
  END IF;
END
$m1_05_project_backfill$;
--> statement-breakpoint
ALTER TABLE public.project FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workspace FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "kanban_board_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "kanban_column_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_kanban_board_fk" FOREIGN KEY ("workspace_id","kanban_board_id") REFERENCES "public"."kanban_board"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_kanban_column_fk" FOREIGN KEY ("workspace_id","kanban_board_id","kanban_column_id") REFERENCES "public"."kanban_column"("workspace_id","board_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_ws_kanban_created_idx" ON "project" USING btree ("workspace_id","kanban_column_id","created_at","id");
--> statement-breakpoint

ALTER TABLE "kanban_board" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kanban_board" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kanban_board"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "kanban_column" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kanban_column" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kanban_column"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

-- Der Workspace-Lifecycle ist die einzige Provisioning-Grenze. Die Funktion
-- hat keinen aufrufbaren API-Vertrag: PUBLIC darf sie nicht ausführen, und der
-- feste pg_catalog-search_path verhindert Object-Shadowing.
CREATE FUNCTION public.provision_default_request_board()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m1_05_provision$
DECLARE
  board_id uuid := pg_catalog.gen_random_uuid();
  prior_workspace text := pg_catalog.current_setting('app.workspace_id', true);
BEGIN
  PERFORM pg_catalog.set_config('app.workspace_id', NEW.id::text, true);

  INSERT INTO public.kanban_board (
    id, workspace_id, name, scope, is_default, created_at, updated_at
  ) VALUES (
    board_id, NEW.id, 'Anfragen', 'residential', true, now(), now()
  );
  INSERT INTO public.kanban_column (
    id, workspace_id, board_id, name, column_type, position, color, is_intake,
    created_at, updated_at
  ) VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'Eingang', 'lead', 1, 'blue', true, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'In Prüfung', 'lead', 2, 'amber', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, board_id, 'Qualifiziert', 'lead', 3, 'green', false, now(), now());

  PERFORM pg_catalog.set_config(
    'app.workspace_id',
    COALESCE(prior_workspace, ''),
    true
  );
  RETURN NEW;
END
$m1_05_provision$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provision_default_request_board() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER workspace_default_request_board
AFTER INSERT ON public.workspace
FOR EACH ROW
EXECUTE FUNCTION public.provision_default_request_board();
