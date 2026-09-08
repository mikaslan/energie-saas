-- F4.1 v2-Finalisierung (additiv neben 0030/finalize_project_calculation_success).
--
-- Teil 1: project_calculation_revision_json_ck (aus 0024) kennt nur die
-- v1-Result-Form (contractVersion = Zeilen-Tupel, resultSha256-Feld im
-- JSON). Der v2-Zweig bindet die v2-Result-Form: contractVersion =
-- 'planning-calculation-result.v2' bei Zeilen-Tupel
-- 'planning-calculation.v2', KEIN resultSha256-Feld im JSON (der SHA-256
-- ueber das kanonische Result lebt nur in der result_sha256-Spalte).
ALTER TABLE "project_calculation_revision" DROP CONSTRAINT "project_calculation_revision_json_ck";--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_json_ck" CHECK ((
        jsonb_typeof("project_calculation_revision"."input_snapshot") = 'object'
        and jsonb_typeof("project_calculation_revision"."provider_snapshot") in ('object', 'array')
        and jsonb_typeof("project_calculation_revision"."result") = 'object'
        and (
          (
            "project_calculation_revision"."result"->>'contractVersion' = "project_calculation_revision"."contract_version"
            and "project_calculation_revision"."result"->>'inputSha256' = encode("project_calculation_revision"."input_sha256", 'hex')
            and "project_calculation_revision"."result"->>'resultSha256' = encode("project_calculation_revision"."result_sha256", 'hex')
            and "project_calculation_revision"."result"->>'quality' = "project_calculation_revision"."quality"
            and "project_calculation_revision"."result"->>'validationStatus' = "project_calculation_revision"."validation_status"
            and "project_calculation_revision"."result"#>>'{model,id}' = "project_calculation_revision"."model_id"
            and "project_calculation_revision"."result"#>>'{model,version}' = "project_calculation_revision"."model_version"
            and "project_calculation_revision"."result"#>>'{model,sourceRevision}' = "project_calculation_revision"."source_revision"
          )
          or (
            "project_calculation_revision"."contract_version" = 'planning-calculation.v2'
            and "project_calculation_revision"."result"->>'contractVersion' = 'planning-calculation-result.v2'
            and "project_calculation_revision"."result"->>'inputSha256' = encode("project_calculation_revision"."input_sha256", 'hex')
            and "project_calculation_revision"."result"->>'quality' = "project_calculation_revision"."quality"
            and "project_calculation_revision"."result"->>'validationStatus' = "project_calculation_revision"."validation_status"
            and "project_calculation_revision"."result"#>>'{model,id}' = "project_calculation_revision"."model_id"
            and "project_calculation_revision"."result"#>>'{model,version}' = "project_calculation_revision"."model_version"
            and "project_calculation_revision"."result"#>>'{model,sourceRevision}' = "project_calculation_revision"."source_revision"
          )
        )
      ) is true);--> statement-breakpoint
--
-- Teil 2: v2-Finalize-Funktion. Die v1-Funktion lehnt v2-Results
-- fail-closed ab (contractVersion-, Quality- und resultSha256-Bindung
-- sind v1-Literale; v2-Results tragen 'planning-calculation-result.v2'
-- und KEIN resultSha256-Feld). Diese v2-Schwester spiegelt exakt
-- dieselbe Sperr-/Replay-/CAS-Semantik
-- (Project -> Job, compare-and-set, stale/conflict), bindet aber das
-- v2-Tupel aus Migration 0078:
--   - Request-Seite: job.contract_version = 'planning-calculation.v2'
--     (0078-CHECK), inputSha256-Bindung an den Job.
--   - Result-Seite: contractVersion = 'planning-calculation-result.v2',
--     quality = 'server_reproduced_public_reference',
--     validationStatus = 'f4_public_reference_validated',
--     model-Tripel = Job-Pins (exakte Reservierungsbindung).
--   - result_sha256 existiert im v2-Result nicht als Feld: Der Aufrufer
--     (calculation-service, nach exaktem Server-Replay) uebergibt den
--     SHA-256 ueber das kanonische Result-JSON als 7. Parameter; die
--     Funktion prueft nur octet_length = 32 und speichert ihn. Der Hash
--     ist deterministisch ueber dem exakt validierten Result, kein
--     Vertrauensvorschuss an den Worker.
CREATE FUNCTION public.finalize_project_calculation_success_v2(
  requested_workspace_id uuid,
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_attempt_count integer,
  requested_revision_id uuid,
  requested_result jsonb,
  requested_result_sha256 bytea
)
RETURNS TABLE(outcome text, revision_id uuid, revision_number integer)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $f4_01_calculation_finalize_v2$
DECLARE
  target_project_id uuid;
  bound_job public.project_calculation_job%ROWTYPE;
  existing_revision public.project_calculation_revision%ROWTYPE;
  next_revision integer;
  database_now timestamptz;
  updated_rows integer;
BEGIN
  IF requested_workspace_id IS DISTINCT FROM NULLIF(
    pg_catalog.current_setting('app.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'calculation finalization tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

  -- Locate without locking the Job, then establish the global Project -> Job
  -- order (identisch zu v1; siehe 0030).
  SELECT job.project_id INTO target_project_id
    FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_job_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = target_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer;
    RETURN;
  END IF;

  SELECT * INTO bound_job
    FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_job_id
     AND job.project_id = target_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer;
    RETURN;
  END IF;

  IF bound_job.state = 'succeeded' AND bound_job.result_revision_id IS NOT NULL THEN
    SELECT * INTO existing_revision
      FROM public.project_calculation_revision AS revision_record
     WHERE revision_record.workspace_id = requested_workspace_id
       AND revision_record.id = bound_job.result_revision_id
       AND revision_record.job_id = requested_job_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calculation finalization integrity mismatch';
    END IF;
    IF bound_job.attempt_count IS DISTINCT FROM requested_attempt_count
       OR existing_revision.result IS DISTINCT FROM requested_result THEN
      RETURN QUERY SELECT
        'conflict'::text,
        existing_revision.id,
        existing_revision.revision;
    ELSE
      RETURN QUERY SELECT
        'replayed'::text,
        existing_revision.id,
        existing_revision.revision;
    END IF;
    RETURN;
  END IF;

  database_now := pg_catalog.clock_timestamp();
  IF bound_job.state <> 'running'
     OR bound_job.lease_token IS DISTINCT FROM requested_lease_token
     OR bound_job.attempt_count IS DISTINCT FROM requested_attempt_count
     OR bound_job.lease_expires_at IS NULL
     OR bound_job.lease_expires_at <= database_now THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer;
    RETURN;
  END IF;
  IF bound_job.input_sha256 IS NULL
     OR bound_job.input_snapshot IS NULL
     OR bound_job.provider_snapshot IS NULL THEN
    RAISE EXCEPTION 'calculation finalization input is incomplete';
  END IF;
  IF pg_catalog.jsonb_typeof(requested_result) <> 'object'
     OR requested_result->>'contractVersion' IS DISTINCT FROM 'planning-calculation-result.v2'
     OR bound_job.contract_version IS DISTINCT FROM 'planning-calculation.v2'
     OR requested_result->>'inputSha256' IS DISTINCT FROM pg_catalog.encode(bound_job.input_sha256, 'hex')
     OR requested_result->>'quality' IS DISTINCT FROM 'server_reproduced_public_reference'
     OR requested_result->>'validationStatus' IS DISTINCT FROM 'f4_public_reference_validated'
     OR requested_result#>>'{model,id}' IS DISTINCT FROM bound_job.model_id
     OR requested_result#>>'{model,version}' IS DISTINCT FROM bound_job.model_version
     OR requested_result#>>'{model,sourceRevision}' IS DISTINCT FROM bound_job.source_revision
     OR requested_result_sha256 IS NULL
     OR pg_catalog.octet_length(requested_result_sha256) <> 32 THEN
    RAISE EXCEPTION 'calculation finalization result binding mismatch';
  END IF;

  SELECT coalesce(pg_catalog.max(revision_record.revision), 0)::integer + 1
    INTO next_revision
    FROM public.project_calculation_revision AS revision_record
   WHERE revision_record.workspace_id = requested_workspace_id
     AND revision_record.project_id = target_project_id;

  INSERT INTO public.project_calculation_revision (
    id, workspace_id, project_id, site_id, revision, job_id,
    address_revision, pin_confirmed_address_revision, profile_id,
    profile_revision, confirmed_profile_revision,
    confirmed_address_revision, requirement_id, requirement_revision,
    source_snapshot_id, contract_version, model_id, model_version,
    source_revision, defaults_version, quality, validation_status,
    input_sha256, result_sha256, input_snapshot, provider_snapshot,
    result, created_by, created_at
  ) VALUES (
    requested_revision_id, requested_workspace_id, bound_job.project_id,
    bound_job.site_id, next_revision, bound_job.id,
    bound_job.address_revision, bound_job.pin_confirmed_address_revision,
    bound_job.profile_id, bound_job.profile_revision,
    bound_job.confirmed_profile_revision, bound_job.confirmed_address_revision,
    bound_job.requirement_id, bound_job.requirement_revision,
    bound_job.source_snapshot_id, bound_job.contract_version,
    bound_job.model_id, bound_job.model_version, bound_job.source_revision,
    bound_job.defaults_version, 'server_reproduced_public_reference',
    'f4_public_reference_validated', bound_job.input_sha256,
    requested_result_sha256,
    bound_job.input_snapshot, bound_job.provider_snapshot, requested_result,
    bound_job.created_by, database_now
  );

  UPDATE public.project_calculation_job AS job
     SET state = 'succeeded',
         lease_token = NULL,
         lease_expires_at = NULL,
         finished_at = database_now,
         result_revision_id = requested_revision_id,
         error_code = NULL,
         error_retryable = NULL
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_job_id
     AND job.project_id = target_project_id
     AND job.state = 'running'
     AND job.lease_token = requested_lease_token
     AND job.attempt_count = requested_attempt_count
     AND job.lease_expires_at > database_now
     AND job.result_revision_id IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  IF updated_rows <> 1 THEN
    RAISE EXCEPTION 'calculation finalization compare-and-set failed';
  END IF;

  RETURN QUERY SELECT 'created'::text, requested_revision_id, next_revision;
END
$f4_01_calculation_finalize_v2$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_project_calculation_success_v2(
  uuid, uuid, uuid, integer, uuid, jsonb, bytea
) FROM PUBLIC;
