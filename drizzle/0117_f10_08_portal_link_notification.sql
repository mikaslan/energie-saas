DROP INDEX "customer_notification_ws_project_active_uq";--> statement-breakpoint
ALTER TABLE "customer_notification" ADD COLUMN "invite_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_notification" ADD CONSTRAINT "customer_notification_invite_fk" FOREIGN KEY ("workspace_id","invite_id") REFERENCES "public"."portal_invite"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notification_ws_project_template_active_uq" ON "customer_notification" USING btree ("workspace_id","project_id","template_id") WHERE "customer_notification"."status" in ('queued', 'failed_retriable');--> statement-breakpoint
ALTER TABLE "customer_notification" ADD CONSTRAINT "customer_notification_template_ck" CHECK ("customer_notification"."template_id" in ('cannot-fulfil.v1', 'portal-link.v1'));--> statement-breakpoint
ALTER TABLE "customer_notification" ADD CONSTRAINT "customer_notification_template_invite_ck" CHECK (((("customer_notification"."template_id" = 'portal-link.v1') and ("customer_notification"."invite_id" is not null)) or (("customer_notification"."template_id" = 'cannot-fulfil.v1') and ("customer_notification"."invite_id" is null))));
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F10-08 Portal-Link-Automatik (Versand Slice 1): zweite Kunden-Mail-
-- Automatik `portal-link.v1` ueber die bestehende M1-11b-Outbox. Empfaenger
-- ist der Projekt-Contact (proven Contact-Graph-Pfad wie cannot-fulfil;
-- ID-only-Payload, Aufloesung erst zum Zustellzeitpunkt, ADR 0018).
-- Echter Provider-Versand bleibt ausgeschlossen (Noop-Transport;
-- RESEND_API_KEY ist externer Blocker, fragen an codex/offen).
--
-- ESTIMATE (Reonic-Automatik unverifiziert): Rotation/Entzug storniert die
-- noch aktive Automatik (cancelled_manual) — nie Dead-Links. Genau eine
-- aktive Notification je (Projekt, Template). Ablauf-vor-Zustellung ist
-- praktisch ausgeschlossen (TTL Tage vs. Sekunden-Dispatch) und faellt auf
-- die Kontaktaufloesung zurueck.
-- ═══════════════════════════════════════════════════════════════════════
-- Guard: identisch zu _m111b_guard_customer_notification, plus
-- Template-Verzweigung (Idempotenzmuster je Template, Invite-Bindung fuer
-- portal-link) und invite_id-Immutabilitaet. cannot-fulfil-Pfad unveraendert.
CREATE OR REPLACE FUNCTION public._m111b_guard_customer_notification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m111b_notification_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_notification DELETE ist verboten; Storno als Statusuebergang'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'queued'
       OR NEW.attempt_count IS DISTINCT FROM 0
       OR NEW.dispatched_at IS NOT NULL
       OR NEW.delivered_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'customer_notification beginnt queued ohne Evidenz'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.template_id = 'cannot-fulfil.v1' THEN
      IF NEW.invite_id IS NOT NULL
         OR NEW.idempotency_key IS DISTINCT FROM ('cannot-fulfil:' || NEW.project_id::text) THEN
        RAISE EXCEPTION 'customer_notification beginnt queued mit deterministischem Idempotenzschluessel'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.project AS project_record
         WHERE project_record.workspace_id = NEW.workspace_id
           AND project_record.id = NEW.project_id
           AND project_record.outcome = 'cannot_fulfill'
      ) THEN
        RAISE EXCEPTION 'customer_notification verlangt eine cannot_fulfill-Transition'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.template_id = 'portal-link.v1' THEN
      IF NEW.invite_id IS NULL
         OR NEW.idempotency_key IS DISTINCT FROM ('portal-link:' || NEW.invite_id::text) THEN
        RAISE EXCEPTION 'customer_notification portal-link verlangt Invite-Idempotenzschluessel'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.portal_invite AS invite_record
         WHERE invite_record.workspace_id = NEW.workspace_id
           AND invite_record.id = NEW.invite_id
           AND invite_record.project_id = NEW.project_id
           AND invite_record.status = 'active'
      ) THEN
        RAISE EXCEPTION 'customer_notification portal-link verlangt aktive Einladung'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'customer_notification unbekanntes Template'
        USING ERRCODE = '23514';
    END IF;
    NEW.next_attempt_at := mutation_time;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  -- UPDATE: unveraenderliche Felder bleiben fix (invite_id neu).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.invite_id IS DISTINCT FROM OLD.invite_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer_notification Update darf unveraenderliche Felder nicht aendern'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = NEW.status THEN
    -- P2-B6: Reiner Dispatch-/Retry-Fortschritt ohne Statuswechsel. Nur
    -- attempt_count, next_attempt_at und dispatched_at duerfen sich bewegen;
    -- Evidenzfelder (delivered_at/failed_at/cancelled_at/error*) bleiben fix.
    IF NEW.attempt_count < OLD.attempt_count
       OR NEW.attempt_count > OLD.attempt_count + 1
       OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.error_code IS DISTINCT FROM OLD.error_code
       OR NEW.error_retryable IS DISTINCT FROM OLD.error_retryable THEN
      RAISE EXCEPTION 'customer_notification Same-Status-Update darf nur Dispatch-Fortschritt aendern'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status IN ('queued', 'failed_retriable')
        AND NEW.status IN ('delivered', 'failed_retriable', 'failed_final',
                           'cancelled_contact_erased', 'cancelled_manual') THEN
    NULL; -- erlaubte klassifizierte/terminale Uebergaenge
  ELSE
    RAISE EXCEPTION 'Illegale customer_notification-Transition'
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m111b_notification_guard$;--> statement-breakpoint
-- Worker liest das Zeilen-Template (Handler versendet je Template-Art;
-- Payload bleibt ID-only, kein Template im Job).
CREATE FUNCTION public._f1008_worker_notification_template(
  requested_workspace_id uuid,
  requested_notification_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1008_notification_template$
BEGIN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', requested_workspace_id::text, true
  );
  RETURN (
    SELECT notification_record.template_id
      FROM public.customer_notification AS notification_record
     WHERE notification_record.workspace_id = requested_workspace_id
       AND notification_record.id = requested_notification_id
  );
END
$f1008_notification_template$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f1008_worker_notification_template(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
-- Storno aktiver Portal-Link-Automatiken eines Projekts (Entzug/Rotation):
-- DEFINER-Kapsel, weil app_runtime kein UPDATE auf customer_notification
-- besitzt (Guard-erlaubte queued/failed_retriable -> cancelled_manual).
-- Aufruf aus withdrawPortalInvite (Service) — Rotation erledigt
-- create_portal_invite intern (gleiche Transaktion, siehe unten).
CREATE FUNCTION public._f1008_cancel_project_portal_notification(
  requested_workspace_id uuid,
  requested_project_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1008_cancel_project_portal_notification$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
BEGIN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', requested_workspace_id::text, true
  );
  UPDATE public.customer_notification AS notification_record
     SET status = 'cancelled_manual',
         cancelled_at = mutation_time
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.project_id = requested_project_id
     AND notification_record.template_id = 'portal-link.v1'
     AND notification_record.status IN ('queued', 'failed_retriable');
END
$f1008_cancel_project_portal_notification$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f1008_cancel_project_portal_notification(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
DO $f1008_worker_acl$
BEGIN
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public._f1008_worker_notification_template(uuid, uuid) TO app_worker;
  END IF;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public._f1008_cancel_project_portal_notification(uuid, uuid) TO app_runtime;
  END IF;
END
$f1008_worker_acl$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.create_portal_invite(
  requested_workspace_id uuid,
  requested_project_id uuid,
  requested_ttl_days integer,
  requested_token_hash bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1001_create_invite$
DECLARE
  actor_id uuid := public.app_actor_id();
  expires_at timestamptz;
  new_id uuid := pg_catalog.gen_random_uuid();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF requested_ttl_days < 1 OR requested_ttl_days > 60 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_ttl'
    );
  END IF;
  IF pg_catalog.octet_length(requested_token_hash) <> 32 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'invalid_binding'
    );
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = requested_project_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  UPDATE public.portal_invite AS old_invite
     SET status = 'withdrawn',
         withdrawn_at = mutation_time,
         withdrawn_by = actor_id,
         withdraw_reason = 'superseded'
   WHERE old_invite.workspace_id = requested_workspace_id
     AND old_invite.project_id = requested_project_id
     AND old_invite.status = 'active';

  -- F10-08: Rotation storniert noch aktive Portal-Link-Automatiken der alten
  -- Einladung in derselben Transaktion (nie Dead-Links; Guard-erlaubte
  -- queued/failed_retriable -> cancelled_manual-Transition).
  UPDATE public.customer_notification AS stale_notification
     SET status = 'cancelled_manual',
         cancelled_at = mutation_time
   WHERE stale_notification.workspace_id = requested_workspace_id
     AND stale_notification.project_id = requested_project_id
     AND stale_notification.template_id = 'portal-link.v1'
     AND stale_notification.status IN ('queued', 'failed_retriable');

  expires_at := mutation_time + (requested_ttl_days * interval '1 day');

  BEGIN
    INSERT INTO public.portal_invite (
      id, workspace_id, project_id, status, token_hash, expires_at, created_by
    ) VALUES (
      new_id, requested_workspace_id, requested_project_id, 'active',
      requested_token_hash, expires_at, actor_id
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'code', 'race_detected'
    );
  END;

  INSERT INTO public.portal_token_locator (
    token_hash, workspace_id, portal_invite_id
  ) VALUES (
    requested_token_hash, requested_workspace_id, new_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'active',
    'inviteId', new_id,
    'projectId', requested_project_id,
    'expiresAt', expires_at,
    'replayed', false
  );
END
$f1001_create_invite$;
