-- user_identity: RLS enable + FORCE (Controller-Ruling, überschreibt die
-- "bewusst global"-Notiz aus 0001_rls_core.sql — ohne Policy würde ein
-- vergessenes WHERE/JOIN alle Plattform-E-Mails offenlegen).
--
-- Sichtbar ist eine Identität nur, wenn sie in mindestens einer Membership
-- des aktuellen Workspace steckt (current_setting via nullif abgesichert,
-- siehe Kommentar in 0001_rls_core.sql — reverted nach einer withTenant-
-- Transaktion auf einer wiederverwendeten Pool-Connection auf '', nicht auf
-- NULL).
--
-- Insert ist bewusst uneingeschränkt (with check (true)): ein Insert legt
-- keine fremden Daten offen und der künftige Auth-Hook (Anlage einer neuen
-- Identität bei Erst-Login) läuft außerhalb von withTenant, bevor überhaupt
-- eine Membership existiert. Kein Update/Delete: Identität ist append-only,
-- die E-Mail ist der unveränderliche Schlüssel.
alter table user_identity enable row level security;
alter table user_identity force row level security;

create policy user_identity_select on user_identity for select
  using (
    exists (
      select 1 from membership m
      where m.user_id = user_identity.id
        and m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    )
  );

create policy user_identity_insert on user_identity for insert
  with check (true);
