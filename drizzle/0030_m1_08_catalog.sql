ALTER TABLE public.project_calculation_revision
  ADD CONSTRAINT project_calculation_revision_ws_id_project_site_revision_uq
  UNIQUE (workspace_id, id, project_id, site_id, revision);--> statement-breakpoint

CREATE TABLE public.catalog_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  internal_sku text NOT NULL,
  component_type text NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  current_revision integer DEFAULT 0 NOT NULL,
  nominal_power_watts integer,
  usable_capacity_wh integer,
  archived_at timestamp with time zone,
  created_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT catalog_component_ws_id_type_uq
    UNIQUE (workspace_id, id, component_type),
  CONSTRAINT catalog_component_sku_ck
    CHECK (internal_sku ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  CONSTRAINT catalog_component_type_ck
    CHECK (component_type IN (
      'module', 'inverter', 'battery', 'wallbox',
      'heat_pump', 'mounting', 'other'
    )),
  CONSTRAINT catalog_component_status_ck
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT catalog_component_revision_ck CHECK (current_revision >= 0),
  CONSTRAINT catalog_component_projection_ck CHECK (
    (nominal_power_watts IS NULL OR nominal_power_watts > 0)
    AND (usable_capacity_wh IS NULL OR usable_capacity_wh > 0)
  ),
  CONSTRAINT catalog_component_archive_ck
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX catalog_component_ws_id_uq
  ON public.catalog_component (workspace_id, id);--> statement-breakpoint
CREATE UNIQUE INDEX catalog_component_ws_sku_ci_uq
  ON public.catalog_component (workspace_id, lower(internal_sku));--> statement-breakpoint
CREATE INDEX catalog_component_ws_list_idx
  ON public.catalog_component (
    workspace_id, status, component_type, internal_sku, id
  );--> statement-breakpoint

CREATE TABLE public.catalog_component_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  component_id uuid NOT NULL,
  revision integer NOT NULL,
  component_type text NOT NULL,
  schema_version text NOT NULL,
  canonicalization_version text NOT NULL,
  revision_snapshot jsonb NOT NULL,
  snapshot_sha256 bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT catalog_component_revision_ws_component_revision_uq
    UNIQUE (workspace_id, component_id, revision),
  CONSTRAINT catalog_component_revision_ws_component_revision_hash_uq
    UNIQUE (workspace_id, component_id, revision, snapshot_sha256),
  CONSTRAINT catalog_component_revision_revision_ck CHECK (revision > 0),
  CONSTRAINT catalog_component_revision_version_ck CHECK (
    schema_version = 'catalog-component-revision.v1'
    AND canonicalization_version = 'catalog-jcs.v1'
  ),
  CONSTRAINT catalog_component_revision_hash_ck
    CHECK (octet_length(snapshot_sha256) = 32),
  CONSTRAINT catalog_component_revision_json_ck CHECK (
    jsonb_typeof(revision_snapshot) = 'object'
    AND (revision_snapshot - ARRAY[
      'schemaVersion', 'canonicalizationVersion', 'identity',
      'presentation', 'technicalData', 'commercial',
      'technicalProvenance', 'snapshotSha256'
    ]::text[]) = '{}'::jsonb
    AND revision_snapshot->>'schemaVersion' = schema_version
    AND revision_snapshot->>'canonicalizationVersion' = canonicalization_version
    AND jsonb_typeof(revision_snapshot->'identity') = 'object'
    AND jsonb_typeof(revision_snapshot->'presentation') = 'object'
    AND jsonb_typeof(revision_snapshot->'technicalData') = 'object'
    AND jsonb_typeof(revision_snapshot->'technicalProvenance') = 'object'
    AND jsonb_typeof(revision_snapshot->'commercial') IN ('object', 'null')
    AND revision_snapshot#>>'{identity,workspaceId}' = workspace_id::text
    AND revision_snapshot#>>'{identity,componentId}' = component_id::text
    AND (revision_snapshot#>>'{identity,revision}')::integer = revision
    AND revision_snapshot#>>'{identity,componentType}' = component_type
    AND revision_snapshot->>'snapshotSha256' = encode(snapshot_sha256, 'hex')
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX catalog_component_revision_ws_id_uq
  ON public.catalog_component_revision (workspace_id, id);--> statement-breakpoint

CREATE TABLE public.project_catalog_resolution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  site_id uuid NOT NULL,
  revision integer NOT NULL,
  requirement_id uuid NOT NULL,
  requirement_revision integer NOT NULL,
  calculation_revision_id uuid NOT NULL,
  calculation_revision integer NOT NULL,
  calculation_input_sha256 bytea NOT NULL,
  calculation_result_sha256 bytea NOT NULL,
  calculation_quality text NOT NULL,
  calculation_validation_status text NOT NULL,
  schema_version text NOT NULL,
  canonicalization_version text NOT NULL,
  resolution_snapshot jsonb NOT NULL,
  resolution_sha256 bytea NOT NULL,
  confirmed_by uuid NOT NULL,
  confirmed_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT project_catalog_resolution_ws_id_project_uq
    UNIQUE (workspace_id, id, project_id),
  CONSTRAINT project_catalog_resolution_revision_ck CHECK (revision > 0),
  CONSTRAINT project_catalog_resolution_binding_revision_ck
    CHECK (requirement_revision > 0 AND calculation_revision > 0),
  CONSTRAINT project_catalog_resolution_version_ck CHECK (
    schema_version = 'project-catalog-resolution.v1'
    AND canonicalization_version = 'catalog-jcs.v1'
    AND calculation_quality = 'server_reproduced_estimate'
    AND calculation_validation_status = 'not_f4_reference_validated'
  ),
  CONSTRAINT project_catalog_resolution_hash_ck CHECK (
    octet_length(calculation_input_sha256) = 32
    AND octet_length(calculation_result_sha256) = 32
    AND octet_length(resolution_sha256) = 32
  ),
  CONSTRAINT project_catalog_resolution_json_ck CHECK (
    jsonb_typeof(resolution_snapshot) = 'object'
    AND (resolution_snapshot - ARRAY[
      'schemaVersion', 'canonicalizationVersion', 'revision', 'bindings',
      'lines', 'requested', 'acknowledgements', 'coverage', 'totals',
      'warnings', 'confirmedBy', 'confirmedAt', 'resolutionSha256'
    ]::text[]) = '{}'::jsonb
    AND resolution_snapshot->>'schemaVersion' = schema_version
    AND resolution_snapshot->>'canonicalizationVersion' = canonicalization_version
    AND (resolution_snapshot->>'revision')::integer = revision
    AND jsonb_typeof(resolution_snapshot->'bindings') = 'object'
    AND resolution_snapshot#>>'{bindings,workspaceId}' = workspace_id::text
    AND resolution_snapshot#>>'{bindings,projectId}' = project_id::text
    AND resolution_snapshot#>>'{bindings,siteId}' = site_id::text
    AND resolution_snapshot#>>'{bindings,requirementId}' = requirement_id::text
    AND (resolution_snapshot#>>'{bindings,requirementRevision}')::integer
      = requirement_revision
    AND resolution_snapshot#>>'{bindings,calculationRevisionId}'
      = calculation_revision_id::text
    AND (resolution_snapshot#>>'{bindings,calculationRevision}')::integer
      = calculation_revision
    AND resolution_snapshot#>>'{bindings,calculationInputSha256}'
      = encode(calculation_input_sha256, 'hex')
    AND resolution_snapshot#>>'{bindings,calculationResultSha256}'
      = encode(calculation_result_sha256, 'hex')
    AND resolution_snapshot#>>'{bindings,calculationQuality}'
      = calculation_quality
    AND resolution_snapshot#>>'{bindings,calculationValidationStatus}'
      = calculation_validation_status
    AND resolution_snapshot->>'confirmedBy' = confirmed_by::text
    AND (resolution_snapshot->>'confirmedAt')::timestamptz = confirmed_at
    AND resolution_snapshot->>'resolutionSha256'
      = encode(resolution_sha256, 'hex')
    AND jsonb_typeof(resolution_snapshot->'lines') = 'array'
    AND jsonb_array_length(resolution_snapshot->'lines') BETWEEN 1 AND 500
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX project_catalog_resolution_ws_id_uq
  ON public.project_catalog_resolution (workspace_id, id);--> statement-breakpoint
CREATE UNIQUE INDEX project_catalog_resolution_ws_project_revision_uq
  ON public.project_catalog_resolution (workspace_id, project_id, revision);--> statement-breakpoint

CREATE TABLE public.project_catalog_resolution_line (
  id uuid PRIMARY KEY NOT NULL,
  workspace_id uuid NOT NULL,
  resolution_id uuid NOT NULL,
  project_id uuid NOT NULL,
  position integer NOT NULL,
  quantity integer NOT NULL,
  catalog_component_id uuid NOT NULL,
  catalog_component_revision integer NOT NULL,
  component_snapshot_sha256 bytea NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT project_catalog_resolution_line_ws_resolution_position_uq
    UNIQUE (workspace_id, resolution_id, position),
  CONSTRAINT project_catalog_resolution_line_ws_resolution_component_uq
    UNIQUE (workspace_id, resolution_id, catalog_component_id),
  CONSTRAINT project_catalog_resolution_line_position_ck CHECK (position > 0),
  CONSTRAINT project_catalog_resolution_line_quantity_ck
    CHECK (quantity BETWEEN 1 AND 100000),
  CONSTRAINT project_catalog_resolution_line_hash_ck
    CHECK (octet_length(component_snapshot_sha256) = 32)
);--> statement-breakpoint

CREATE UNIQUE INDEX project_catalog_resolution_line_ws_id_uq
  ON public.project_catalog_resolution_line (workspace_id, id);--> statement-breakpoint
CREATE INDEX project_catalog_resolution_line_ws_component_project_idx
  ON public.project_catalog_resolution_line (
    workspace_id, catalog_component_id, catalog_component_revision, project_id
  );--> statement-breakpoint

ALTER TABLE public.catalog_component
  ADD CONSTRAINT catalog_component_workspace_id_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspace(id);--> statement-breakpoint
ALTER TABLE public.catalog_component
  ADD CONSTRAINT catalog_component_created_by_fk
  FOREIGN KEY (workspace_id, created_by)
  REFERENCES public.membership(workspace_id, user_id);--> statement-breakpoint

ALTER TABLE public.catalog_component_revision
  ADD CONSTRAINT catalog_component_revision_workspace_id_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspace(id);--> statement-breakpoint
ALTER TABLE public.catalog_component_revision
  ADD CONSTRAINT catalog_component_revision_component_type_fk
  FOREIGN KEY (workspace_id, component_id, component_type)
  REFERENCES public.catalog_component(workspace_id, id, component_type);--> statement-breakpoint
ALTER TABLE public.catalog_component_revision
  ADD CONSTRAINT catalog_component_revision_created_by_fk
  FOREIGN KEY (workspace_id, created_by)
  REFERENCES public.membership(workspace_id, user_id);--> statement-breakpoint

ALTER TABLE public.project_catalog_resolution
  ADD CONSTRAINT project_catalog_resolution_workspace_id_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspace(id);--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution
  ADD CONSTRAINT project_catalog_resolution_project_site_fk
  FOREIGN KEY (workspace_id, project_id, site_id)
  REFERENCES public.project(workspace_id, id, site_id)
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution
  ADD CONSTRAINT project_catalog_resolution_requirement_fk
  FOREIGN KEY (workspace_id, requirement_id, project_id, requirement_revision)
  REFERENCES public.project_requirement(workspace_id, id, project_id, revision)
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution
  ADD CONSTRAINT project_catalog_resolution_calculation_fk
  FOREIGN KEY (
    workspace_id, calculation_revision_id, project_id, site_id,
    calculation_revision
  ) REFERENCES public.project_calculation_revision(
    workspace_id, id, project_id, site_id, revision
  ) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution
  ADD CONSTRAINT project_catalog_resolution_confirmed_by_fk
  FOREIGN KEY (workspace_id, confirmed_by)
  REFERENCES public.membership(workspace_id, user_id);--> statement-breakpoint

ALTER TABLE public.project_catalog_resolution_line
  ADD CONSTRAINT project_catalog_resolution_line_workspace_id_fk
  FOREIGN KEY (workspace_id) REFERENCES public.workspace(id);--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution_line
  ADD CONSTRAINT project_catalog_resolution_line_resolution_project_fk
  FOREIGN KEY (workspace_id, resolution_id, project_id)
  REFERENCES public.project_catalog_resolution(workspace_id, id, project_id)
  ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution_line
  ADD CONSTRAINT project_catalog_resolution_line_catalog_revision_fk
  FOREIGN KEY (
    workspace_id, catalog_component_id, catalog_component_revision,
    component_snapshot_sha256
  ) REFERENCES public.catalog_component_revision(
    workspace_id, component_id, revision, snapshot_sha256
  );--> statement-breakpoint

CREATE FUNCTION public.guard_catalog_component_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_08_component_guard$
DECLARE
  current_snapshot jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog_component: DELETE ist verboten';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.internal_sku IS DISTINCT FROM OLD.internal_sku
     OR NEW.component_type IS DISTINCT FROM OLD.component_type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'catalog_component: stabile Identitaet ist unveraenderlich';
  END IF;
  IF NEW.current_revision < OLD.current_revision
     OR NEW.current_revision > OLD.current_revision + 1 THEN
    RAISE EXCEPTION 'catalog_component: current_revision muss lueckenlos steigen';
  END IF;
  IF NEW.current_revision > OLD.current_revision THEN
    SELECT revision.revision_snapshot
      INTO current_snapshot
      FROM public.catalog_component_revision AS revision
     WHERE revision.workspace_id = NEW.workspace_id
       AND revision.component_id = NEW.id
       AND revision.revision = NEW.current_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog_component: neue Revision fehlt';
    END IF;
  ELSE
    SELECT revision.revision_snapshot
      INTO current_snapshot
      FROM public.catalog_component_revision AS revision
     WHERE revision.workspace_id = NEW.workspace_id
       AND revision.component_id = NEW.id
       AND revision.revision = NEW.current_revision;
  END IF;
  IF NEW.status = 'active' AND (
    NEW.current_revision < 1
    OR current_snapshot IS NULL
    OR jsonb_typeof(current_snapshot->'commercial') <> 'object'
  ) THEN
    RAISE EXCEPTION 'catalog_component: active verlangt vollstaendige Preise';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('active', 'archived'))
    OR (OLD.status = 'active' AND NEW.status = 'archived')
    OR (OLD.status = 'active' AND NEW.status = 'draft'
        AND NEW.current_revision = OLD.current_revision + 1)
    OR (OLD.status = 'archived' AND NEW.status = 'draft')
  ) THEN
    RAISE EXCEPTION 'catalog_component: unzulaessiger Lifecycle-Uebergang';
  END IF;
  RETURN NEW;
END
$m1_08_component_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_catalog_component_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.guard_catalog_component_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_08_revision_guard$
DECLARE
  component_record public.catalog_component%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'catalog_component_revision ist immutable';
  END IF;
  SELECT * INTO component_record
    FROM public.catalog_component
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.component_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog_component_revision: Komponente fehlt';
  END IF;
  IF NEW.revision <> component_record.current_revision + 1 THEN
    RAISE EXCEPTION 'catalog_component_revision: Revision muss lueckenlos N+1 sein';
  END IF;
  IF NEW.component_type IS DISTINCT FROM component_record.component_type THEN
    RAISE EXCEPTION 'catalog_component_revision: Komponententyp driftet';
  END IF;
  RETURN NEW;
END
$m1_08_revision_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_catalog_component_revision() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.apply_catalog_component_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_08_apply_revision$
DECLARE
  technical_schema text;
  projected_power integer;
  projected_capacity integer;
BEGIN
  technical_schema := NEW.revision_snapshot#>>'{technicalData,schemaVersion}';
  projected_power := CASE technical_schema
    WHEN 'module.v1' THEN (NEW.revision_snapshot#>>'{technicalData,nominalPowerWatts}')::integer
    WHEN 'inverter.v1' THEN (NEW.revision_snapshot#>>'{technicalData,nominalAcPowerWatts}')::integer
    WHEN 'wallbox.v1' THEN (NEW.revision_snapshot#>>'{technicalData,maxChargingPowerWatts}')::integer
    WHEN 'heat_pump.v1' THEN (NEW.revision_snapshot#>>'{technicalData,nominalHeatingPowerWatts}')::integer
    ELSE NULL
  END;
  projected_capacity := CASE technical_schema
    WHEN 'battery.v1' THEN (NEW.revision_snapshot#>>'{technicalData,usableCapacityWh}')::integer
    ELSE NULL
  END;
  UPDATE public.catalog_component
     SET current_revision = NEW.revision,
         status = 'draft',
         archived_at = NULL,
         nominal_power_watts = projected_power,
         usable_capacity_wh = projected_capacity,
         updated_at = pg_catalog.now()
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.component_id;
  RETURN NEW;
END
$m1_08_apply_revision$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.apply_catalog_component_revision() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.mark_catalog_component_projects_stale()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_08_catalog_stale$
BEGIN
  IF NEW.current_revision IS DISTINCT FROM OLD.current_revision
     OR (NEW.status = 'archived' AND OLD.status <> 'archived') THEN
    UPDATE public.project AS project_record
       SET catalog_resolution_status = 'pending',
           updated_at = pg_catalog.now()
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.catalog_resolution_status = 'resolved'
       AND EXISTS (
         SELECT 1
           FROM public.project_catalog_resolution AS resolution
           JOIN public.project_catalog_resolution_line AS line
             ON line.workspace_id = resolution.workspace_id
            AND line.resolution_id = resolution.id
          WHERE resolution.workspace_id = project_record.workspace_id
            AND resolution.project_id = project_record.id
            AND resolution.revision = (
              SELECT pg_catalog.max(latest.revision)
                FROM public.project_catalog_resolution AS latest
               WHERE latest.workspace_id = resolution.workspace_id
                 AND latest.project_id = resolution.project_id
            )
            AND line.catalog_component_id = NEW.id
            AND (
              line.catalog_component_revision < NEW.current_revision
              OR NEW.status = 'archived'
            )
       );
  END IF;
  RETURN NEW;
END
$m1_08_catalog_stale$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_catalog_component_projects_stale() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.validate_project_catalog_resolution_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_08_resolution_validate$
DECLARE
  target_resolution public.project_catalog_resolution%ROWTYPE;
  trigger_row jsonb;
  target_resolution_id uuid;
  target_workspace_id uuid;
  expected_lines integer;
  actual_lines integer;
  bindings_current boolean;
BEGIN
  trigger_row := to_jsonb(NEW);
  target_workspace_id := (trigger_row->>'workspace_id')::uuid;
  target_resolution_id := CASE
    WHEN TG_TABLE_NAME = 'project_catalog_resolution'
      THEN (trigger_row->>'id')::uuid
    ELSE (trigger_row->>'resolution_id')::uuid
  END;
  SELECT * INTO target_resolution
    FROM public.project_catalog_resolution AS resolution
   WHERE resolution.workspace_id = target_workspace_id
     AND resolution.id = target_resolution_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  expected_lines := jsonb_array_length(target_resolution.resolution_snapshot->'lines');
  SELECT pg_catalog.count(*)::integer INTO actual_lines
    FROM public.project_catalog_resolution_line AS line
   WHERE line.workspace_id = target_resolution.workspace_id
     AND line.resolution_id = target_resolution.id;
  IF actual_lines <> expected_lines OR actual_lines < 1 THEN
    RAISE EXCEPTION 'project_catalog_resolution: relationale Zeilen sind unvollstaendig';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.project_catalog_resolution_line AS line
     WHERE line.workspace_id = target_resolution.workspace_id
       AND line.resolution_id = target_resolution.id
       AND (
         line.position > expected_lines
         OR target_resolution.resolution_snapshot#>>ARRAY[
           'lines', (line.position - 1)::text, 'lineId'
         ] IS DISTINCT FROM line.id::text
         OR target_resolution.resolution_snapshot#>>ARRAY[
           'lines', (line.position - 1)::text, 'catalogComponentId'
         ] IS DISTINCT FROM line.catalog_component_id::text
         OR (target_resolution.resolution_snapshot#>>ARRAY[
           'lines', (line.position - 1)::text, 'catalogComponentRevision'
         ])::integer IS DISTINCT FROM line.catalog_component_revision
         OR (target_resolution.resolution_snapshot#>>ARRAY[
           'lines', (line.position - 1)::text, 'quantity'
         ])::integer IS DISTINCT FROM line.quantity
         OR target_resolution.resolution_snapshot#>>ARRAY[
           'lines', (line.position - 1)::text, 'componentSnapshotSha256'
         ] IS DISTINCT FROM encode(line.component_snapshot_sha256, 'hex')
       )
  ) THEN
    RAISE EXCEPTION 'project_catalog_resolution: Zeilen und Snapshot driften';
  END IF;

  -- Raw INSERT is part of app_runtime's narrow write contract, so the
  -- validator cannot rely on the service having locked Project already. Lock
  -- it in a separate statement and only then evaluate every mutable binding;
  -- under READ COMMITTED the following SELECT receives a fresh snapshot after
  -- any concurrent invalidation transaction has committed.
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = target_resolution.workspace_id
     AND project_record.id = target_resolution.project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_catalog_resolution: Project fehlt';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.project_requirement AS requirement
      JOIN public.project_calculation_revision AS calculation
        ON calculation.workspace_id = requirement.workspace_id
       AND calculation.project_id = requirement.project_id
       AND calculation.requirement_id = requirement.id
       AND calculation.requirement_revision = requirement.revision
     WHERE requirement.workspace_id = target_resolution.workspace_id
       AND requirement.project_id = target_resolution.project_id
       AND requirement.id = target_resolution.requirement_id
       AND requirement.revision = target_resolution.requirement_revision
       AND requirement.revision = (
         SELECT pg_catalog.max(latest_requirement.revision)
           FROM public.project_requirement AS latest_requirement
          WHERE latest_requirement.workspace_id = requirement.workspace_id
            AND latest_requirement.project_id = requirement.project_id
       )
       AND calculation.id = target_resolution.calculation_revision_id
       AND calculation.site_id = target_resolution.site_id
       AND calculation.revision = target_resolution.calculation_revision
       AND calculation.input_sha256 = target_resolution.calculation_input_sha256
       AND calculation.result_sha256 = target_resolution.calculation_result_sha256
       AND calculation.quality = target_resolution.calculation_quality
       AND calculation.validation_status
         = target_resolution.calculation_validation_status
       AND NOT EXISTS (
         SELECT 1
           FROM public.project_catalog_resolution_line AS line
           JOIN public.catalog_component AS component
             ON component.workspace_id = line.workspace_id
            AND component.id = line.catalog_component_id
          WHERE line.workspace_id = target_resolution.workspace_id
            AND line.resolution_id = target_resolution.id
            AND (
              component.status <> 'active'
              OR component.current_revision <> line.catalog_component_revision
            )
       )
  ) INTO bindings_current;
  UPDATE public.project AS project_record
     SET catalog_resolution_status = CASE
           WHEN bindings_current THEN 'resolved' ELSE 'pending'
         END,
         updated_at = pg_catalog.now()
   WHERE project_record.workspace_id = target_resolution.workspace_id
     AND project_record.id = target_resolution.project_id
     AND target_resolution.revision = (
       SELECT pg_catalog.max(latest.revision)
         FROM public.project_catalog_resolution AS latest
        WHERE latest.workspace_id = target_resolution.workspace_id
          AND latest.project_id = target_resolution.project_id
     );
  RETURN NULL;
END
$m1_08_resolution_validate$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.validate_project_catalog_resolution_snapshot() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.lock_project_calculation_finalization(
  requested_workspace_id uuid,
  requested_job_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $m1_08_calculation_lock$
DECLARE
  target_project_id uuid;
BEGIN
  IF requested_workspace_id IS DISTINCT FROM NULLIF(
    pg_catalog.current_setting('app.workspace_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'calculation finalization tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT job.project_id INTO target_project_id
    FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id = requested_job_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = target_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN target_project_id;
END
$m1_08_calculation_lock$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lock_project_calculation_finalization(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.finalize_project_calculation_success(
  requested_workspace_id uuid,
  requested_job_id uuid,
  requested_lease_token uuid,
  requested_attempt_count integer,
  requested_revision_id uuid,
  requested_result jsonb
)
RETURNS TABLE(outcome text, revision_id uuid, revision_number integer)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $m1_08_calculation_finalize$
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
  -- order. Raw app_worker callers cannot bypass this order because their
  -- direct revision INSERT and result_revision_id UPDATE privileges are
  -- removed by the pinned role contract.
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
     OR requested_result->>'contractVersion' IS DISTINCT FROM bound_job.contract_version
     OR requested_result->>'inputSha256' IS DISTINCT FROM pg_catalog.encode(bound_job.input_sha256, 'hex')
     OR requested_result->>'resultSha256' IS NULL
     OR requested_result->>'resultSha256' !~ '^[0-9a-f]{64}$'
     OR requested_result->>'quality' IS DISTINCT FROM 'server_reproduced_estimate'
     OR requested_result->>'validationStatus' IS DISTINCT FROM 'not_f4_reference_validated'
     OR requested_result#>>'{model,id}' IS DISTINCT FROM bound_job.model_id
     OR requested_result#>>'{model,version}' IS DISTINCT FROM bound_job.model_version
     OR requested_result#>>'{model,sourceRevision}' IS DISTINCT FROM bound_job.source_revision THEN
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
    bound_job.defaults_version, 'server_reproduced_estimate',
    'not_f4_reference_validated', bound_job.input_sha256,
    pg_catalog.decode(requested_result->>'resultSha256', 'hex'),
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
$m1_08_calculation_finalize$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_project_calculation_success(
  uuid, uuid, uuid, integer, uuid, jsonb
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.mark_project_catalog_resolution_stale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m1_08_planning_stale$
BEGIN
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = NEW.workspace_id
     AND project_record.id = NEW.project_id
   FOR UPDATE;
  UPDATE public.project AS project_record
     SET catalog_resolution_status = 'pending',
         updated_at = pg_catalog.now()
   WHERE project_record.workspace_id = NEW.workspace_id
     AND project_record.id = NEW.project_id
     AND project_record.catalog_resolution_status = 'resolved'
     AND EXISTS (
       SELECT 1
         FROM public.project_catalog_resolution AS resolution
        WHERE resolution.workspace_id = NEW.workspace_id
          AND resolution.project_id = NEW.project_id
          AND resolution.revision = (
            SELECT pg_catalog.max(latest.revision)
              FROM public.project_catalog_resolution AS latest
             WHERE latest.workspace_id = NEW.workspace_id
               AND latest.project_id = NEW.project_id
          )
          AND (
            (TG_TABLE_NAME = 'project_requirement'
              AND (resolution.requirement_id <> NEW.id
                OR resolution.requirement_revision <> NEW.revision))
            OR
            (TG_TABLE_NAME = 'project_calculation_revision'
              AND (resolution.calculation_revision_id <> NEW.id
                OR resolution.calculation_revision <> NEW.revision))
          )
     );
  RETURN NEW;
END
$m1_08_planning_stale$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_project_catalog_resolution_stale() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER catalog_component_mutation_guard
  BEFORE UPDATE OR DELETE ON public.catalog_component
  FOR EACH ROW EXECUTE FUNCTION public.guard_catalog_component_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_component_no_truncate
  BEFORE TRUNCATE ON public.catalog_component
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_component_revision_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.catalog_component_revision
  FOR EACH ROW EXECUTE FUNCTION public.guard_catalog_component_revision();--> statement-breakpoint
CREATE TRIGGER catalog_component_revision_apply
  AFTER INSERT ON public.catalog_component_revision
  FOR EACH ROW EXECUTE FUNCTION public.apply_catalog_component_revision();--> statement-breakpoint
CREATE TRIGGER catalog_component_revision_no_truncate
  BEFORE TRUNCATE ON public.catalog_component_revision
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER catalog_component_projects_stale
  AFTER UPDATE OF current_revision, status ON public.catalog_component
  FOR EACH ROW EXECUTE FUNCTION public.mark_catalog_component_projects_stale();--> statement-breakpoint

CREATE TRIGGER project_catalog_resolution_immutable
  BEFORE UPDATE ON public.project_catalog_resolution
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_catalog_resolution_no_truncate
  BEFORE TRUNCATE ON public.project_catalog_resolution
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_catalog_resolution_line_immutable
  BEFORE UPDATE ON public.project_catalog_resolution_line
  FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_catalog_resolution_line_no_truncate
  BEFORE TRUNCATE ON public.project_catalog_resolution_line
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER project_catalog_resolution_complete
  AFTER INSERT ON public.project_catalog_resolution
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_project_catalog_resolution_snapshot();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER project_catalog_resolution_line_complete
  AFTER INSERT ON public.project_catalog_resolution_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_project_catalog_resolution_snapshot();--> statement-breakpoint

CREATE TRIGGER project_requirement_catalog_stale
  AFTER INSERT ON public.project_requirement
  FOR EACH ROW EXECUTE FUNCTION public.mark_project_catalog_resolution_stale();--> statement-breakpoint
CREATE TRIGGER project_calculation_revision_catalog_stale
  AFTER INSERT ON public.project_calculation_revision
  FOR EACH ROW EXECUTE FUNCTION public.mark_project_catalog_resolution_stale();--> statement-breakpoint

ALTER TABLE public.catalog_component ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.catalog_component FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_component
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );--> statement-breakpoint

ALTER TABLE public.catalog_component_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.catalog_component_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.catalog_component_revision
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );--> statement-breakpoint

ALTER TABLE public.project_catalog_resolution ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_catalog_resolution
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );--> statement-breakpoint

ALTER TABLE public.project_catalog_resolution_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_catalog_resolution_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_catalog_resolution_line
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );
