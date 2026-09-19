-- ═══════════════════════════════════════════════════════════════════════
-- F8-24a: RLS-freier Sweep-Arbeitsvorrat (Locator-Praezedenz
-- erasure_operation_locator/portal_token_locator).
--
-- Der Overdue-Sweep (taeglich 06:00, alle Workspaces) kann seine
-- Kandidaten NICHT aus `workspace` lesen: FORCE RLS + genau eine
-- permissive Policy (`tenant_isolation`) lassen fuer app_worker ohne
-- app.workspace_id null Zeilen uebrig — ein Worker-Bypass ist
-- architektonisch ausgeschlossen (tenant-invariants verbietet jede
-- zweite permissive Policy; DEFINER umgeht FORCE RLS nicht).
-- Deshalb spiegelt ein AFTER-INSERT-Trigger jede Workspace-id in
-- diese Tabelle (IDs only, keine Fachdaten, keine workspace_id-
-- Spalte). Der Sweep paginiert ueber den Spiegel; jeder Belegzugriff
-- darunter bleibt tenant-isoliert via withTenantOn.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE public.overdue_sweep_workspace (
  workspace_id uuid PRIMARY KEY
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public._f824a_mirror_workspace_for_sweep()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f824a_mirror_workspace_for_sweep$
BEGIN
  INSERT INTO public.overdue_sweep_workspace (workspace_id)
  VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$f824a_mirror_workspace_for_sweep$;--> statement-breakpoint
CREATE TRIGGER overdue_sweep_workspace_mirror_ins
AFTER INSERT ON public.workspace
FOR EACH ROW EXECUTE FUNCTION public._f824a_mirror_workspace_for_sweep();--> statement-breakpoint
REVOKE ALL ON FUNCTION public._f824a_mirror_workspace_for_sweep() FROM PUBLIC;--> statement-breakpoint
-- Backfill (best effort, ehrlich begrenzt): Unter FORCE RLS sieht der
-- Migrierer ohne app.workspace_id keine einzige Workspace-Zeile — das
-- SELECT ist dort leer, Greenfield-korrekt (der Trigger traegt alle
-- kuenftigen Workspaces). Kein stiller Bestands-Anspruch.
INSERT INTO public.overdue_sweep_workspace (workspace_id)
SELECT id FROM public.workspace
ON CONFLICT DO NOTHING;
