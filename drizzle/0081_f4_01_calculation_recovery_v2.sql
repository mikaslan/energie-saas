-- F4.1 v2-Crash-Recovery (additiv neben 0080, analog 0026 fuer v1): Jeder
-- fachliche v2-Versuch erhaelt genau einen pg-boss-Lauf; ein Claim plant den
-- naechsten Lauf vorsorglich am Lease-Ende (Watchdog gegen Worker-Crash) und
-- ein Retry timt ihn auf den fachlichen Backoff-Zeitpunkt um. Ohne diese
-- Routine bliebe ein abgestuerzter v2-Lauf fuer immer auf `running` stehen:
-- 0080 nimmt nur `queued` an, der Sweep kennt nur `retry_wait`, und nichts
-- wuerde den abgelaufenen Lease je wieder zustellen. Schluessel und
-- Startzeit folgen exakt der 0026-Semantik (`<jobId>:<versuch>`,
-- `start_after` = Lease-Ende bei `running`, sonst `next_attempt_at`), nur
-- auf die eigene Queue `calculation.execute.v2` und das v2-Payload bezogen.
DO $f4_01_recovery_v2_migration$
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
    IF CURRENT_USER = SESSION_USER
       AND CURRENT_USER IN ('app_test', 'app_ci')
       AND pg_catalog.current_database() ~* 'test' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'F4.1 v2 recovery: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'F4.1 v2 recovery: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'F4.1 v2 recovery: app_migrator braucht die gepinnte SET-only-Kante zu app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'F4.1 v2 recovery: pg-boss muss vor der strikten App-Migration initialisiert sein';
  END IF;
  SELECT pg_catalog.max(version)
    INTO pgboss_version
    FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'F4.1 v2 recovery: erwartet pg-boss-Schema v38, ist %', pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'calculation.execute.v2'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 0
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F4.1 v2 recovery: calculation.execute.v2-Queue fehlt oder driftet';
  END IF;
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_worker REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_worker IN SCHEMA pgboss REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE $recovery_v2_ddl$
    CREATE OR REPLACE FUNCTION pgboss.enqueue_project_calculation_v2(
      workspace_id uuid,
      job_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $recovery_v2_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_attempt integer;
      dispatch_key text;
      dispatch_start_after timestamp with time zone;
      domain_state text;
      domain_attempt_count integer;
      domain_next_attempt_at timestamp with time zone;
      domain_lease_expires_at timestamp with time zone;
      runtime_pgboss_version integer;
    BEGIN
      IF NULLIF(
           pg_catalog.current_setting('app.workspace_id', true),
           ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'calculation v2 dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;

      SELECT domain_job.state,
             domain_job.attempt_count,
             domain_job.next_attempt_at,
             domain_job.lease_expires_at
        INTO domain_state,
             domain_attempt_count,
             domain_next_attempt_at,
             domain_lease_expires_at
        FROM public.project_calculation_job AS domain_job
       WHERE domain_job.workspace_id = $1
         AND domain_job.id = $2
         AND domain_job.state IN ('queued', 'running', 'retry_wait')
         AND domain_job.contract_version = 'planning-calculation.v2'
         AND pg_catalog.octet_length(domain_job.reservation_key) = 32
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'calculation v2 dispatch: keine zustellbare v2-Reservation'
          USING ERRCODE = '42501';
      END IF;

      dispatch_attempt := domain_attempt_count + 1;
      dispatch_key := $2::text || ':' || dispatch_attempt::text;
      dispatch_start_after := CASE domain_state
        WHEN 'running' THEN domain_lease_expires_at
        ELSE domain_next_attempt_at
      END;
      IF dispatch_start_after IS NULL THEN
        RAISE EXCEPTION 'calculation v2 dispatch: Zustellzeit fehlt';
      END IF;

      -- Erst nach der RLS-sichtbaren Domainpruefung darf der Aufruf einen
      -- UUID-abgeleiteten Lock belegen. Gleiche gueltige Reservationen werden
      -- damit ueber parallele Runtime-Sessions seriell betrachtet.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734769)
      );

      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'calculation v2 dispatch: pg-boss-Schemaversion driftet';
      END IF;

      SELECT *
        INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'calculation.execute.v2';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 0
         OR queue_config.notify THEN
        RAISE EXCEPTION 'calculation v2 dispatch: Queuevertrag fehlt oder driftet';
      END IF;

      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'project-calculation-dispatch.v2',
        'workspaceId', $1::text,
        'jobId', $2::text
      );

      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'calculation.execute.v2'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'calculation.execute.v2'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'calculation.execute.v2'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'calculation v2 dispatch: aktiver pg-boss-Job verletzt den Dispatchvertrag';
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
        dispatch_start_after,
        dispatch_key,
        queue_config.expire_seconds,
        queue_config.deletion_seconds,
        dispatch_start_after + queue_config.retention_seconds * interval '1 second',
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
           WHERE queued_job.name = 'calculation.execute.v2'
             AND queued_job.singleton_key = dispatch_key
             AND queued_job.data = dispatch_payload
             AND queued_job.policy = 'exclusive'
             AND queued_job.state IN ('created', 'retry', 'active')
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'calculation v2 dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $recovery_v2_body$
  $recovery_v2_ddl$;

  -- Gezielt statt pauschal (wie 0080): Ein Blanket-Revoke aller
  -- pg-boss-Routinen wuerde die Runtime-Grants spaeterer Slices entfernen,
  -- ohne sie wiederherzustellen. Geschlossen wird nur die ersetzte Routine
  -- (PUBLIC-Default), geoeffnet nur der payload-minimierte Runtime-Einstieg.
  EXECUTE 'REVOKE ALL ON FUNCTION pgboss.enqueue_project_calculation_v2(uuid, uuid) FROM PUBLIC, app_owner, app_migrator, app_runtime, app_system, app_auth, app_membership_writer, identity_reconciler';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_project_calculation_v2(uuid, uuid) TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$f4_01_recovery_v2_migration$;
