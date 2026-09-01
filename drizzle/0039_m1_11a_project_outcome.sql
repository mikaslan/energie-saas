CREATE TABLE "project_loss_reason" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_loss_reason_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_loss_reason_ws_position_uq" UNIQUE("workspace_id","position"),
	CONSTRAINT "project_loss_reason_label_ck" CHECK (length(btrim("project_loss_reason"."label")) between 1 and 80
          and "project_loss_reason"."label" = normalize("project_loss_reason"."label", NFKC)
          and "project_loss_reason"."label" !~ '[[:cntrl:]]'
          and "project_loss_reason"."label" !~ '(^[[:space:]])|([[:space:]]$)'),
	CONSTRAINT "project_loss_reason_position_ck" CHECK ("project_loss_reason"."position" between 1 and 2147483647),
	CONSTRAINT "project_loss_reason_revision_ck" CHECK ("project_loss_reason"."revision" between 1 and 2147483647),
	CONSTRAINT "project_loss_reason_timestamps_ck" CHECK ("project_loss_reason"."updated_at" >= "project_loss_reason"."created_at"
          and ("project_loss_reason"."archived_at" is null or "project_loss_reason"."archived_at" >= "project_loss_reason"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "outcome_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "loss_reason_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "loss_reason_text" text;--> statement-breakpoint

-- Der Upgrade-Bestand liegt unter FORCE RLS. Nur der Tabellen-Owner darf in
-- diesem engen, transaktionalen Fenster alle Zeilen fuer Precondition und
-- Backfill sehen. Ein Fehler rollt auch NO FORCE zurueck.
LOCK TABLE public.project IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE public.project NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $m111a_project_upgrade_precondition$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.project
     WHERE outcome = 'lost'
  ) THEN
    RAISE EXCEPTION
      'M1-11a kann bestehende Lost-Projects ohne strukturierten Grund nicht migrieren';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.project
     WHERE outcome IN ('won', 'cannot_fulfill')
       AND NOT pg_catalog.isfinite(updated_at)
  ) THEN
    RAISE EXCEPTION
      'M1-11a kann geschlossene Bestandsprojects mit nicht-endlichem updated_at nicht migrieren';
  END IF;
END
$m111a_project_upgrade_precondition$;--> statement-breakpoint
UPDATE public.project
   SET closed_at = updated_at
 WHERE outcome IN ('won', 'cannot_fulfill')
   AND closed_at IS NULL;--> statement-breakpoint
ALTER TABLE public.project FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "project_loss_reason" ADD CONSTRAINT "project_loss_reason_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_loss_reason_ws_label_ci_uq" ON "project_loss_reason" USING btree ("workspace_id",lower(btrim("label")));--> statement-breakpoint
CREATE INDEX "project_loss_reason_ws_active_position_idx" ON "project_loss_reason" USING btree ("workspace_id","position","id") WHERE "project_loss_reason"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_loss_reason_fk" FOREIGN KEY ("workspace_id","loss_reason_id") REFERENCES "public"."project_loss_reason"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_ws_request_closed_idx" ON "project" USING btree ("workspace_id","closed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "project"."phase" = 'request' and "project"."outcome" in ('won', 'lost');--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_outcome_revision_ck" CHECK ("project"."outcome_revision" between 0 and 2147483647);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_closed_at_ck" CHECK ("project"."closed_at" is null or isfinite("project"."closed_at"));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_loss_reason_text_ck" CHECK ("project"."loss_reason_text" is null or (
        length("project"."loss_reason_text") between 1 and 500
        and "project"."loss_reason_text" = btrim("project"."loss_reason_text")
        and "project"."loss_reason_text" = normalize("project"."loss_reason_text", NFKC)
        and "project"."loss_reason_text" !~ '[[:cntrl:]]'
      ));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_outcome_state_ck" CHECK ((
        "project"."outcome" = 'open'
        and "project"."closed_at" is null
        and "project"."loss_reason_id" is null
        and "project"."loss_reason_text" is null
      ) or (
        "project"."outcome" = 'won'
        and "project"."closed_at" is not null
        and "project"."loss_reason_id" is null
        and "project"."loss_reason_text" is null
      ) or (
        "project"."outcome" = 'lost'
        and "project"."closed_at" is not null
        and "project"."loss_reason_id" is not null
      ) or (
        "project"."outcome" = 'cannot_fulfill'
        and "project"."closed_at" is not null
        and "project"."loss_reason_id" is null
        and "project"."loss_reason_text" is null
      ));
--> statement-breakpoint

-- Der bestehende Erasurevertrag wird quellgepinnt um genau das neue,
-- personenbeziehbare Lost-Freitextfeld erweitert. Alle bisherigen Locks,
-- Tombstones, Replays und Evidenzregeln bleiben bytegenau erhalten.
DO $m111a_erasure_upgrade$
DECLARE
  erase_source text;
  source_sha256 text;
  upgraded_source text;
  old_project_scrub constant text := $m111a_old_project_scrub$
  UPDATE public.project AS project_record
     SET name = 'geloescht-' || project_record.id::text,
         dedupe_review_required = false, updated_at = erase_time
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'projectIds'
       ) AS value
     );
$m111a_old_project_scrub$;
  new_project_scrub constant text := $m111a_new_project_scrub$
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
$m111a_new_project_scrub$;
BEGIN
  SELECT routine.prosrc,
         pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
           'hex'
         )
    INTO erase_source, source_sha256
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'public'
     AND routine.proname = 'erase_inactive_lead'
     AND pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M1-11a Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       'c7bbe2311d331eb8ad272b4d8dd48ccfb53d21be2418989703d980c61f3e1562' THEN
    RAISE EXCEPTION 'M1-11a Erasure: unerwarteter M1-10-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_project_scrub) = 0 THEN
    RAISE EXCEPTION 'M1-11a Erasure: gepinnter Project-Scrub-Anker fehlt';
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
$m111a_erasure_upgrade$;--> statement-breakpoint

-- Positive Actorbindung fuer Taxonomie und Outcome. Fehlende/malformed
-- Membershipdaten und jedes external_only ausser literal false enden in NULL.
CREATE FUNCTION public._m111a_actor_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111a_actor_role$
DECLARE
  actor_id uuid := public.app_actor_id();
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  IF actor_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT membership_record.role, membership_record.capabilities
    INTO actor_role, actor_capabilities
    FROM public.membership AS membership_record
   WHERE membership_record.workspace_id = requested_workspace_id
     AND membership_record.user_id = actor_id
   LIMIT 1;
  IF NOT FOUND
     OR actor_role NOT IN ('viewer', 'editor', 'admin')
     OR pg_catalog.jsonb_typeof(actor_capabilities) <> 'object'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_each(actor_capabilities) AS capability(key, value)
        WHERE pg_catalog.jsonb_typeof(capability.value) <> 'boolean'
     )
     OR (
       actor_capabilities ? 'external_only'
       AND actor_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
     ) THEN
    RETURN NULL;
  END IF;
  RETURN actor_role;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$m111a_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m111a_actor_can_read_loss_reasons(
  requested_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111a_reason_read$
  SELECT COALESCE(
    public._m111a_actor_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m111a_reason_read$;--> statement-breakpoint

CREATE FUNCTION public._m111a_actor_can_manage_loss_reasons(
  requested_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111a_reason_manage$
  SELECT COALESCE(
    public._m111a_actor_role(requested_workspace_id) = 'admin',
    false
  )
$m111a_reason_manage$;--> statement-breakpoint

CREATE FUNCTION public._m111a_erasure_scrub_allowed(
  row_workspace_id uuid,
  row_project_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111a_erasure_scrub$
DECLARE
  erasure_operation uuid;
BEGIN
  BEGIN
    erasure_operation := NULLIF(
      pg_catalog.current_setting('app.erasure_operation_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    erasure_operation := NULL;
  END;
  IF erasure_operation IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(EXISTS (
    SELECT 1
      FROM public.erasure_tombstone AS tombstone
     WHERE tombstone.operation_id = erasure_operation
       AND tombstone.workspace_id = row_workspace_id
       AND tombstone.graph_ids->'projectIds' ? row_project_id::text
  ), false);
END
$m111a_erasure_scrub$;--> statement-breakpoint

CREATE FUNCTION public._m111a_guard_loss_reason()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m111a_reason_guard$
DECLARE
  mutation_time timestamptz := pg_catalog.transaction_timestamp();
  next_position integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project_loss_reason DELETE ist verboten; Archive verwenden'
      USING ERRCODE = '23514';
  END IF;
  IF NOT public._m111a_actor_can_manage_loss_reasons(NEW.workspace_id) THEN
    RAISE EXCEPTION 'project_loss_reason verlangt einen internen Admin'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'project_loss_reason beginnt aktiv mit Revision 1'
        USING ERRCODE = '23514';
    END IF;
    -- Alle Creates desselben Workspace werden ueber dessen unveraenderliche
    -- PK serialisiert. Die Position ist DB-owned und niemals Caller-Input.
    PERFORM 1
      FROM public.workspace AS workspace_record
     WHERE workspace_record.id = NEW.workspace_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_loss_reason Workspace fehlt'
        USING ERRCODE = '23503';
    END IF;
    SELECT COALESCE(pg_catalog.max(reason_record.position), 0) + 1
      INTO next_position
      FROM public.project_loss_reason AS reason_record
     WHERE reason_record.workspace_id = NEW.workspace_id;
    IF next_position NOT BETWEEN 1 AND 2147483647 THEN
      RAISE EXCEPTION 'project_loss_reason Position ist erschoepft'
        USING ERRCODE = '22003';
    END IF;
    NEW.position := next_position;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.revision >= 2147483647
     OR NEW.revision <> OLD.revision + 1
     OR (OLD.archived_at IS NULL) = (NEW.archived_at IS NULL) THEN
    RAISE EXCEPTION 'project_loss_reason Update verletzt den CAS-Archivvertrag'
      USING ERRCODE = '23514';
  END IF;
  NEW.archived_at := CASE
    WHEN OLD.archived_at IS NULL THEN mutation_time
    ELSE NULL
  END;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m111a_reason_guard$;--> statement-breakpoint

CREATE FUNCTION public._m111a_guard_project_outcome()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m111a_outcome_guard$
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

  -- Die einzige Transition-fremde Ausnahme ist der exakt durch einen
  -- Tombstone gebundene PII-Scrub der bestehenden Erasure-Funktion.
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
    -- app_runtime darf den privaten Erasure-Helfer bewusst nicht ausführen.
    -- Deshalb wird er erst nach der rein lokalen Formprüfung ausgewertet und
    -- niemals auf dem normalen Outcome-Pfad aufgerufen.
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
$m111a_outcome_guard$;--> statement-breakpoint

-- Die Evidenz liegt absichtlich im DB-Trigger. Damit kann auch ein direkter,
-- durch ACL/RLS/Guard erlaubter Project-UPDATE weder Event noch Audit umgehen.
-- Freitext und Reason-Label werden nie in append-only Tabellen kopiert.
CREATE FUNCTION public._m111a_record_project_outcome()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111a_outcome_evidence$
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
$m111a_outcome_evidence$;--> statement-breakpoint

-- Outcome-Evidenz darf ausschließlich als verschachtelter Effekt des
-- Project-Transition-Triggers entstehen. So können Worker/System/Runtime mit
-- ihren allgemeinen Outbox-Rechten keine fiktive Projektaktivität einfügen.
CREATE FUNCTION public._m111a_guard_outcome_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $m111a_outcome_evidence_guard$
BEGIN
  IF TG_TABLE_NAME = 'domain_events' THEN
    IF NEW.event_type IN (
         'project.outcome_won', 'project.outcome_lost',
         'project.outcome_reopened'
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
    -- Nur erfolgreiche Domain-Evidenz muss aus dem Transition-Trigger
    -- stammen. Ein allowed=false-Audit wird nach dem Rollback bewusst vom
    -- autorisierten Action-Boundary geschrieben und hat Trigger-Tiefe 1.
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
$m111a_outcome_evidence_guard$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m111a_actor_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_actor_can_read_loss_reasons(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_actor_can_manage_loss_reasons(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_erasure_scrub_allowed(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_guard_loss_reason() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_guard_project_outcome() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_record_project_outcome() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m111a_guard_outcome_evidence_insert() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER project_loss_reason_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_loss_reason
FOR EACH ROW EXECUTE FUNCTION public._m111a_guard_loss_reason();--> statement-breakpoint
CREATE TRIGGER project_loss_reason_no_truncate
BEFORE TRUNCATE ON public.project_loss_reason
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
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
EXECUTE FUNCTION public._m111a_guard_project_outcome();--> statement-breakpoint
CREATE TRIGGER project_outcome_insert_guard
BEFORE INSERT ON public.project
FOR EACH ROW EXECUTE FUNCTION public._m111a_guard_project_outcome();--> statement-breakpoint
CREATE TRIGGER project_outcome_evidence
AFTER UPDATE OF outcome ON public.project
FOR EACH ROW
WHEN (OLD.outcome IS DISTINCT FROM NEW.outcome)
EXECUTE FUNCTION public._m111a_record_project_outcome();--> statement-breakpoint
CREATE TRIGGER domain_events_project_outcome_insert_guard
BEFORE INSERT ON public.domain_events
FOR EACH ROW EXECUTE FUNCTION public._m111a_guard_outcome_evidence_insert();--> statement-breakpoint
CREATE TRIGGER audit_log_project_outcome_insert_guard
BEFORE INSERT ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public._m111a_guard_outcome_evidence_insert();--> statement-breakpoint

ALTER TABLE public.project_loss_reason ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_loss_reason FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_loss_reason
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

DO $m111a_reason_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY project_loss_reason_actor_select '
    'ON public.project_loss_reason AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m111a_actor_can_read_loss_reasons(workspace_id))',
    actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY project_loss_reason_actor_insert '
    'ON public.project_loss_reason AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m111a_actor_can_manage_loss_reasons(workspace_id))',
    actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY project_loss_reason_actor_update '
    'ON public.project_loss_reason AS RESTRICTIVE FOR UPDATE TO %s '
    -- Interne Leser duerfen die Zeile fuer Lost mit FOR SHARE sperren. Eine
    -- echte Mutation bleibt zusaetzlich im BEFORE-Guard strikt Admin-only.
    'USING (public._m111a_actor_can_read_loss_reasons(workspace_id)) '
    'WITH CHECK (public._m111a_actor_can_read_loss_reasons(workspace_id))',
    actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY project_loss_reason_actor_delete '
    'ON public.project_loss_reason AS RESTRICTIVE FOR DELETE TO %s '
    'USING (false)',
    actor_policy_role
  );
END
$m111a_reason_actor_policies$;--> statement-breakpoint

REVOKE ALL ON public.project_loss_reason FROM PUBLIC;--> statement-breakpoint
DO $m111a_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.project_loss_reason FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m111a_actor_role(uuid), '
        'public._m111a_actor_can_read_loss_reasons(uuid), '
        'public._m111a_actor_can_manage_loss_reasons(uuid), '
        'public._m111a_guard_loss_reason(), '
        'public._m111a_guard_project_outcome(), '
        'public._m111a_record_project_outcome() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.project_loss_reason TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._m111a_actor_role(uuid),
      public._m111a_actor_can_read_loss_reasons(uuid),
      public._m111a_actor_can_manage_loss_reasons(uuid)
      TO app_runtime;
  END IF;
  -- Der Worker finalisiert Berechnungen ausschliesslich ueber enge Definer-
  -- Funktionen und benoetigt kein direktes Project-SELECT. Ein historischer
  -- Tabellen-Grant wuerde sonst den neuen internen Lost-Kommentar offenlegen.
  IF pg_catalog.to_regrole('app_worker') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.project FROM app_worker;
  END IF;
END
$m111a_acl$;
