CREATE TABLE "project_task_team_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_team_assignment_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_task_team_assignment_ws_task_team_uq" UNIQUE("workspace_id","task_id","team_id"),
	CONSTRAINT "project_task_team_assignment_time_ck" CHECK (pg_catalog.isfinite("project_task_team_assignment"."assigned_at"))
);
--> statement-breakpoint
ALTER TABLE "project_task" ADD COLUMN "team_assignment_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_task_team_assignment" ADD CONSTRAINT "project_task_team_assignment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_team_assignment" ADD CONSTRAINT "project_task_team_assignment_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."project_task"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_team_assignment" ADD CONSTRAINT "project_task_team_assignment_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_task_team_assignment_ws_team_task_idx" ON "project_task_team_assignment" USING btree ("workspace_id","team_id","task_id");--> statement-breakpoint
ALTER TABLE "project_task" ADD CONSTRAINT "project_task_team_assignment_revision_ck" CHECK ("project_task"."team_assignment_revision" between 0 and 2147483647);--> statement-breakpoint
ALTER TABLE public.project_task_team_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_team_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_task_team_assignment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-20: Guard-Carve-out — reine Teamzuweisung (nur
-- team_assignment_revision) braucht keinen Fach-Revisions-Bump.
-- Triggert NUR bei Aenderung der neuen Spalte; INSERT/DELETE- und
-- Fach-UPDATE-Pfade sind byte-identisch zum bisherigen Verhalten.
-- (Echte 0233 zentral uebernimmt diesen Block + aktualisiert den
-- _m110_guard_project_task-Quell-Pin im Rollenvertrag.)
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._m110_guard_project_task()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m110_task_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m110_erasure_delete_allowed(OLD.workspace_id, OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project_task DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public._m110_actor_can_write_tasks(NEW.workspace_id)
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project_task verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_task Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    -- Zweites READ-COMMITTED-Statement nach dem Project-Lock: wenn eine
    -- Erasure zuerst committet, darf der Trigger keine alte Contact-Joinseite
    -- aus dem vor dem Lock-Wait erzeugten Statement-Snapshot verwenden.
    PERFORM 1
      FROM public.project AS project_record
      JOIN public.contact AS contact_record
        ON contact_record.workspace_id = project_record.workspace_id
       AND contact_record.id = project_record.contact_id
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
       AND contact_record.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_task Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> 1
       OR NEW.status <> 'open'
       OR NEW.completed_at IS NOT NULL
       OR NEW.archived_at IS NOT NULL
       OR NEW.created_by IS DISTINCT FROM actor_id
       OR NEW.updated_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_task Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  -- F1-20 (0233): reine Teamzuweisung — eigene CAS-Domaene ohne
  -- Fach-Revisions-Bump. Archiv-, Actor- und Bindungs-Guards gelten
  -- unveraendert (Archiv-Fehlertext identisch zum Bestand).
  IF NEW.team_assignment_revision IS DISTINCT FROM OLD.team_assignment_revision THEN
    IF OLD.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'project_task ist archiviert und unveraenderlich'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body_version IS DISTINCT FROM OLD.body_version
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.due_at IS DISTINCT FROM OLD.due_at
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
       OR NEW.revision IS DISTINCT FROM OLD.revision
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.updated_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_task Teamzuweisung darf keine Fachfelder mitveraendern'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.body_version IS DISTINCT FROM OLD.body_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1
     OR NEW.updated_by IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'project_task immutable Bindung oder Revision verletzt'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'project_task ist archiviert und unveraenderlich'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.archived_at IS NOT NULL THEN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.due_at IS DISTINCT FROM OLD.due_at
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'project_task Archive darf keine Fachfelder mitveraendern'
        USING ERRCODE = '23514';
    END IF;
    NEW.archived_at := mutation_time;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'done' THEN
      NEW.completed_at := mutation_time;
    ELSIF NEW.status = 'open' THEN
      NEW.completed_at := NULL;
    END IF;
  ELSIF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'project_task completed_at folgt ausschliesslich dem Status'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m110_task_guard$;
