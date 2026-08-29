-- M1-03: Custom-GUCs transportieren Kontext, authentifizieren aber keinen
-- SQL-Principal. Deshalb darf Membership-DML nicht mehr allein davon abhängen,
-- ob app.actor_id gesetzt oder leer ist. Diese zusätzliche Schranke bindet
-- jeden Schreibvorgang an eine echte, nicht per SET/set_config fälschbare
-- PostgreSQL-Rollenmitgliedschaft.
--
-- Forward-only: Nach einer produktiven Anwendung wird diese Datei niemals
-- verändert oder rückwärts ausgeführt. Eine fachlich nötige Rücknahme erfolgt
-- ausschließlich als neue, versionierte Folgemigration samt eigenem Gate.
--
-- app_membership_writer ist eine NOLOGIN-Markerrolle ohne Tabellen-Ownership.
-- Unter den fachlich laufenden Diensten ist nur app_system Mitglied;
-- app_owner trägt den Marker für Migrationen und app_migrator erreicht ihn nur
-- über den bewusst erlaubten SET-ROLE-Pfad zum Owner. app_runtime ist nie
-- Mitglied.
-- Die normale Tabellen-ACL entzieht app_runtime Membership-DML bereits vor
-- RLS. Die Policies und der Statement-Trigger bleiben als unabhängiger
-- Drift-Backstop wirksam, falls später versehentlich ein DML-Grant zurückkehrt.
create policy membership_principal_insert on public.membership
  as restrictive
  for insert
  to public
  with check (
    pg_catalog.pg_has_role(
      current_user,
      'app_membership_writer',
      'MEMBER'
    )
  );
--> statement-breakpoint

create policy membership_principal_update on public.membership
  as restrictive
  for update
  to public
  using (
    pg_catalog.pg_has_role(
      current_user,
      'app_membership_writer',
      'MEMBER'
    )
  )
  with check (
    pg_catalog.pg_has_role(
      current_user,
      'app_membership_writer',
      'MEMBER'
    )
  );
--> statement-breakpoint

create policy membership_principal_delete on public.membership
  as restrictive
  for delete
  to public
  using (
    pg_catalog.pg_has_role(
      current_user,
      'app_membership_writer',
      'MEMBER'
    )
  );
--> statement-breakpoint

-- Der Statement-Trigger lehnt den falschen Principal auch bei einer
-- Nulltreffer-Mutation stabil mit 42501 ab. RLS allein könnte UPDATE/DELETE
-- ohne sichtbare Zielzeile als erfolgreichen No-op erscheinen lassen.
-- Lock-Reihenfolge und READ-COMMITTED-Vertrag aus 0018 bleiben unverändert.
create or replace function public.guard_membership_statement()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $$
declare
  v_workspace pg_catalog.uuid := nullif(
    pg_catalog.current_setting('app.workspace_id', true),
    ''
  )::pg_catalog.uuid;
begin
  if not pg_catalog.pg_has_role(
    current_user,
    'app_membership_writer',
    'MEMBER'
  ) then
    raise exception using
      errcode = '42501',
      message = 'membership DML requires the system principal';
  end if;

  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = '25001',
      message = 'membership DML requires READ COMMITTED isolation';
  end if;

  if v_workspace is null then
    raise exception using
      errcode = '42501',
      message = 'membership DML requires a workspace context';
  end if;

  perform 1
     from public.workspace as w
    where w.id = v_workspace
      for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'membership DML requires an existing workspace context';
  end if;

  return null;
end
$$;
