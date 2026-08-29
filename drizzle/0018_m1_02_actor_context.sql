-- M1-02: Der verifizierte Nutzer-Akteur wird transaktionslokal neben dem
-- Workspace-Kontext sichtbar. Custom-GUCs sind Kontexttransport, keine
-- Authentifizierung; die Trust Boundary ist in ADR 0004 dokumentiert.
create or replace function public.app_actor_id()
returns pg_catalog.uuid
language sql
stable
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select nullif(pg_catalog.current_setting('app.actor_id', true), '')::pg_catalog.uuid
$$;
--> statement-breakpoint

-- Erste, unabhängige Schranke: Actor-Pfade dürfen die eigene Membership
-- weder anlegen noch verändern oder löschen. Der NULL-Fall ist der explizite
-- System-/Recovery-Pfad; die normale Tenant-RLS bleibt zusätzlich aktiv.
create policy membership_actor_insert on public.membership
  as restrictive
  for insert
  with check (
    public.app_actor_id() is null
    or user_id <> public.app_actor_id()
  );
--> statement-breakpoint
create policy membership_actor_update on public.membership
  as restrictive
  for update
  using (
    public.app_actor_id() is null
    or user_id <> public.app_actor_id()
  )
  with check (
    public.app_actor_id() is null
    or user_id <> public.app_actor_id()
  );
--> statement-breakpoint
create policy membership_actor_delete on public.membership
  as restrictive
  for delete
  using (
    public.app_actor_id() is null
    or user_id <> public.app_actor_id()
  );
--> statement-breakpoint

-- Actorbasierte Membership-Mutationen müssen vor JEDEM Zielzeilen-Lock über
-- dieselbe Workspace-Zeile serialisiert werden. Ein Lock erst im Row-Trigger
-- könnte bei gegenseitigem Admin-DELETE die jeweils andere Membership-Zeile
-- schon halten und dadurch einen Deadlock erzeugen.
--
-- READ COMMITTED ist Teil des Sicherheitsvertrags: Unter REPEATABLE READ kann
-- ein vor dem Warten erzeugter Snapshot eine inzwischen gelöschte oder
-- herabgestufte Actor-Membership weiter sehen. Verwaltete App-Transaktionen
-- setzen diese Isolation als erste Anweisung; direkte DB-Aufrufe werden hier
-- fail-closed abgelehnt.
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
--> statement-breakpoint

create trigger membership_dml_serialize
before insert or update or delete on public.membership
for each statement execute function public.guard_membership_statement();
--> statement-breakpoint

-- Zweite Schranke: vollständige Autorisierung jeder Membership-Mutation.
-- SECURITY INVOKER ist wesentlich: die Rollenprüfung bleibt unter derselben
-- FORCE-RLS-Tenant-Grenze wie die auslösende Operation.
create or replace function public.guard_membership_dml()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $$
declare
  v_actor pg_catalog.uuid := public.app_actor_id();
  v_workspace pg_catalog.uuid;
  v_actor_role pg_catalog.text;
begin
  -- Membership-Identität ist unveränderlich, auch auf Systempfaden. Ein
  -- kontrollierter Transfer ist DELETE+INSERT oder eine eigene Migration.
  if tg_op = 'UPDATE'
     and (new.id is distinct from old.id
          or new.workspace_id is distinct from old.workspace_id
          or new.user_id is distinct from old.user_id
          or new.created_at is distinct from old.created_at) then
    raise exception using
      errcode = '42501',
      message = 'membership identity columns are immutable';
  end if;

  -- Actorlos ist ausschließlich der dokumentierte Bootstrap-/Recovery-Pfad.
  -- Die Tenant-RLS prüft workspace_id weiterhin in USING und WITH CHECK.
  if v_actor is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Defense in depth hinter den restriktiven Policies. INSERT, UPDATE und
  -- DELETE werden getrennt behandelt, damit OLD/NEW nie implizit benutzt wird.
  if tg_op = 'INSERT' then
    if new.user_id = v_actor then
      raise exception using
        errcode = '42501',
        message = 'membership self-mutation is not permitted';
    end if;
    v_workspace := new.workspace_id;
  elsif tg_op = 'DELETE' then
    if old.user_id = v_actor then
      raise exception using
        errcode = '42501',
        message = 'membership self-mutation is not permitted';
    end if;
    v_workspace := old.workspace_id;
  else
    if old.user_id = v_actor or new.user_id = v_actor then
      raise exception using
        errcode = '42501',
        message = 'membership self-mutation is not permitted';
    end if;
    v_workspace := new.workspace_id;
  end if;

  -- Der BEFORE-STATEMENT-Trigger hat die Workspace-Zeile bereits gesperrt,
  -- bevor PostgreSQL irgendeine Ziel-Membership sperren konnte. Die Actor-
  -- Membership wird bewusst nur gelesen: FOR SHARE würde zusätzlich die
  -- restriktive UPDATE-Policy anwenden und damit die eigene Zeile ausblenden.
  select m.role
    into v_actor_role
    from public.membership as m
   where m.workspace_id = v_workspace
     and m.user_id = v_actor;

  if v_actor_role is distinct from 'admin' then
    raise exception using
      errcode = '42501',
      message = 'membership mutation requires an admin in the target workspace';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
--> statement-breakpoint

create trigger membership_dml_guard
before insert or update or delete on public.membership
for each row execute function public.guard_membership_dml();
