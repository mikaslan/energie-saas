-- F7-03b: Antwortwert ist Nutzlast, keine Struktur (E2E-Befund).
-- `_f704_valid_checklist_blocks` unveraendert gegenueber 0143 (Vollkopie,
-- Pin bleibt gueltig). `_f704_checklist_structure` streicht kuenftig auch
-- `value` (Antworttext) unter derselben Sichtbarkeitsbedingung wie `done`:
-- Editoren duerfen Textpunkte beantworten (F7.4: Antworten ja, Struktur
-- nein; F7-02E: Antworttext ist Nutzlast, kein Gate). Zuvor verweigerte die
-- Kapsel jeden Editor-Save mit Antworttext als 42501-Strukturwechsel —
-- Text aus Vorlagen (struktur-geschuetzt ab Version 1) war damit faktisch
-- unbeantwortbar. Keine neue Tabelle, keine neue Permission
-- (checklist.write), keine RLS-Aenderung.
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
           OR item_record.value - ARRAY['id','title','done','required','visible','irrelevant','visibleIf','kind','description','value','componentId']::text[]
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
           -- F7-02C (0130): optionale Anzeige-Punkt-Felder kind/description.
           -- Fehlender Key und explizites null sind gueltig (Aufgabe).
           OR (item_record.value ? 'kind'
               AND (item_record.value->'kind') IS NOT NULL
               AND (item_record.value->'kind') <> 'null'::jsonb
               AND NOT (item_record.value->>'kind' IN ('task','title','description','radio','text','multi')))
           OR (item_record.value ? 'description'
               AND (item_record.value->'description') IS NOT NULL
               AND (item_record.value->'description') <> 'null'::jsonb
               AND (pg_catalog.jsonb_typeof(item_record.value->'description') <> 'string'
                    OR NOT public._f704_valid_clean_text(item_record.value->>'description', 2000)))
           -- F7-02E (0142): optionaler Antworttext value (nur Textpunkt).
           -- Fehlender Key und explizites null sind gueltig (kein Wert).
           OR (item_record.value ? 'value'
               AND (item_record.value->'value') IS NOT NULL
               AND (item_record.value->'value') <> 'null'::jsonb
               AND (pg_catalog.jsonb_typeof(item_record.value->'value') <> 'string'
                    OR NOT public._f704_valid_clean_text(item_record.value->>'value', 2000)))
           OR ((item_record.value ? 'value')
               AND (item_record.value->'value') IS NOT NULL
               AND (item_record.value->'value') <> 'null'::jsonb
               AND (item_record.value->>'kind' IS DISTINCT FROM 'text'))
           -- Anzeige-Punkte tragen weder Pflicht noch Erledigt; Fliesstext
           -- nur am Beschreibungspunkt (Mischbestaende abweisen).
           OR ((item_record.value->>'kind' IN ('title','description'))
               AND ((item_record.value->'required') = 'true'::jsonb
                    OR (item_record.value->'done') = 'true'::jsonb))
           OR ((item_record.value ? 'description')
               AND (item_record.value->'description') IS NOT NULL
               AND (item_record.value->'description') <> 'null'::jsonb
               AND (item_record.value->>'kind' IS DISTINCT FROM 'description'))
           -- F7-13 (0131): optionale Vorlagen-Identitaet componentId.
           -- Fehlender Key und explizites null sind gueltig (Legacy).
           OR (item_record.value ? 'componentId'
               AND (item_record.value->'componentId') IS NOT NULL
               AND (item_record.value->'componentId') <> 'null'::jsonb
               AND ((item_record.value->>'componentId') !~
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
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
      -- F7-02D (0141): Einfachauswahl — hoechstens ein erledigter
      -- Radio-Punkt je Segment (Scope spiegelt visibleIf-Regeln).
      -- F7-02F (0143): Mehrfachauswahl zaehlt hier bewusst nicht —
      -- mehrere erledigte Multi-Punkte je Segment sind gueltig.
      IF (SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_array_elements(segment_record.value->'items') AS item(value)
           WHERE item.value->>'kind' = 'radio'
             AND item.value->'done' = 'true'::jsonb) > 1 THEN
        RETURN false;
      END IF;
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
--> statement-breakpoint

-- F7-03b: Struktur ohne Antwortwert (s. Kopfkommentar).
CREATE OR REPLACE FUNCTION public._f704_checklist_structure(requested_blocks jsonb)
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
                    THEN ARRAY['done','value']
                  ELSE '{}'::text[]
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
$f704_structure$;;--> statement-breakpoint
