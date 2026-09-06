CREATE TABLE "project_checklist_segment_completion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid NOT NULL,
	CONSTRAINT "project_checklist_segment_completion_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "project_checklist_segment_completion_segment_uq" UNIQUE("workspace_id","checklist_id","segment_id"),
	CONSTRAINT "project_checklist_segment_completion_time_ck" CHECK (pg_catalog.isfinite("project_checklist_segment_completion"."completed_at"))
);
--> statement-breakpoint
ALTER TABLE "project_checklist" DROP CONSTRAINT "project_checklist_ws_project_uq";--> statement-breakpoint
DROP INDEX "project_checklist_ws_project_idx";--> statement-breakpoint
ALTER TABLE "project_checklist" ADD COLUMN "phase" text DEFAULT 'site_documentation' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_checklist" ADD COLUMN "title" text DEFAULT 'Baustellendokumentation' NOT NULL;--> statement-breakpoint

-- Exakt dieselbe Textgrenze wie JavaScript cleanText(): kanonisches NFKC,
-- ECMAScript-Trim, keine Cc/Cf-Codepoints und Laenge in UTF-16-Codeunits.
-- PostgreSQL length() zaehlt Unicode-Codepoints und seine POSIX-Klasse
-- [[:cntrl:]] erfasst insbesondere Cf nicht; beides waere hier zu schwach.
CREATE FUNCTION public._f704_valid_clean_text(requested_value text, max_utf16_units integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $f704_valid_clean_text$
DECLARE
  character_count integer := pg_catalog.char_length(requested_value);
  character_index integer;
  codepoint integer;
  utf16_units integer := 0;
BEGIN
  IF max_utf16_units < 1
     OR character_count < 1
     OR requested_value IS DISTINCT FROM normalize(requested_value, NFKC)
     OR requested_value <> pg_catalog.btrim(requested_value) THEN
    RETURN false;
  END IF;

  FOR character_index IN 1..character_count LOOP
    codepoint := pg_catalog.ascii(pg_catalog.substr(requested_value, character_index, 1));

    -- Unicode General Categories Cc und Cf, gespiegelt aus der von Node/JS
    -- verwendeten Unicode-Tabelle. PostgreSQL-UTF8 kann U+0000 nicht tragen.
    IF codepoint BETWEEN 0 AND 31
       OR codepoint BETWEEN 127 AND 159
       OR codepoint = 173
       OR codepoint BETWEEN 1536 AND 1541
       OR codepoint IN (1564, 1757, 1807)
       OR codepoint BETWEEN 2192 AND 2193
       OR codepoint = 2274
       OR codepoint = 6158
       OR codepoint BETWEEN 8203 AND 8207
       OR codepoint BETWEEN 8234 AND 8238
       OR codepoint BETWEEN 8288 AND 8292
       OR codepoint BETWEEN 8294 AND 8303
       OR codepoint = 65279
       OR codepoint BETWEEN 65529 AND 65531
       OR codepoint IN (69821, 69837)
       OR codepoint BETWEEN 78896 AND 78911
       OR codepoint BETWEEN 113824 AND 113827
       OR codepoint BETWEEN 119155 AND 119162
       OR codepoint = 917505
       OR codepoint BETWEEN 917536 AND 917631 THEN
      RETURN false;
    END IF;

    -- PostgreSQL 18.4 normalisiert mit Unicode 16, Node 22+/24+/26 hier
    -- mit Unicode 17. U+A7F1 bekam dort neu die NFKC-Abbildung "S". Bis
    -- PostgreSQL dieselbe Tabelle nutzt, darf der rohe Codepoint nicht durch.
    IF codepoint = 42993 THEN RETURN false; END IF;

    -- trim() entfernt diese nicht-normalisierenden Unicode-Spaces nur an
    -- den Raendern; die restlichen ECMAScript-Spaces sind oben bereits durch
    -- Cc/Cf, NFKC-Gleichheit oder btrim abgedeckt.
    IF character_index IN (1, character_count)
       AND codepoint IN (5760, 8232, 8233) THEN
      RETURN false;
    END IF;

    utf16_units := utf16_units + CASE WHEN codepoint > 65535 THEN 2 ELSE 1 END;
    IF utf16_units > max_utf16_units THEN RETURN false; END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$f704_valid_clean_text$;--> statement-breakpoint

ALTER TABLE "project_checklist_segment_completion" ADD CONSTRAINT "project_checklist_segment_completion_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checklist_segment_completion" ADD CONSTRAINT "project_checklist_segment_completion_checklist_fk" FOREIGN KEY ("workspace_id","checklist_id") REFERENCES "public"."project_checklist"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_checklist_segment_completion_checklist_idx" ON "project_checklist_segment_completion" USING btree ("workspace_id","checklist_id","completed_at");--> statement-breakpoint
CREATE INDEX "project_checklist_ws_project_phase_idx" ON "project_checklist" USING btree ("workspace_id","project_id","phase");--> statement-breakpoint
ALTER TABLE "project_checklist" ADD CONSTRAINT "project_checklist_phase_ck" CHECK ("project_checklist"."phase" in ('qualification', 'consultation', 'site_documentation'));--> statement-breakpoint
ALTER TABLE "project_checklist" ADD CONSTRAINT "project_checklist_title_ck" CHECK (public._f704_valid_clean_text("project_checklist"."title", 200));--> statement-breakpoint

-- F7.4: Der alte F7.2-Snapshot hatte keine stabilen Baumidentitäten. Die
-- UUIDs werden deterministisch aus Checkliste + JSON-Pfad abgeleitet, damit
-- Wiederholung und Rollout-Gegenproben exakt denselben Bestand erhalten.
CREATE FUNCTION public._f704_stable_tree_uuid(checklist_id uuid, tree_path text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $f704_stable_uuid$
  SELECT (
    pg_catalog.substr(hash_value, 1, 8) || '-' ||
    pg_catalog.substr(hash_value, 9, 4) || '-5' ||
    pg_catalog.substr(hash_value, 14, 3) || '-8' ||
    pg_catalog.substr(hash_value, 18, 3) || '-' ||
    pg_catalog.substr(hash_value, 21, 12)
  )::uuid
  FROM (
    SELECT pg_catalog.md5(checklist_id::text || ':' || tree_path) AS hash_value
  ) AS digest
$f704_stable_uuid$;--> statement-breakpoint

-- project_checklist ist FORCE-RLS. Der Owner-Backfill muss den vollständigen
-- Bestand sehen, ohne nacheinander erratene Tenant-GUCs zu setzen. Drizzle
-- führt die gesamte Datei in einer Transaktion aus: bei jedem Fehler rollt
-- auch NO FORCE zurück; vor dem Commit wird FORCE explizit wiederhergestellt.
ALTER TABLE public.project_checklist NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
LOCK TABLE public.project_checklist IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $f704_legacy_preflight$
DECLARE
  checklist_record record;
  block_record record;
  segment_record record;
  item_record record;
BEGIN
  FOR checklist_record IN SELECT id, blocks FROM public.project_checklist LOOP
    IF pg_catalog.jsonb_typeof(checklist_record.blocks) <> 'array' THEN
      RAISE EXCEPTION 'F7.4: project_checklist.blocks enthält keinen Array-Bestand'
        USING ERRCODE = '23514';
    END IF;
    FOR block_record IN
      SELECT value FROM pg_catalog.jsonb_array_elements(checklist_record.blocks) AS block(value)
    LOOP
      IF pg_catalog.jsonb_typeof(block_record.value) <> 'object'
         OR NOT block_record.value ?& ARRAY['name','position','segments']
         OR block_record.value - ARRAY['id','name','position','visible','segments']::text[]
            <> '{}'::jsonb
         OR pg_catalog.jsonb_typeof(block_record.value->'segments') <> 'array'
         OR (
           block_record.value ? 'id'
           AND (
             pg_catalog.jsonb_typeof(block_record.value->'id') <> 'string'
             OR block_record.value->>'id' !~
               '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
           )
         ) THEN
        RAISE EXCEPTION 'F7.4: ungültiger Legacy-Block in Checkliste %', checklist_record.id
          USING ERRCODE = '23514';
      END IF;
      FOR segment_record IN
        SELECT value FROM pg_catalog.jsonb_array_elements(block_record.value->'segments') AS segment(value)
      LOOP
        IF pg_catalog.jsonb_typeof(segment_record.value) <> 'object'
           OR NOT segment_record.value ?& ARRAY['name','position','items']
           OR segment_record.value - ARRAY['id','name','position','visible','items']::text[]
              <> '{}'::jsonb
           OR pg_catalog.jsonb_typeof(segment_record.value->'items') <> 'array'
           OR (
             segment_record.value ? 'id'
             AND (
               pg_catalog.jsonb_typeof(segment_record.value->'id') <> 'string'
               OR segment_record.value->>'id' !~
                 '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
             )
           ) THEN
          RAISE EXCEPTION 'F7.4: ungültiges Legacy-Segment in Checkliste %', checklist_record.id
            USING ERRCODE = '23514';
        END IF;
        FOR item_record IN
          SELECT value FROM pg_catalog.jsonb_array_elements(segment_record.value->'items') AS item(value)
        LOOP
          IF pg_catalog.jsonb_typeof(item_record.value) <> 'object'
             OR NOT item_record.value ?& ARRAY['title','done']
             OR item_record.value - ARRAY['id','title','done','required','visible']::text[]
                <> '{}'::jsonb
             OR (
               item_record.value ? 'id'
               AND (
                 pg_catalog.jsonb_typeof(item_record.value->'id') <> 'string'
                 OR item_record.value->>'id' !~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
               )
             ) THEN
            RAISE EXCEPTION 'F7.4: ungültiger Legacy-Punkt in Checkliste %', checklist_record.id
              USING ERRCODE = '23514';
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END
$f704_legacy_preflight$;--> statement-breakpoint

UPDATE public.project_checklist AS checklist_record
   SET blocks = COALESCE((
     SELECT pg_catalog.jsonb_agg(
       pg_catalog.jsonb_build_object(
         'id', CASE
           WHEN pg_catalog.jsonb_typeof(block_record.value->'id') = 'string'
            AND block_record.value->>'id' ~
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
           THEN (block_record.value->>'id')::uuid
           ELSE public._f704_stable_tree_uuid(
             checklist_record.id,
             'block:' || block_record.ordinality::text
           )
         END,
         'name', block_record.value->'name',
         'position', block_record.value->'position',
         'visible', COALESCE(block_record.value->'visible', 'true'::jsonb),
         'segments', COALESCE((
           SELECT pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', CASE
                 WHEN pg_catalog.jsonb_typeof(segment_record.value->'id') = 'string'
                  AND segment_record.value->>'id' ~
                    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
                 THEN (segment_record.value->>'id')::uuid
                 ELSE public._f704_stable_tree_uuid(
                   checklist_record.id,
                   'block:' || block_record.ordinality::text ||
                   ':segment:' || segment_record.ordinality::text
                 )
               END,
               'name', segment_record.value->'name',
               'position', segment_record.value->'position',
               'visible', COALESCE(segment_record.value->'visible', 'true'::jsonb),
               'items', COALESCE((
                 SELECT pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_object(
                     'id', CASE
                       WHEN pg_catalog.jsonb_typeof(item_record.value->'id') = 'string'
                        AND item_record.value->>'id' ~
                          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
                       THEN (item_record.value->>'id')::uuid
                       ELSE public._f704_stable_tree_uuid(
                         checklist_record.id,
                         'block:' || block_record.ordinality::text ||
                         ':segment:' || segment_record.ordinality::text ||
                         ':item:' || item_record.ordinality::text
                       )
                     END,
                     'title', item_record.value->'title',
                     'done', item_record.value->'done',
                     'required', COALESCE(item_record.value->'required', 'false'::jsonb),
                     'visible', COALESCE(item_record.value->'visible', 'true'::jsonb)
                   ) ORDER BY item_record.ordinality
                 )
                 FROM pg_catalog.jsonb_array_elements(
                   COALESCE(segment_record.value->'items', '[]'::jsonb)
                 ) WITH ORDINALITY AS item_record(value, ordinality)
               ), '[]'::jsonb)
             ) ORDER BY segment_record.ordinality
           )
           FROM pg_catalog.jsonb_array_elements(
             COALESCE(block_record.value->'segments', '[]'::jsonb)
           ) WITH ORDINALITY AS segment_record(value, ordinality)
         ), '[]'::jsonb)
       ) ORDER BY block_record.ordinality
     )
     FROM pg_catalog.jsonb_array_elements(checklist_record.blocks)
       WITH ORDINALITY AS block_record(value, ordinality)
   ), '[]'::jsonb);--> statement-breakpoint

DROP FUNCTION public._f704_stable_tree_uuid(uuid, text);--> statement-breakpoint

-- Tiefe, fail-closed Snapshotvalidierung. Sie ist zusätzlich zur Zod-Grenze
-- nötig, weil der DB-Capsule-Vertrag auch bei einem fehlerhaften App-Caller
-- stabile, eindeutige IDs und unverfälschte Pflichtfelder garantieren muss.
CREATE FUNCTION public._f704_valid_checklist_blocks(requested_blocks jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $f704_valid_blocks$
DECLARE
  block_record record;
  segment_record record;
  item_record record;
  node_count integer := 0;
BEGIN
  IF pg_catalog.jsonb_typeof(requested_blocks) <> 'array'
     OR pg_catalog.jsonb_array_length(requested_blocks) > 50
     OR pg_catalog.octet_length(requested_blocks::text) > 900000 THEN
    RETURN false;
  END IF;

  FOR block_record IN
    SELECT value
      FROM pg_catalog.jsonb_array_elements(requested_blocks) AS block(value)
  LOOP
    node_count := node_count + 1;
    -- Globales Limit, synchron zu CHECKLIST_NODES_MAX im Zod-Vertrag. Ohne
    -- diese Schranke erlaubten die Ebenenlimits 2.505.050 Knoten.
    IF node_count > 500 THEN RETURN false; END IF;
    IF pg_catalog.jsonb_typeof(block_record.value) <> 'object'
       OR NOT block_record.value ?& ARRAY['id','name','position','visible','segments']
       OR block_record.value - ARRAY['id','name','position','visible','segments']::text[]
          <> '{}'::jsonb
       OR pg_catalog.jsonb_typeof(block_record.value->'id') <> 'string'
       OR block_record.value->>'id' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(block_record.value->'name') <> 'string'
       OR NOT public._f704_valid_clean_text(block_record.value->>'name', 200)
       OR pg_catalog.jsonb_typeof(block_record.value->'position') <> 'number'
       OR block_record.value->>'position' !~ '^[0-9]+$'
       OR (block_record.value->>'position')::numeric > 2147483647
       OR pg_catalog.jsonb_typeof(block_record.value->'visible') <> 'boolean'
       OR pg_catalog.jsonb_typeof(block_record.value->'segments') <> 'array'
       OR pg_catalog.jsonb_array_length(block_record.value->'segments') > 100 THEN
      RETURN false;
    END IF;

    FOR segment_record IN
      SELECT value
        FROM pg_catalog.jsonb_array_elements(block_record.value->'segments') AS segment(value)
    LOOP
      node_count := node_count + 1;
      IF node_count > 500 THEN RETURN false; END IF;
      IF pg_catalog.jsonb_typeof(segment_record.value) <> 'object'
         OR NOT segment_record.value ?& ARRAY['id','name','position','visible','items']
         OR segment_record.value - ARRAY['id','name','position','visible','items']::text[]
            <> '{}'::jsonb
         OR pg_catalog.jsonb_typeof(segment_record.value->'id') <> 'string'
         OR segment_record.value->>'id' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR pg_catalog.jsonb_typeof(segment_record.value->'name') <> 'string'
         OR NOT public._f704_valid_clean_text(segment_record.value->>'name', 200)
         OR pg_catalog.jsonb_typeof(segment_record.value->'position') <> 'number'
         OR segment_record.value->>'position' !~ '^[0-9]+$'
         OR (segment_record.value->>'position')::numeric > 2147483647
         OR pg_catalog.jsonb_typeof(segment_record.value->'visible') <> 'boolean'
         OR pg_catalog.jsonb_typeof(segment_record.value->'items') <> 'array'
         OR pg_catalog.jsonb_array_length(segment_record.value->'items') > 500 THEN
        RETURN false;
      END IF;

      FOR item_record IN
        SELECT value
          FROM pg_catalog.jsonb_array_elements(segment_record.value->'items') AS item(value)
      LOOP
        node_count := node_count + 1;
        IF node_count > 500 THEN RETURN false; END IF;
        IF pg_catalog.jsonb_typeof(item_record.value) <> 'object'
           OR NOT item_record.value ?& ARRAY['id','title','done','required','visible']
           OR item_record.value - ARRAY['id','title','done','required','visible']::text[]
              <> '{}'::jsonb
           OR pg_catalog.jsonb_typeof(item_record.value->'id') <> 'string'
           OR item_record.value->>'id' !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR pg_catalog.jsonb_typeof(item_record.value->'title') <> 'string'
           OR NOT public._f704_valid_clean_text(item_record.value->>'title', 500)
           OR pg_catalog.jsonb_typeof(item_record.value->'done') <> 'boolean'
           OR pg_catalog.jsonb_typeof(item_record.value->'required') <> 'boolean'
           OR pg_catalog.jsonb_typeof(item_record.value->'visible') <> 'boolean' THEN
          RETURN false;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Ein set-basierter HashAggregate ersetzt lineares ANY(text[]) plus
  -- array_append. Damit bleibt die Eindeutigkeitspruefung fuer den global
  -- begrenzten Baum linear statt quadratisch.
  IF EXISTS (
    WITH identities(identity_value) AS (
      SELECT block.value->>'id'
        FROM pg_catalog.jsonb_array_elements(requested_blocks) AS block(value)
      UNION ALL
      SELECT segment.value->>'id'
        FROM pg_catalog.jsonb_array_elements(requested_blocks) AS block(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments')
          AS segment(value)
      UNION ALL
      SELECT item.value->>'id'
        FROM pg_catalog.jsonb_array_elements(requested_blocks) AS block(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments')
          AS segment(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(segment.value->'items')
          AS item(value)
    )
    SELECT 1
      FROM identities
     GROUP BY identity_value
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$f704_valid_blocks$;--> statement-breakpoint

ALTER TABLE public.project_checklist
  ADD CONSTRAINT project_checklist_blocks_v2_ck
  CHECK (public._f704_valid_checklist_blocks(blocks));--> statement-breakpoint
ALTER TABLE public.project_checklist FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE FUNCTION public._f704_checklist_structure(requested_blocks jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $f704_structure$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      block_record.value,
      '{segments}',
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_set(
            segment_record.value,
            '{items}',
            COALESCE((
              SELECT pg_catalog.jsonb_agg(
                item_record.value - CASE
                  WHEN (block_record.value->>'visible')::boolean
                   AND (segment_record.value->>'visible')::boolean
                   AND (item_record.value->>'visible')::boolean
                    THEN 'done'
                  ELSE ''
                END
                ORDER BY item_record.ordinality
              )
                FROM pg_catalog.jsonb_array_elements(segment_record.value->'items')
                  WITH ORDINALITY AS item_record(value, ordinality)
            ), '[]'::jsonb)
          ) ORDER BY segment_record.ordinality
        )
          FROM pg_catalog.jsonb_array_elements(block_record.value->'segments')
            WITH ORDINALITY AS segment_record(value, ordinality)
      ), '[]'::jsonb)
    ) ORDER BY block_record.ordinality
  ), '[]'::jsonb)
    FROM pg_catalog.jsonb_array_elements(requested_blocks)
      WITH ORDINALITY AS block_record(value, ordinality)
$f704_structure$;--> statement-breakpoint

CREATE FUNCTION public._f704_actor_checklist_role(requested_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f704_actor_role$
DECLARE
  actor_id uuid := public.app_actor_id();
  actor_role text;
  actor_capabilities jsonb;
BEGIN
  IF actor_id IS NULL THEN RETURN NULL; END IF;
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
$f704_actor_role$;--> statement-breakpoint

CREATE FUNCTION public._f704_assert_workspace(requested_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $f704_workspace$
DECLARE
  context_workspace_id uuid;
BEGIN
  BEGIN
    context_workspace_id := NULLIF(
      pg_catalog.current_setting('app.workspace_id', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    context_workspace_id := NULL;
  END;
  IF context_workspace_id IS DISTINCT FROM requested_workspace_id THEN
    RAISE EXCEPTION 'F7.4 Workspace-Kontext stimmt nicht überein'
      USING ERRCODE = '42501';
  END IF;
END
$f704_workspace$;--> statement-breakpoint

CREATE FUNCTION public.save_project_checklist_v2(
  requested_workspace_id uuid,
  requested_project_id uuid,
  requested_checklist_id uuid,
  requested_phase text,
  requested_title text,
  expected_version integer,
  requested_blocks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f704_save$
DECLARE
  actor_id uuid := public.app_actor_id();
  actor_role text;
  current_checklist public.project_checklist%ROWTYPE;
  result_checklist_id uuid;
  result_version integer;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  completed_segment record;
  old_segment jsonb;
  new_segment jsonb;
BEGIN
  PERFORM public._f704_assert_workspace(requested_workspace_id);
  actor_role := public._f704_actor_checklist_role(requested_workspace_id);
  IF actor_id IS NULL OR actor_role NOT IN ('editor', 'admin') THEN
    RAISE EXCEPTION 'Projekt-Checkliste verlangt einen internen Editor oder Admin'
      USING ERRCODE = '42501';
  END IF;
  IF expected_version IS NULL OR expected_version < 0
     OR requested_phase NOT IN ('qualification', 'consultation', 'site_documentation')
     OR requested_title IS NULL
     OR NOT public._f704_valid_clean_text(requested_title, 200)
     OR NOT public._f704_valid_checklist_blocks(requested_blocks) THEN
    RAISE EXCEPTION 'Projekt-Checklisten-Command ist ungültig'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = requested_project_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Projekt-Checkliste: Projekt fehlt' USING ERRCODE = 'P0002';
  END IF;

  IF expected_version = 0 THEN
    IF requested_checklist_id IS NOT NULL THEN
      RAISE EXCEPTION 'Neue Projekt-Checkliste darf keine Server-ID vorgeben'
        USING ERRCODE = '23514';
    END IF;
    IF actor_role <> 'admin' AND (
      requested_phase <> 'site_documentation'
      OR requested_title <> 'Baustellendokumentation'
      OR EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(requested_blocks) AS block(value)
          LEFT JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments') AS segment(value)
            ON true
          LEFT JOIN LATERAL pg_catalog.jsonb_array_elements(segment.value->'items') AS item(value)
            ON true
         WHERE block.value->'visible' IS DISTINCT FROM 'true'::jsonb
            OR (
              segment.value IS NOT NULL
              AND segment.value->'visible' IS DISTINCT FROM 'true'::jsonb
            )
            OR (
              item.value IS NOT NULL
              AND (
                item.value->'visible' IS DISTINCT FROM 'true'::jsonb
                OR item.value->'required' IS DISTINCT FROM 'false'::jsonb
              )
            )
      )
    ) THEN
      RAISE EXCEPTION 'Nur Admins dürfen Pflicht-/Sichtbarkeitsstruktur anlegen'
        USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.project_checklist (
      workspace_id, project_id, phase, title, version, blocks,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      requested_workspace_id, requested_project_id, requested_phase,
      requested_title, 1, requested_blocks, actor_id, NULL,
      mutation_time, mutation_time
    )
    RETURNING id, version INTO result_checklist_id, result_version;
  ELSE
    IF requested_checklist_id IS NULL THEN
      RAISE EXCEPTION 'Bestehende Projekt-Checkliste verlangt ihre ID'
        USING ERRCODE = '23514';
    END IF;
    SELECT checklist_record.* INTO current_checklist
      FROM public.project_checklist AS checklist_record
     WHERE checklist_record.workspace_id = requested_workspace_id
       AND checklist_record.project_id = requested_project_id
       AND checklist_record.id = requested_checklist_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Projekt-Checkliste fehlt' USING ERRCODE = 'P0002';
    END IF;
    IF current_checklist.version <> expected_version THEN
      RAISE EXCEPTION 'Projekt-Checklisten-Version ist veraltet'
        USING ERRCODE = '40001', DETAIL = current_checklist.version::text;
    END IF;
    IF current_checklist.version = 2147483647 THEN
      RAISE EXCEPTION 'Projekt-Checklisten-Version ist ausgeschöpft'
        USING ERRCODE = '22003';
    END IF;
    IF actor_role <> 'admin' AND (
      requested_phase IS DISTINCT FROM current_checklist.phase
      OR requested_title IS DISTINCT FROM current_checklist.title
      OR public._f704_checklist_structure(requested_blocks)
         IS DISTINCT FROM public._f704_checklist_structure(current_checklist.blocks)
    ) THEN
      RAISE EXCEPTION 'Nur Admins dürfen die Checklistenstruktur ändern'
        USING ERRCODE = '42501';
    END IF;

    FOR completed_segment IN
      SELECT completion.segment_id
        FROM public.project_checklist_segment_completion AS completion
       WHERE completion.workspace_id = requested_workspace_id
         AND completion.checklist_id = requested_checklist_id
    LOOP
      SELECT segment.value INTO old_segment
        FROM pg_catalog.jsonb_array_elements(current_checklist.blocks) AS block(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments') AS segment(value)
       WHERE segment.value->>'id' = completed_segment.segment_id::text;
      SELECT segment.value INTO new_segment
        FROM pg_catalog.jsonb_array_elements(requested_blocks) AS block(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments') AS segment(value)
       WHERE segment.value->>'id' = completed_segment.segment_id::text;
      IF old_segment IS NULL OR new_segment IS DISTINCT FROM old_segment THEN
        RAISE EXCEPTION 'Abgeschlossenes Segment ist bis zum Unlock unveränderlich'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;

    UPDATE public.project_checklist
       SET phase = requested_phase,
           title = requested_title,
           blocks = requested_blocks,
           version = version + 1,
           updated_by = actor_id,
           updated_at = mutation_time
     WHERE workspace_id = requested_workspace_id
       AND id = requested_checklist_id
       AND version = expected_version
    RETURNING id, version INTO result_checklist_id, result_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Projekt-Checklisten-CAS verloren' USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    requested_workspace_id, 'project_checklist', result_checklist_id,
    CASE WHEN expected_version = 0 THEN 'checklist.created' ELSE 'checklist.updated' END,
    actor_id::text,
    pg_catalog.jsonb_build_object(
      'checklistId', result_checklist_id,
      'projectId', requested_project_id,
      'phase', requested_phase,
      'version', result_version
    ), mutation_time
  );
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details, occurred_at
  ) VALUES (
    requested_workspace_id, actor_id::text, 'checklist.write',
    'project_checklist', true,
    pg_catalog.jsonb_build_object(
      'checklistId', result_checklist_id,
      'projectId', requested_project_id,
      'baseVersion', expected_version
    ), mutation_time
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN expected_version = 0 THEN 'created' ELSE 'updated' END,
    'checklistId', result_checklist_id,
    'version', result_version
  );
END
$f704_save$;--> statement-breakpoint

CREATE FUNCTION public.complete_project_checklist_segment(
  requested_workspace_id uuid,
  requested_project_id uuid,
  requested_checklist_id uuid,
  requested_segment_id uuid,
  expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f704_complete$
DECLARE
  actor_id uuid := public.app_actor_id();
  actor_role text;
  current_checklist public.project_checklist%ROWTYPE;
  current_project_phase text;
  target_block jsonb;
  target_segment jsonb;
  existing_completion public.project_checklist_segment_completion%ROWTYPE;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
  installation_exists boolean := false;
  remaining_required integer;
BEGIN
  IF requested_workspace_id IS NULL
     OR requested_project_id IS NULL
     OR requested_checklist_id IS NULL
     OR requested_segment_id IS NULL
     OR expected_version IS NULL
     OR expected_version < 1 THEN
    RAISE EXCEPTION 'Segmentabschluss-Command ist ungültig'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._f704_assert_workspace(requested_workspace_id);
  actor_role := public._f704_actor_checklist_role(requested_workspace_id);
  IF actor_id IS NULL OR actor_role NOT IN ('editor', 'admin') THEN
    RAISE EXCEPTION 'Segmentabschluss verlangt einen internen Editor oder Admin'
      USING ERRCODE = '42501';
  END IF;
  SELECT project_record.phase INTO current_project_phase
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = requested_project_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Projekt fehlt' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1
    FROM public.installation AS installation_record
   WHERE installation_record.workspace_id = requested_workspace_id
     AND installation_record.project_id = requested_project_id
   FOR KEY SHARE;
  installation_exists := FOUND;

  SELECT checklist_record.* INTO current_checklist
    FROM public.project_checklist AS checklist_record
   WHERE checklist_record.workspace_id = requested_workspace_id
     AND checklist_record.project_id = requested_project_id
     AND checklist_record.id = requested_checklist_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Projekt-Checkliste fehlt' USING ERRCODE = 'P0002'; END IF;

  SELECT completion.* INTO existing_completion
    FROM public.project_checklist_segment_completion AS completion
   WHERE completion.workspace_id = requested_workspace_id
     AND completion.checklist_id = requested_checklist_id
     AND completion.segment_id = requested_segment_id;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'replayed',
      'checklistId', requested_checklist_id,
      'segmentId', requested_segment_id,
      'version', current_checklist.version,
      'completedAt', existing_completion.completed_at,
      'completedById', existing_completion.completed_by
    );
  END IF;
  IF current_checklist.version <> expected_version THEN
    RAISE EXCEPTION 'Projekt-Checklisten-Version ist veraltet'
      USING ERRCODE = '40001', DETAIL = current_checklist.version::text;
  END IF;
  IF current_checklist.version = 2147483647 THEN
    RAISE EXCEPTION 'Projekt-Checklisten-Version ist ausgeschöpft'
      USING ERRCODE = '22003';
  END IF;
  IF current_checklist.phase = 'site_documentation'
     AND (current_project_phase <> 'installation' OR NOT installation_exists) THEN
    RAISE EXCEPTION 'Baustellendokumentation verlangt die Installationsphase'
      USING ERRCODE = '23514';
  END IF;

  SELECT block.value, segment.value INTO target_block, target_segment
    FROM pg_catalog.jsonb_array_elements(current_checklist.blocks) AS block(value)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments') AS segment(value)
   WHERE segment.value->>'id' = requested_segment_id::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checklisten-Segment fehlt' USING ERRCODE = 'P0002'; END IF;
  IF target_block->'visible' IS DISTINCT FROM 'true'::jsonb
     OR target_segment->'visible' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Unsichtbares Segment kann nicht abgeschlossen werden'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO remaining_required
    FROM pg_catalog.jsonb_array_elements(target_segment->'items') AS item(value)
   WHERE item.value->'required' = 'true'::jsonb
     AND item.value->'visible' = 'true'::jsonb
     AND item.value->'done' <> 'true'::jsonb;
  IF remaining_required > 0 THEN
    RAISE EXCEPTION 'Pflichtpositionen sind noch offen'
      USING ERRCODE = '23514', DETAIL = remaining_required::text;
  END IF;

  INSERT INTO public.project_checklist_segment_completion (
    workspace_id, checklist_id, segment_id, completed_at, completed_by
  ) VALUES (
    requested_workspace_id, requested_checklist_id, requested_segment_id,
    mutation_time, actor_id
  );
  UPDATE public.project_checklist
     SET version = version + 1,
         updated_by = actor_id,
         updated_at = mutation_time
   WHERE workspace_id = requested_workspace_id
     AND id = requested_checklist_id
     AND version = expected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Segmentabschluss-CAS verloren' USING ERRCODE = '40001'; END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    requested_workspace_id, 'project_checklist', requested_checklist_id,
    'checklist.segment_completed', actor_id::text,
    pg_catalog.jsonb_build_object(
      'checklistId', requested_checklist_id,
      'projectId', requested_project_id,
      'segmentId', requested_segment_id,
      'version', expected_version + 1
    ), mutation_time
  );
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details, occurred_at
  ) VALUES (
    requested_workspace_id, actor_id::text, 'checklist.write',
    'project_checklist_segment', true,
    pg_catalog.jsonb_build_object(
      'checklistId', requested_checklist_id,
      'projectId', requested_project_id,
      'segmentId', requested_segment_id,
      'baseVersion', expected_version
    ), mutation_time
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', 'completed',
    'checklistId', requested_checklist_id,
    'segmentId', requested_segment_id,
    'version', expected_version + 1,
    'completedAt', mutation_time,
    'completedById', actor_id
  );
END
$f704_complete$;--> statement-breakpoint

CREATE FUNCTION public.unlock_project_checklist_segment(
  requested_workspace_id uuid,
  requested_project_id uuid,
  requested_checklist_id uuid,
  requested_segment_id uuid,
  expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f704_unlock$
DECLARE
  actor_id uuid := public.app_actor_id();
  actor_role text;
  current_checklist public.project_checklist%ROWTYPE;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF requested_workspace_id IS NULL
     OR requested_project_id IS NULL
     OR requested_checklist_id IS NULL
     OR requested_segment_id IS NULL
     OR expected_version IS NULL
     OR expected_version < 1 THEN
    RAISE EXCEPTION 'Segment-Unlock-Command ist ungültig'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._f704_assert_workspace(requested_workspace_id);
  actor_role := public._f704_actor_checklist_role(requested_workspace_id);
  IF actor_id IS NULL OR actor_role <> 'admin' THEN
    RAISE EXCEPTION 'Segment-Unlock verlangt einen internen Admin'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.project AS project_record
   WHERE project_record.workspace_id = requested_workspace_id
     AND project_record.id = requested_project_id
   FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Projekt fehlt' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1
    FROM public.installation AS installation_record
   WHERE installation_record.workspace_id = requested_workspace_id
     AND installation_record.project_id = requested_project_id
   FOR KEY SHARE;

  SELECT checklist_record.* INTO current_checklist
    FROM public.project_checklist AS checklist_record
   WHERE checklist_record.workspace_id = requested_workspace_id
     AND checklist_record.project_id = requested_project_id
     AND checklist_record.id = requested_checklist_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Projekt-Checkliste fehlt' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(current_checklist.blocks) AS block(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(block.value->'segments') AS segment(value)
     WHERE segment.value->>'id' = requested_segment_id::text
  ) THEN
    RAISE EXCEPTION 'Checklisten-Segment fehlt' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.project_checklist_segment_completion AS completion
     WHERE completion.workspace_id = requested_workspace_id
       AND completion.checklist_id = requested_checklist_id
       AND completion.segment_id = requested_segment_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'replayed',
      'checklistId', requested_checklist_id,
      'segmentId', requested_segment_id,
      'version', current_checklist.version
    );
  END IF;
  IF current_checklist.version <> expected_version THEN
    RAISE EXCEPTION 'Projekt-Checklisten-Version ist veraltet'
      USING ERRCODE = '40001', DETAIL = current_checklist.version::text;
  END IF;
  IF current_checklist.version = 2147483647 THEN
    RAISE EXCEPTION 'Projekt-Checklisten-Version ist ausgeschöpft'
      USING ERRCODE = '22003';
  END IF;

  DELETE FROM public.project_checklist_segment_completion
   WHERE workspace_id = requested_workspace_id
     AND checklist_id = requested_checklist_id
     AND segment_id = requested_segment_id;
  UPDATE public.project_checklist
     SET version = version + 1,
         updated_by = actor_id,
         updated_at = mutation_time
   WHERE workspace_id = requested_workspace_id
     AND id = requested_checklist_id
     AND version = expected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Segment-Unlock-CAS verloren' USING ERRCODE = '40001'; END IF;

  INSERT INTO public.domain_events (
    workspace_id, aggregate_type, aggregate_id, event_type,
    actor, payload, occurred_at
  ) VALUES (
    requested_workspace_id, 'project_checklist', requested_checklist_id,
    'checklist.segment_unlocked', actor_id::text,
    pg_catalog.jsonb_build_object(
      'checklistId', requested_checklist_id,
      'projectId', requested_project_id,
      'segmentId', requested_segment_id,
      'version', expected_version + 1
    ), mutation_time
  );
  INSERT INTO public.audit_log (
    workspace_id, actor, action, resource, allowed, details, occurred_at
  ) VALUES (
    requested_workspace_id, actor_id::text, 'checklist.unlock',
    'project_checklist_segment', true,
    pg_catalog.jsonb_build_object(
      'checklistId', requested_checklist_id,
      'projectId', requested_project_id,
      'segmentId', requested_segment_id,
      'baseVersion', expected_version
    ), mutation_time
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', 'unlocked',
    'checklistId', requested_checklist_id,
    'segmentId', requested_segment_id,
    'version', expected_version + 1
  );
END
$f704_unlock$;--> statement-breakpoint

ALTER TABLE public.project_checklist_segment_completion ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_checklist_segment_completion FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.project_checklist_segment_completion
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint

CREATE TRIGGER project_checklist_no_truncate
BEFORE TRUNCATE ON public.project_checklist
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER project_checklist_segment_completion_no_truncate
BEFORE TRUNCATE ON public.project_checklist_segment_completion
FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation();--> statement-breakpoint

REVOKE ALL ON FUNCTION public._f704_valid_clean_text(text,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f704_valid_checklist_blocks(jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f704_checklist_structure(jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f704_actor_checklist_role(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f704_assert_workspace(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.save_project_checklist_v2(uuid,uuid,uuid,text,text,integer,jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_project_checklist_segment(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.unlock_project_checklist_segment(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON
  public.project_checklist,
  public.project_checklist_segment_completion
  FROM PUBLIC;--> statement-breakpoint

DO $f704_acl$
DECLARE
  principal_name text;
BEGIN
  FOREACH principal_name IN ARRAY ARRAY[
    'app_migrator', 'app_runtime', 'app_system', 'app_auth', 'app_worker',
    'app_erasure', 'app_membership_writer', 'identity_reconciler'
  ]::text[] LOOP
    IF pg_catalog.to_regrole(principal_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.project_checklist, '
        'public.project_checklist_segment_completion FROM %I',
        principal_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION '
        'public._f704_valid_clean_text(text,integer), '
        'public._f704_valid_checklist_blocks(jsonb), '
        'public._f704_checklist_structure(jsonb), '
        'public._f704_actor_checklist_role(uuid), '
        'public._f704_assert_workspace(uuid), '
        'public.save_project_checklist_v2(uuid,uuid,uuid,text,text,integer,jsonb), '
        'public.complete_project_checklist_segment(uuid,uuid,uuid,uuid,integer), '
        'public.unlock_project_checklist_segment(uuid,uuid,uuid,uuid,integer) FROM %I',
        principal_name
      );
    END IF;
  END LOOP;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT ON
      public.project_checklist,
      public.project_checklist_segment_completion
      TO app_runtime;
    GRANT EXECUTE ON FUNCTION
      public.save_project_checklist_v2(uuid,uuid,uuid,text,text,integer,jsonb),
      public.complete_project_checklist_segment(uuid,uuid,uuid,uuid,integer),
      public.unlock_project_checklist_segment(uuid,uuid,uuid,uuid,integer)
      TO app_runtime;
  END IF;
END
$f704_acl$;
