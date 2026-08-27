-- ═══════════════════════════════════════════════════════════════════════
-- reconcile_user_identity: Fehlermeldung im Konflikt-Zweig entschärfen.
--
-- Bisher meldete die Funktion im Konfliktfall:
--
--   'user_identity % ist bereits an auth_user % gekoppelt (angefragt: %)'
--
-- Damit war die Fehlermeldung selbst ein Auskunftskanal: wer die Funktion
-- aufrufen darf (in M0 die gemeinsame App-Rolle), konnte für eine geratene
-- E-Mail die BESTEHENDE auth_user_id auslesen — ohne je eine Zeile lesen zu
-- dürfen. Die Policies halten dicht, die Meldung nicht.
--
-- Neu: eine generische Meldung ohne E-Mail, ohne bestehende Kopplung, ohne
-- angefragten Wert. Dass der Aufruf fehlschlägt, lässt sich nicht verbergen —
-- die Operation MUSS scheitern —, aber welcher Zustand dahintersteckt, gibt
-- die Funktion nicht mehr preis.
--
-- Für die Diagnose bleibt der Fall über den Zeitpunkt des Fehlschlags und die
-- Audit-/Log-Seite nachvollziehbar; ein Wert gehört dort hin, nicht in eine
-- Meldung, die bis zum Aufrufer durchgereicht wird.
--
-- ── Mechanik: Ersetzen einer Funktion, die uns nicht mehr gehört ────────
-- Seit drizzle/0015 gehört die Funktion der Rolle identity_reconciler, und die
-- Migrationsrolle kann per SET ROLE nicht mehr hinein (`set false`). Genau
-- diesen Fall hat der Kommentar in 0015 angekündigt: wer die Funktion ändert,
-- muss sich die Mitgliedschaft vorher mit SET-Recht verschaffen und sie danach
-- wieder abgeben. Das ist hier der Ablauf — Vorlage für jede künftige Migration
-- an dieser Funktion.
--
-- `create or replace function` erhält Eigentümer UND Rechte der bestehenden
-- Funktion; der EXECUTE-Entzug von PUBLIC aus 0015 bleibt also bestehen (als
-- Test festgehalten).
-- ═══════════════════════════════════════════════════════════════════════

do $mig$
declare
  v_app name := current_user;
begin
  execute format('grant identity_reconciler to %I with inherit false, set true', v_app);
  grant create on schema public to identity_reconciler;
  set role identity_reconciler;

  create or replace function reconcile_user_identity(p_email text, p_auth_user_id text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $fn$
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
      -- Gleiche Kopplung -> idempotenter No-op. Fremde Kopplung -> Fehler,
      -- und zwar OHNE zu verraten, an wen.
      select id, auth_user_id into v_id, v_linked
        from user_identity where lower(email) = v_email;
      if v_linked is distinct from p_auth_user_id then
        raise exception 'identity already linked';
      end if;
    end if;

    perform set_config('app.identity_reconcile_email', '', true);
    return v_id;
  end
  $fn$;

  reset role;
  revoke create on schema public from identity_reconciler;
  execute format('grant identity_reconciler to %I with inherit false, set false', v_app);
end
$mig$;
