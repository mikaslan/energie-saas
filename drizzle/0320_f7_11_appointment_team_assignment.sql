-- ═══════════════════════════════════════════════════════════════════════
-- F7-11 Termin-Mehr-Team (Katalog F7.5, Block-Ebene): mehrere Teams parallel
-- je Termin. Muster F1-20 (0233): Seitentabelle + eigene CAS-Domäne
-- team_assignment_revision (kein Fach-Revisions-Bump, Guard-Carve-out unten).
-- team-FK RESTRICT (F1-20); unabhängig von team_id (Legacy, F1-12).
-- Schema-Teil per db:generate erzeugt (Fremd-Drift aus 0172 verworfen,
-- 0233-Extraktions-Präzedenz); RLS + Guard hand-appended (0128/0233-Muster).
-- Rechte: appointment.write (Assign/Unassign), appointment.read (Projektion);
-- calendar.read (Team-Optionen) — keine neue Permission.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "project_appointment_team_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_appointment_team_assignment_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_appointment_team_assignment_ws_appt_team_uq" UNIQUE("workspace_id","appointment_id","team_id"),
	CONSTRAINT "project_appointment_team_assignment_time_ck" CHECK (pg_catalog.isfinite("project_appointment_team_assignment"."assigned_at"))
);
--> statement-breakpoint
ALTER TABLE "project_appointment" ADD COLUMN "team_assignment_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_appointment_team_assignment" ADD CONSTRAINT "project_appointment_team_assignment_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment_team_assignment" ADD CONSTRAINT "project_appointment_team_assignment_appointment_fk" FOREIGN KEY ("workspace_id","appointment_id") REFERENCES "public"."project_appointment"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_appointment_team_assignment" ADD CONSTRAINT "project_appointment_team_assignment_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_appointment_team_assignment_ws_team_appt_idx" ON "project_appointment_team_assignment" USING btree ("workspace_id","team_id","appointment_id");--> statement-breakpoint
ALTER TABLE "project_appointment" ADD CONSTRAINT "project_appointment_team_assignment_revision_ck" CHECK ("project_appointment"."team_assignment_revision" between 0 and 2147483647);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7-11: RLS-Vertrag im M1-CRM-Muster (tenant_isolation + FORCE).
-- ACLs (SELECT/INSERT/DELETE für app_runtime) vergibt der Rollenvertrag
-- (0114-Präzedenz: keine Grants in der Migration).
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.project_appointment_team_assignment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_appointment_team_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_appointment_team_assignment
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7-11: Guard-Carve-out — reine Teamzuweisung (nur
-- team_assignment_revision) braucht keinen Fach-Revisions-Bump.
-- Triggert NUR bei Aenderung der neuen Spalte; INSERT/DELETE- und
-- Fach-UPDATE-Pfade sind byte-identisch zu 0043. F1-20 (0233)-Muster.
-- (Rollenvertrag: _m115_guard_project_appointment-Quell-Pin aktualisiert.)
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._m115_guard_project_appointment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m115_appointment_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF actor_id IS NULL AND CURRENT_USER = 'app_owner' THEN
      IF public._m115_erasure_delete_allowed(OLD.workspace_id, OLD.id) THEN
        RETURN OLD;
      END IF;
    END IF;
    IF NOT public._m115_actor_can_write_appointments(OLD.workspace_id)
       OR actor_id IS NULL THEN
      RAISE EXCEPTION 'project_appointment DELETE verlangt Editor/Admin oder Erasure'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT public._m115_actor_can_write_appointments(NEW.workspace_id)
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project_appointment verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_appointment Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project AS project_record
      JOIN public.contact AS contact_record
        ON contact_record.workspace_id = project_record.workspace_id
       AND contact_record.id = project_record.contact_id
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
       AND contact_record.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_appointment Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> 1
       OR NEW.created_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_appointment Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  -- F7-11 (0320): reine Teamzuweisung — eigene CAS-Domaene ohne
  -- Fach-Revisions-Bump. Bindungs-Guards gelten unveraendert.
  IF NEW.team_assignment_revision IS DISTINCT FROM OLD.team_assignment_revision THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.location IS DISTINCT FROM OLD.location
       OR NEW.start_at IS DISTINCT FROM OLD.start_at
       OR NEW.end_at IS DISTINCT FROM OLD.end_at
       OR NEW.all_day IS DISTINCT FROM OLD.all_day
       OR NEW.appointment_type IS DISTINCT FROM OLD.appointment_type
       OR NEW.calendar_id IS DISTINCT FROM OLD.calendar_id
       OR NEW.team_id IS DISTINCT FROM OLD.team_id
       OR NEW.revision IS DISTINCT FROM OLD.revision
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'project_appointment Teamzuweisung darf keine Fachfelder mitveraendern'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'project_appointment immutable Bindung oder Revision verletzt'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m115_appointment_guard$;
