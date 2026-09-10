-- ═══════════════════════════════════════════════════════════════════════
-- F15-01 (0088): Default-Commercial-Board provisionieren + Bestand backfillen.
-- Der Workspace-Trigger bleibt die einzige Provisionierungsgrenze (Muster
-- 0032); neue Workspaces erhalten Residential- UND Commercial-Board mit
-- denselben vier Spalten. Signatur/Owner/Sprache/SECURITY DEFINER/search_path
-- der Funktion bleiben unverändert — nur der Rumpf wächst (Pin-Update im
-- Rollenvertrag).
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

  -- F15-01: Default-Gewerbe-Board (Spalten-Setup = Wohnbau-Kopie; eigene
  -- Gewerbe-Workflow-Stufen bleiben ESTIMATE/offen).
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
    (pg_catalog.gen_random_uuid(), NEW.id, commercial_board_id, 'In Prüfung', 'lead', 2, 'amber', false, now(), now()),
    (pg_catalog.gen_random_uuid(), NEW.id, commercial_board_id, 'Qualifiziert', 'lead', 3, 'green', false, now(), now()),
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
-- Backfill: Bestands-Workspaces ohne aktives Default-Commercial-Board
-- erhalten genau eines (idempotent via Partial-Unique-Index
-- kanban_board_ws_scope_default_uq; RLS-Zeilen pro Workspace via
-- set_config, da FORCE RLS auch in Migrationen gilt).
-- ═══════════════════════════════════════════════════════════════════════
DO $f15_01_backfill$
DECLARE
  workspace_row record;
  board_id uuid;
  prior_workspace text := pg_catalog.current_setting('app.workspace_id', true);
BEGIN
  FOR workspace_row IN
    SELECT w.id
      FROM public.workspace w
     WHERE NOT EXISTS (
       SELECT 1 FROM public.kanban_board b
        WHERE b.workspace_id = w.id
          AND b.scope = 'commercial'
          AND b.is_default = true
          AND b.archived_at IS NULL
     )
  LOOP
    PERFORM pg_catalog.set_config('app.workspace_id', workspace_row.id::text, true);
    board_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.kanban_board (
      id, workspace_id, name, scope, is_default, created_at, updated_at
    ) VALUES (
      board_id, workspace_row.id, 'Anfragen Gewerbe', 'commercial', true, now(), now()
    );
    INSERT INTO public.kanban_column (
      id, workspace_id, board_id, name, column_type, position, color, is_intake,
      created_at, updated_at
    ) VALUES
      (pg_catalog.gen_random_uuid(), workspace_row.id, board_id, 'Eingang', 'lead', 1, 'blue', true, now(), now()),
      (pg_catalog.gen_random_uuid(), workspace_row.id, board_id, 'In Prüfung', 'lead', 2, 'amber', false, now(), now()),
      (pg_catalog.gen_random_uuid(), workspace_row.id, board_id, 'Qualifiziert', 'lead', 3, 'green', false, now(), now()),
      (pg_catalog.gen_random_uuid(), workspace_row.id, board_id, 'Angebote', 'offer', 4, 'blue', false, now(), now());
  END LOOP;
  PERFORM pg_catalog.set_config('app.workspace_id', COALESCE(prior_workspace, ''), true);
END
$f15_01_backfill$;
