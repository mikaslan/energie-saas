-- Append-only per Trigger: domain_events (Outbox) und audit_log dürfen nach
-- dem Insert nie mehr verändert oder gelöscht werden — das ist die
-- fachliche Garantie hinter beiden Tabellen (unveränderliche Historie).
-- Kein Owner-Bypass wie bei RLS FORCE: ein BEFORE-Trigger greift für JEDE
-- Rolle inklusive des Tabellen-Owners.
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger domain_events_append_only before update or delete on domain_events
  for each row execute function forbid_mutation();
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function forbid_mutation();

-- RLS: enable + FORCE, current_setting(...) via nullif(..., '') abgesichert
-- (siehe Kommentar in drizzle/0001_rls_core.sql — current_setting('app.workspace_id', true)
-- liefert auf einer wiederverwendeten Pool-Verbindung nach einer withTenant-
-- Transaktion nicht NULL, sondern den Platzhalter-Default '', und ''::uuid
-- würde ohne nullif() einen Fehler werfen statt fail-closed NULL zu liefern).
alter table domain_events enable row level security;
alter table domain_events force row level security;
create policy tenant_isolation on domain_events
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy tenant_isolation on audit_log
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
