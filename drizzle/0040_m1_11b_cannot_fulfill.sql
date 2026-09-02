CREATE TABLE "customer_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"template_id" text DEFAULT 'cannot-fulfil.v1' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	"error_retryable" boolean,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notification_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "customer_notification_ws_idempotency_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "customer_notification_status_ck" CHECK ("customer_notification"."status" in ('queued', 'delivered', 'failed_retriable', 'failed_final', 'cancelled_contact_erased', 'cancelled_manual')),
	CONSTRAINT "customer_notification_attempt_count_ck" CHECK ("customer_notification"."attempt_count" >= 0),
	CONSTRAINT "customer_notification_error_class_ck" CHECK ("customer_notification"."error_code" is null or "customer_notification"."error_code" in ('recipient_unavailable', 'transport_unavailable', 'provider_rejected', 'invalid_template')),
	CONSTRAINT "customer_notification_timestamps_ck" CHECK ("customer_notification"."updated_at" >= "customer_notification"."created_at")
);
--> statement-breakpoint
CREATE TABLE "customer_notification_delivery_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_class" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notification_delivery_attempt_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "customer_notification_delivery_attempt_ws_notification_attempt_uq" UNIQUE("workspace_id","notification_id","attempt_number"),
	CONSTRAINT "customer_notification_delivery_attempt_outcome_ck" CHECK ("customer_notification_delivery_attempt"."outcome" in ('delivered', 'failed_retriable', 'failed_final')),
	CONSTRAINT "customer_notification_delivery_attempt_number_ck" CHECK ("customer_notification_delivery_attempt"."attempt_number" >= 1),
	CONSTRAINT "customer_notification_delivery_attempt_error_ck" CHECK (("customer_notification_delivery_attempt"."outcome" = 'delivered' and "customer_notification_delivery_attempt"."error_class" is null)
          or ("customer_notification_delivery_attempt"."outcome" in ('failed_retriable', 'failed_final')
              and "customer_notification_delivery_attempt"."error_class" in ('recipient_unavailable', 'transport_unavailable', 'provider_rejected', 'invalid_template')))
);
--> statement-breakpoint
DROP INDEX "project_ws_request_closed_idx";--> statement-breakpoint
ALTER TABLE "customer_notification" ADD CONSTRAINT "customer_notification_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification" ADD CONSTRAINT "customer_notification_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_delivery_attempt" ADD CONSTRAINT "customer_notification_delivery_attempt_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_delivery_attempt" ADD CONSTRAINT "customer_notification_delivery_attempt_notification_fk" FOREIGN KEY ("workspace_id","notification_id") REFERENCES "public"."customer_notification"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_notification_ws_project_active_uq" ON "customer_notification" USING btree ("workspace_id","project_id") WHERE "customer_notification"."status" in ('queued', 'failed_retriable');--> statement-breakpoint
CREATE INDEX "project_ws_request_closed_idx" ON "project" USING btree ("workspace_id","closed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "project"."phase" = 'request' and "project"."outcome" in ('won', 'lost', 'cannot_fulfill');--> statement-breakpoint
-- M1-11b Cannot Fulfil: Transactional Outbox + Kundenbenachrichtigung + Freeze
-- (custom-SQL-Teil nach dem von drizzle-kit generierten Tabellen-DDL).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.customer_notification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.customer_notification FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.customer_notification
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

ALTER TABLE public.customer_notification_delivery_attempt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.customer_notification_delivery_attempt FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.customer_notification_delivery_attempt
  USING (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid
  );--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Freeze-Guard (Angebotssperre) — nur auf INSERT, vier Angebotstabellen.
-- Review-Befund P0-1: der gemeinsame Serialisierungspunkt gegen
-- mark_cannot_fulfill (FOR UPDATE auf project) ist das FOR SHARE auf die
-- Project-Zeile, DANN die Outcome-Prüfung. So können Transition und
-- INSERT-basierte Aktivierung nicht beide unter READ COMMITTED committen.
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m111b_guard_offer_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m111b_offer_freeze$
DECLARE
  project_outcome text;
BEGIN
  SELECT project_record.outcome
    INTO project_outcome
    FROM public.project AS project_record
   WHERE project_record.workspace_id = NEW.workspace_id
     AND project_record.id = NEW.project_id
   FOR SHARE;
  IF NOT FOUND THEN
    -- Fremdes/fehlendes Project: die composite-FK (workspace_id, project_id)
    -- lehnt den Insert ohnehin ab; hier nicht vorweg werfen, damit die RLS-
    -- with-check-Reihenfolge im Cross-Tenant-Test erhalten bleibt.
    RETURN NEW;
  END IF;
  IF project_outcome = 'cannot_fulfill' THEN
    RAISE EXCEPTION 'project_cannot_fulfil_locked'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$m111b_offer_freeze$;--> statement-breakpoint

-- Review-Befund P1-5: verifiziert — alle vier Tabellen entstehen ausschließlich
-- per INSERT (Approvals sind append-only, Candidates/Issuances werden per INSERT
-- angelegt; der worker-`state`-Lauf ist Fortschritt, keine Aktivierung). Es gibt
-- keine Signatur-Tabelle im Scope (M2-03b2 bleibt blockiert). Freeze bleibt
-- deshalb bewusst INSERT-only; der Erasure-DELETE-Pfad bleibt frei.
CREATE TRIGGER offer_release_candidate_cannot_fulfil_freeze
BEFORE INSERT ON public.offer_release_candidate
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_offer_freeze();--> statement-breakpoint
CREATE TRIGGER offer_release_candidate_approval_cannot_fulfil_freeze
BEFORE INSERT ON public.offer_release_candidate_approval
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_offer_freeze();--> statement-breakpoint
CREATE TRIGGER offer_issuance_cannot_fulfil_freeze
BEFORE INSERT ON public.offer_issuance
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_offer_freeze();--> statement-breakpoint
CREATE TRIGGER offer_issuance_approval_cannot_fulfil_freeze
BEFORE INSERT ON public.offer_issuance_approval
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_offer_freeze();--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Outbox-Mutationsguard. Review-Befunde P2-6/P2-9: Storno deckt queued UND
-- failed_retriable; cancelled_manual ist fachliches Storno, cancelled_contact_erased
-- bleibt DSGVO-Erasure. Kein physisches DELETE.
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m111b_guard_customer_notification()
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
       OR NEW.cancelled_at IS NOT NULL
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
    NEW.next_attempt_at := mutation_time;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  -- UPDATE: unveraenderliche Felder bleiben fix.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer_notification Update darf unveraenderliche Felder nicht aendern'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = NEW.status THEN
    -- Reiner Dispatch-/Retry-Fortschritt ohne Statuswechsel.
    IF NEW.attempt_count < OLD.attempt_count
       OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'customer_notification attempt_count driftet'
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

CREATE TRIGGER customer_notification_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.customer_notification
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_customer_notification();--> statement-breakpoint
CREATE TRIGGER customer_notification_no_truncate
BEFORE TRUNCATE ON public.customer_notification
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Append-only Zustellevidenz. Review-Befund P2-7: nur Enum-Fehlercodes und
-- Metadaten, nie Provider-/SMTP-Rohmeldungen.
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m111b_guard_delivery_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m111b_attempt_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_notification_delivery_attempt DELETE ist verboten'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'customer_notification_delivery_attempt UPDATE ist verboten'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customer_notification AS notification_record
     WHERE notification_record.workspace_id = NEW.workspace_id
       AND notification_record.id = NEW.notification_id
       AND notification_record.status IN ('queued', 'failed_retriable')
  ) THEN
    RAISE EXCEPTION 'customer_notification_delivery_attempt verlangt eine zustellbare Outbox-Zeile'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$m111b_attempt_guard$;--> statement-breakpoint

CREATE TRIGGER customer_notification_delivery_attempt_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.customer_notification_delivery_attempt
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_delivery_attempt();--> statement-breakpoint
CREATE TRIGGER customer_notification_delivery_attempt_no_truncate
BEFORE TRUNCATE ON public.customer_notification_delivery_attempt
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Quellgepinnte Ersetzungen der drei M1-11a-Funktionen durch _m111b_*-Varianten.
-- ════════════════════════════════════════════════════════════════════════

DO $m111b_replace_outcome_guard$
DECLARE
  source text;
  source_sha256 text;
  anchor constant text := $m111b_anchor$ELSIF OLD.outcome IN ('won', 'lost') AND NEW.outcome = 'open' THEN$m111b_anchor$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')), 'hex'
         )
    INTO source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = '_m111a_guard_project_outcome'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = '';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b: _m111a_guard_project_outcome fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '3952346bb8ee74692d7608d62f29fd57b4a13c847f6fd5a16db71b004ccd88a6' THEN
    RAISE EXCEPTION 'M1-11b: unerwarteter _m111a_guard_project_outcome-Hash %',
      source_sha256;
  END IF;
  IF (pg_catalog.length(source) - pg_catalog.length(pg_catalog.replace(source, anchor, '')))
       / pg_catalog.length(anchor) <> 1 THEN
    RAISE EXCEPTION 'M1-11b: gepinnter Outcome-Guard-Anker fehlt oder ist mehrdeutig';
  END IF;
END
$m111b_replace_outcome_guard$;--> statement-breakpoint

CREATE FUNCTION public._m111b_guard_project_outcome()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m111b_outcome_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
  actor_role text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome IS DISTINCT FROM 'open'
       OR NEW.outcome_revision IS DISTINCT FROM 0
       OR NEW.closed_at IS NOT NULL
       OR NEW.loss_reason_id IS NOT NULL
       OR NEW.loss_reason_text IS NOT NULL THEN
      RAISE EXCEPTION 'Project muss ohne vorweggenommenes Outcome beginnen'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.outcome = 'lost'
     AND OLD.loss_reason_text IS NOT NULL
     AND NEW.loss_reason_text IS NULL
     AND NEW.name = 'geloescht-' || NEW.id::text
     AND NEW.dedupe_review_required = false
     AND NEW.updated_at >= OLD.updated_at
     AND (
       pg_catalog.to_jsonb(NEW)
         - ARRAY[
             'name', 'dedupe_review_required', 'loss_reason_text', 'updated_at'
           ]::text[]
     ) IS NOT DISTINCT FROM (
       pg_catalog.to_jsonb(OLD)
         - ARRAY[
             'name', 'dedupe_review_required', 'loss_reason_text', 'updated_at'
           ]::text[]
     ) THEN
    IF public._m111a_erasure_scrub_allowed(OLD.workspace_id, OLD.id) THEN
      RETURN NEW;
    END IF;
  END IF;

  actor_role := public._m111a_actor_role(NEW.workspace_id);
  IF actor_role IS NULL OR actor_role NOT IN ('editor', 'admin') THEN
    RAISE EXCEPTION 'Project-Outcome verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1
    FROM public.contact AS contact_record
   WHERE contact_record.workspace_id = NEW.workspace_id
     AND contact_record.id = NEW.contact_id
     AND contact_record.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project-Outcome ist fuer geloeschte Kontakte gesperrt'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.phase <> 'request'
     OR NEW.phase <> 'request'
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kanban_board_id IS DISTINCT FROM OLD.kanban_board_id
     OR NEW.kanban_column_id IS DISTINCT FROM OLD.kanban_column_id
     OR OLD.outcome_revision >= 2147483647
     OR NEW.outcome_revision <> OLD.outcome_revision + 1 THEN
    RAISE EXCEPTION 'Project-Outcome verletzt Scope, Board oder Revision'
      USING ERRCODE = '23514';
  END IF;
  IF (
    pg_catalog.to_jsonb(NEW)
      - ARRAY[
          'outcome', 'outcome_revision', 'closed_at', 'loss_reason_id',
          'loss_reason_text', 'updated_at'
        ]::text[]
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD)
      - ARRAY[
          'outcome', 'outcome_revision', 'closed_at', 'loss_reason_id',
          'loss_reason_text', 'updated_at'
        ]::text[]
  ) THEN
    RAISE EXCEPTION 'Project-Outcome darf keine fremden Projectfelder aendern'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.outcome = 'open' AND NEW.outcome = 'won' THEN
    IF NEW.loss_reason_id IS NOT NULL OR NEW.loss_reason_text IS NOT NULL THEN
      RAISE EXCEPTION 'Won darf keinen Verlustgrund tragen'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := mutation_time;
  ELSIF OLD.outcome = 'open' AND NEW.outcome = 'lost' THEN
    IF NEW.loss_reason_id IS NULL THEN
      RAISE EXCEPTION 'Lost verlangt einen strukturierten Verlustgrund'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project_loss_reason AS reason_record
     WHERE reason_record.workspace_id = NEW.workspace_id
       AND reason_record.id = NEW.loss_reason_id
       AND reason_record.archived_at IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lost-Verlustgrund fehlt, ist fremd oder archiviert'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := mutation_time;
  ELSIF OLD.outcome = 'open' AND NEW.outcome = 'cannot_fulfill' THEN
    IF NEW.loss_reason_id IS NOT NULL OR NEW.loss_reason_text IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot Fulfil darf keinen Verlustgrund tragen'
        USING ERRCODE = '23514';
    END IF;
    NEW.closed_at := mutation_time;
  ELSIF OLD.outcome IN ('won', 'lost') AND NEW.outcome = 'open' THEN
    NEW.closed_at := NULL;
    NEW.loss_reason_id := NULL;
    NEW.loss_reason_text := NULL;
  ELSE
    RAISE EXCEPTION 'Illegale Project-Outcome-Transition'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m111b_outcome_guard$;--> statement-breakpoint

DO $m111b_replace_outcome_evidence$
DECLARE
  source text;
  source_sha256 text;
  anchor constant text := $m111b_anchor$WHEN OLD.outcome IN ('won', 'lost') AND NEW.outcome = 'open'$m111b_anchor$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')), 'hex'
         )
    INTO source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = '_m111a_record_project_outcome'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = '';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b: _m111a_record_project_outcome fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '2472df44c865e488ca1d205c905c8fb85a5a9f1fd2c0bdd9f8ef271cee210a81' THEN
    RAISE EXCEPTION 'M1-11b: unerwarteter _m111a_record_project_outcome-Hash %',
      source_sha256;
  END IF;
  IF (pg_catalog.length(source) - pg_catalog.length(pg_catalog.replace(source, anchor, '')))
       / pg_catalog.length(anchor) <> 1 THEN
    RAISE EXCEPTION 'M1-11b: gepinnter Evidenz-Anker fehlt oder ist mehrdeutig';
  END IF;
END
$m111b_replace_outcome_evidence$;--> statement-breakpoint

CREATE FUNCTION public._m111b_record_project_outcome()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111b_outcome_evidence$
DECLARE
  actor_id uuid := public.app_actor_id();
  event_type text;
  evidence jsonb;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Project-Outcome-Evidenz verlangt einen Actor'
      USING ERRCODE = '42501';
  END IF;
  event_type := CASE
    WHEN OLD.outcome = 'open' AND NEW.outcome = 'won'
      THEN 'project.outcome_won'
    WHEN OLD.outcome = 'open' AND NEW.outcome = 'lost'
      THEN 'project.outcome_lost'
    WHEN OLD.outcome = 'open' AND NEW.outcome = 'cannot_fulfill'
      THEN 'project.outcome_cannot_fulfil'
    WHEN OLD.outcome IN ('won', 'lost') AND NEW.outcome = 'open'
      THEN 'project.outcome_reopened'
    ELSE NULL
  END;
  IF event_type IS NULL THEN
    RAISE EXCEPTION 'Unbekannte Project-Outcome-Evidenzkante'
      USING ERRCODE = '23514';
  END IF;
  evidence := pg_catalog.jsonb_build_object(
    'projectId', NEW.id::text,
    'previousOutcome', OLD.outcome,
    'nextOutcome', NEW.outcome,
    'outcomeRevision', NEW.outcome_revision
  );
  IF NEW.outcome = 'lost' THEN
    evidence := evidence || pg_catalog.jsonb_build_object(
      'lossReasonId', NEW.loss_reason_id::text,
      'hasComment', NEW.loss_reason_text IS NOT NULL
    );
  ELSIF OLD.outcome = 'lost' THEN
    evidence := evidence || pg_catalog.jsonb_build_object(
      'lossReasonId', OLD.loss_reason_id::text,
      'hasComment', OLD.loss_reason_text IS NOT NULL
    );
  END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    NEW.workspace_id, 'project', NEW.id, event_type,
    actor_id::text, evidence, NEW.updated_at
  );
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details, occurred_at
  ) VALUES (
    NEW.workspace_id, actor_id::text, 'project.outcome.write',
    'project', true, evidence, NEW.updated_at
  );
  RETURN NULL;
END
$m111b_outcome_evidence$;--> statement-breakpoint

DO $m111b_replace_outcome_evidence_guard$
DECLARE
  source text;
  source_sha256 text;
  anchor constant text := $m111b_anchor$'project.outcome_reopened'$m111b_anchor$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')), 'hex'
         )
    INTO source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = '_m111a_guard_outcome_evidence_insert'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = '';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b: _m111a_guard_outcome_evidence_insert fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '0816b66f08461d515e44d3746c08e12e0f85bc8390d57d73ec1d17ccd39ed876' THEN
    RAISE EXCEPTION 'M1-11b: unerwarteter _m111a_guard_outcome_evidence_insert-Hash %',
      source_sha256;
  END IF;
  IF (pg_catalog.length(source) - pg_catalog.length(pg_catalog.replace(source, anchor, '')))
       / pg_catalog.length(anchor) <> 1 THEN
    RAISE EXCEPTION 'M1-11b: gepinnter Whitelist-Anker fehlt oder ist mehrdeutig';
  END IF;
END
$m111b_replace_outcome_evidence_guard$;--> statement-breakpoint

CREATE FUNCTION public._m111b_guard_outcome_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111b_outcome_evidence_guard$
BEGIN
  IF TG_TABLE_NAME = 'domain_events' THEN
    IF NEW.event_type IN (
         'project.outcome_won', 'project.outcome_lost',
         'project.outcome_reopened', 'project.outcome_cannot_fulfil'
       ) THEN
      IF pg_catalog.pg_trigger_depth() <> 2
         OR NEW.aggregate_type IS DISTINCT FROM 'project'
         OR NEW.aggregate_id::text IS DISTINCT FROM NEW.payload->>'projectId'
         OR NEW.actor IS DISTINCT FROM public.app_actor_id()::text THEN
        RAISE EXCEPTION 'Project-Outcome-Event verlangt den Transition-Trigger'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'audit_log' THEN
    IF NEW.action = 'project.outcome.write' AND NEW.allowed IS TRUE THEN
      IF pg_catalog.pg_trigger_depth() <> 2
         OR NEW.resource IS DISTINCT FROM 'project'
         OR NEW.actor IS DISTINCT FROM public.app_actor_id()::text THEN
        RAISE EXCEPTION 'Project-Outcome-Audit verlangt den Transition-Trigger'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$m111b_outcome_evidence_guard$;--> statement-breakpoint

-- Trigger umhaengen und alte M1-11a-Funktionen entfernen.
DROP TRIGGER project_outcome_mutation_guard ON public.project;--> statement-breakpoint
DROP TRIGGER project_outcome_insert_guard ON public.project;--> statement-breakpoint
DROP TRIGGER project_outcome_evidence ON public.project;--> statement-breakpoint
DROP TRIGGER domain_events_project_outcome_insert_guard ON public.domain_events;--> statement-breakpoint
DROP TRIGGER audit_log_project_outcome_insert_guard ON public.audit_log;--> statement-breakpoint

CREATE TRIGGER project_outcome_mutation_guard
BEFORE UPDATE OF outcome, outcome_revision, closed_at, loss_reason_id,
  loss_reason_text ON public.project
FOR EACH ROW
WHEN (
  OLD.outcome IS DISTINCT FROM NEW.outcome
  OR OLD.outcome_revision IS DISTINCT FROM NEW.outcome_revision
  OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
  OR OLD.loss_reason_id IS DISTINCT FROM NEW.loss_reason_id
  OR OLD.loss_reason_text IS DISTINCT FROM NEW.loss_reason_text
)
EXECUTE FUNCTION public._m111b_guard_project_outcome();--> statement-breakpoint
CREATE TRIGGER project_outcome_insert_guard
BEFORE INSERT ON public.project
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_project_outcome();--> statement-breakpoint
CREATE TRIGGER project_outcome_evidence
AFTER UPDATE OF outcome ON public.project
FOR EACH ROW
WHEN (OLD.outcome IS DISTINCT FROM NEW.outcome)
EXECUTE FUNCTION public._m111b_record_project_outcome();--> statement-breakpoint
CREATE TRIGGER domain_events_project_outcome_insert_guard
BEFORE INSERT ON public.domain_events
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_outcome_evidence_insert();--> statement-breakpoint
CREATE TRIGGER audit_log_project_outcome_insert_guard
BEFORE INSERT ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public._m111b_guard_outcome_evidence_insert();--> statement-breakpoint

DROP FUNCTION public._m111a_guard_project_outcome();--> statement-breakpoint
DROP FUNCTION public._m111a_record_project_outcome();--> statement-breakpoint
DROP FUNCTION public._m111a_guard_outcome_evidence_insert();--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Runtime-Kapsel: verbindlich ausgestelltes Angebot = Approval ohne Withdrawal.
-- Review-Befund P2-10: search_path gepinnt; Workspace/Projekt-Zusammengehoerigkeit
-- ist die interne WHERE-Bindung (workspace_id UND project_id).
-- ════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m111b_project_has_binding_issuance(
  requested_workspace_id uuid,
  requested_project_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m111b_binding_issuance$
BEGIN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', requested_workspace_id::text, true
  );
  RETURN COALESCE(EXISTS (
    SELECT 1
      FROM public.offer_issuance_approval AS approval
     WHERE approval.workspace_id = requested_workspace_id
       AND approval.project_id = requested_project_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.offer_issuance_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = approval.workspace_id
            AND withdrawal.issuance_id = approval.issuance_id
       )
  ), false);
END
$m111b_binding_issuance$;--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Drei Worker-Zugriffskapseln (SECURITY DEFINER). Review-Befund P2-10: alle mit
-- search_path = pg_catalog; der Workspace-GUC wird intern aus dem Parameter
-- gesetzt (die Quelle ist der Job-Payload), damit FORCE-RLS die Zeilen sieht.
-- ════════════════════════════════════════════════════════════════════════

CREATE FUNCTION public._m111b_worker_resolve_recipient(
  requested_workspace_id uuid,
  requested_notification_id uuid
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $m111b_resolve_recipient$
DECLARE
  recipient_email text;
BEGIN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', requested_workspace_id::text, true
  );
  SELECT contact_record.email_primary
    INTO recipient_email
    FROM public.customer_notification AS notification_record
    JOIN public.project AS project_record
      ON project_record.workspace_id = notification_record.workspace_id
     AND project_record.id = notification_record.project_id
    JOIN public.contact AS contact_record
      ON contact_record.workspace_id = project_record.workspace_id
     AND contact_record.id = project_record.contact_id
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.id = requested_notification_id
   FOR UPDATE OF contact_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b recipient: Notification, Projekt oder Contact fehlt'
      USING ERRCODE = '23503';
  END IF;
  RETURN recipient_email;
END
$m111b_resolve_recipient$;--> statement-breakpoint

CREATE FUNCTION public._m111b_worker_deliver(
  requested_workspace_id uuid,
  requested_notification_id uuid,
  requested_attempt_number integer,
  requested_outcome text,
  requested_error_class text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m111b_worker_deliver$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
  notification_status text;
  notification_attempt_count integer;
BEGIN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', requested_workspace_id::text, true
  );
  IF requested_outcome NOT IN ('delivered', 'failed_retriable', 'failed_final') THEN
    RAISE EXCEPTION 'M1-11b deliver: unbekanntes outcome'
      USING ERRCODE = '23514';
  END IF;
  IF (requested_outcome = 'delivered') <> (requested_error_class IS NULL) THEN
    RAISE EXCEPTION 'M1-11b deliver: outcome/error_class inkohaerent'
      USING ERRCODE = '23514';
  END IF;

  -- Idempotenter Doppel-Dispatch: existiert der Versuch bereits, ist die
  -- Zustellung schon verbucht und es entsteht KEINE zweite Evidenz.
  IF EXISTS (
    SELECT 1 FROM public.customer_notification_delivery_attempt AS attempt_record
     WHERE attempt_record.workspace_id = requested_workspace_id
       AND attempt_record.notification_id = requested_notification_id
       AND attempt_record.attempt_number = requested_attempt_number
  ) THEN
    RETURN;
  END IF;

  SELECT notification_record.status, notification_record.attempt_count
    INTO notification_status, notification_attempt_count
    FROM public.customer_notification AS notification_record
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.id = requested_notification_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b deliver: Outbox-Zeile fehlt'
      USING ERRCODE = '23503';
  END IF;
  IF notification_status NOT IN ('queued', 'failed_retriable') THEN
    RAISE EXCEPTION 'M1-11b deliver: Outbox-Zeile ist nicht zustellbar'
      USING ERRCODE = '23514';
  END IF;
  IF requested_attempt_number <> notification_attempt_count + 1 THEN
    RAISE EXCEPTION 'M1-11b deliver: attempt_number driftet'
      USING ERRCODE = '23514';
  END IF;

  -- Review-Befund P1-2: Evidenz (record) wird in derselben Transaktion wie der
  -- Statusuebergang geschrieben; der Idempotenzschluessel ist (notification_id,
  -- attempt_number). Ein idempotenter Doppel-Dispatch erzeugt keine zweite Zeile.
  BEGIN
    INSERT INTO public.customer_notification_delivery_attempt (
      workspace_id, notification_id, attempt_number, outcome, error_class, occurred_at
    ) VALUES (
      requested_workspace_id, requested_notification_id, requested_attempt_number,
      requested_outcome, requested_error_class, mutation_time
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN; -- idempotenter Doppel-Dispatch: keine zweite Evidenz
  END;

  UPDATE public.customer_notification AS notification_record
     SET attempt_count = requested_attempt_number,
         dispatched_at = COALESCE(notification_record.dispatched_at, mutation_time),
         delivered_at = CASE WHEN requested_outcome = 'delivered' THEN mutation_time ELSE NULL END,
         failed_at = CASE WHEN requested_outcome IN ('failed_retriable', 'failed_final') THEN mutation_time ELSE NULL END,
         error_code = CASE WHEN requested_outcome = 'delivered' THEN NULL ELSE requested_error_class END,
         error_retryable = CASE WHEN requested_outcome = 'failed_retriable' THEN true
                                WHEN requested_outcome = 'failed_final' THEN false
                                ELSE NULL END,
         cancelled_at = NULL,
         status = CASE
           WHEN requested_outcome = 'delivered' THEN 'delivered'
           WHEN requested_outcome = 'failed_retriable' THEN 'failed_retriable'
           ELSE 'failed_final'
         END,
         updated_at = mutation_time
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.id = requested_notification_id;
END
$m111b_worker_deliver$;--> statement-breakpoint

CREATE FUNCTION public._m111b_worker_cancel_erased(
  requested_workspace_id uuid,
  requested_notification_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m111b_worker_cancel_erased$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
  notification_status text;
BEGIN
  PERFORM pg_catalog.set_config(
    'app.workspace_id', requested_workspace_id::text, true
  );
  SELECT notification_record.status
    INTO notification_status
    FROM public.customer_notification AS notification_record
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.id = requested_notification_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b cancel: Outbox-Zeile fehlt'
      USING ERRCODE = '23503';
  END IF;
  IF notification_status NOT IN ('queued', 'failed_retriable') THEN
    RAISE EXCEPTION 'M1-11b cancel: nur nicht-terminale Zeilen stornierbar'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.customer_notification AS notification_record
     SET status = 'cancelled_contact_erased',
         cancelled_at = mutation_time,
         updated_at = mutation_time
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.id = requested_notification_id;
END
$m111b_worker_cancel_erased$;--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Quellgepinnte Erweiterung von erase_inactive_lead: Notification-Zeilen des
-- Contact-Graphen werden mitgelockt und queued/failed_retriable zu
-- cancelled_contact_erased storniert (Review-Befund P2-6). Die beiden Anker
-- (Lock + Storno) sind nachweisbar im Live-Quelltext.
-- ════════════════════════════════════════════════════════════════════════
DO $m111b_erasure_upgrade$
DECLARE
  erase_source text;
  source_sha256 text;
  upgraded_source text;
  old_project_scrub constant text := $m111b_old_project_scrub$
  UPDATE public.project AS project_record
     SET name = 'geloescht-' || project_record.id::text,
         dedupe_review_required = false,
         loss_reason_text = NULL,
         updated_at = erase_time
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'projectIds'
       ) AS value
     );
$m111b_old_project_scrub$;
  new_project_scrub constant text := $m111b_new_project_scrub$
  UPDATE public.project AS project_record
     SET name = 'geloescht-' || project_record.id::text,
         dedupe_review_required = false,
         loss_reason_text = NULL,
         updated_at = erase_time
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'projectIds'
       ) AS value
     );

  -- M1-11b Anker 1: Notification-Zeilen des Contact-Graphen werden mitgelockt,
  -- damit eine parallel laufende Transition/Zustellung nicht mit der Erasure
  -- verschraenkt (TOCTOU-Lock statt reiner Nachpruefung).
  PERFORM 1 FROM public.customer_notification AS notification_record
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.project_id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'projectIds'
       ) AS value
     )
   ORDER BY notification_record.id FOR UPDATE;

  -- M1-11b Anker 2: nicht-terminale Zeilen werden storniert; ein Storno ist ein
  -- Statusuebergang OHNE Versuchszeile. Erasure bleibt Betroffenenrechtspflicht,
  -- kein fachlicher Undo (Review-Befund P2-9).
  UPDATE public.customer_notification AS notification_record
     SET status = 'cancelled_contact_erased',
         cancelled_at = erase_time,
         updated_at = erase_time
   WHERE notification_record.workspace_id = requested_workspace_id
     AND notification_record.project_id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'projectIds'
       ) AS value
     )
     AND notification_record.status IN ('queued', 'failed_retriable');
$m111b_new_project_scrub$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')), 'hex'
         )
    INTO erase_source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'erase_inactive_lead'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '859c9563aef9d9d4ccba5b0ee91b578dc35ab431beb2b3a9ee5d216f5eccb088' THEN
    RAISE EXCEPTION 'M1-11b Erasure: unerwarteter M1-11a-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_project_scrub) = 0 THEN
    RAISE EXCEPTION 'M1-11b Erasure: gepinnter Project-Scrub-Anker fehlt';
  END IF;
  upgraded_source := pg_catalog.replace(
    erase_source, old_project_scrub, new_project_scrub
  );
  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION public.erase_inactive_lead('
    'requested_workspace_id uuid, requested_contact_id uuid, '
    'requested_operation_id uuid) '
    'RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER '
    'SET search_path = pg_catalog AS %L',
    upgraded_source
  );
END
$m111b_erasure_upgrade$;--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Dispatch-Einstieg pgboss.enqueue_customer_notification (Muster 0035).
-- ════════════════════════════════════════════════════════════════════════
DO $m111b_customer_notification_dispatch_migration$
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
    RAISE EXCEPTION 'M1-11b dispatch: pgboss-Schema fehlt';
  END IF;
  IF pgboss_owner <> 'app_worker' THEN
    RAISE EXCEPTION 'M1-11b dispatch: pgboss muss app_worker gehoeren';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'app_worker', 'SET') THEN
    RAISE EXCEPTION 'M1-11b dispatch: app_migrator braucht SET auf app_worker';
  END IF;

  EXECUTE 'SET LOCAL ROLE app_worker';
  IF pg_catalog.to_regclass('pgboss.job') IS NULL
     OR pg_catalog.to_regclass('pgboss.queue') IS NULL THEN
    RAISE EXCEPTION 'M1-11b dispatch: pg-boss ist nicht initialisiert';
  END IF;
  SELECT pg_catalog.max(version) INTO pgboss_version FROM pgboss.version;
  IF pgboss_version IS DISTINCT FROM 38 THEN
    RAISE EXCEPTION 'M1-11b dispatch: erwartet pg-boss v38, ist %',
      pgboss_version;
  END IF;
  PERFORM 1
    FROM pgboss.queue AS queue
   WHERE queue.name = 'notification.customer'
     AND queue.policy = 'exclusive'
     AND queue.retry_limit = 10
     AND queue.retry_delay = 1
     AND queue.retry_backoff = true
     AND queue.retry_delay_max = 60
     AND queue.expire_seconds = 180
     AND queue.notify = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11b dispatch: Queue fehlt oder driftet';
  END IF;

  EXECUTE $m111b_dispatch_ddl$
    CREATE FUNCTION pgboss.enqueue_customer_notification(
      workspace_id uuid,
      notification_id uuid
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $m111b_dispatch_body$
    DECLARE
      queue_config pgboss.queue%ROWTYPE;
      dispatch_payload jsonb;
      dispatch_attempt integer;
      dispatch_key text;
      dispatch_start_after timestamptz;
      notification_next_attempt_at timestamptz;
    BEGIN
      IF $1 IS NULL OR $2 IS NULL OR NULLIF(
           pg_catalog.current_setting('app.workspace_id', true), ''
         )::uuid IS DISTINCT FROM $1 THEN
        RAISE EXCEPTION 'M1-11b dispatch: workspace context mismatch'
          USING ERRCODE = '42501';
      END IF;
      SELECT notification_record.attempt_count,
             notification_record.next_attempt_at
        INTO dispatch_attempt, notification_next_attempt_at
        FROM public.customer_notification AS notification_record
       WHERE notification_record.workspace_id = $1
         AND notification_record.id = $2;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'M1-11b dispatch: keine zustellbare Outbox-Zeile'
          USING ERRCODE = '42501';
      END IF;
      dispatch_attempt := dispatch_attempt + 1;
      -- Review-Befund P1-2: singletonKey aus Notification-ID + Attempt, damit
      -- parallele Worker denselben Versuch nicht doppelt zustellen.
      dispatch_key := $2::text || ':' || dispatch_attempt::text;
      dispatch_start_after := notification_next_attempt_at;
      IF dispatch_start_after IS NULL THEN
        dispatch_start_after := pg_catalog.statement_timestamp();
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended($2::text, 1701734778)
      );
      SELECT * INTO queue_config
        FROM pgboss.queue AS queue
       WHERE queue.name = 'notification.customer';
      IF NOT FOUND
         OR queue_config.policy <> 'exclusive'
         OR queue_config.retry_limit <> 10
         OR queue_config.retry_delay <> 1
         OR NOT queue_config.retry_backoff
         OR queue_config.retry_delay_max <> 60
         OR queue_config.expire_seconds <> 180
         OR queue_config.notify THEN
        RAISE EXCEPTION 'M1-11b dispatch: Queuevertrag fehlt oder driftet';
      END IF;
      dispatch_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 'customer-notification-dispatch.v1',
        'workspaceId', $1::text,
        'notificationId', $2::text,
        'attemptNumber', dispatch_attempt
      );
      IF EXISTS (
        SELECT 1 FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'notification.customer'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        UPDATE pgboss.job AS queued_job
           SET start_after = dispatch_start_after,
               keep_until = dispatch_start_after
                 + queue_config.retention_seconds * interval '1 second'
         WHERE queued_job.name = 'notification.customer'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry');
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'notification.customer'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'M1-11b dispatch: aktiver Job verletzt Vertrag';
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
      IF NOT FOUND AND NOT EXISTS (
        SELECT 1 FROM pgboss.job AS queued_job
         WHERE queued_job.name = 'notification.customer'
           AND queued_job.singleton_key = dispatch_key
           AND queued_job.data = dispatch_payload
           AND queued_job.policy = 'exclusive'
           AND queued_job.state IN ('created', 'retry', 'active')
      ) THEN
        RAISE EXCEPTION 'M1-11b dispatch: unerwarteter pg-boss-Konflikt';
      END IF;
    END
    $m111b_dispatch_body$
  $m111b_dispatch_ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION pgboss.enqueue_customer_notification(uuid, uuid) FROM PUBLIC';
  EXECUTE 'GRANT USAGE ON SCHEMA pgboss TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION pgboss.enqueue_customer_notification(uuid, uuid) TO app_runtime';
  EXECUTE 'SET LOCAL ROLE app_owner';
END
$m111b_customer_notification_dispatch_migration$;--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- Grants und ACLs.
-- ════════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public._m111b_guard_offer_freeze() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_guard_customer_notification() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_guard_delivery_attempt() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_guard_project_outcome() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_record_project_outcome() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_guard_outcome_evidence_insert() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_project_has_binding_issuance(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_worker_resolve_recipient(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_worker_deliver(uuid, uuid, integer, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111b_worker_cancel_erased(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

REVOKE ALL ON public.customer_notification FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.customer_notification_delivery_attempt FROM PUBLIC;--> statement-breakpoint

DO $m111b_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.customer_notification FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.customer_notification_delivery_attempt FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m111b_guard_offer_freeze(), '
        'public._m111b_guard_customer_notification(), '
        'public._m111b_guard_delivery_attempt(), '
        'public._m111b_guard_project_outcome(), '
        'public._m111b_record_project_outcome(), '
        'public._m111b_guard_outcome_evidence_insert() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;

  -- Runtime: lesen (Zustellstatus ohne PII), insert (Outbox im Transition-Tx),
  -- update (Dispatch-Fortschritt) und die schmale Binding-Kapsel.
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.customer_notification TO app_runtime;
    GRANT SELECT ON public.customer_notification_delivery_attempt TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._m111b_project_has_binding_issuance(uuid, uuid)
      TO app_runtime;
  END IF;

  -- Worker: ausschliesslich ueber die drei Definer-Kapseln, KEINE Tabellengrants.
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public._m111b_worker_resolve_recipient(uuid, uuid),
      public._m111b_worker_deliver(uuid, uuid, integer, text, text),
      public._m111b_worker_cancel_erased(uuid, uuid)
      TO app_worker;
  END IF;

  -- Erasure-Rolle (falls vorhanden) darf den Storno-Trigger ausloesen; die
  -- Transition selbst laeuft ueber erase_inactive_lead (Definer).
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT SELECT ON public.customer_notification TO app_erasure;
    GRANT SELECT ON public.customer_notification_delivery_attempt TO app_erasure;
  END IF;
END
$m111b_acl$;
