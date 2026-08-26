-- RLS: enable + FORCE (auch der Tabellen-Owner unterliegt den Policies)
--
-- current_setting('app.workspace_id', true) liefert NUR auf einer Verbindung,
-- die diesen Parameter noch NIE referenziert hat, NULL. Nach einer
-- withTenant-Transaktion (set_config(..., true) = SET LOCAL) reverted der Wert
-- auf einer wiederverwendeten Pool-Verbindung nicht auf NULL, sondern auf den
-- Platzhalter-Default '' (leerer String) — ''::uuid wirft einen Fehler statt
-- NULL zu liefern. Mit Connection-Pooling (Pool/Neon) tritt das früher oder
-- später auf jeder Verbindung auf, die einmal in withTenant lief. nullif(...,
-- '') fängt das ab, bevor der uuid-Cast greift.
alter table workspace enable row level security;
alter table workspace force row level security;
create policy tenant_isolation on workspace
  using (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.workspace_id', true), '')::uuid);

alter table membership enable row level security;
alter table membership force row level security;
create policy tenant_isolation on membership
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- user_identity ist bewusst global (Blaupause: eine Identität in n Workspaces) — keine Tenant-Policy.
