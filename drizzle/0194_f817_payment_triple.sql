-- ═══════════════════════════════════════════════════════════════════════
-- F8-17: Zahlungsbeleg-Tripel auf commercial_document_render_job.
-- template_ck/recipe_ck auf beide gueltigen Paare erweitert (Invoice +
-- Payment, Kreuzmix per pair_ck ausgeschlossen); der pgboss-Dispatch
-- akzeptiert beide Tripel. Additiv, keine Datenaenderung.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE "commercial_document_render_job" DROP CONSTRAINT "commercial_document_render_job_template_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" DROP CONSTRAINT "commercial_document_render_job_recipe_ck";--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_pair_ck" CHECK ((("commercial_document_render_job"."template_version" = 'invoice-pdf-template.v1') and ("commercial_document_render_job"."renderer_recipe" = 'invoice-pdf-renderer-recipe.v1')) or (("commercial_document_render_job"."template_version" = 'invoice-payment-template.v1') and ("commercial_document_render_job"."renderer_recipe" = 'invoice-payment-renderer-recipe.v1')));--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_template_ck" CHECK ("commercial_document_render_job"."template_version" in ('invoice-pdf-template.v1', 'invoice-payment-template.v1'));--> statement-breakpoint
ALTER TABLE "commercial_document_render_job" ADD CONSTRAINT "commercial_document_render_job_recipe_ck" CHECK ("commercial_document_render_job"."renderer_recipe" in ('invoice-pdf-renderer-recipe.v1', 'invoice-payment-renderer-recipe.v1'));
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- F8-17: Dispatch-Gate aufs Payment-Tripel erweitert (Koerper sonst
-- byte-identisch zu 0193). ID-only-Payload, idempotenter Dispatch-Key.
-- ═══════════════════════════════════════════════════════════════════════
DO $f817_pdf_dispatch_migration$
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
    RAISE EXCEPTION 'F8-17 PDF dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'F8-17 PDF dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'F8-17 PDF dispatch: app_migrator braucht SET auf app_worker';
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
         AND (
               (domain_job.template_version = 'invoice-pdf-template.v1'
                AND domain_job.renderer_recipe = 'invoice-pdf-renderer-recipe.v1'
                AND domain_job.input_json ->> 'schemaVersion' = 'invoice-pdf-input.v1')
            OR (domain_job.template_version = 'invoice-payment-template.v1'
                AND domain_job.renderer_recipe = 'invoice-payment-renderer-recipe.v1'
                AND domain_job.input_json ->> 'schemaVersion' = 'invoice-payment-input.v1')
             )
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
$f817_pdf_dispatch_migration$;