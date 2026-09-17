-- ═══════════════════════════════════════════════════════════════════════
-- F9-12 Default-4er-Kategorie-Satz (Blaupause F9.2 „Admin-Kategorien
-- (Travel/On-site/Office/Other + custom)"): genau 4 Zeit-Ereignistypen
-- je Workspace — Travel position 0, On-site 1, Office 2, Other 3 in
-- Blaupause-Reihenfolge, Namen wörtlich, Farben NULL.
-- ESTIMATE: Blaupause nennt keine Positionen/Farben — 0-3 aufsteigend
-- hält die Reihenfolge in der Listensortierung (position/name/id)
-- stabil, keine erfundenen Hex-Werte. Reversibel: kein Schutz-Flag,
-- kein is_default, Admins ändern Defaults per F9.1-CRUD.
-- Provisionierung an der Workspace-Anlage (0022-Muster): AFTER
-- INSERT-Trigger für neue Workspaces + idempotenter Backfill für
-- Bestand (ON CONFLICT DO NOTHING auf dem partiellen Unique-Index —
-- Custom-Zeilen bleiben unangetastet, Rest wird ergänzt).
-- Rechte: keine Rollen/Policies/Permission/RLS-Änderungen (M1-CRM-Muster
-- tenant_isolation + FORCE aus 0050 bleibt); beide Funktionen
-- SECURITY DEFINER mit festem pg_catalog-search_path, REVOKE ALL FROM
-- PUBLIC (kein aufrufbarer API-Vertrag). GUC-Tanz in der Seed-Funktion
-- (FORCE RLS gilt auch für Owner, 0050:65).
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.seed_default_time_event_types(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f9_12_seed$
DECLARE
  prior_workspace text := pg_catalog.current_setting('app.workspace_id', true);
BEGIN
  PERFORM pg_catalog.set_config('app.workspace_id', p_workspace_id::text, true);

  INSERT INTO public.time_event_type (workspace_id, name, name_normalized, position)
  VALUES (p_workspace_id, 'Travel', 'travel', 0)
  ON CONFLICT (workspace_id, name_normalized) WHERE archived_at IS NULL DO NOTHING;
  INSERT INTO public.time_event_type (workspace_id, name, name_normalized, position)
  VALUES (p_workspace_id, 'On-site', 'on-site', 1)
  ON CONFLICT (workspace_id, name_normalized) WHERE archived_at IS NULL DO NOTHING;
  INSERT INTO public.time_event_type (workspace_id, name, name_normalized, position)
  VALUES (p_workspace_id, 'Office', 'office', 2)
  ON CONFLICT (workspace_id, name_normalized) WHERE archived_at IS NULL DO NOTHING;
  INSERT INTO public.time_event_type (workspace_id, name, name_normalized, position)
  VALUES (p_workspace_id, 'Other', 'other', 3)
  ON CONFLICT (workspace_id, name_normalized) WHERE archived_at IS NULL DO NOTHING;

  PERFORM pg_catalog.set_config(
    'app.workspace_id',
    COALESCE(prior_workspace, ''),
    true
  );
  RETURN;
END
$f9_12_seed$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.seed_default_time_event_types(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.provision_default_time_event_types()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f9_12_provision$
BEGIN
  PERFORM public.seed_default_time_event_types(NEW.id);
  RETURN NEW;
END
$f9_12_provision$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.provision_default_time_event_types() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER workspace_default_time_event_types
AFTER INSERT ON public.workspace
FOR EACH ROW
EXECUTE FUNCTION public.provision_default_time_event_types();
--> statement-breakpoint
SELECT public.seed_default_time_event_types(w.id) FROM public.workspace w;
