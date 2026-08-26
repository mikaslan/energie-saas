-- Fix Round 1, Important #1: Row-level BEFORE-Trigger (0004_append_only.sql)
-- feuert NIE bei TRUNCATE — TRUNCATE ist keine zeilenweise Operation, und
-- RLS greift bei TRUNCATE ebenfalls nicht. Jede Rolle mit TRUNCATE-Recht auf
-- der Tabelle (inkl. unserer App-Rolle, die als Owner automatisch TRUNCATE
-- darf) könnte den kompletten Outbox-/Audit-Bestand mit einem einzigen
-- Statement löschen, ohne dass der Row-Level-Trigger je feuert. Fix: ein
-- zusätzlicher STATEMENT-Level-Trigger auf TRUNCATE, der dieselbe
-- forbid_mutation()-Funktion wiederverwendet (die Funktion wirft
-- unabhängig davon, ob sie row- oder statement-level aufgerufen wird).
create trigger domain_events_no_truncate before truncate on domain_events
  for each statement execute function forbid_mutation();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function forbid_mutation();
