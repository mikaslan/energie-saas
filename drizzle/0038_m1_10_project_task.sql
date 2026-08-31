-- Der DB-Vertrag speichert nur das ProseMirror-Dokument; die versionierte
-- Action-Huelle wird vorher getrennt. Diese Funktion bleibt nach Deployment
-- unveraendert: eine spaetere Rich-Text-Version erhaelt eine neue Funktion.
CREATE FUNCTION public._m110_valid_task_rich_text_v1(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $m110_rich_text_v1$
DECLARE
  node_metrics record;
BEGIN
  IF pg_catalog.jsonb_typeof(candidate) <> 'object'
     OR pg_catalog.octet_length(
          pg_catalog.convert_to(candidate::text, 'UTF8')
        ) > 32768 THEN
    RETURN false;
  END IF;

  WITH RECURSIVE document_nodes(node, parent_type, depth) AS (
    SELECT candidate, NULL::text, 1
    UNION ALL
    SELECT child.value, document_nodes.node->>'type', document_nodes.depth + 1
      FROM document_nodes
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        CASE
          WHEN pg_catalog.jsonb_typeof(document_nodes.node->'content') = 'array'
          THEN document_nodes.node->'content'
          ELSE '[]'::jsonb
        END
      ) AS child(value)
  )
  SELECT pg_catalog.count(*)::integer AS node_count,
         pg_catalog.max(depth)::integer AS depth,
         COALESCE(pg_catalog.sum(
           CASE WHEN node->>'type' = 'text'
                THEN pg_catalog.char_length(node->>'text') ELSE 0 END
         ), 0)::integer AS text_count,
         COALESCE(pg_catalog.bool_and(
           pg_catalog.jsonb_typeof(node) = 'object'
           AND CASE node->>'type'
             WHEN 'doc' THEN
               node ?& ARRAY['type', 'content']::text[]
               AND node - ARRAY['type', 'content']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'content') = 'array'
             WHEN 'paragraph' THEN
               node ?& ARRAY['type', 'content']::text[]
               AND node - ARRAY['type', 'content']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'content') = 'array'
             WHEN 'heading' THEN
               node ?& ARRAY['type', 'attrs', 'content']::text[]
               AND node - ARRAY['type', 'attrs', 'content']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'attrs') = 'object'
               AND node->'attrs' ? 'level'
               AND (node->'attrs') - 'level' = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'attrs'->'level') = 'number'
               AND node->'attrs'->>'level' IN ('2', '3')
               AND pg_catalog.jsonb_typeof(node->'content') = 'array'
             WHEN 'bulletList' THEN
               node ?& ARRAY['type', 'content']::text[]
               AND node - ARRAY['type', 'content']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'content') = 'array'
               AND pg_catalog.jsonb_array_length(node->'content') BETWEEN 1 AND 500
             WHEN 'orderedList' THEN
               node ?& ARRAY['type', 'content']::text[]
               AND node - ARRAY['type', 'attrs', 'content']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'content') = 'array'
               AND pg_catalog.jsonb_array_length(node->'content') BETWEEN 1 AND 500
               AND CASE WHEN node ? 'attrs' THEN
                 pg_catalog.jsonb_typeof(node->'attrs') = 'object'
                 AND node->'attrs' ? 'start'
                 AND (node->'attrs') - 'start' = '{}'::jsonb
                 AND pg_catalog.jsonb_typeof(node->'attrs'->'start') = 'number'
                 AND node->'attrs'->>'start' ~ '^[1-9][0-9]*$'
                 AND (node->'attrs'->>'start')::numeric <= 1000000
               ELSE true END
             WHEN 'listItem' THEN
               node ?& ARRAY['type', 'content']::text[]
               AND node - ARRAY['type', 'content']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'content') = 'array'
               AND pg_catalog.jsonb_array_length(node->'content') BETWEEN 1 AND 500
             WHEN 'hardBreak' THEN
               node ? 'type' AND node - 'type' = '{}'::jsonb
             WHEN 'text' THEN
               node ?& ARRAY['type', 'text']::text[]
               AND node - ARRAY['type', 'text', 'marks']::text[] = '{}'::jsonb
               AND pg_catalog.jsonb_typeof(node->'text') = 'string'
               AND pg_catalog.char_length(node->>'text') BETWEEN 1 AND 10000
               AND NOT EXISTS (
                 SELECT 1
                   FROM pg_catalog.generate_series(
                     1, pg_catalog.char_length(node->>'text')
                   ) AS character_position(value)
                  WHERE pg_catalog.ascii(pg_catalog.substr(
                          node->>'text', character_position.value, 1
                        )) BETWEEN 0 AND 8
                     OR pg_catalog.ascii(pg_catalog.substr(
                          node->>'text', character_position.value, 1
                        )) IN (11, 12)
                     OR pg_catalog.ascii(pg_catalog.substr(
                          node->>'text', character_position.value, 1
                        )) BETWEEN 14 AND 31
                     OR pg_catalog.ascii(pg_catalog.substr(
                          node->>'text', character_position.value, 1
                        )) BETWEEN 127 AND 159
               )
               AND CASE WHEN node ? 'marks' THEN
                 pg_catalog.jsonb_typeof(node->'marks') = 'array'
                 AND pg_catalog.jsonb_array_length(node->'marks') <= 2
                 AND NOT EXISTS (
                   SELECT 1
                     FROM pg_catalog.jsonb_array_elements(node->'marks') AS mark(value)
                    WHERE pg_catalog.jsonb_typeof(mark.value) <> 'object'
                       OR NOT mark.value ? 'type'
                       OR mark.value - 'type' <> '{}'::jsonb
                       OR mark.value->>'type' NOT IN ('bold', 'italic')
                 )
                 AND (
                   SELECT pg_catalog.count(*) =
                          pg_catalog.count(DISTINCT mark.value->>'type')
                     FROM pg_catalog.jsonb_array_elements(node->'marks') AS mark(value)
                 )
               ELSE true END
             ELSE false
           END
           AND CASE
             WHEN parent_type IS NULL THEN node->>'type' = 'doc'
             WHEN parent_type = 'doc' THEN node->>'type' IN (
               'paragraph', 'heading', 'bulletList', 'orderedList'
             )
             WHEN parent_type = 'paragraph' THEN node->>'type' IN ('text', 'hardBreak')
             WHEN parent_type = 'heading' THEN node->>'type' IN ('text', 'hardBreak')
             WHEN parent_type = 'bulletList' THEN node->>'type' = 'listItem'
             WHEN parent_type = 'orderedList' THEN node->>'type' = 'listItem'
             WHEN parent_type = 'listItem' THEN node->>'type' IN (
               'paragraph', 'bulletList', 'orderedList'
             )
             ELSE false
           END
         ), false) AS structurally_valid
    INTO node_metrics
    FROM document_nodes;

  IF node_metrics.node_count > 500
     OR node_metrics.depth > 8
     OR node_metrics.text_count > 10000 THEN
    RETURN false;
  END IF;
  RETURN node_metrics.structurally_valid;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END
$m110_rich_text_v1$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m110_valid_task_rich_text_v1(jsonb) FROM PUBLIC;
--> statement-breakpoint

CREATE TABLE "project_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_version" text DEFAULT 'task-rich-text.v1' NOT NULL,
	"body" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_task_title_ck" CHECK (length(btrim("project_task"."title")) between 1 and 200),
	CONSTRAINT "project_task_body_version_ck" CHECK ("project_task"."body_version" = 'task-rich-text.v1'),
	CONSTRAINT "project_task_body_ck" CHECK (public._m110_valid_task_rich_text_v1("project_task"."body")),
	CONSTRAINT "project_task_due_at_ck" CHECK ("project_task"."due_at" is null or isfinite("project_task"."due_at")),
	CONSTRAINT "project_task_status_ck" CHECK ("project_task"."status" in ('open', 'done')),
	CONSTRAINT "project_task_completion_ck" CHECK (("project_task"."status" = 'open' and "project_task"."completed_at" is null)
          or ("project_task"."status" = 'done' and "project_task"."completed_at" is not null)),
	CONSTRAINT "project_task_revision_ck" CHECK ("project_task"."revision" between 1 and 2147483647),
	CONSTRAINT "project_task_timestamps_ck" CHECK ("project_task"."updated_at" >= "project_task"."created_at"
          and ("project_task"."completed_at" is null or "project_task"."completed_at" >= "project_task"."created_at")
          and ("project_task"."archived_at" is null or "project_task"."archived_at" >= "project_task"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "project_task_assignee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_assignee_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_task_assignee_ws_task_membership_uq" UNIQUE("workspace_id","task_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "project_task_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_checklist_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_task_checklist_ws_task_position_uq" UNIQUE("workspace_id","task_id","position"),
	CONSTRAINT "project_task_checklist_position_ck" CHECK ("project_task_checklist_item"."position" between 0 and 99),
	CONSTRAINT "project_task_checklist_text_ck" CHECK (length(btrim("project_task_checklist_item"."text")) between 1 and 500),
	CONSTRAINT "project_task_checklist_time_ck" CHECK ("project_task_checklist_item"."updated_at" >= "project_task_checklist_item"."created_at")
);
--> statement-breakpoint
CREATE TABLE "project_task_label" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_task_label_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_task_label_ws_task_position_uq" UNIQUE("workspace_id","task_id","position"),
	CONSTRAINT "project_task_label_position_ck" CHECK ("project_task_label"."position" between 0 and 14),
	CONSTRAINT "project_task_label_name_ck" CHECK (length(btrim("project_task_label"."name")) between 1 and 40),
	CONSTRAINT "project_task_label_color_ck" CHECK ("project_task_label"."color" in ('slate', 'blue', 'emerald', 'amber', 'rose', 'violet'))
);
--> statement-breakpoint
ALTER TABLE "project_task" ADD CONSTRAINT "project_task_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task" ADD CONSTRAINT "project_task_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignee" ADD CONSTRAINT "project_task_assignee_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignee" ADD CONSTRAINT "project_task_assignee_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."project_task"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_assignee" ADD CONSTRAINT "project_task_assignee_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_checklist_item" ADD CONSTRAINT "project_task_checklist_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_checklist_item" ADD CONSTRAINT "project_task_checklist_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."project_task"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_label" ADD CONSTRAINT "project_task_label_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_task_label" ADD CONSTRAINT "project_task_label_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."project_task"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_task_ws_project_active_idx" ON "project_task" USING btree ("workspace_id","project_id","status","due_at","id") WHERE "project_task"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "project_task_ws_due_active_idx" ON "project_task" USING btree ("workspace_id","due_at","id") WHERE "project_task"."archived_at" is null and "project_task"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "project_task_assignee_ws_membership_task_idx" ON "project_task_assignee" USING btree ("workspace_id","membership_id","task_id");--> statement-breakpoint
CREATE INDEX "project_task_checklist_ws_task_idx" ON "project_task_checklist_item" USING btree ("workspace_id","task_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_task_label_ws_task_name_ci_uq" ON "project_task_label" USING btree ("workspace_id","task_id",lower(btrim("name")));--> statement-breakpoint

-- Positive Actorbindung: ein leerer Actor ist hier kein System-Bypass. Auch
-- fehlgeformte Capability-Objekte werden fail-closed behandelt.
CREATE FUNCTION public._m110_actor_task_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m110_actor_role$
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
$m110_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._m110_actor_can_read_tasks(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m110_actor_read$
  SELECT COALESCE(
    public._m110_actor_task_role(requested_workspace_id)
      IN ('viewer', 'editor', 'admin'),
    false
  )
$m110_actor_read$;--> statement-breakpoint

CREATE FUNCTION public._m110_actor_can_write_tasks(requested_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m110_actor_write$
  SELECT COALESCE(
    public._m110_actor_task_role(requested_workspace_id)
      IN ('editor', 'admin'),
    false
  )
$m110_actor_write$;--> statement-breakpoint

CREATE FUNCTION public._m110_erasure_delete_allowed(
  row_workspace_id uuid,
  row_task_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $m110_erasure_allowed$
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
       AND tombstone.graph_ids->'taskIds' ? row_task_id::text
  ), false);
END
$m110_erasure_allowed$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m110_actor_task_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m110_actor_can_read_tasks(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m110_actor_can_write_tasks(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m110_erasure_delete_allowed(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION public._m110_guard_project_task()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m110_task_guard$
DECLARE
  actor_id uuid := public.app_actor_id();
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public._m110_erasure_delete_allowed(OLD.workspace_id, OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'project_task DELETE ist nur im Erasurevertrag erlaubt'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public._m110_actor_can_write_tasks(NEW.workspace_id)
     OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project_task verlangt einen internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM public.project AS project_record
     WHERE project_record.workspace_id = NEW.workspace_id
       AND project_record.id = NEW.project_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project_task Project-Bindung fehlt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> 1
       OR NEW.status <> 'open'
       OR NEW.completed_at IS NOT NULL
       OR NEW.archived_at IS NOT NULL
       OR NEW.created_by IS DISTINCT FROM actor_id
       OR NEW.updated_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'project_task Create-Vertrag verletzt'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := mutation_time;
    NEW.updated_at := mutation_time;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.body_version IS DISTINCT FROM OLD.body_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1
     OR NEW.updated_by IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'project_task immutable Bindung oder Revision verletzt'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'project_task ist archiviert und unveraenderlich'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.archived_at IS NOT NULL THEN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.due_at IS DISTINCT FROM OLD.due_at
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'project_task Archive darf keine Fachfelder mitveraendern'
        USING ERRCODE = '23514';
    END IF;
    NEW.archived_at := mutation_time;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'done' THEN
      NEW.completed_at := mutation_time;
    ELSIF NEW.status = 'open' THEN
      NEW.completed_at := NULL;
    END IF;
  ELSIF NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'project_task completed_at folgt ausschliesslich dem Status'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := mutation_time;
  RETURN NEW;
END
$m110_task_guard$;--> statement-breakpoint

CREATE FUNCTION public._m110_guard_project_task_child()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m110_task_child_guard$
DECLARE
  row_workspace_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  row_task_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END;
  parent_archived_at timestamptz;
  target_role text;
  target_capabilities jsonb;
  actor_id uuid := public.app_actor_id();
BEGIN
  -- Der normale Runtime-Pfad besitzt bewusst kein EXECUTE auf dem privaten
  -- Erasure-Helper. Nur der actorlose Owner-Definerpfad darf ihn erreichen.
  IF TG_OP = 'DELETE' AND actor_id IS NULL THEN
    IF CURRENT_USER = 'app_owner' THEN
      IF public._m110_erasure_delete_allowed(row_workspace_id, row_task_id) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  IF actor_id IS NULL
     OR NOT public._m110_actor_can_write_tasks(row_workspace_id) THEN
    RAISE EXCEPTION 'project_task Kindmutation verlangt internen Editor oder Admin'
      USING ERRCODE = '23514';
  END IF;

  SELECT task_record.archived_at
    INTO parent_archived_at
    FROM public.project_task AS task_record
   WHERE task_record.workspace_id = row_workspace_id
     AND task_record.id = row_task_id
   FOR UPDATE NOWAIT;
  IF NOT FOUND OR parent_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'project_task Kindmutation verlangt eine aktive Aufgabe'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'project_task Kindbindung ist unveraenderlich'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.statement_timestamp();
  END IF;

  IF TG_TABLE_NAME = 'project_task_assignee' AND TG_OP <> 'DELETE' THEN
    SELECT membership_record.role, membership_record.capabilities
      INTO target_role, target_capabilities
     FROM public.membership AS membership_record
     WHERE membership_record.workspace_id = NEW.workspace_id
       AND membership_record.id = NEW.membership_id
     LIMIT 1;
    IF NOT FOUND
       OR target_role NOT IN ('viewer', 'editor', 'admin')
       OR pg_catalog.jsonb_typeof(target_capabilities) <> 'object'
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_each(target_capabilities) AS capability(key, value)
          WHERE pg_catalog.jsonb_typeof(capability.value) <> 'boolean'
       )
       OR (
         target_capabilities ? 'external_only'
         AND target_capabilities->'external_only' IS DISTINCT FROM 'false'::jsonb
       ) THEN
      RAISE EXCEPTION 'project_task Assignee muss eine interne Membership sein'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND (
      SELECT pg_catalog.count(*)
        FROM public.project_task_assignee AS assignee
       WHERE assignee.workspace_id = NEW.workspace_id
         AND assignee.task_id = NEW.task_id
    ) >= 50 THEN
      RAISE EXCEPTION 'project_task erlaubt hoechstens 50 Assignees'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'project_task_checklist_item' AND TG_OP <> 'DELETE' THEN
    NEW.updated_at := pg_catalog.statement_timestamp();
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$m110_task_child_guard$;--> statement-breakpoint

CREATE FUNCTION public._m110_guard_project_task_positions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m110_task_positions$
DECLARE
  row_workspace_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  row_task_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.task_id ELSE NEW.task_id END;
  actor_id uuid := public.app_actor_id();
  item_count integer;
  minimum_position integer;
  maximum_position integer;
BEGIN
  -- Constraint-Trigger laufen bei normalen Runtime-Mutationen als Caller.
  -- Deshalb wird der private Erasure-Helper nur actorlos als Owner ausgewertet.
  IF actor_id IS NULL AND CURRENT_USER = 'app_owner' THEN
    IF public._m110_erasure_delete_allowed(row_workspace_id, row_task_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'project_task_checklist_item' THEN
    SELECT pg_catalog.count(*)::integer, pg_catalog.min(position), pg_catalog.max(position)
      INTO item_count, minimum_position, maximum_position
      FROM public.project_task_checklist_item
     WHERE workspace_id = row_workspace_id AND task_id = row_task_id;
  ELSE
    SELECT pg_catalog.count(*)::integer, pg_catalog.min(position), pg_catalog.max(position)
      INTO item_count, minimum_position, maximum_position
      FROM public.project_task_label
     WHERE workspace_id = row_workspace_id AND task_id = row_task_id;
  END IF;
  IF item_count > 0
     AND (minimum_position <> 0 OR maximum_position <> item_count - 1) THEN
    RAISE EXCEPTION 'project_task Kindpositionen muessen lueckenlos bei 0 beginnen'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$m110_task_positions$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public._m110_guard_project_task() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m110_guard_project_task_child() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._m110_guard_project_task_positions() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER project_task_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_task
FOR EACH ROW EXECUTE FUNCTION public._m110_guard_project_task();--> statement-breakpoint
CREATE TRIGGER project_task_assignee_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_task_assignee
FOR EACH ROW EXECUTE FUNCTION public._m110_guard_project_task_child();--> statement-breakpoint
CREATE TRIGGER project_task_checklist_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_task_checklist_item
FOR EACH ROW EXECUTE FUNCTION public._m110_guard_project_task_child();--> statement-breakpoint
CREATE TRIGGER project_task_label_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.project_task_label
FOR EACH ROW EXECUTE FUNCTION public._m110_guard_project_task_child();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER project_task_checklist_positions_guard
AFTER INSERT OR UPDATE OR DELETE ON public.project_task_checklist_item
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public._m110_guard_project_task_positions();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER project_task_label_positions_guard
AFTER INSERT OR UPDATE OR DELETE ON public.project_task_label
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public._m110_guard_project_task_positions();--> statement-breakpoint

CREATE TRIGGER project_task_no_truncate
BEFORE TRUNCATE ON public.project_task
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_task_assignee_no_truncate
BEFORE TRUNCATE ON public.project_task_assignee
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_task_checklist_no_truncate
BEFORE TRUNCATE ON public.project_task_checklist_item
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_task_label_no_truncate
BEFORE TRUNCATE ON public.project_task_label
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

ALTER TABLE public.project_task ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_assignee ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_assignee FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_checklist_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_checklist_item FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_label ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_task_label FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.project_task
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_task_assignee
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_task_checklist_item
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_task_label
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

DO $m110_actor_policies$
DECLARE
  actor_policy_role text := CASE
    WHEN pg_catalog.to_regrole('app_runtime') IS NULL THEN 'PUBLIC'
    ELSE 'app_runtime'
  END;
  table_name text;
  policy_prefix text;
  delete_predicate text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'project_task', 'project_task_assignee',
    'project_task_checklist_item', 'project_task_label'
  ]::text[] LOOP
    policy_prefix := table_name || '_actor';
    -- Runtime darf die private Erasure-Hilfsfunktion nicht direkt auswerten:
    -- RLS-Ausdruecke laufen mit Caller-Rechten und duerfen nicht auf einen
    -- OR-Kurzschluss vertrauen. Der SECURITY-DEFINER-Erasurepfad laeuft als
    -- app_owner und ist daher nicht Ziel dieser app_runtime-Policy; Trigger +
    -- transaktionslokaler Graph-GUC begrenzen dort weiterhin jede Loeschung.
    delete_predicate := CASE
      WHEN actor_policy_role = 'app_runtime' AND table_name = 'project_task'
        THEN 'false'
      WHEN actor_policy_role = 'app_runtime'
        THEN 'public._m110_actor_can_write_tasks(workspace_id)'
      WHEN table_name = 'project_task'
        THEN 'public._m110_erasure_delete_allowed(workspace_id, id)'
      ELSE 'public._m110_actor_can_write_tasks(workspace_id) OR '
           || 'public._m110_erasure_delete_allowed(workspace_id, task_id)'
    END;
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO %s '
      'USING (public._m110_actor_can_read_tasks(workspace_id) OR '
      '(CURRENT_USER = ''app_owner'' AND public.app_actor_id() IS NULL))',
      policy_prefix || '_select', table_name, actor_policy_role
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO %s '
      'WITH CHECK (public._m110_actor_can_write_tasks(workspace_id))',
      policy_prefix || '_insert', table_name, actor_policy_role
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO %s '
      'USING (public._m110_actor_can_write_tasks(workspace_id)) '
      'WITH CHECK (public._m110_actor_can_write_tasks(workspace_id))',
      policy_prefix || '_update', table_name, actor_policy_role
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO %s USING (%s)',
      policy_prefix || '_delete', table_name, actor_policy_role,
      delete_predicate
    );
  END LOOP;
END
$m110_actor_policies$;--> statement-breakpoint

REVOKE ALL ON public.project_task FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.project_task_assignee FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.project_task_checklist_item FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON public.project_task_label FROM PUBLIC;--> statement-breakpoint

DO $m110_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.project_task, '
        'public.project_task_assignee, public.project_task_checklist_item, '
        'public.project_task_label FROM %I', principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._m110_valid_task_rich_text_v1(jsonb), '
        'public._m110_actor_task_role(uuid), '
        'public._m110_actor_can_read_tasks(uuid), '
        'public._m110_actor_can_write_tasks(uuid), '
        'public._m110_erasure_delete_allowed(uuid,uuid), '
        'public._m110_guard_project_task(), '
        'public._m110_guard_project_task_child(), '
        'public._m110_guard_project_task_positions() FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.project_task TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.project_task_assignee,
      public.project_task_checklist_item,
      public.project_task_label
      TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public._m110_valid_task_rich_text_v1(jsonb),
      public._m110_actor_task_role(uuid),
      public._m110_actor_can_read_tasks(uuid),
      public._m110_actor_can_write_tasks(uuid)
      TO app_runtime;
  END IF;
END
$m110_acl$;--> statement-breakpoint

-- taskIds bleibt optional: historische versiegelte Tombstones behalten ihren
-- exakten Hash und koennen ohne Graphmigration replayt werden.
CREATE OR REPLACE FUNCTION public.guard_erasure_tombstone_worm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $m110_tombstone_worm$
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
    'offerIssuanceWithdrawalIds', 'taskIds'
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
$m110_tombstone_worm$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_erasure_tombstone_worm() FROM PUBLIC;
--> statement-breakpoint

ALTER FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  RENAME TO build_inactive_lead_erasure_graph_m203b1;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public.build_inactive_lead_erasure_graph_m203b1(uuid, uuid)
  FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION public.build_inactive_lead_erasure_graph(
  requested_workspace_id uuid,
  requested_contact_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $m110_erasure_graph$
  SELECT public.build_inactive_lead_erasure_graph_m203b1(
           requested_workspace_id, requested_contact_id
         )
         || CASE WHEN task_graph.ids = '[]'::jsonb THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object('taskIds', task_graph.ids)
            END
    FROM (
      SELECT COALESCE(
        pg_catalog.jsonb_agg(task_record.id::text ORDER BY task_record.id),
        '[]'::jsonb
      ) AS ids
        FROM public.project_task AS task_record
        JOIN public.project AS project_record
          ON project_record.workspace_id = task_record.workspace_id
         AND project_record.id = task_record.project_id
       WHERE task_record.workspace_id = requested_workspace_id
         AND project_record.contact_id = requested_contact_id
    ) AS task_graph
$m110_erasure_graph$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.build_inactive_lead_erasure_graph(uuid, uuid)
  FROM PUBLIC;
--> statement-breakpoint

-- Die aktuelle 0035-Funktion wird ausschliesslich bei exakt gepinntem prosrc
-- und vier exakten Ankern erweitert. Dadurch kann keine parallele Erasure-
-- Aenderung still ueberschrieben werden.
DO $m110_erasure_upgrade$
DECLARE
  erase_source text;
  upgraded_source text;
  source_sha256 text;
  old_replay_graph constant text := $m110_old_replay_graph$
    operational_graph_document := graph_document || pg_catalog.jsonb_build_object(
      'offerIds', COALESCE(graph_document->'offerIds', '[]'::jsonb),
      'offerVariantIds', COALESCE(graph_document->'offerVariantIds', '[]'::jsonb),
      'offerVariantRevisionIds', COALESCE(graph_document->'offerVariantRevisionIds', '[]'::jsonb),
      'offerVariantSectionIds', COALESCE(graph_document->'offerVariantSectionIds', '[]'::jsonb),
      'offerBomLineIds', COALESCE(graph_document->'offerBomLineIds', '[]'::jsonb)
    );
$m110_old_replay_graph$;
  new_replay_graph constant text := $m110_new_replay_graph$
    operational_graph_document := graph_document || pg_catalog.jsonb_build_object(
      'offerIds', COALESCE(graph_document->'offerIds', '[]'::jsonb),
      'offerVariantIds', COALESCE(graph_document->'offerVariantIds', '[]'::jsonb),
      'offerVariantRevisionIds', COALESCE(graph_document->'offerVariantRevisionIds', '[]'::jsonb),
      'offerVariantSectionIds', COALESCE(graph_document->'offerVariantSectionIds', '[]'::jsonb),
      'offerBomLineIds', COALESCE(graph_document->'offerBomLineIds', '[]'::jsonb),
      'taskIds', COALESCE(graph_document->'taskIds', '[]'::jsonb)
    );
$m110_new_replay_graph$;
  old_task_lock constant text := $m110_old_task_lock$
  PERFORM 1 FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'jobIds'
       ) AS value
     )
   ORDER BY job.id FOR UPDATE;
$m110_old_task_lock$;
  new_task_lock constant text := $m110_new_task_lock$
  PERFORM 1 FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     )
   ORDER BY task_record.id FOR UPDATE;
  PERFORM 1 FROM public.project_calculation_job AS job
   WHERE job.workspace_id = requested_workspace_id
     AND job.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         operational_graph_document->'jobIds'
       ) AS value
     )
   ORDER BY job.id FOR UPDATE;
$m110_new_task_lock$;
  old_activity constant text := $m110_old_activity$
        SELECT project_record.updated_at FROM public.project AS project_record
         WHERE project_record.workspace_id = requested_workspace_id
           AND project_record.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'projectIds') AS value
           )
        UNION ALL
        SELECT receipt.received_at FROM public.inbound_receipt AS receipt
$m110_old_activity$;
  new_activity constant text := $m110_new_activity$
        SELECT project_record.updated_at FROM public.project AS project_record
         WHERE project_record.workspace_id = requested_workspace_id
           AND project_record.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(graph_document->'projectIds') AS value
           )
        UNION ALL
        SELECT task_record.updated_at FROM public.project_task AS task_record
         WHERE task_record.workspace_id = requested_workspace_id
           AND task_record.id IN (
             SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
               COALESCE(graph_document->'taskIds', '[]'::jsonb)
             ) AS value
           )
        UNION ALL
        SELECT receipt.received_at FROM public.inbound_receipt AS receipt
$m110_new_activity$;
  old_delete constant text := $m110_old_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.offer_issuance_approval AS approval
$m110_old_delete$;
  new_delete constant text := $m110_new_delete$
  -- Die Löschreihenfolge ist FK-sicher; die zuvor genommene Lockreihenfolge
  -- bleibt davon unberührt. Die Nummernserie wird absichtlich nie angefasst.
  DELETE FROM public.project_task AS task_record
   WHERE task_record.workspace_id = requested_workspace_id
     AND task_record.id IN (
       SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(
         COALESCE(operational_graph_document->'taskIds', '[]'::jsonb)
       ) AS value
     );
  DELETE FROM public.offer_issuance_approval AS approval
$m110_new_delete$;
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
    RAISE EXCEPTION 'M1-10 Erasure: erase_inactive_lead fehlt';
  END IF;
  IF source_sha256 IS DISTINCT FROM
       '1d865e697787271c715ee6a606f5cc6463456c53ee0c2fb5c906213e5170287c' THEN
    RAISE EXCEPTION 'M1-10 Erasure: unerwarteter M2-03b1-Quellhash %',
      source_sha256;
  END IF;
  IF pg_catalog.strpos(erase_source, old_replay_graph) = 0
     OR pg_catalog.strpos(erase_source, old_task_lock) = 0
     OR pg_catalog.strpos(erase_source, old_activity) = 0
     OR pg_catalog.strpos(erase_source, old_delete) = 0 THEN
    RAISE EXCEPTION 'M1-10 Erasure: gepinnter Quellanker fehlt';
  END IF;

  upgraded_source := pg_catalog.replace(
    erase_source, old_replay_graph, new_replay_graph
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_task_lock, new_task_lock
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_activity, new_activity
  );
  upgraded_source := pg_catalog.replace(
    upgraded_source, old_delete, new_delete
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
$m110_erasure_upgrade$;--> statement-breakpoint

DO $m110_erasure_acl$
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
        'public._m110_erasure_delete_allowed(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph(uuid,uuid), '
        'public.build_inactive_lead_erasure_graph_m203b1(uuid,uuid) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_erasure') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.erase_inactive_lead(uuid, uuid, uuid)
      TO app_erasure;
  END IF;
END
$m110_erasure_acl$;
