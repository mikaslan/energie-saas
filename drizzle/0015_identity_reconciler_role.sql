-- ═══════════════════════════════════════════════════════════════════════
-- F11, zweiter Schnitt: das Reconcile-Fenster hängt nicht mehr an einem
-- frei setzbaren GUC, sondern an einer DEFINER-ROLLE.
--
-- Befund des Finalchecks gegen drizzle/0014: die beiden Fenster-Policies
-- galten `TO PUBLIC`. Damit konnte JEDER SQL-Caller `app.workspace_id`
-- leeren, `app.identity_reconcile_email` selbst setzen und darüber fremde
-- Identitäten lesen bzw. eine noch ungekoppelte Identität claimen. Der GUC
-- war der einzige Türsteher, und er ließ jeden herein, der ihn kannte.
-- Ebenso war `EXECUTE` auf die Funktion öffentlich.
--
-- ── Der Umbau ──────────────────────────────────────────────────────────
-- 1. Eine eigene Rolle `identity_reconciler`: NOLOGIN, besitzt keine Tabelle,
--    ist NICHT Owner von user_identity. FORCE RLS greift für sie also ganz
--    normal — sie ist keine Hintertür, sondern nur ein NAME, an den sich
--    Policies binden lassen.
-- 2. Beide Fenster-Policies gelten jetzt `TO identity_reconciler` UND tragen
--    zusätzlich `current_user = 'identity_reconciler'` im Prädikat.
-- 3. Die Funktion gehört dieser Rolle und bleibt SECURITY DEFINER. Nur
--    WÄHREND ihres Laufs ist `current_user` = identity_reconciler, nur dann
--    existiert das Fenster überhaupt.
-- 4. `EXECUTE` wird PUBLIC entzogen und gezielt an die aufrufende App-Rolle
--    vergeben.
--
-- Der GUC-Mechanismus aus 0014 BLEIBT — aber als zweiter Gürtel: er verengt
-- das Fenster innerhalb des Funktionslaufs auf genau eine E-Mail und genau
-- eine Transaktion. Er ist nicht mehr das, was den Fremden draußen hält.
--
-- ── Warum die Mitgliedschaft nicht durchschlägt (nachgemessen, PG 18) ───
-- Wer die Rolle anlegt, wird von PostgreSQL automatisch Mitglied
-- (admin_option = true, inherit_option = false, set_option = false). Seit
-- PG 16 ist die Vererbung pro Mitgliedschaft schaltbar, und RLS wertet
-- ausschließlich die VERERBBARE Mitgliedschaft aus. Mit `inherit false`
-- greift eine Policy `TO identity_reconciler` also NICHT für das Mitglied.
-- Zusätzlich verhindert `set false`, dass sich die App-Rolle per SET ROLE in
-- die Definer-Rolle setzt. Gemessen gegen die embedded-DB:
--
--   app_test setzt den GUC selbst und liest user_identity  -> 0 Zeilen
--   app_test claimt per UPDATE                             -> 0 Zeilen
--   app_test macht SET ROLE identity_reconciler            -> permission denied
--   Aufruf der SECURITY-DEFINER-Funktion                   -> funktioniert
--
-- Das `set true` weiter unten ist deshalb NUR für die Dauer dieses
-- Migrationsschritts gesetzt: `ALTER FUNCTION … OWNER TO` verlangt seit
-- PG 16, dass der Ausführende in die neue Owner-Rolle wechseln KÖNNTE. Am
-- Ende des DO-Blocks wird es wieder abgeräumt.
--
-- ── Voraussetzung an die Migrationsrolle ───────────────────────────────
-- Sie braucht `CREATEROLE` und muss Eigentümerin des Schemas `public` sein
-- (letzteres, weil der neue Funktions-Owner kurzzeitig CREATE auf `public`
-- braucht). Beides ist unbedenklich für die RLS-Zusage: seit PG 16 kann eine
-- CREATEROLE-Rolle weder SUPERUSER noch BYPASSRLS verleihen, wenn sie es
-- nicht selbst hat — nachgemessen, beides scheitert mit „permission denied
-- to create role". Das Gate in scripts/migrate.mts bleibt damit tragfähig.
-- Siehe docs/adr/0003-db-rollen-trennung.md, Block 1/2.
--
-- Rollen sind CLUSTER-global, nicht datenbankgebunden. Das Anlegen ist
-- deshalb idempotent formuliert; existiert die Rolle bereits aus einer
-- anderen Datenbank desselben Clusters, wird sie wiederverwendet.
-- ═══════════════════════════════════════════════════════════════════════

-- REIHENFOLGE IST HIER TRAGEND, und zwar aus einem nicht offensichtlichen
-- Grund: `ALTER … OWNER TO` schreibt die ACL um (aclnewowner) und ersetzt dabei
-- alle Einträge des ALTEN Eigentümers durch den neuen. Ein vor dem Wechsel
-- erteiltes `grant execute … to <App-Rolle>` verschwindet dadurch spurlos, wenn
-- App-Rolle und alter Eigentümer dieselbe sind — genau der Fall in M0.
-- Deshalb: erst Eigentümer wechseln, dann per SET ROLE als neuer Eigentümer
-- kommentieren und die Rechte setzen, dann die Rolle wieder abgeben.
do $$
declare
  v_app name := current_user;
begin
  if not exists (select 1 from pg_roles where rolname = 'identity_reconciler') then
    create role identity_reconciler nologin nosuperuser nobypassrls;
  end if;

  -- USAGE MUSS hier stehen, nicht weiter unten: sobald der Block per SET ROLE
  -- als identity_reconciler arbeitet, muss diese Rolle `public` im search_path
  -- auflösen können. In einer Datenbank, in der `revoke all on schema public
  -- from public` bereits gelaufen ist (ADR 0003, Block 2), scheitert der Block
  -- sonst mit „function reconcile_user_identity(text, text) does not exist".
  grant usage on schema public to identity_reconciler;

  -- Nur für diesen Migrationsschritt: SET-Recht, damit ALTER … OWNER TO greift
  -- (PG 16+ verlangt, dass der Ausführende in die neue Owner-Rolle wechseln
  -- könnte) und damit die Rechte unten als neuer Eigentümer gesetzt werden
  -- können.
  execute format('grant identity_reconciler to %I with inherit false, set true', v_app);

  -- (a) Eigentümerwechsel. Der neue Owner braucht CREATE auf dem Schema der
  -- Funktion — ebenfalls nur für die Dauer dieses Schritts.
  grant create on schema public to identity_reconciler;
  alter function reconcile_user_identity(text, text) owner to identity_reconciler;
  revoke create on schema public from identity_reconciler;

  -- (b) als neuer Eigentümer: EXECUTE gehört nicht der Welt. In M0 gibt es
  -- genau eine App-Rolle, und das ist dieselbe, die migriert; nach der
  -- Rollentrennung ist es app_auth (ADR 0003, Block 4).
  set role identity_reconciler;
  revoke execute on function reconcile_user_identity(text, text) from public;
  execute format('grant execute on function reconcile_user_identity(text, text) to %I', v_app);

  comment on function reconcile_user_identity(text, text) is
    'Idempotente Kopplung user_identity.auth_user_id <- better-auth. SECURITY DEFINER, '
    'Owner ist die eigens dafuer angelegte Rolle identity_reconciler (NOLOGIN, besitzt '
    'sonst nichts). Nur waehrend des Funktionslaufs ist current_user diese Rolle und nur '
    'dann greifen die Policies user_identity_reconcile_select/_update. EXECUTE ist nicht '
    'oeffentlich. Nach der Rollentrennung (ADR 0003, Block 4) ist der einzige Aufrufer '
    'app_auth. Aendert eine kuenftige Migration diese Funktion, muss sie sich die '
    'Mitgliedschaft in identity_reconciler vorher wieder mit SET-Recht verschaffen.';
  reset role;

  -- (c) Fenster wieder zu: keine Vererbung (RLS-Policies greifen nicht für die
  -- App-Rolle) und kein SET ROLE (die Definer-Rolle ist nicht annehmbar).
  execute format('grant identity_reconciler to %I with inherit false, set false', v_app);
end $$;
--> statement-breakpoint

-- Die Definer-Rolle braucht die Tabelle überhaupt anfassen zu dürfen. GRANTs
-- und RLS sind orthogonal: diese Rechte erlauben den Zugriff, die Policies
-- unten begrenzen ihn auf das Fenster. DELETE steht bewusst nicht dabei.
grant select, insert, update on user_identity to identity_reconciler;
--> statement-breakpoint

-- membership: NICHT weil die Definer-Rolle Mitgliedschaften bräuchte, sondern
-- weil die bestehende Policy `user_identity_select` (drizzle/0002) für PUBLIC
-- gilt und in ihrem Prädikat auf `membership` zugreift. PostgreSQL verlangt das
-- Leserecht, um den Ausdruck überhaupt auswerten zu dürfen — auch wenn er
-- garantiert `false` liefert. Das Recht bringt der Rolle nichts: `membership`
-- trägt selbst tenant_isolation, und die Funktion läuft per Konstruktion ohne
-- app.workspace_id, sieht dort also null Zeilen (als Test festgehalten).
grant select on membership to identity_reconciler;
--> statement-breakpoint

-- Policies aus 0014 auf die Definer-Rolle verengen. `alter policy … to …`
-- ändert nur den Adressatenkreis; das Prädikat wird zusätzlich um die exakte
-- Identitätsprüfung ergänzt, damit eine versehentlich später erteilte
-- vererbbare Mitgliedschaft das Fenster nicht doch aufstößt.
alter policy user_identity_reconcile_select on user_identity
  to identity_reconciler
  using (
    current_user = 'identity_reconciler'
    and nullif(current_setting('app.workspace_id', true), '') is null
    and lower(email) = nullif(current_setting('app.identity_reconcile_email', true), '')
  );
--> statement-breakpoint

alter policy user_identity_reconcile_update on user_identity
  to identity_reconciler
  using (
    current_user = 'identity_reconciler'
    and nullif(current_setting('app.workspace_id', true), '') is null
    and lower(email) = nullif(current_setting('app.identity_reconcile_email', true), '')
  )
  with check (
    current_user = 'identity_reconciler'
    and nullif(current_setting('app.workspace_id', true), '') is null
    and lower(email) = nullif(current_setting('app.identity_reconcile_email', true), '')
  );
--> statement-breakpoint
