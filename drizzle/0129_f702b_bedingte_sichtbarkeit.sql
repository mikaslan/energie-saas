-- F7-02B: Bedingte Sichtbarkeit if/then (Katalog F7.2).
-- Validator erlaubt das optionale `visibleIf`-Objekt {itemId,equals};
-- das Complete-Gate zaehlt bedingt versteckte Pflichtpunkte nicht
-- (Single-Hop ueber RAW-done im selben Segment). Keine neue Tabelle,
-- keine neue Permission (checklist.write/configure), keine RLS-Aenderung.
CREATE OR REPLACE FUNCTION public._f704_valid_checklist_blocks(requested_blocks jsonb)
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
           OR item_record.value - ARRAY['id','title','done','required','visible','irrelevant','visibleIf']::text[]
              <> '{}'::jsonb
           -- F7-04b (0127): optionale Irrelevant-Markierung {reason,by,at}.
           OR (item_record.value ? 'irrelevant'
               AND (pg_catalog.jsonb_typeof(item_record.value->'irrelevant') <> 'object'
                    OR NOT (item_record.value->'irrelevant' ?& ARRAY['reason','by','at'])
                    OR ((item_record.value->'irrelevant') - ARRAY['reason','by','at']::text[]
                        <> '{}'::jsonb)
                    OR pg_catalog.jsonb_typeof(item_record.value->'irrelevant'->'reason') <> 'string'
                    OR NOT public._f704_valid_clean_text(
                         item_record.value->'irrelevant'->>'reason', 500)
                    OR (item_record.value->'irrelevant'->>'by') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                    OR pg_catalog.jsonb_typeof(item_record.value->'irrelevant'->'at') <> 'string'
                    OR (item_record.value->'irrelevant'->>'at') !~
                       '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'))
           -- F7-02B (0129): optionale if/then-Sichtbarkeitsregel {itemId,equals}.
           -- Fehlender Key und explizites null sind gueltig (keine Regel).
           OR (item_record.value ? 'visibleIf'
               AND (item_record.value->'visibleIf') IS NOT NULL
               AND (item_record.value->'visibleIf') <> 'null'::jsonb
               AND (pg_catalog.jsonb_typeof(item_record.value->'visibleIf') <> 'object'
                    OR NOT (item_record.value->'visibleIf' ?& ARRAY['itemId','equals'])
                    OR ((item_record.value->'visibleIf') - ARRAY['itemId','equals']::text[]
                        <> '{}'::jsonb)
                    OR (item_record.value->'visibleIf'->>'itemId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                    OR pg_catalog.jsonb_typeof(item_record.value->'visibleIf'->'equals') <> 'boolean'))
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

CREATE OR REPLACE FUNCTION public.complete_project_checklist_segment(
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
     AND item.value->'done' <> 'true'::jsonb
     -- F7-04b (0127): irrelevant markierte Pflichtpunkte blockieren nicht.
     AND item.value->'irrelevant' IS NULL
     -- F7-02B (0129): bedingt versteckte Pflichtpunkte blockieren nicht.
     -- Single-Hop ueber das RAW-done-Flag desselben Segments.
     AND (NOT (item.value ? 'visibleIf')
          OR (item.value->'visibleIf') IS NULL
          OR (item.value->'visibleIf') = 'null'::jsonb
          OR NOT EXISTS (
            SELECT 1
              FROM pg_catalog.jsonb_array_elements(target_segment->'items') AS ref(value)
             WHERE ref.value->>'id' = item.value->'visibleIf'->>'itemId'
               AND (ref.value->'done') IS DISTINCT FROM (item.value->'visibleIf'->'equals')
          ));
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
--> statement-breakpoint
