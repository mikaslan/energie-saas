ALTER TABLE "commercial_document_render_job" DROP CONSTRAINT "commercial_document_render_job_status_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "error_retryable" boolean;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "artifact_mime_type" text;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "artifact_sha256" "bytea";--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "artifact_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD COLUMN "artifact_bytes" "bytea";--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_attempt_ck" CHECK ("commercial_document_render_job"."attempt_count" between 0 and 3);--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_error_ck" CHECK ((
        "commercial_document_render_job"."error_code" is null and "commercial_document_render_job"."error_retryable" is null
      ) or (
        "commercial_document_render_job"."error_code" ~ '^[a-z][a-z0-9_]{0,79}$' and "commercial_document_render_job"."error_retryable" is not null
      ));--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_artifact_ck" CHECK ((
        "commercial_document_render_job"."artifact_mime_type" is null
        and "commercial_document_render_job"."artifact_sha256" is null
        and "commercial_document_render_job"."artifact_size_bytes" is null
        and "commercial_document_render_job"."artifact_bytes" is null
      ) or (
        "commercial_document_render_job"."artifact_mime_type" = 'application/pdf'
        and octet_length("commercial_document_render_job"."artifact_sha256") = 32
        and "commercial_document_render_job"."artifact_size_bytes" between 100 and 8388608
        and octet_length("commercial_document_render_job"."artifact_bytes") = "commercial_document_render_job"."artifact_size_bytes"
        and "commercial_document_render_job"."artifact_sha256" = pg_catalog.sha256("commercial_document_render_job"."artifact_bytes")
      ));--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_shape_ck" CHECK (case "commercial_document_render_job"."status"
        when 'requested' then
          "commercial_document_render_job"."lease_token" is null and "commercial_document_render_job"."lease_expires_at" is null
          and "commercial_document_render_job"."finished_at" is null and "commercial_document_render_job"."error_code" is null
          and "commercial_document_render_job"."error_retryable" is null and "commercial_document_render_job"."artifact_bytes" is null
        when 'queued' then
          "commercial_document_render_job"."lease_token" is null and "commercial_document_render_job"."lease_expires_at" is null
          and "commercial_document_render_job"."finished_at" is null and "commercial_document_render_job"."error_code" is null
          and "commercial_document_render_job"."error_retryable" is null and "commercial_document_render_job"."artifact_bytes" is null
        when 'running' then
          "commercial_document_render_job"."lease_token" is not null and "commercial_document_render_job"."lease_expires_at" is not null
          and "commercial_document_render_job"."started_at" is not null and "commercial_document_render_job"."finished_at" is null
          and "commercial_document_render_job"."error_code" is null and "commercial_document_render_job"."error_retryable" is null
          and "commercial_document_render_job"."artifact_bytes" is null
        when 'retry_wait' then
          "commercial_document_render_job"."lease_token" is null and "commercial_document_render_job"."lease_expires_at" is null
          and "commercial_document_render_job"."started_at" is not null and "commercial_document_render_job"."finished_at" is null
          and "commercial_document_render_job"."error_code" is not null and "commercial_document_render_job"."error_retryable" = true
          and "commercial_document_render_job"."artifact_bytes" is null
        when 'succeeded' then
          "commercial_document_render_job"."lease_token" is null and "commercial_document_render_job"."lease_expires_at" is null
          and "commercial_document_render_job"."started_at" is not null and "commercial_document_render_job"."finished_at" is not null
          and "commercial_document_render_job"."error_code" is null and "commercial_document_render_job"."error_retryable" is null
          and "commercial_document_render_job"."artifact_bytes" is not null
        when 'failed_final' then
          "commercial_document_render_job"."lease_token" is null and "commercial_document_render_job"."lease_expires_at" is null
          and "commercial_document_render_job"."started_at" is not null and "commercial_document_render_job"."finished_at" is not null
          and "commercial_document_render_job"."error_code" is not null and "commercial_document_render_job"."error_retryable" = false
          and "commercial_document_render_job"."artifact_bytes" is null
        else false end);--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_status_ck" CHECK ("commercial_document_render_job"."status" in (
        'requested', 'queued', 'running', 'retry_wait', 'succeeded', 'failed_final'
      ));--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-02c P1-2: Input-Immutability-Trigger. Versiegelte Spalten sind nach
-- Insert unveraenderlich (23514); Status-/Lease-/Fehler-/Artefakt-Spalten
-- folgen der Zustandsmaschine (Shape-CHECKs oben).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public._m302c_guard_render_input_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m302c_render_input_immutable$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.document_id IS DISTINCT FROM NEW.document_id
     OR OLD.input_json IS DISTINCT FROM NEW.input_json
     OR OLD.input_sha256 IS DISTINCT FROM NEW.input_sha256
     OR OLD.template_version IS DISTINCT FROM NEW.template_version
     OR OLD.renderer_recipe IS DISTINCT FROM NEW.renderer_recipe THEN
    RAISE EXCEPTION 'render_input_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$m302c_render_input_immutable$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS commercial_document_render_job_input_immutable
  ON public.commercial_document_render_job;--> statement-breakpoint
CREATE TRIGGER commercial_document_render_job_input_immutable
BEFORE UPDATE ON public.commercial_document_render_job
FOR EACH ROW EXECUTE FUNCTION public._m302c_guard_render_input_immutable();--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-02c P1-1: RLS-SELECT auf Write-Schranke heben. input_json enthaelt
-- Steuer-ID/IBAN (M3-01 schwaerzt ohne issuing_details.write); Viewer+
-- duerfen Job-Zeilen nicht lesen. Download-Auth (M3-02d) zieht
-- issuing_details.write nach. Hash-Pins im Rollenvertrag neu ernten.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS commercial_document_render_job_actor_select
  ON public.commercial_document_render_job;--> statement-breakpoint
DO $m302c_select_tightening$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m301_actor_can_write_invoicing(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'commercial_document_render_job_actor_select', 'commercial_document_render_job', actor_policy_role
  );
END
$m302c_select_tightening$;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M3-02c: pgboss-Dispatch invoice-pdf.render (Muster enqueue_offer_pdf_draft,
-- 0033, eigene Queue). ID-only-Payload, idempotenter Dispatch-Key, Schema-Gate.
-- ═══════════════════════════════════════════════════════════════════════
DO $m302c_pdf_dispatch_migration$
DECLARE
  pgboss_owner text;
BEGIN
  SELECT owner.rolname
    INTO pgboss_owner
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'pgboss';

  IF pgboss_owner IS NULL THEN
    IF CURRENT_USER = SESSION_USER
       AND CURRENT_USER IN ('app_test', 'app_ci')
       AND pg_catalog.current_database() ~* 'test' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'M3-02c PDF dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'M3-02c PDF dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'M3-02c PDF dispatch: app_migrator braucht SET auf app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  EXECUTE $dispatch_ddl$
    CREATE OR REPLACE FUNCTION pgboss.enqueue_invoice_pdf_render(
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
           pg_catalog.current_setting('app.workspace_id', true), ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'invoice PDF dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;

      SELECT domain_job.status,
             domain_job.attempt_count,
             domain_job.next_attempt_at,
             domain_job.lease_expires_at
        INTO domain_state,
             domain_attempt_count,
             domain_next_attempt_at,
             domain_lease_expires_at
        FROM public.commercial_document_render_job AS domain_job
       WHERE domain_job.workspace_id = $1
         AND domain_job.id = $2
         AND domain_job.status IN ('requested', 'queued', 'running', 'retry_wait')
         AND domain_job.template_version = 'invoice-pdf-template.v1'
         AND domain_job.renderer_recipe = 'invoice-pdf-renderer-recipe.v1'
         AND domain_job.input_json ->> 'schemaVersion' = 'invoice-pdf-input.v1'
         AND domain_job.input_json ->> 'canonicalizationVersion' = 'invoice-pdf-jcs.v1'
         AND pg_catalog.octet_length(domain_job.input_sha256) = 32
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invoice PDF dispatch: keine zustellbare Reservation'
          USING ERRCODE = '42501';
      END IF;

      dispatch_attempt := domain_attempt_count + 1;
      dispatch_key := $2::text || ':' || dispatch_attempt::text;
      dispatch_start_after := CASE domain_state
        WHEN 'running' THEN domain_lease_expires_at
        ELSE domain_next_attempt_at
      END;
      IF dispatch_start_after IS NULL THEN
        RAISE EXCEPTION 'invoice PDF dispatch: Zustellzeit fehlt';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734771)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'invoice PDF dispatch: pg-boss-Schemaversion driftet';
      END IF;
      SELECT *
        INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'invoice-pdf.render';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'invoice PDF dispatch: Queuevertrag fehlt oder driftet';
      END IF;

      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'invoice-pdf-dispatch.v1',
        'workspaceId', $1::text,
        'jobId', $2::text
      );
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'invoice-pdf.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'invoice-pdf.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'invoice-pdf.render'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'invoice PDF dispatch: aktiver Job verletzt Vertrag';
      END IF;

      INSERT INTO pgboss.job (
        name, data, priority, start_after, singleton_key, expire_seconds,
        deletion_seconds, keep_until, retry_limit, retry_delay,
        retry_backoff, retry_delay_max, policy, dead_letter,
        heartbeat_seconds
      )
      SELECT queue_config.name,
             dispatch_payload,
             0,
             dispatch_start_after,
             dispatch_key,
             queue_config.expire_seconds,
             queue_config.deletion_seconds,
             dispatch_start_after
               + queue_config.retention_seconds * interval '1 second',
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
           WHERE queued_job.name = 'invoice-pdf.render'
             AND queued_job.singleton_key = dispatch_key
             AND queued_job.data = dispatch_payload
             AND queued_job.policy = 'exclusive'
             AND queued_job.state IN ('created', 'retry', 'active')
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'invoice PDF dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $dispatch_body$
  $dispatch_ddl$;

  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_invoice_pdf_render(uuid, uuid) TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_invoice_pdf_render(uuid, uuid) TO app_worker';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m302c_pdf_dispatch_migration$;