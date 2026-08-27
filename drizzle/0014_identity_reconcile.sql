-- ═══════════════════════════════════════════════════════════════════════
-- F11: idempotenter, ENG PRIVILEGIERTER Identity-Reconcile.
--
-- Ersetzt den Plain-Insert im Auth-Hook (lib/auth.ts). Zu leisten ist:
-- existiert lower(email) bereits (z. B. aus einer M1-Einladung), wird
-- auth_user_id nachgetragen; sonst wird die Identität angelegt. Zweimal
-- aufrufen ändert nichts; eine bereits ANDERS gekoppelte Identität ist ein
-- Fehler, kein stilles Überschreiben.
--
-- ── Warum SECURITY DEFINER ALLEIN nicht reicht ─────────────────────────
-- Die naheliegende Route ("SECURITY-DEFINER-Funktion, dem Tabellen-Owner
-- gehörend, umgeht die Policies") ist FALSCH und wurde vor dem Bau empirisch
-- widerlegt. `user_identity` läuft mit FORCE ROW LEVEL SECURITY, und FORCE
-- bedeutet exakt: die Policies gelten AUCH für den Tabellen-Owner
-- (PostgreSQL 17, ALTER TABLE … FORCE ROW LEVEL SECURITY). SECURITY DEFINER
-- verschiebt nur `current_user` auf den Funktions-Owner — das ist hier der
-- Tabellen-Owner, also ändert sich nichts. Messung gegen die embedded-DB:
--
--   owner-select   (RLS FORCE, using false)        -> 0 Zeilen
--   owner-update   (keine UPDATE-Policy)           -> rowcount 0
--   SECDEF-select  (Owner = Tabellen-Owner)        -> 0 Zeilen
--   SECDEF-update  (Owner = Tabellen-Owner)        -> rowcount 0
--
-- RLS umgehen können nur Superuser und BYPASSRLS-Rollen — beides ist in
-- diesem Projekt hart verboten (scripts/migrate.mts). Es führt also KEIN Weg
-- an Policies vorbei; die Frage ist nur, wie ENG sie gefasst sind.
--
-- ── Der gewählte Schnitt ───────────────────────────────────────────────
-- Zwei zusätzliche Policies, die ein Fenster von der Breite EINER E-MAIL
-- öffnen, und zwar nur außerhalb jedes Mandantenkontexts:
--
--   * gebunden an `app.identity_reconcile_email`. Diesen Parameter setzt die
--     Funktion selbst per set_config(..., is_local => true), also TRANSAKTIONS-
--     LOKAL. Nach dem Funktionsende (bzw. spätestens mit der Transaktion) ist
--     das Fenster wieder zu — nachgemessen, siehe Test.
--   * zusätzlich gebunden an `app.workspace_id IS NULL`. Jeder normale
--     Request-Pfad läuft in withTenant/withAuthorizedTenant und hat den
--     Mandantenparameter gesetzt; aus einer Mandantentransaktion heraus ist
--     das Fenster damit grundsätzlich verschlossen. Die Funktion prüft das
--     zusätzlich selbst und wirft mit klarer Meldung.
--   * `nullif(…, '')` ist Pflicht, nicht Kosmetik: auf einer wiederverwendeten
--     Pool-Verbindung fällt ein gesetzter Parameter auf '' zurück, nicht auf
--     NULL (siehe drizzle/0001_rls_core.sql).
--
-- Beide Policies sind PERMISSIVE und werden mit der bestehenden
-- membership-basierten SELECT-Policy ODER-verknüpft. Das ist hier gewollt und
-- unschädlich, weil das Prädikat die Zeile bereits auf die eine E-Mail
-- festnagelt, die der Aufrufer ohnehin kennt. `user_identity` ist keine
-- Mandantentabelle (TENANT_EXEMPT), der Policy-Vertrag aus
-- drizzle/0013_rls_policy_contract.sql ("genau eine permissive Policy") gilt
-- für sie nicht.
--
-- ── Was das Fenster NICHT aufmacht ─────────────────────────────────────
-- Der Trigger user_identity_link_auth_only (drizzle/0011) wirkt unabhängig von
-- RLS und wird durch die neue UPDATE-Policy erstmals ERREICHBAR — genau als
-- was er dort angekündigt war. Er erzwingt weiterhin: id, email und created_at
-- unveränderlich, auth_user_id genau EINMAL setzbar, kein Re-Pointing.
--
-- ── Restrisiko und Härtungspunkt (ADR 0003) ────────────────────────────
-- In der M0-Rollenlage gibt es genau EINE Datenbankrolle. Wer SQL auf dieser
-- Verbindung ausführen kann, kann den Parameter selbst setzen und damit eine
-- noch ungekoppelte Identität an einen eigenen auth_user hängen. Bewertung:
-- (a) dieselbe Verbindung ist heute Tabellen-Owner und dürfte ohnehin DDL —
--     das Restrisiko ist gegenüber dem Status quo nicht neu;
-- (b) `user_identity_insert` erlaubt bereits `with check (true)`, also das
--     Anlegen beliebiger Identitäten.
-- Die Härtung ist deshalb keine Policy-Frage, sondern die Rollentrennung:
-- sobald ADR 0003 umgesetzt ist, laufen beide Policies auf `TO app_owner`
-- (die Funktion läuft unter SECURITY DEFINER als app_owner; app_runtime und
-- app_auth erreichen das Fenster dann nicht mehr), und das EXECUTE-Recht wird
-- von PUBLIC auf app_auth verengt. Beide Schritte stehen als ausführbares SQL
-- in docs/adr/0003-db-rollen-trennung.md.
-- ═══════════════════════════════════════════════════════════════════════

create policy user_identity_reconcile_select on user_identity for select
  using (
    nullif(current_setting('app.workspace_id', true), '') is null
    and lower(email) = nullif(current_setting('app.identity_reconcile_email', true), '')
  );
--> statement-breakpoint

create policy user_identity_reconcile_update on user_identity for update
  using (
    nullif(current_setting('app.workspace_id', true), '') is null
    and lower(email) = nullif(current_setting('app.identity_reconcile_email', true), '')
  )
  with check (
    nullif(current_setting('app.workspace_id', true), '') is null
    and lower(email) = nullif(current_setting('app.identity_reconcile_email', true), '')
  );
--> statement-breakpoint

-- Der Reconcile selbst läuft als EIN Statement: `on conflict (lower(email))
-- do update` mit SPEZIFIZIERTEM Arbiter. Damit ist der Wettlauf zwischen einer
-- parallel angelegten Einladung und dem Erst-Login atomar entschieden, ohne
-- Lese-dann-Schreib-Fenster.
--
-- Korrektur einer Fehlannahme aus der vorigen Fix-Welle: dort stand, PostgreSQL
-- verlange bei JEDEM `on conflict` — auch `do nothing` — die Sichtbarkeit der
-- kollidierenden Zeile. Das stimmt so nicht. Die SELECT-Prüfung greift bei
-- `do nothing` nur mit SPEZIFIZIERTEM Arbiter (`on conflict (…) do nothing`);
-- targetloses `on conflict do nothing` — das, was Drizzles
-- `.onConflictDoNothing()` ohne `target` erzeugt — prüft sie nicht. Der wahre
-- Defekt war ein anderer: ein Plain-Insert (und ebenso ein `do nothing`) kann
-- eine BESTEHENDE Identität nicht koppeln, und `do update` scheiterte an der
-- fehlenden UPDATE-Policy. Genau die fehlt jetzt nicht mehr.
create or replace function reconcile_user_identity(p_email text, p_auth_user_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text;
  v_id     uuid;
  v_linked text;
begin
  if p_email is null or btrim(p_email) = '' then
    raise exception 'reconcile_user_identity: p_email ist pflicht';
  end if;
  if p_auth_user_id is null or btrim(p_auth_user_id) = '' then
    raise exception 'reconcile_user_identity: p_auth_user_id ist pflicht';
  end if;
  if nullif(current_setting('app.workspace_id', true), '') is not null then
    raise exception
      'reconcile_user_identity laeuft nur ausserhalb eines Mandantenkontexts (app.workspace_id ist gesetzt)';
  end if;

  v_email := lower(p_email);
  perform set_config('app.identity_reconcile_email', v_email, true);

  insert into user_identity (id, email, auth_user_id)
  values (gen_random_uuid(), v_email, p_auth_user_id)
  on conflict (lower(email)) do update
     set auth_user_id = excluded.auth_user_id
   where user_identity.auth_user_id is null
  returning id into v_id;

  if v_id is null then
    -- Kein Treffer heißt: die Zeile existiert und ist bereits gekoppelt.
    -- Gleiche Kopplung -> idempotenter No-op. Fremde Kopplung -> Fehler.
    select id, auth_user_id into v_id, v_linked
      from user_identity where lower(email) = v_email;
    if v_linked is distinct from p_auth_user_id then
      raise exception
        'user_identity % ist bereits an auth_user % gekoppelt (angefragt: %)',
        v_email, coalesce(v_linked, '<null>'), p_auth_user_id;
    end if;
  end if;

  perform set_config('app.identity_reconcile_email', '', true);
  return v_id;
end $$;
--> statement-breakpoint

comment on function reconcile_user_identity(text, text) is
  'Idempotente Kopplung user_identity.auth_user_id <- better-auth. SECURITY DEFINER; '
  'arbeitet durch die eng gefassten Policies user_identity_reconcile_select/_update, '
  'weil FORCE ROW LEVEL SECURITY auch fuer den Tabellen-Owner gilt. '
  'HAERTUNGSPUNKT (ADR 0003): EXECUTE ist in M0 bewusst noch bei PUBLIC, weil es nur '
  'eine Datenbankrolle gibt. Mit der Rollentrennung gilt: '
  'revoke execute on function reconcile_user_identity(text, text) from public; '
  'grant execute on function reconcile_user_identity(text, text) to app_auth; '
  'und beide Policies werden auf TO app_owner verengt.';
