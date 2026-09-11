-- ═══════════════════════════════════════════════════════════════════════
-- F1-05a Spaltenverwaltung: app_runtime darf Board-Spalten lesen, anlegen,
-- umbenennen, verschieben, archivieren/wiederherstellen (SELECT/INSERT/
-- UPDATE — kein DELETE: Archiv statt Löschen, Muster 0041 project_note).
-- Schreiben gatet der Service-Layer (project.write, keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
DO $f105a_column_grants$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.kanban_column TO app_runtime;
  END IF;
END
$f105a_column_grants$;--> statement-breakpoint
