-- RLS für site: enable + FORCE, current_setting(...) via nullif(..., '')
-- abgesichert (Muster aus 0001_rls_core.sql/0004_append_only.sql —
-- current_setting('app.workspace_id', true) liefert auf einer
-- wiederverwendeten Pool-Verbindung nach einer withTenant-Transaktion nicht
-- NULL, sondern den Platzhalter-Default '', und ''::uuid würde ohne
-- nullif() einen Fehler werfen statt fail-closed NULL zu liefern).
alter table site enable row level security;
alter table site force row level security;
create policy tenant_isolation on site
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
