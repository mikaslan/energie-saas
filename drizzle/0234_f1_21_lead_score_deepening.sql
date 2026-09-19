ALTER TABLE "project" ADD COLUMN "lead_score_value" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_score_band" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_score_signals" text[];--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_score_computed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lead_score_status" text;--> statement-breakpoint
CREATE INDEX "project_ws_lead_score_idx" ON "project" USING btree ("workspace_id","lead_score_status","lead_score_computed_at");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_score_value_ck" CHECK ("project"."lead_score_value" is null or "project"."lead_score_value" between 0 and 100);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_score_band_ck" CHECK ("project"."lead_score_band" is null or "project"."lead_score_band" in ('hot', 'warm', 'cold'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_score_status_ck" CHECK ("project"."lead_score_status" is null or "project"."lead_score_status" in ('pending', 'ready'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_lead_score_ready_shape_ck" CHECK ("project"."lead_score_status" is distinct from 'ready' or (
        "project"."lead_score_value" is not null
        and "project"."lead_score_band" is not null
        and "project"."lead_score_signals" is not null
        and "project"."lead_score_computed_at" is not null
      ));--> statement-breakpoint

-- Kapsel 1/2: synchroner Recompute (Worker-Handler + Tests). Spiegelt exakt
-- die Board-Leseregel (9 Signale + Intent-EXISTS über 4 Quellen, Summe →
-- Clamp min(100,·), Bänder hot≥70/warm≥40). Idempotent (FOR UPDATE +
-- deterministisches Ergebnis); fehlendes Projekt = stiller No-Op (Zeile
-- gelöscht/erasure — kein Retry-Grund). Fasst updated_at bewusst NICHT an
-- (abgeleiteter Wert, keine fachliche Lead-Aktivität).
CREATE OR REPLACE FUNCTION public._f121_recompute_lead_score(
  p_workspace_id uuid,
  p_project_id uuid
)
RETURNS TABLE (
  score_value integer,
  score_band text,
  score_signals text[],
  score_computed_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f121_recompute$
DECLARE
  v_contact_id uuid;
  v_site_id uuid;
  v_lead_source_id uuid;
  v_email boolean := false;
  v_phone boolean := false;
  v_address boolean := false;
  v_geo boolean := false;
  v_profile boolean := false;
  v_profile_confirmed boolean := false;
  v_requirements boolean := false;
  v_key_account boolean := false;
  v_source boolean := false;
  v_intent boolean := false;
  v_raw integer := 0;
  v_now timestamp with time zone;
BEGIN
  SELECT project_row.contact_id, project_row.site_id, project_row.lead_source_id
    INTO v_contact_id, v_site_id, v_lead_source_id
    FROM public.project AS project_row
   WHERE project_row.workspace_id = p_workspace_id
     AND project_row.id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Kontakt/Site-Signale (Nichtleer = enthält Nicht-Whitespace, Spiegel von
  -- String.trim() !== '' in der Service-Schicht).
  SELECT
    coalesce(contact_row.email_primary ~ E'\\S', false),
    coalesce(coalesce(
      contact_row.phone_e164, contact_row.phone_mobile, contact_row.phone_raw
    ) ~ E'\\S', false),
    coalesce(site_row.postal_code ~ E'\\S', false)
      AND coalesce(site_row.city ~ E'\\S', false),
    site_row.lat IS NOT NULL AND site_row.lng IS NOT NULL
    INTO v_email, v_phone, v_address, v_geo
    FROM public.contact AS contact_row
    JOIN public.site AS site_row
      ON site_row.workspace_id = contact_row.workspace_id
     AND site_row.id = v_site_id
   WHERE contact_row.workspace_id = p_workspace_id
     AND contact_row.id = v_contact_id;
  IF NOT FOUND THEN
    v_email := false;
    v_phone := false;
    v_address := false;
    v_geo := false;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.site_energy_profile AS energy_profile
     WHERE energy_profile.workspace_id = p_workspace_id
       AND energy_profile.site_id = v_site_id
  ) INTO v_profile;
  SELECT EXISTS (
    SELECT 1
      FROM public.site_energy_profile AS energy_profile
     WHERE energy_profile.workspace_id = p_workspace_id
       AND energy_profile.site_id = v_site_id
       AND energy_profile.confirmed_at IS NOT NULL
  ) INTO v_profile_confirmed;

  SELECT (
    SELECT requirement.requirements
      FROM public.project_requirement AS requirement
     WHERE requirement.workspace_id = p_workspace_id
       AND requirement.project_id = p_project_id
     ORDER BY requirement.revision DESC
     LIMIT 1
  ) IS NOT NULL INTO v_requirements;

  -- Spiegel des Board-Joins (Assignment + Membership + Identität).
  SELECT EXISTS (
    SELECT 1
      FROM public.project_assignment AS assignment_record
      JOIN public.membership AS membership_record
        ON membership_record.workspace_id = assignment_record.workspace_id
       AND membership_record.id = assignment_record.membership_id
      JOIN public.user_identity AS identity_record
        ON identity_record.id = membership_record.user_id
     WHERE assignment_record.workspace_id = p_workspace_id
       AND assignment_record.project_id = p_project_id
       AND assignment_record.assignment_role = 'key_account'
  ) INTO v_key_account;

  v_source := v_lead_source_id IS NOT NULL;

  -- Intent-OR über 4 kundeninitiierte Quellen (kein Tracking).
  SELECT (
    EXISTS (
      SELECT 1
        FROM public.portal_view_log AS portal_view
        JOIN public.portal_invite AS portal_invite
          ON portal_invite.workspace_id = portal_view.workspace_id
         AND portal_invite.id = portal_view.portal_invite_id
       WHERE portal_view.workspace_id = p_workspace_id
         AND portal_invite.project_id = p_project_id
    )
    OR EXISTS (
      SELECT 1
        FROM public.project_appointment AS appointment
       WHERE appointment.workspace_id = p_workspace_id
         AND appointment.project_id = p_project_id
    )
    OR EXISTS (
      SELECT 1
        FROM public.signature_view_log AS signature_view
        JOIN public.signature_request AS signature_request
          ON signature_request.workspace_id = signature_view.workspace_id
         AND signature_request.id = signature_view.signature_request_id
       WHERE signature_view.workspace_id = p_workspace_id
         AND signature_request.project_id = p_project_id
    )
    OR EXISTS (
      SELECT 1
        FROM public.file_request_upload AS upload
       WHERE upload.workspace_id = p_workspace_id
         AND upload.project_id = p_project_id
    )
  ) INTO v_intent;

  v_raw := (CASE WHEN v_email THEN 10 ELSE 0 END)
    + (CASE WHEN v_phone THEN 10 ELSE 0 END)
    + (CASE WHEN v_address THEN 10 ELSE 0 END)
    + (CASE WHEN v_geo THEN 10 ELSE 0 END)
    + (CASE WHEN v_profile THEN 20 ELSE 0 END)
    + (CASE WHEN v_profile AND v_profile_confirmed THEN 10 ELSE 0 END)
    + (CASE WHEN v_requirements THEN 15 ELSE 0 END)
    + (CASE WHEN v_key_account THEN 10 ELSE 0 END)
    + (CASE WHEN v_source THEN 5 ELSE 0 END)
    + (CASE WHEN v_intent THEN 10 ELSE 0 END);
  score_value := LEAST(100, v_raw);
  score_band := CASE
    WHEN score_value >= 70 THEN 'hot'
    WHEN score_value >= 40 THEN 'warm'
    ELSE 'cold'
  END;
  score_signals := pg_catalog.array_remove(ARRAY[
    CASE WHEN v_email THEN 'email' END,
    CASE WHEN v_phone THEN 'phone' END,
    CASE WHEN v_address THEN 'address' END,
    CASE WHEN v_geo THEN 'geo' END,
    CASE WHEN v_profile THEN 'profile' END,
    CASE WHEN v_profile AND v_profile_confirmed THEN 'profileConfirmed' END,
    CASE WHEN v_requirements THEN 'requirements' END,
    CASE WHEN v_key_account THEN 'keyAccount' END,
    CASE WHEN v_source THEN 'source' END,
    CASE WHEN v_intent THEN 'intent' END
  ], NULL);
  v_now := pg_catalog.now();

  UPDATE public.project AS project_row
     SET lead_score_value = score_value,
         lead_score_band = score_band,
         lead_score_signals = score_signals,
         lead_score_computed_at = v_now,
         lead_score_status = 'ready'
   WHERE project_row.workspace_id = p_workspace_id
     AND project_row.id = p_project_id;

  score_computed_at := v_now;
  RETURN NEXT;
END
$f121_recompute$;--> statement-breakpoint
DO $f121_recompute_acl$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public._f121_recompute_lead_score(uuid, uuid) FROM PUBLIC';
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public._f121_recompute_lead_score(uuid, uuid) TO app_worker';
  END IF;
END
$f121_recompute_acl$;--> statement-breakpoint
-- Kapsel 2/2: Dispatch in die worker-owned pg-boss-Queue (einzige
-- Runtime-Naht, Muster 0033). Testdatenbanken ohne pg-boss dürfen die
-- Migration explizit unter app_test/app_ci ausführen; jede andere fehlende
-- oder driftende Installation bricht fail-closed ab.
DO $f121_lead_score_dispatch_migration$
DECLARE
  pgboss_owner text;
  pgboss_version integer;
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
    RAISE EXCEPTION 'F1-21 lead score dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'F1-21 lead score dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'F1-21 lead score dispatch: app_migrator braucht SET auf app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'F1-21 lead score dispatch: pg-boss ist nicht initialisiert';
  END IF;
  SELECT pg_catalog.max(version)
    INTO pgboss_version
    FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'F1-21 lead score dispatch: erwartet pg-boss v38, ist %',
      pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'lead.score.recompute.v1'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 10
     AND queue.retry_delay = 1
     AND queue.retry_backoff = true
     AND queue.retry_delay_max = 60
     AND queue.expire_seconds = 180
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F1-21 lead score dispatch: lead.score.recompute.v1-Queue fehlt oder driftet (Bootstrap zuerst ausführen)';
  END IF;

  EXECUTE $dispatch_ddl$
    CREATE OR REPLACE FUNCTION pgboss.enqueue_lead_score_recompute(
      workspace_id uuid,
      project_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $dispatch_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_key text;
      runtime_pgboss_version integer;
    BEGIN
      IF NULLIF(
           pg_catalog.current_setting('app.workspace_id', true), ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'lead score dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 121021121)
      );
      SELECT pg_catalog.max(version)
        INTO runtime_pgboss_version
        FROM pgboss.version;
      IF runtime_pgboss_version IS DISTINCT FROM 38 THEN
        RAISE EXCEPTION 'lead score dispatch: pg-boss-Schemaversion driftet';
      END IF;
      SELECT *
        INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'lead.score.recompute.v1';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'lead score dispatch: Queuevertrag fehlt oder driftet';
      END IF;

      -- Worker-owned Kapsel: KEIN Zugriff auf public.project (ACL-Trennung).
      -- Der Aufrufer (app_runtime) kippt lead_score_status selbst auf pending;
      -- fehlende Projekte erledigt der Worker als No-Op (Recompute-Kapsel).
      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'lead-score-recompute-dispatch.v1',
        'workspaceId', $1::text,
        'projectId', $2::text
      );
      dispatch_key := $2::text;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'lead.score.recompute.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'lead.score.recompute.v1'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'lead score dispatch: aktiver Job verletzt Vertrag';
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
             pg_catalog.now(),
             dispatch_key,
             queue_config.expire_seconds,
             queue_config.deletion_seconds,
             pg_catalog.now()
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
           WHERE queued_job.name = 'lead.score.recompute.v1'
             AND queued_job.singleton_key = dispatch_key
             AND queued_job.data = dispatch_payload
             AND queued_job.policy = 'exclusive'
             AND queued_job.state IN ('created', 'retry', 'active')
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'lead score dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $dispatch_body$
  $dispatch_ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION pgboss.enqueue_lead_score_recompute(uuid, uuid) FROM PUBLIC';
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_lead_score_recompute(uuid, uuid) TO app_runtime';
  END IF;
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_lead_score_recompute(uuid, uuid) TO app_worker';
  END IF;
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$f121_lead_score_dispatch_migration$;

