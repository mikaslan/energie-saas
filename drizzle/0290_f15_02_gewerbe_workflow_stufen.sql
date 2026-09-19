-- ═══════════════════════════════════════════════════════════════════════
-- F15-02 (0290): Eigene Gewerbe-Workflow-Stufen für das Default-
-- Commercial-Board.
--
-- F15-01 (0088) hat das Commercial-Board als Wohnbau-Kopie provisioniert
-- („Anfragen Gewerbe", gleiche 4 Spalten); die Spec
-- (docs/spec/F15-01-gewerbe-bereich.md) markiert eigene
-- Gewerbe-Workflow-Stufen als UNKNOWN/ESTIMATE ohne Reonic-Referenz.
-- Diese Migration ersetzt die Commercial-Stufen in
-- provision_default_request_board und benennt unberührte Bestands-Boards
-- karten-erhaltend per UPDATE um.
--
-- ESTIMATE (reversibel, keine Reonic-Referenz): Die Stufennamen
-- 'Bedarfsanalyse' (Lastgang-/Verbrauchsklärung) und 'Planung'
-- (technische Auslegung) sind eine fachliche Schätzung für den
-- Gewerbe-Workflow. 'Eingang' (Intake) und 'Angebote' (Offer-Spalte)
-- bleiben bewusst generisch: Typen sind lead/offer-kompatibel
-- (Position 1-3 lead, Position 4 offer), Intake bleibt Position 1
-- (kanban_column_intake_lead_ck), die Offer-Spalte bleibt Position 4,
-- damit Angebotsflüsse unverändert greifen. Farben/Positionen bleiben
-- positionsgleich zum Wohnbau-Setup.
--
-- Signatur/Owner/Sprache/SECURITY DEFINER/search_path der Funktion
-- bleiben unverändert — nur der Commercial-Rumpf wird ersetzt
-- (CREATE OR REPLACE übernimmt Owner/Rechte automatisch; kein
-- REVOKE/GRANT/ALTER OWNER nötig, Muster 0088).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.provision_default_request_board()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $m2_01_provision$
DECLARE
  residential_board_id uuid := pg_catalog.gen_random_uuid();
  commercial_board_id uuid := pg_catalog.gen_random_uuid();
  prior_workspace text := pg_catalog.current_setting('app.workspace_id', true);
BEGIN
  PERFORM pg_catalog.set_config('app.workspace_id', NEW.id::text, true);

  INSERT INTO public.kanban_board (
    id, workspace_id, name, scope, is_default, created_at, updated_at
  ) VALUES (
    residential_board_id, NEW.id, 'Anfragen', 'residential', true, now(), now()
  );
  INSERT INTO public.kanban_column (
    id, workspace_id, board_id, name, column_type, position, color, is_intake,
    created_at, updated_at
  ) VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, residential_board_id, 'Eingang', 'lead', 1, 'blue', true, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, residential_board_id, 'In Prüfung', 'lead', 2, 'amber', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, residential_board_id, 'Qualifiziert', 'lead', 3, 'green', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, residential_board_id, 'Angebote', 'offer', 4, 'blue', false, now(), now());

  -- F15-02: Eigene Gewerbe-Workflow-Stufen (ESTIMATE, siehe Kopfkommentar).
  -- Residential-Setup oberhalb bleibt byte-identisch zu 0088.
  INSERT INTO public.kanban_board (
    id, workspace_id, name, scope, is_default, created_at, updated_at
  ) VALUES (
    commercial_board_id, NEW.id, 'Anfragen Gewerbe', 'commercial', true, now(), now()
  );
  INSERT INTO public.kanban_column (
    id, workspace_id, board_id, name, column_type, position, color, is_intake,
    created_at, updated_at
  ) VALUES
    (pg_catalog.gen_random_uuid(), NEW.id, commercial_board_id, 'Eingang', 'lead', 1, 'blue', true, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, commercial_board_id, 'Bedarfsanalyse', 'lead', 2, 'amber', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, commercial_board_id, 'Planung', 'lead', 3, 'green', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, commercial_board_id, 'Angebote', 'offer', 4, 'blue', false, now(), now());

  PERFORM pg_catalog.set_config(
    'app.workspace_id',
    COALESCE(prior_workspace, ''),
    true
  );
  RETURN NEW;
END
$m2_01_provision$;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- Backfill: Aktive Default-Commercial-Boards, deren aktive Spalten exakt
-- den vier alten Default-Spalten (Position/Name/Typ aus 0088) entsprechen,
-- erhalten per UPDATE die neuen Stufennamen — Spalten-IDs bleiben stabil,
-- Karten (project.kanban_column_id) bleiben zugeordnet. Angepasste Boards
-- (umbenannte/zusätzliche/entfernte Spalten, abweichende Typen),
-- archivierte Boards und Residential-Boards bleiben unangetastet.
-- Idempotent: Nach dem Umbenennen greift die Alt-Namen-Garantie nicht
-- mehr, ein Re-Run trifft null Zeilen. RLS-Zeilen pro Workspace via
-- set_config, da FORCE RLS auch in Migrationen gilt (Muster 0088).
-- ═══════════════════════════════════════════════════════════════════════
DO $f15_02_backfill$
DECLARE
  workspace_row record;
  prior_workspace text := pg_catalog.current_setting('app.workspace_id', true);
BEGIN
  -- FORCE-RLS-Fenster (Muster 0032): Im Migrationskontext ist
  -- app.workspace_id ungesetzt, daher saehe die Workspace-Schleife
  -- sonst null Zeilen (tenant_isolation: id = NULL). NO FORCE laesst
  -- den Owner (Migrations-Principal) passieren; am Blockende wird
  -- FORCE wiederhergestellt (transaktional — bei Fehler Rollback).
  ALTER TABLE public.workspace NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.kanban_board NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.kanban_column NO FORCE ROW LEVEL SECURITY;
  FOR workspace_row IN
    SELECT w.id
      FROM public.workspace w
  LOOP
    PERFORM pg_catalog.set_config('app.workspace_id', workspace_row.id::text, true);
    UPDATE public.kanban_column AS col
       SET name = mapping.new_name,
           updated_at = now()
      FROM (VALUES
        (2, 'Bedarfsanalyse'),
        (3, 'Planung')
      ) AS mapping (pos, new_name),
      public.kanban_board AS board
     WHERE board.workspace_id = workspace_row.id
       AND board.scope = 'commercial'
       AND board.is_default = true
       AND board.archived_at IS NULL
       AND col.workspace_id = board.workspace_id
       AND col.board_id = board.id
       AND col.archived_at IS NULL
       AND col.position = mapping.pos
       AND (
         SELECT pg_catalog.count(*)
           FROM public.kanban_column AS cnt
          WHERE cnt.workspace_id = board.workspace_id
            AND cnt.board_id = board.id
            AND cnt.archived_at IS NULL
       ) = 4
       AND NOT EXISTS (
         SELECT 1
           FROM public.kanban_column AS other
          WHERE other.workspace_id = board.workspace_id
            AND other.board_id = board.id
            AND other.archived_at IS NULL
            AND (other.position, other.name, other.column_type) NOT IN (
              (1, 'Eingang', 'lead'),
              (2, 'In Prüfung', 'lead'),
              (3, 'Qualifiziert', 'lead'),
              (4, 'Angebote', 'offer')
            )
       );
  END LOOP;
  ALTER TABLE public.workspace FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.kanban_board FORCE ROW LEVEL SECURITY;
  ALTER TABLE public.kanban_column FORCE ROW LEVEL SECURITY;
  PERFORM pg_catalog.set_config('app.workspace_id', COALESCE(prior_workspace, ''), true);
END
$f15_02_backfill$;
