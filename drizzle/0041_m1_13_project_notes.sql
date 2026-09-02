CREATE TABLE "project_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_type" text DEFAULT 'project' NOT NULL,
	"text_version" text DEFAULT 'note-text.v1' NOT NULL,
	"text_markdown" text NOT NULL,
	"pinned_at" timestamp with time zone,
	"pinned_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_note_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_note_parent_type_ck" CHECK ("project_note"."parent_type" = 'project'),
	CONSTRAINT "project_note_text_version_ck" CHECK ("project_note"."text_version" = 'note-text.v1'),
	CONSTRAINT "project_note_text_markdown_ck" CHECK (length("project_note"."text_markdown") between 1 and 10000),
	CONSTRAINT "project_note_pin_pair_ck" CHECK (("project_note"."pinned_at" is null) = ("project_note"."pinned_by" is null)),
	CONSTRAINT "project_note_edit_pair_ck" CHECK (("project_note"."edited_at" is null) = ("project_note"."edited_by" is null)),
	CONSTRAINT "project_note_deleted_at_ck" CHECK ("project_note"."deleted_at" is null or "project_note"."deleted_at" >= "project_note"."created_at"),
	CONSTRAINT "project_note_revision_ck" CHECK ("project_note"."revision" between 1 and 2147483647),
	CONSTRAINT "project_note_timestamps_ck" CHECK (isfinite("project_note"."created_at")
          and ("project_note"."pinned_at" is null or isfinite("project_note"."pinned_at"))
          and ("project_note"."edited_at" is null or isfinite("project_note"."edited_at"))
          and ("project_note"."deleted_at" is null or isfinite("project_note"."deleted_at")))
);
--> statement-breakpoint
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_note_ws_project_active_idx" ON "project_note" USING btree ("workspace_id","project_id","pinned_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id") WHERE "project_note"."deleted_at" is null;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-13: Notiz-Actor-Helfer (Muster M1-10 _m110_actor_task_role).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public._m113_actor_note_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m113_actor_role$
DECLARE
  actor_id uuid;
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  actor_id := public.app_actor_id();
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
$m113_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m113_actor_can_read_notes(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m113_actor_read$
  SELECT COALESCE(
    public._m113_actor_note_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m113_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m113_actor_can_write_notes(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m113_actor_write$
  SELECT COALESCE(
    public._m113_actor_note_role(requested_workspace_id)
      IN ('editor', 'admin'),
    false
  )
$m113_actor_write$;--> statement-breakpoint

CREATE FUNCTION public._m113_erasure_delete_allowed(
  row_workspace_id uuid,
  row_note_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m113_erasure_allowed$
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
       AND tombstone.graph_ids->'noteIds' ? row_note_id::text
  ), false);
END
$m113_erasure_allowed$;--> statement-breakpoint

CREATE FUNCTION public._m113_guard_project_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m113_note_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m113_erasure_delete_allowed(OLD.workspace_id, OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project_note DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public._m113_actor_can_write_notes(NEW.workspace_id)
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project_note verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_note Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
      FROM public.project AS project_record
      JOIN public.contact AS contact_record
        ON contact_record.workspace_id = project_record.workspace_id
       AND contact_record.id = project_record.contact_id
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
       AND contact_record.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_note Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> 1
       OR NEW.created_by IS DISTINCT FROM actor_id
       OR NEW.edited_by IS NOT NULL
       OR NEW.edited_at IS NOT NULL
       OR NEW.deleted_at IS NOT NULL
       OR NEW.parent_type <> 'project'
       OR NEW.text_version <> 'note-text.v1' THEN
      RAISE EXCEPTION 'project_note Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.pinned_at IS NOT NULL AND NEW.pinned_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_note pinned_by muss der Actor sein'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.parent_type IS DISTINCT FROM OLD.parent_type
     OR NEW.text_version IS DISTINCT FROM OLD.text_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'project_note immutable Bindung oder Revision verletzt'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'project_note ist geloescht und unveraenderlich'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    IF NEW.text_markdown IS DISTINCT FROM OLD.text_markdown
       OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
       OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by
       OR NEW.edited_at IS DISTINCT FROM OLD.edited_at
       OR NEW.edited_by IS DISTINCT FROM OLD.edited_by THEN
      RAISE EXCEPTION 'project_note Delete darf keine Fachfelder mitveraendern'
        USING ERRCODE = '23514';
    END IF;
    NEW.deleted_at := mutation_time;
  ELSIF NEW.text_markdown IS DISTINCT FROM OLD.text_markdown THEN
    IF NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
       OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by
       OR NEW.edited_at IS NULL
       OR NEW.edited_by IS DISTINCT FROM actor_id
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'project_note Text-Edit-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.edited_at := mutation_time;
  ELSIF NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
        OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by THEN
    IF NEW.text_markdown IS DISTINCT FROM OLD.text_markdown
       OR NEW.edited_at IS DISTINCT FROM OLD.edited_at
       OR NEW.edited_by IS DISTINCT FROM OLD.edited_by
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'project_note Pin-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.pinned_at IS NOT NULL AND NEW.pinned_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_note pinned_by muss der Actor sein'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'project_note Update ohne Fachfeldaenderung'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$m113_note_guard$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m113_actor_note_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m113_actor_can_read_notes(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m113_actor_can_write_notes(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m113_erasure_delete_allowed(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m113_guard_project_note() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER project_note_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_note
FOR EACH ROW EXECUTE FUNCTION public._m113_guard_project_note();--> statement-breakpoint
CREATE TRIGGER project_note_no_truncate
BEFORE TRUNCATE ON public.project_note
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();
--> statement-breakpoint

ALTER TABLE public.project_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.project_note
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint

DO $m113_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
  delete_predicate text;
BEGIN
  delete_predicate := CASE
    WHEN actor_policy_role = 'app_runtime' THEN 'false'
    ELSE 'public._m113_erasure_delete_allowed(workspace_id, id)'
  END;
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_note AS RESTRICTIVE FOR SELECT TO %s '
    'USING (public._m113_actor_can_read_notes(workspace_id) OR '
    '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
    'project_note_actor_select', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_note AS RESTRICTIVE FOR INSERT TO %s '
    'WITH CHECK (public._m113_actor_can_write_notes(workspace_id))',
    'project_note_actor_insert', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_note AS RESTRICTIVE FOR UPDATE TO %s '
    'USING (public._m113_actor_can_write_notes(workspace_id)) '
    'WITH CHECK (public._m113_actor_can_write_notes(workspace_id))',
    'project_note_actor_update', actor_policy_role
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY %I ON public.project_note AS RESTRICTIVE FOR DELETE TO %s USING (%s)',
    'project_note_actor_delete', actor_policy_role, delete_predicate
  );
END
$m113_actor_policies$;--> statement-breakpoint

REVOKE ALL ON public.project_note FROM PUBLIC;
--> statement-breakpoint

DO $m113_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.project_note FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m113_actor_note_role(uuid), '
        'public._m113_actor_can_read_notes(uuid), '
        'public._m113_actor_can_write_notes(uuid), '
        'public._m113_erasure_delete_allowed(uuid,uuid), '
        'public._m113_guard_project_note() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.project_note TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._m113_actor_note_role(uuid),
      public._m113_actor_can_read_notes(uuid),
      public._m113_actor_can_write_notes(uuid)
      TO app_runtime;
  END IF;
END
$m113_acl$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════
-- M1-13: Erasure-Graph-Erweiterung um noteIds (quellgepinnt, Muster 0027/0038).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m113_tombstone_worm$
DECLARE
  graph_key text;
  required_keys constant text[] := ARRAY[
    'contactId', 'legalHoldIds', 'siteIds', 'projectIds', 'profileIds',
    'jobIds', 'revisionIds', 'requirementIds', 'snapshotIds', 'receiptIds',
    'offerIds', 'offerVariantIds', 'offerVariantRevisionIds',
    'offerVariantSectionIds', 'offerBomLineIds'
  ]::text[];
  optional_keys constant text[] := ARRAY[
    'offerPdfDraftIds', 'offerRecipientIds', 'offerRecipientRevisionIds',
    'offerReleaseCandidateIds', 'offerReleaseCandidateApprovalIds',
    'offerIssuanceIds', 'offerIssuanceApprovalIds',
    'offerIssuanceWithdrawalIds', 'taskIds', 'noteIds'
  ]::text[];
  allowed_keys constant text[] := required_keys || optional_keys;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'erasure_tombstone WORM append-only: % ist verboten', TG_OP;
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.graph_ids) <> 'object'
     OR NEW.graph_ids - allowed_keys <> '{}'::jsonb
     OR NOT NEW.graph_ids ?& required_keys THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.graph_ids->'contactId') <> 'string'
     OR NEW.graph_ids->>'contactId' <> NEW.contact_id::text THEN
    RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonischen ID-only-Graphen';
  END IF;

  FOREACH graph_key IN ARRAY allowed_keys LOOP
    CONTINUE WHEN graph_key = 'contactId';
    CONTINUE WHEN graph_key = ANY(optional_keys)
                  AND NOT NEW.graph_ids ? graph_key;
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
    IF NEW.graph_ids->graph_key IS DISTINCT FROM COALESCE((
         SELECT pg_catalog.jsonb_agg(
                  graph_value.value ORDER BY graph_value.value #>> '{}'
                )
           FROM pg_catalog.jsonb_array_elements(NEW.graph_ids->graph_key)
             AS graph_value(value)
       ), '[]'::jsonb)
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements_text(NEW.graph_ids->graph_key)
             AS graph_value(value)
          GROUP BY graph_value.value
         HAVING pg_catalog.count(*) > 1
       ) THEN
      RAISE EXCEPTION 'erasure_tombstone enthaelt keinen kanonisch sortierten ID-only-Graphen';
    END IF;
  END LOOP;
  RETURN NEW;
END
$m113_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;
--> statement-breakpoint

ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m113;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.build_inactive_lead_erasure_graph_m113(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m113_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m113(
           requested_workspace_id, requested_contact_id
         )
         || CASE WHEN note_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object('noteIds', note_graph.ids)
            END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(note_record.id::text ORDER BY note_record.id),
        '[]'::jsonb
      ) AS ids
        FROM public.project_note AS note_record
        JOIN public.project AS project_record
          ON project_record.workspace_id = note_record.workspace_id
         AND project_record.id = note_record.project_id
       WHERE note_record.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ) AS note_graph
$m113_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

-- Die aktuelle 0039-Funktion wird ausschliesslich bei exakt gepinntem prosrc
-- und drei exakten Ankern erweitert. Dadurch kann keine parallele Erasure-
-- Aenderung still ueberschrieben werden.
DO $m113_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_note_replay_graph constant text := $m113_old_replay_graph$
    operational_graph_document := graph_document || pg_catalog.jsonb_build_object(
      'offerIds', COALESCE(graph_document->'offerIds', '[]'::jsonb),
      'offerVariantIds', COALESCE(graph_document->'offerVariantIds', '[]'::jsonb),
      'offerVariantRevisionIds', COALESCE(graph_document->'offerVariantRevisionIds', '[]'::jsonb),
      'offerVariantSectionIds', COALESCE(graph_document->'offerVariantSectionIds', '[]'::jsonb),
      'offerBomLineIds', COALESCE(graph_document->'offerBomLineIds', '[]'::jsonb),
      'taskIds', COALESCE(graph_document->'taskIds', '[]'::jsonb)
    );
$m113_old_replay_graph$;
  new_note_replay_graph constant text := $m113_new_replay_graph$
    operational_graph_document := graph_document || pg_catalog.jsonb_build_object(
      'offerIds', COALESCE(graph_document->'offerIds', '[]'::jsonb),
      'offerVariantIds', COALESCE(graph_document->'offerVariantIds', '[]'::jsonb),
      'offerVariantRevisionIds', COALESCE(graph_document->'offerVariantRevisionIds', '[]'::jsonb),
      'offerVariantSectionIds', COALESCE(graph_document->'offerVariantSectionIds', '[]'::jsonb),
      'offerBomLineIds', COALESCE(graph_document->'offerBomLineIds', '[]'::jsonb),
      'taskIds', COALESCE(graph_document->'taskIds', '[]'::jsonb),
      'noteIds', COALESCE(graph_document->'noteIds', '[]'::jsonb)
    );
$m113_new_replay_graph$;
  old_note_lock constant text := $m113_old_note_lock$
  PERFORM 1 FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY task_record.id FOR UPDATE;
$m113_old_note_lock$;
  new_note_lock constant text := $m113_new_note_lock$
  PERFORM 1 FROM public.project_note AS note_record
   WHERE note_record.workspace_id = requested_workspace_id
     AND note_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'noteIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY note_record.id FOR UPDATE;
  PERFORM 1 FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY task_record.id FOR UPDATE;
$m113_new_note_lock$;
  old_note_delete constant text := $m113_old_note_delete$
  DELETE FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     );
$m113_old_note_delete$;
  new_note_delete constant text := $m113_new_note_delete$
  DELETE FROM public.project_note AS note_record
   WHERE note_record.workspace_id = requested_workspace_id
     AND note_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'noteIds', '[]'::jsonb)
       ) AS value
     );
  DELETE FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     );
$m113_new_note_delete$;
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
    RAISE EXCEPTION 'M1-13 Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '859c9563aef9d9d4ccba5b0ee91b578dc35ab431beb2b3a9ee5d216f5eccb088' THEN
    RAISE EXCEPTION 'M1-13 Erasure: unerwarteter M1-11a-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_note_replay_graph) = 0
     OR pg_catalog.strpos(erase_source, old_note_lock) = 0
     OR pg_catalog.strpos(erase_source, old_note_delete) = 0 THEN
    RAISE EXCEPTION 'M1-13 Erasure: gepinnter Quellanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source, old_note_replay_graph, new_note_replay_graph
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_note_lock, new_note_lock
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_note_delete, new_note_delete
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
$m113_erasure_upgrade$;--> statement-breakpoint

DO $m113_erasure_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public.build_inactive_lead_erasure_graph(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph_m113(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m113_erasure_acl$;
