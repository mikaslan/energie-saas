-- M1-07: enger, mandantengebundener Uebergang aus dem fachlichen
-- Reservation-Job in pg-boss. In der expliziten Ein-Rollen-Testsuite gibt es
-- kein pg-boss-Schema; dort bleibt diese reine Betriebsnaht absichtlich leer.
DO $m1_07_dispatch_migration$
DECLARE
  pgboss_owner text;
  pgboss_version integer;
BEGIN
  SELECT owner.rolname
    INTO pgboss_owner
    FROM pg_catalog.pg_namespace namespace
    JOIN pg_catalog.pg_roles owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'pgboss';

  IF pgboss_owner IS NULL THEN
    -- Nur die explizite, lokale Ein-Rollen-Kompatibilitaet darf die
    -- betriebliche pg-boss-Naht ueberspringen. Ein Strict-/Produktionslauf
    -- darf 0025 niemals als angewandt journalen, solange pg-boss fehlt.
    IF CURRENT_USER = SESSION_USER
       AND CURRENT_USER IN ('app_test', 'app_ci')
       AND pg_catalog.current_database() ~* 'test' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'M1-07 dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'M1-07 dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'M1-07 dispatch: app_migrator braucht die gepinnte SET-only-Kante zu app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'M1-07 dispatch: pg-boss muss vor der strikten App-Migration initialisiert sein';
  END IF;
  SELECT pg_catalog.max(version)
    INTO pgboss_version
    FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'M1-07 dispatch: erwartet pg-boss-Schema v38, ist %', pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'calculation.execute'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 0
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-07 dispatch: calculation.execute-Queue fehlt oder driftet';
  END IF;
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_worker REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_worker IN SCHEMA pgboss REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE $dispatch_ddl$
    CREATE FUNCTION pgboss.enqueue_project_calculation(
      workspace_id uuid,
      job_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $dispatch_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      runtime_pgboss_version integer;
    BEGIN
      IF NULLIF(
           pg_catalog.current_setting('app.workspace_id', true),
           ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'calculation dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;

      PERFORM 1
        FROM public.project_calculation_job AS domain_job
       WHERE domain_job.workspace_id = $1
         AND domain_job.id = $2
         AND domain_job.state = 'queued'
         AND pg_catalog.octet_length(domain_job.reservation_key) = 32
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'calculation dispatch: keine zustellbare Reservation'
          USING ERRCODE = '42501';
      END IF;

      -- Erst nach der RLS-sichtbaren Domainpruefung darf der Aufruf einen
      -- UUID-abgeleiteten Lock belegen. Gleiche gueltige Reservationen werden
      -- damit ueber parallele Runtime-Sessions seriell betrachtet;
      -- Hashkollisionen verengen lediglich die Parallelitaet.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734769)
      );

      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'calculation dispatch: pg-boss-Schemaversion driftet';
      END IF;

      SELECT *
        INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'calculation.execute';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 0
         OR queue_config.notify THEN
        RAISE EXCEPTION 'calculation dispatch: Queuevertrag fehlt oder driftet';
      END IF;

      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'project-calculation-dispatch.v1',
        'workspaceId', $1::text,
        'jobId', $2::text
      );

      -- Nur ein exakt von dieser Routine materialisierter, noch aktiver Job
      -- ist ein Replay. Gleichnamige oder gleich geschluesselte Fremdzeilen
      -- werden nicht als Erfolg verschluckt.
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'calculation.execute'
           AND queued_job.singleton_key = $2::text
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'calculation.execute'
           AND queued_job.singleton_key = $2::text
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'calculation dispatch: aktiver pg-boss-Job verletzt den Dispatchvertrag';
      END IF;

      INSERT INTO pgboss.job (
        name,
        data,
        priority,
        start_after,
        singleton_key,
        expire_seconds,
        deletion_seconds,
        keep_until,
        retry_limit,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        policy,
        dead_letter,
        heartbeat_seconds
      )
      SELECT
        queue_config.name,
        dispatch_payload,
        0,
        pg_catalog.now(),
        $2::text,
        queue_config.expire_seconds,
        queue_config.deletion_seconds,
        pg_catalog.now() + queue_config.retention_seconds * interval '1 second',
        queue_config.retry_limit,
        queue_config.retry_delay,
        queue_config.retry_backoff,
        queue_config.retry_delay_max,
        queue_config.policy,
        queue_config.dead_letter,
        queue_config.heartbeat_seconds
      ON CONFLICT DO NOTHING;

      IF NOT FOUND THEN
        IF EXISTS (
          SELECT 1
            FROM pgboss.job AS queued_job
           WHERE queued_job.name = 'calculation.execute'
             AND queued_job.singleton_key = $2::text
             AND queued_job.data = dispatch_payload
             AND queued_job.policy = 'exclusive'
             AND queued_job.state IN ('created', 'retry', 'active')
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'calculation dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $dispatch_body$
  $dispatch_ddl$;

  -- PostgreSQL gewaehrt neuen Funktionen standardmaessig PUBLIC EXECUTE.
  -- Die Worker-Ownerphase schliesst alle pg-boss-Routinen und oeffnet nur
  -- diesen einen, payload-minimierten Einstieg fuer Runtime.
  EXECUTE 'REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_project_calculation(uuid, uuid) TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m1_07_dispatch_migration$;
