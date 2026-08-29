-- M1-07: kontrollierte DSGVO-Erasure fuer inaktive, rein vorvertragliche
-- Leads. Der fachliche Graph wird entfernt, waehrend Contact, Site und Project
-- nur mit stabilen IDs pseudonymisiert erhalten bleiben. Die einzige
-- Wiederanlaufspur ist ein append-only ID-/Hash-Tombstone.
DO $m1_07_erasure_principal$
DECLARE
  erasure_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO erasure_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'app_erasure';
  IF NOT FOUND
     AND CURRENT_USER = SESSION_USER
     AND CURRENT_USER IN ('app_test', 'app_ci')
     AND pg_catalog.current_database() ~* 'test' THEN
    CREATE ROLE app_erasure NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
      NOCREATEDB NOCREATEROLE NOREPLICATION;
    SELECT * INTO erasure_role
      FROM pg_catalog.pg_roles
     WHERE rolname = 'app_erasure';
  END IF;
  IF NOT FOUND
     OR erasure_role.rolcanlogin
     OR erasure_role.rolinherit
     OR erasure_role.rolsuper
     OR erasure_role.rolbypassrls
     OR erasure_role.rolcreatedb
     OR erasure_role.rolcreaterole
     OR erasure_role.rolreplication THEN
    RAISE EXCEPTION 'M1-07 erasure: app_erasure fehlt oder ist nicht strikt NOLOGIN/NOINHERIT';
  END IF;
END
$m1_07_erasure_principal$;--> statement-breakpoint

CREATE TABLE public.contact_legal_hold (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  reason text NOT NULL,
  placed_at timestamp with time zone DEFAULT pg_catalog.now() NOT NULL,
  released_at timestamp with time zone,
  CONSTRAINT contact_legal_hold_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT contact_legal_hold_workspace_id_fk
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id),
  CONSTRAINT contact_legal_hold_contact_fk
    FOREIGN KEY (workspace_id, contact_id)
    REFERENCES public.contact(workspace_id, id),
  CONSTRAINT contact_legal_hold_reason_ck
    CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 200),
  CONSTRAINT contact_legal_hold_release_ck
    CHECK (released_at IS NULL OR released_at >= placed_at)
);--> statement-breakpoint
CREATE INDEX contact_legal_hold_active_idx
  ON public.contact_legal_hold (workspace_id, contact_id, placed_at)
  WHERE released_at IS NULL;--> statement-breakpoint

CREATE TABLE public.erasure_operation_locator (
  operation_id uuid PRIMARY KEY NOT NULL,
  scope_id uuid NOT NULL,
  CONSTRAINT erasure_operation_locator_operation_scope_uq
    UNIQUE (operation_id, scope_id),
  CONSTRAINT erasure_operation_locator_scope_id_fk
    FOREIGN KEY (scope_id) REFERENCES public.workspace(id)
);--> statement-breakpoint

CREATE TABLE public.erasure_tombstone (
  operation_id uuid PRIMARY KEY NOT NULL,
  workspace_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  reason text NOT NULL,
  graph_sha256 bytea NOT NULL,
  tombstone_sha256 bytea NOT NULL,
  graph_ids jsonb NOT NULL,
  eligible_at timestamp with time zone NOT NULL,
  erased_at timestamp with time zone NOT NULL,
  CONSTRAINT erasure_tombstone_ws_contact_uq UNIQUE (workspace_id, contact_id),
  CONSTRAINT erasure_tombstone_operation_ws_uq UNIQUE (operation_id, workspace_id),
  CONSTRAINT erasure_tombstone_workspace_id_fk
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id),
  CONSTRAINT erasure_tombstone_locator_fk
    FOREIGN KEY (operation_id, workspace_id)
    REFERENCES public.erasure_operation_locator(operation_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT erasure_tombstone_contact_fk
    FOREIGN KEY (workspace_id, contact_id)
    REFERENCES public.contact(workspace_id, id),
  CONSTRAINT erasure_tombstone_reason_ck
    CHECK (reason = 'inactive_lead_24_months'),
  CONSTRAINT erasure_tombstone_hash_ck
    CHECK (
      pg_catalog.octet_length(graph_sha256) = 32
      AND pg_catalog.octet_length(tombstone_sha256) = 32
    ),
  CONSTRAINT erasure_tombstone_graph_ck
    CHECK (pg_catalog.jsonb_typeof(graph_ids) = 'object'),
  CONSTRAINT erasure_tombstone_time_ck CHECK (erased_at >= eligible_at)
);--> statement-breakpoint

ALTER TABLE public.contact_legal_hold ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.contact_legal_hold FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contact_legal_hold
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true),
      ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.erasure_tombstone ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.erasure_tombstone FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.erasure_tombstone
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true),
      ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true),
      ''
    )::uuid
  );--> statement-breakpoint
-- Der zyklische Job/Result-Vertrag muss fuer die atomare Graphbereinigung bis
-- zum Transaktionsende pruefbar sein. Beide Seiten bleiben NO ACTION.
ALTER TABLE public.project_calculation_revision
  ALTER CONSTRAINT project_calculation_revision_job_project_site_fk
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE public.project_calculation_job
  ALTER CONSTRAINT project_calculation_job_result_revision_project_site_fk
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

CREATE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_tombstone_worm$
DECLARE
  graph_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.jsonb_typeof(NEW.graph_ids) <> 'object'
       OR NEW.graph_ids - ARRAY[
         'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
         'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds'
       ]::text[] <> '{}'::jsonb
       OR NOT NEW.graph_ids ?& ARRAY[
         'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
         'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds'
       ]::text[]
       OR pg_catalog.jsonb_typeof(NEW.graph_ids->'contactId') <> 'string'
       OR NEW.graph_ids->>'contactId' <> NEW.contact_id::text THEN
      RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
    END IF;
    FOREACH graph_key IN ARRAY ARRAY[
      'legalHoldIds', 'siteIds', 'projectIds', 'profileIds', 'jobIds',
      'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds'
    ]::text[] LOOP
      IF pg_catalog.jsonb_typeof(NEW.graph_ids->graph_key) <> 'array'
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(NEW.graph_ids->graph_key)
               AS graph_value(value)
            WHERE pg_catalog.jsonb_typeof(graph_value.value) <> 'string'
               OR graph_value.value #>> '{}' !~
                 '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         ) THEN
        RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'erasure_tombstone WORM append-only: % ist verboten', TG_OP;
END
$m1_07_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER erasure_tombstone_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.erasure_tombstone
  FOR EACH ROW EXECUTE FUNCTION public.guard_erasure_tombstone_worm();--> statement-breakpoint
CREATE TRIGGER erasure_tombstone_no_truncate
  BEFORE TRUNCATE ON public.erasure_tombstone
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_erasure_tombstone_worm();--> statement-breakpoint
CREATE TRIGGER erasure_operation_locator_append_only
  BEFORE UPDATE OR DELETE ON public.erasure_operation_locator
  FOR EACH ROW EXECUTE FUNCTION public.guard_erasure_tombstone_worm();--> statement-breakpoint
CREATE TRIGGER erasure_operation_locator_no_truncate
  BEFORE TRUNCATE ON public.erasure_operation_locator
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_erasure_tombstone_worm();--> statement-breakpoint

-- Die bestehenden Immutable-Guards erhalten genau eine DELETE-Ausnahme: Die
-- lokale Operation muss eine gueltige UUID sein und der Tombstone muss gerade
-- diesen Tabellen-/Workspace-/Datensatz im gespeicherten Graphen autorisieren.
CREATE OR REPLACE FUNCTION public.guard_site_energy_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_profile_guard$
DECLARE
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
         AND tombstone.graph_ids->'profileIds' ? OLD.id::text
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'site_energy_profile mutation guard: DELETE ist nur im Erasurevertrag erlaubt';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.input_mode IS DISTINCT FROM OLD.input_mode
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'site_energy_profile mutation guard: Identitaet und Vertrag sind unveraenderlich';
  END IF;

  IF OLD.confirmed_profile_revision IS NULL
     AND OLD.confirmed_address_revision IS NULL
     AND OLD.confirmed_by IS NULL
     AND OLD.confirmed_at IS NULL
     AND NEW.revision = OLD.revision
     AND NEW.address_revision = OLD.address_revision
     AND NEW.profile IS NOT DISTINCT FROM OLD.profile
     AND NEW.profile_sha256 IS NOT DISTINCT FROM OLD.profile_sha256
     AND NEW.source_kind IS NOT DISTINCT FROM OLD.source_kind
     AND NEW.source_snapshot_id IS NOT DISTINCT FROM OLD.source_snapshot_id
     AND NEW.source_project_id IS NOT DISTINCT FROM OLD.source_project_id
     AND NEW.confirmed_profile_revision = OLD.revision
     AND NEW.confirmed_address_revision = OLD.address_revision
     AND NEW.confirmed_by IS NOT NULL
     AND NEW.confirmed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.revision = OLD.revision + 1
     AND NEW.confirmed_profile_revision IS NULL
     AND NEW.confirmed_address_revision IS NULL
     AND NEW.confirmed_by IS NULL
     AND NEW.confirmed_at IS NULL
     AND (
       NEW.profile IS DISTINCT FROM OLD.profile
       OR NEW.profile_sha256 IS DISTINCT FROM OLD.profile_sha256
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
       OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
       OR NEW.source_project_id IS DISTINCT FROM OLD.source_project_id
       OR NEW.address_revision IS DISTINCT FROM OLD.address_revision
     )
     AND ((NEW.profile IS DISTINCT FROM OLD.profile)
       = (NEW.profile_sha256 IS DISTINCT FROM OLD.profile_sha256)) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'site_energy_profile mutation guard: nur Confirmation oder Save N+1 ist erlaubt';
END
$m1_07_profile_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_site_energy_profile_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_project_calculation_job_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_job_guard$
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
$m1_07_job_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_project_calculation_job_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_project_calculation_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m1_07_revision_guard$
DECLARE
  bound_job public.project_calculation_job%ROWTYPE;
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
         AND tombstone.graph_ids->'revisionIds' ? OLD.id::text
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project_calculation_revision ist immutable; DELETE ist nur im Erasurevertrag erlaubt';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'project_calculation_revision ist immutable; UPDATE ist verboten';
  END IF;

  SELECT * INTO bound_job
    FROM public.project_calculation_job
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.job_id
     AND project_id = NEW.project_id
     AND site_id = NEW.site_id;
  IF NOT FOUND OR bound_job.state <> 'running' THEN
    RAISE EXCEPTION 'project_calculation_revision: Job fehlt oder ist nicht running';
  END IF;
  IF bound_job.address_revision IS DISTINCT FROM NEW.address_revision
     OR bound_job.pin_confirmed_address_revision IS DISTINCT FROM NEW.pin_confirmed_address_revision
     OR bound_job.profile_id IS DISTINCT FROM NEW.profile_id
     OR bound_job.profile_revision IS DISTINCT FROM NEW.profile_revision
     OR bound_job.confirmed_profile_revision IS DISTINCT FROM NEW.confirmed_profile_revision
     OR bound_job.confirmed_address_revision IS DISTINCT FROM NEW.confirmed_address_revision
     OR bound_job.requirement_id IS DISTINCT FROM NEW.requirement_id
     OR bound_job.requirement_revision IS DISTINCT FROM NEW.requirement_revision
     OR bound_job.source_snapshot_id IS DISTINCT FROM NEW.source_snapshot_id
     OR bound_job.contract_version IS DISTINCT FROM NEW.contract_version
     OR bound_job.model_id IS DISTINCT FROM NEW.model_id
     OR bound_job.model_version IS DISTINCT FROM NEW.model_version
     OR bound_job.source_revision IS DISTINCT FROM NEW.source_revision
     OR bound_job.defaults_version IS DISTINCT FROM NEW.defaults_version
     OR bound_job.input_sha256 IS DISTINCT FROM NEW.input_sha256
     OR bound_job.input_snapshot IS DISTINCT FROM NEW.input_snapshot
     OR bound_job.provider_snapshot IS DISTINCT FROM NEW.provider_snapshot
     OR bound_job.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'project_calculation_revision: Resultbindungen stimmen nicht mit dem Job ueberein';
  END IF;
  RETURN NEW;
END
$m1_07_revision_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_project_calculation_revision() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.erase_inactive_lead(
  requested_workspace_id uuid,
  requested_contact_id uuid,
  requested_operation_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m1_07_erase$
DECLARE
  contact_row public.contact%ROWTYPE;
  existing_tombstone public.erasure_tombstone%ROWTYPE;
  located_workspace_id uuid;
  conflicting_operation uuid;
  graph_document jsonb;
  current_graph_document jsonb;
  graph_digest bytea;
  tombstone_digest bytea;
  latest_activity timestamp with time zone;
  eligible_time timestamp with time zone;
  erase_time timestamp with time zone;
  is_first_erasure boolean := false;
BEGIN
  IF requested_workspace_id IS NULL
     OR requested_contact_id IS NULL
     OR requested_operation_id IS NULL THEN
    RAISE EXCEPTION 'erasure_invalid_request';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.workspace_id',
    requested_workspace_id::text,
    true
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      requested_workspace_id::text || ':' || requested_contact_id::text,
      1701734770
    )
  );

  SELECT locator.scope_id INTO located_workspace_id
    FROM public.erasure_operation_locator AS locator
   WHERE locator.operation_id = requested_operation_id
   FOR SHARE;
  IF FOUND AND located_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'erasure_operation_conflict';
  END IF;

  SELECT * INTO existing_tombstone
    FROM public.erasure_tombstone AS tombstone
   WHERE tombstone.operation_id = requested_operation_id
   FOR SHARE;
  IF FOUND THEN
    IF existing_tombstone.workspace_id IS DISTINCT FROM requested_workspace_id
       OR existing_tombstone.contact_id IS DISTINCT FROM requested_contact_id THEN
      RAISE EXCEPTION 'erasure_operation_conflict';
    END IF;
    graph_document := existing_tombstone.graph_ids;
    eligible_time := existing_tombstone.eligible_at;
    erase_time := existing_tombstone.erased_at;
    graph_digest := pg_catalog.sha256(
      pg_catalog.convert_to(graph_document::text, 'UTF8')
    );
    IF graph_digest IS DISTINCT FROM existing_tombstone.graph_sha256 THEN
      RAISE EXCEPTION 'erasure_tombstone_corrupt';
    END IF;
    tombstone_digest := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.concat_ws(
        '|',
        existing_tombstone.operation_id::text,
        existing_tombstone.workspace_id::text,
        existing_tombstone.contact_id::text,
        existing_tombstone.reason,
        pg_catalog.encode(graph_digest, 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(eligible_time), 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(erase_time), 'hex')
      ),
      'UTF8'
    ));
    IF tombstone_digest IS DISTINCT FROM existing_tombstone.tombstone_sha256 THEN
      RAISE EXCEPTION 'erasure_tombstone_corrupt';
    END IF;
  ELSE
    SELECT tombstone.operation_id INTO conflicting_operation
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.workspace_id = requested_workspace_id
       AND tombstone.contact_id = requested_contact_id
     FOR SHARE;
    IF FOUND THEN
      RAISE EXCEPTION 'erasure_already_recorded';
    END IF;

    SELECT * INTO contact_row
      FROM public.contact AS contact_record
     WHERE contact_record.workspace_id = requested_workspace_id
       AND contact_record.id = requested_contact_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'erasure_contact_not_found';
    END IF;

    erase_time := pg_catalog.statement_timestamp();

    PERFORM 1
      FROM public.contact_legal_hold AS legal_hold
     WHERE legal_hold.workspace_id = requested_workspace_id
       AND legal_hold.contact_id = requested_contact_id
     ORDER BY legal_hold.id
     FOR UPDATE;
    IF EXISTS (
      SELECT 1
        FROM public.contact_legal_hold AS legal_hold
       WHERE legal_hold.workspace_id = requested_workspace_id
         AND legal_hold.contact_id = requested_contact_id
         AND legal_hold.released_at IS NULL
    ) THEN
      RAISE EXCEPTION 'erasure_legal_hold';
    END IF;

    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = requested_workspace_id
       AND project_record.contact_id = requested_contact_id
     ORDER BY project_record.id
     FOR UPDATE;
    IF EXISTS (
      SELECT 1
        FROM public.project AS project_record
       WHERE project_record.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
         AND project_record.outcome = 'won'
    ) THEN
      RAISE EXCEPTION 'erasure_contract_retained';
    END IF;

    PERFORM 1
      FROM public.site AS site_record
     WHERE site_record.workspace_id = requested_workspace_id
       AND site_record.contact_id = requested_contact_id
     ORDER BY site_record.id
     FOR UPDATE;

    graph_document := pg_catalog.jsonb_build_object(
      'contactId', requested_contact_id::text,
      'legalHoldIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(legal_hold.id::text ORDER BY legal_hold.id)
          FROM public.contact_legal_hold AS legal_hold
         WHERE legal_hold.workspace_id = requested_workspace_id
           AND legal_hold.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'siteIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(site_record.id::text ORDER BY site_record.id)
          FROM public.site AS site_record
         WHERE site_record.workspace_id = requested_workspace_id
           AND site_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'projectIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(project_record.id::text ORDER BY project_record.id)
          FROM public.project AS project_record
         WHERE project_record.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'profileIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(profile.id::text ORDER BY profile.id)
          FROM public.site_energy_profile AS profile
          JOIN public.site AS site_record
            ON site_record.workspace_id = profile.workspace_id
           AND site_record.id = profile.site_id
         WHERE profile.workspace_id = requested_workspace_id
           AND site_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'jobIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(job.id::text ORDER BY job.id)
          FROM public.project_calculation_job AS job
          JOIN public.project AS project_record
            ON project_record.workspace_id = job.workspace_id
           AND project_record.id = job.project_id
         WHERE job.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'revisionIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(revision.id::text ORDER BY revision.id)
          FROM public.project_calculation_revision AS revision
          JOIN public.project AS project_record
            ON project_record.workspace_id = revision.workspace_id
           AND project_record.id = revision.project_id
         WHERE revision.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'requirementIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(requirement.id::text ORDER BY requirement.id)
          FROM public.project_requirement AS requirement
          JOIN public.project AS project_record
            ON project_record.workspace_id = requirement.workspace_id
           AND project_record.id = requirement.project_id
         WHERE requirement.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'snapshotIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(snapshot.id::text ORDER BY snapshot.id)
          FROM public.calculator_snapshot AS snapshot
          JOIN public.project AS project_record
            ON project_record.workspace_id = snapshot.workspace_id
           AND project_record.id = snapshot.project_id
         WHERE snapshot.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'receiptIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(receipt.id::text ORDER BY receipt.id)
          FROM public.inbound_receipt AS receipt
          JOIN public.project AS project_record
            ON project_record.workspace_id = receipt.workspace_id
           AND project_record.id = receipt.project_id
         WHERE receipt.workspace_id = requested_workspace_id
           AND (
             project_record.contact_id = requested_contact_id
             OR receipt.email_match_contact_id = requested_contact_id
             OR receipt.phone_match_contact_id = requested_contact_id
           )
      ), '[]'::jsonb)
    );
    is_first_erasure := true;
  END IF;

  IF NOT is_first_erasure THEN
    -- Replay bleibt derselbe privilegierte Erasurevorgang, muss aber alle
    -- aktuellen Schutzgates erneut passieren. Neue IDs duerfen nie still an
    -- dem WORM-Tombstone vorbeileben.
    SELECT * INTO contact_row
      FROM public.contact AS contact_record
     WHERE contact_record.workspace_id = requested_workspace_id
       AND contact_record.id = requested_contact_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'erasure_contact_not_found';
    END IF;

    PERFORM 1
      FROM public.contact_legal_hold AS legal_hold
     WHERE legal_hold.workspace_id = requested_workspace_id
       AND legal_hold.contact_id = requested_contact_id
     ORDER BY legal_hold.id
     FOR UPDATE;
    IF EXISTS (
      SELECT 1
        FROM public.contact_legal_hold AS legal_hold
       WHERE legal_hold.workspace_id = requested_workspace_id
         AND legal_hold.contact_id = requested_contact_id
         AND legal_hold.released_at IS NULL
    ) THEN
      RAISE EXCEPTION 'erasure_legal_hold';
    END IF;

    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = requested_workspace_id
       AND project_record.contact_id = requested_contact_id
     ORDER BY project_record.id
     FOR UPDATE;
    IF EXISTS (
      SELECT 1
        FROM public.project AS project_record
       WHERE project_record.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
         AND project_record.outcome = 'won'
    ) THEN
      RAISE EXCEPTION 'erasure_contract_retained';
    END IF;

    PERFORM 1
      FROM public.site AS site_record
     WHERE site_record.workspace_id = requested_workspace_id
       AND site_record.contact_id = requested_contact_id
     ORDER BY site_record.id
     FOR UPDATE;

    current_graph_document := pg_catalog.jsonb_build_object(
      'contactId', requested_contact_id::text,
      'legalHoldIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(legal_hold.id::text ORDER BY legal_hold.id)
          FROM public.contact_legal_hold AS legal_hold
         WHERE legal_hold.workspace_id = requested_workspace_id
           AND legal_hold.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'siteIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(site_record.id::text ORDER BY site_record.id)
          FROM public.site AS site_record
         WHERE site_record.workspace_id = requested_workspace_id
           AND site_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'projectIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(project_record.id::text ORDER BY project_record.id)
          FROM public.project AS project_record
         WHERE project_record.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'profileIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(profile.id::text ORDER BY profile.id)
          FROM public.site_energy_profile AS profile
          JOIN public.site AS site_record
            ON site_record.workspace_id = profile.workspace_id
           AND site_record.id = profile.site_id
         WHERE profile.workspace_id = requested_workspace_id
           AND site_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'jobIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(job.id::text ORDER BY job.id)
          FROM public.project_calculation_job AS job
          JOIN public.project AS project_record
            ON project_record.workspace_id = job.workspace_id
           AND project_record.id = job.project_id
         WHERE job.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'revisionIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(revision.id::text ORDER BY revision.id)
          FROM public.project_calculation_revision AS revision
          JOIN public.project AS project_record
            ON project_record.workspace_id = revision.workspace_id
           AND project_record.id = revision.project_id
         WHERE revision.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'requirementIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(requirement.id::text ORDER BY requirement.id)
          FROM public.project_requirement AS requirement
          JOIN public.project AS project_record
            ON project_record.workspace_id = requirement.workspace_id
           AND project_record.id = requirement.project_id
         WHERE requirement.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'snapshotIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(snapshot.id::text ORDER BY snapshot.id)
          FROM public.calculator_snapshot AS snapshot
          JOIN public.project AS project_record
            ON project_record.workspace_id = snapshot.workspace_id
           AND project_record.id = snapshot.project_id
         WHERE snapshot.workspace_id = requested_workspace_id
           AND project_record.contact_id = requested_contact_id
      ), '[]'::jsonb),
      'receiptIds', COALESCE((
        SELECT pg_catalog.jsonb_agg(receipt.id::text ORDER BY receipt.id)
          FROM public.inbound_receipt AS receipt
          JOIN public.project AS project_record
            ON project_record.workspace_id = receipt.workspace_id
           AND project_record.id = receipt.project_id
         WHERE receipt.workspace_id = requested_workspace_id
           AND (
             project_record.contact_id = requested_contact_id
             OR receipt.email_match_contact_id = requested_contact_id
             OR receipt.phone_match_contact_id = requested_contact_id
           )
      ), '[]'::jsonb)
    );
    IF NOT current_graph_document <@ graph_document THEN
      RAISE EXCEPTION 'erasure_graph_drift';
    END IF;
  END IF;

  -- Diese Locks sind auch im Restore-Replay tragend. Insbesondere kann weder
  -- ein laufender Worker geloescht noch dessen Row-Lock uebergangen werden.
  PERFORM 1
    FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'jobIds') AS value
     )
   ORDER BY job.id
   FOR UPDATE;
  IF EXISTS (
    SELECT 1
      FROM public.project_calculation_job AS job
     WHERE job.workspace_id = requested_workspace_id
       AND job.id IN (
         SELECT value::uuid
           FROM pg_catalog.jsonb_array_elements_text(graph_document->'jobIds') AS value
       )
       AND job.state = 'running'
       AND job.lease_expires_at > pg_catalog.statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'erasure_worker_active' USING ERRCODE = '55006';
  END IF;
  PERFORM 1
    FROM public.project_calculation_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'revisionIds') AS value
     )
   ORDER BY revision.id
   FOR UPDATE;
  PERFORM 1
    FROM public.site_energy_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'profileIds') AS value
     )
   ORDER BY profile.id
   FOR UPDATE;
  PERFORM 1
    FROM public.project_requirement AS requirement
   WHERE requirement.workspace_id = requested_workspace_id
     AND requirement.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'requirementIds') AS value
     )
   ORDER BY requirement.id
   FOR UPDATE;
  PERFORM 1
    FROM public.calculator_snapshot AS snapshot
   WHERE snapshot.workspace_id = requested_workspace_id
     AND snapshot.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'snapshotIds') AS value
     )
   ORDER BY snapshot.id
   FOR UPDATE;
  PERFORM 1
    FROM public.inbound_receipt AS receipt
   WHERE receipt.workspace_id = requested_workspace_id
     AND receipt.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'receiptIds') AS value
     )
   ORDER BY receipt.id
   FOR UPDATE;

  IF is_first_erasure THEN
    -- Inaktivitaet ist eine Eigenschaft des ganzen, zuvor vollstaendig
    -- gesperrten Fachgraphen. Ausschliesslich die DB-Uhr entscheidet; ein
    -- vom Aufrufer gelieferter Zeitwert existiert im Vertrag nicht.
    SELECT pg_catalog.max(activity.activity_at) INTO latest_activity
      FROM (
        SELECT contact_row.updated_at AS activity_at
        UNION ALL
        SELECT site_record.updated_at
          FROM public.site AS site_record
         WHERE site_record.workspace_id = requested_workspace_id
           AND site_record.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'siteIds') AS value
           )
        UNION ALL
        SELECT project_record.updated_at
          FROM public.project AS project_record
         WHERE project_record.workspace_id = requested_workspace_id
           AND project_record.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'projectIds') AS value
           )
        UNION ALL
        SELECT receipt.received_at
          FROM public.inbound_receipt AS receipt
         WHERE receipt.workspace_id = requested_workspace_id
           AND receipt.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'receiptIds') AS value
           )
        UNION ALL
        SELECT snapshot.created_at
          FROM public.calculator_snapshot AS snapshot
         WHERE snapshot.workspace_id = requested_workspace_id
           AND snapshot.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'snapshotIds') AS value
           )
        UNION ALL
        SELECT requirement.created_at
          FROM public.project_requirement AS requirement
         WHERE requirement.workspace_id = requested_workspace_id
           AND requirement.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'requirementIds') AS value
           )
        UNION ALL
        SELECT profile.updated_at
          FROM public.site_energy_profile AS profile
         WHERE profile.workspace_id = requested_workspace_id
           AND profile.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'profileIds') AS value
           )
        UNION ALL
        SELECT GREATEST(
                 job.created_at,
                 job.started_at,
                 job.finished_at
               )
          FROM public.project_calculation_job AS job
         WHERE job.workspace_id = requested_workspace_id
           AND job.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'jobIds') AS value
           )
        UNION ALL
        SELECT revision.created_at
          FROM public.project_calculation_revision AS revision
         WHERE revision.workspace_id = requested_workspace_id
           AND revision.id IN (
             SELECT value::uuid
               FROM pg_catalog.jsonb_array_elements_text(graph_document->'revisionIds') AS value
           )
      ) AS activity;
    eligible_time := latest_activity + interval '24 months';
    IF erase_time < eligible_time THEN
      RAISE EXCEPTION 'erasure_not_eligible';
    END IF;
    graph_digest := pg_catalog.sha256(
      pg_catalog.convert_to(graph_document::text, 'UTF8')
    );
    tombstone_digest := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.concat_ws(
        '|',
        requested_operation_id::text,
        requested_workspace_id::text,
        requested_contact_id::text,
        'inactive_lead_24_months',
        pg_catalog.encode(graph_digest, 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(eligible_time), 'hex'),
        pg_catalog.encode(pg_catalog.timestamptz_send(erase_time), 'hex')
      ),
      'UTF8'
    ));
    INSERT INTO public.erasure_operation_locator (operation_id, scope_id)
    VALUES (requested_operation_id, requested_workspace_id);
    INSERT INTO public.erasure_tombstone (
      operation_id,
      workspace_id,
      contact_id,
      reason,
      graph_sha256,
      tombstone_sha256,
      graph_ids,
      eligible_at,
      erased_at
    ) VALUES (
      requested_operation_id,
      requested_workspace_id,
      requested_contact_id,
      'inactive_lead_24_months',
      graph_digest,
      tombstone_digest,
      graph_document,
      eligible_time,
      erase_time
    );
  END IF;
  PERFORM pg_catalog.set_config(
    'app.erasure_operation_id',
    requested_operation_id::text,
    true
  );

  DELETE FROM public.contact_legal_hold AS legal_hold
   WHERE legal_hold.workspace_id = requested_workspace_id
     AND legal_hold.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(
           COALESCE(graph_document->'legalHoldIds', '[]'::jsonb)
         ) AS value
     );
  DELETE FROM public.project_calculation_revision AS revision
   WHERE revision.workspace_id = requested_workspace_id
     AND revision.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'revisionIds') AS value
     );
  DELETE FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'jobIds') AS value
     );
  DELETE FROM public.site_energy_profile AS profile
   WHERE profile.workspace_id = requested_workspace_id
     AND profile.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'profileIds') AS value
     );
  DELETE FROM public.project_requirement AS requirement
   WHERE requirement.workspace_id = requested_workspace_id
     AND requirement.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'requirementIds') AS value
     );
  DELETE FROM public.calculator_snapshot AS snapshot
   WHERE snapshot.workspace_id = requested_workspace_id
     AND snapshot.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'snapshotIds') AS value
     );
  UPDATE public.inbound_receipt AS receipt
     SET producer_deployment_id = NULL,
         acquisition = pg_catalog.jsonb_build_object(
           'channel', 'website_calculator',
           'source', 'solarrechner',
           'pagePath', NULL,
           'referrerOrigin', NULL,
           'utm', pg_catalog.jsonb_build_object(
             'source', NULL,
             'medium', NULL,
             'campaign', NULL,
             'term', NULL,
             'content', NULL
           )
         ),
         privacy_notice_version = 'erased',
         privacy_notice_url = 'https://example.invalid/erased',
         email_match_contact_id = NULL,
         phone_match_contact_id = NULL
   WHERE receipt.workspace_id = requested_workspace_id
     AND receipt.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'receiptIds') AS value
     );
  UPDATE public.site AS site_record
     SET label = NULL,
         formatted_address = NULL,
         address_fingerprint = NULL,
         address_fingerprint_version = NULL,
         address_mode = 'legacy',
         street = NULL,
         house_number = NULL,
         postal_code = NULL,
         city = NULL,
         lat = NULL,
         lng = NULL,
         geocode_source = NULL,
         geocode_precision = NULL,
         geocode_place_id = NULL,
         address_follow_up_required = false,
         pin_confirmed = false,
         pin_confirmed_address_revision = NULL,
         pin_adjusted = false,
         updated_at = erase_time
   WHERE site_record.workspace_id = requested_workspace_id
     AND site_record.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'siteIds') AS value
     );
  UPDATE public.project AS project_record
     SET name = 'geloescht-' || project_record.id::text,
         dedupe_review_required = false,
         updated_at = erase_time
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id IN (
       SELECT value::uuid
         FROM pg_catalog.jsonb_array_elements_text(graph_document->'projectIds') AS value
     );
  UPDATE public.contact AS contact_record
     SET display_name = 'geloescht-' || contact_record.id::text,
         email_primary = NULL,
         email_normalized = NULL,
         phone_raw = NULL,
         phone_e164 = NULL,
         marketing_consent = false,
         marketing_consent_at = NULL,
         marketing_consent_source = NULL,
         dedupe_review_required = false,
         deleted_at = erase_time,
         updated_at = erase_time
   WHERE contact_record.workspace_id = requested_workspace_id
     AND contact_record.id = requested_contact_id;

  IF is_first_erasure THEN
    INSERT INTO public.domain_events (
      workspace_id,
      aggregate_type,
      aggregate_id,
      event_type,
      actor,
      payload,
      occurred_at
    ) VALUES (
      requested_workspace_id,
      'contact',
      requested_contact_id,
      'contact.erased',
      'app_erasure',
      pg_catalog.jsonb_build_object(
        'operationId', requested_operation_id::text,
        'contactId', requested_contact_id::text,
        'graphSha256', pg_catalog.encode(graph_digest, 'hex')
      ),
      erase_time
    );
    INSERT INTO public.audit_log (
      workspace_id,
      actor,
      action,
      resource,
      allowed,
      details,
      occurred_at
    ) VALUES (
      requested_workspace_id,
      'app_erasure',
      'contact.erase_inactive_lead',
      'contact:' || requested_contact_id::text,
      true,
      pg_catalog.jsonb_build_object(
        'operationId', requested_operation_id::text,
        'contactId', requested_contact_id::text,
        'graphSha256', pg_catalog.encode(graph_digest, 'hex')
      ),
      erase_time
    );
  END IF;
  RETURN requested_operation_id;
END
$m1_07_erase$;--> statement-breakpoint

CREATE FUNCTION public.replay_erasure_tombstone(requested_operation_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m1_07_replay$
DECLARE
  tombstone public.erasure_tombstone%ROWTYPE;
  replay_workspace_id uuid;
BEGIN
  IF requested_operation_id IS NULL THEN
    RAISE EXCEPTION 'erasure_invalid_request';
  END IF;
  SELECT locator.scope_id INTO replay_workspace_id
    FROM public.erasure_operation_locator AS locator
   WHERE locator.operation_id = requested_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erasure_tombstone_not_found';
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', replay_workspace_id::text, true);
  SELECT * INTO tombstone
    FROM public.erasure_tombstone AS stored
   WHERE stored.operation_id = requested_operation_id
     AND stored.workspace_id = replay_workspace_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erasure_tombstone_not_found';
  END IF;
  RETURN public.erase_inactive_lead(
    tombstone.workspace_id,
    tombstone.contact_id,
    tombstone.operation_id
  );
END
$m1_07_replay$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.replay_erasure_tombstone(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_erasure;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid) TO app_erasure;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.replay_erasure_tombstone(uuid) TO app_erasure;
