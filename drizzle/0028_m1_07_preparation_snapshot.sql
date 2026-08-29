-- M1-07: Der fachliche Job reserviert die minimale, fuer die spaetere
-- Input-Erzeugung benoetigte Wahrheit bytegenau. Historische Jobs ohne diesen
-- Snapshot bleiben lesbar, werden vor Provider-I/O jedoch fail-closed beendet;
-- sie werden keinesfalls aus inzwischen mutierten Profil-/Sitezeilen rekonstruiert.
ALTER TABLE public.project_calculation_job
  ADD COLUMN preparation_snapshot jsonb,
  ADD COLUMN preparation_sha256 bytea;--> statement-breakpoint

ALTER TABLE public.project_calculation_job
  ADD CONSTRAINT project_calculation_job_preparation_ck
  CHECK ((
    (preparation_snapshot IS NULL AND preparation_sha256 IS NULL)
    OR (
      pg_catalog.jsonb_typeof(preparation_snapshot) = 'object'
      AND preparation_snapshot->>'schemaVersion'
        = 'project-calculation-preparation.v1'
      AND pg_catalog.octet_length(preparation_sha256) = 32
    )
  ) IS TRUE);--> statement-breakpoint

-- 0027 hat den Erasure-Ausnahmepfad eingefuehrt. Die additive Erweiterung
-- bewahrt ihn und pinnt zusaetzlich beide Preparation-Felder ab dem INSERT.
CREATE OR REPLACE FUNCTION public.guard_project_calculation_job_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_preparation_job_guard$
DECLARE
  transition_allowed boolean;
  erasure_setting text;
  erasure_operation uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    erasure_setting := pg_catalog.current_setting('app.erasure_operation_id', true);
    BEGIN
      erasure_operation := NULLIF(erasure_setting, '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      erasure_operation := NULL;
    END;
    IF erasure_operation IS NOT NULL AND EXISTS (
      SELECT 1
        FROM public.erasure_tombstone AS tombstone
       WHERE tombstone.operation_id = erasure_operation
         AND tombstone.workspace_id = OLD.workspace_id
         AND tombstone.graph_ids->'jobIds' ? OLD.id::text
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project_calculation_job mutation guard: DELETE ist nur im Erasurevertrag erlaubt';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.address_revision IS DISTINCT FROM OLD.address_revision
     OR NEW.pin_confirmed_address_revision IS DISTINCT FROM OLD.pin_confirmed_address_revision
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.profile_revision IS DISTINCT FROM OLD.profile_revision
     OR NEW.confirmed_profile_revision IS DISTINCT FROM OLD.confirmed_profile_revision
     OR NEW.confirmed_address_revision IS DISTINCT FROM OLD.confirmed_address_revision
     OR NEW.requirement_id IS DISTINCT FROM OLD.requirement_id
     OR NEW.requirement_revision IS DISTINCT FROM OLD.requirement_revision
     OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
     OR NEW.reservation_key IS DISTINCT FROM OLD.reservation_key
     OR NEW.provider_recipe_version IS DISTINCT FROM OLD.provider_recipe_version
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.defaults_version IS DISTINCT FROM OLD.defaults_version
     OR NEW.preparation_snapshot IS DISTINCT FROM OLD.preparation_snapshot
     OR NEW.preparation_sha256 IS DISTINCT FROM OLD.preparation_sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Bindungen sind unveraenderlich';
  END IF;

  IF OLD.input_sha256 IS NOT NULL
     AND (NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
       OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
       OR NEW.provider_snapshot IS DISTINCT FROM OLD.provider_snapshot) THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Input-Snapshot ist unveraenderlich';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: attempt_count darf nur monoton einzeln steigen';
  END IF;

  transition_allowed :=
    NEW.state = OLD.state
    OR (OLD.state = 'queued' AND NEW.state = 'running')
    OR (OLD.state = 'running' AND NEW.state IN ('retry_wait', 'succeeded', 'failed_final'))
    OR (OLD.state = 'retry_wait' AND NEW.state = 'queued');
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: unzulaessige state transition';
  END IF;
  IF NEW.state = 'running' AND OLD.state <> 'running'
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Claim muss attempt_count erhoehen';
  END IF;
  IF NEW.state <> 'running' AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: attempt_count aendert sich nur beim Claim';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: started_at ist nach erstem Setzen unveraenderlich';
  END IF;
  IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: finished_at ist unveraenderlich';
  END IF;
  IF OLD.result_revision_id IS NOT NULL
     AND NEW.result_revision_id IS DISTINCT FROM OLD.result_revision_id THEN
    RAISE EXCEPTION 'project_calculation_job mutation guard: Resultbindung ist unveraenderlich';
  END IF;
  RETURN NEW;
END
$m1_07_preparation_job_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_project_calculation_job_mutation()
  FROM PUBLIC;--> statement-breakpoint
