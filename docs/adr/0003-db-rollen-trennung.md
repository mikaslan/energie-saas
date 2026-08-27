# ADR 0003: Datenbank-Rollentrennung — Known-Limitation für M0

Datum: 2026-08-26 · Status: akzeptiert (als Known-Limitation für M0)
· Überarbeitet: 2026-08-27 (Grant-Skizze ausführbar gemacht, Codex-Re-Review)

## Kontext

Migrationen, Web-App, better-auth und der Worker teilen sich aktuell einen einzigen
`POSTGRES_URL`. Die Runtime-Rolle wird dadurch beim Migrationslauf **Eigentümerin aller
Tabellen** (`scripts/migrate.mts`). Das ist der Befund aus dem Codex-Ultra-Review
(Severity: Important, `scripts/migrate.mts:31`).

Was heute bereits richtig ist und **nicht** aufgeweicht werden darf:

- Die Rolle ist weder Superuser noch `BYPASSRLS`; `scripts/migrate.mts` bricht sonst hart
  ab (kein Override-Flag). Ein Superuser würde RLS bedingungslos umgehen.
- Alle Mandantentabellen laufen mit `FORCE ROW LEVEL SECURITY`, das gilt **auch für den
  Eigentümer**.
- `domain_events` und `audit_log` sind zusätzlich per Trigger append-only, inklusive
  eines statement-level TRUNCATE-Triggers (`drizzle/0005`) — Trigger wirken unabhängig
  von RLS und auch gegen den Eigentümer.

Was trotzdem offen bleibt: der Eigentümer darf **DDL** ausführen. Er kann also

- `ALTER TABLE … DISABLE ROW LEVEL SECURITY` oder `NO FORCE` setzen,
- Policies droppen oder durch permissive Varianten ersetzen,
- Trigger droppen und danach `TRUNCATE`/`UPDATE` auf den append-only-Tabellen fahren,
- fremde Spalten/Constraints entfernen.

Ein kompromittierter App-Prozess (SQL-Injection, ausgenutzte Dependency, geleaktes
Runtime-Secret) hat damit einen Weg, die gesamte Mandantengrenze abzuschalten, statt nur
Daten des eigenen Mandanten zu sehen. Die Sicherheitsgarantie ist damit korrekt
implementiert, aber nicht **strukturell** abgesichert.

## Entscheidung

Für **M0 wird das bewusst akzeptiert**: es gibt keine Produktionsdaten, keinen
Pilotkunden und keinen öffentlich erreichbaren Mandantenendpunkt. Der Aufwand einer
sauberen Rollentrennung gehört an den Punkt, an dem die Zieldatenbank (Neon) real
aufgesetzt wird — dort werden Rollen und Grants ohnehin einmalig eingerichtet.

**Bindende Frist: die Trennung ist VOR dem ersten Pilotkunden beim Neon-Setup
umzusetzen.** Sie ist kein „nice to have" der späteren Milestones.

### Zwei Dinge, die man beim Lesen der Grants nicht verwechseln darf

Die vorige Fassung dieser Skizze war in sich widersprüchlich, weil beides
durcheinanderging. Deshalb vorweg:

1. **GRANTs und RLS sind orthogonal.** Ein `GRANT SELECT` sagt nur, ob die Rolle die
   Tabelle überhaupt anfassen darf. Ob sie danach Zeilen SIEHT, entscheiden allein die
   Policies. Ein Grant überwindet keine Policy, und eine Policy ersetzt keinen Grant —
   man braucht beides. Konkret: `app_auth` bekäme mit einem `GRANT SELECT ON
   user_identity` trotzdem **null Zeilen** zurück, weil `user_identity_select` eine
   Membership verlangt und `FORCE ROW LEVEL SECURITY` das auch gegen den Eigentümer
   durchsetzt. Genau deshalb läuft die Identity-Kopplung über eine SECURITY-DEFINER-
   Funktion (siehe unten), nicht über einen Grant.
2. **`app_runtime` bleibt unter FORCE RLS — das ist gewollt.** Die Rollentrennung
   ersetzt die Mandantenisolation nicht, sie ergänzt sie um eine zweite, strukturelle
   Schranke: `app_runtime` darf kein DDL mehr, kann die Policies also nicht mehr
   abschalten.

### Zielbild der Rollen

| Rolle | Login | Zweck | Rechte |
| --- | --- | --- | --- |
| `app_owner` | **NOLOGIN** | Eigentümerin von Schema **und** Tabellen; Ziel von `SET ROLE` im Migrationslauf | DDL in `public`; wird von keinem laufenden Dienst direkt benutzt |
| `app_migrator` | ja | führt `scripts/migrate.mts` aus | ausschließlich `SET ROLE app_owner` (Mitgliedschaft ohne Vererbung); sonst keine Rechte |
| `app_runtime` | ja | Next.js-Portal (`withTenant`/`withAuthorizedTenant`) | tabellen-spezifisches DML auf den Domänentabellen; **kein** DDL, **kein** TRUNCATE, **kein** Zugriff auf `auth_*`; unterliegt weiterhin FORCE RLS |
| `app_auth` | ja | ausschließlich better-auth (`lib/db/auth-client.ts`, `POSTGRES_URL_AUTH`) | DML auf `auth_*` + `EXECUTE` auf `reconcile_user_identity`; **kein** Zugriff auf Domänentabellen |
| `app_worker` | ja | pg-boss-Worker (`POSTGRES_URL_WORKER`) | Eigentümer des Schemas `pgboss`; Domänenrechte nur explizit pro Job-Klasse; **kein** DDL in `public` |
| `identity_reconciler` | **NOLOGIN** | Eigentümerin der SECURITY-DEFINER-Funktion `reconcile_user_identity`; von `drizzle/0015` angelegt, nicht hier | `SELECT/INSERT/UPDATE` auf `user_identity`, `SELECT` auf `membership`; besitzt **keine** Tabelle; laufende Dienste können sie nicht annehmen (siehe Einschränkung unten) |

### Wer `identity_reconciler` annehmen kann — und wer nicht

Eine frühere Fassung dieses Dokuments behauptete, die Rolle sei „von niemandem
annehmbar". Das ist **falsch** und wird hier richtiggestellt.

Die Mitgliedschaften der laufenden Dienste stehen auf `inherit false, set false`
(`drizzle/0015`): `app_runtime`, `app_auth` und `app_worker` können weder die Policies
der Rolle erben noch per `SET ROLE` in sie hineinwechseln — das ist nachgemessen
(*permission denied to set role*) und der Kern der Härtung.

**Wer die Rolle anlegt, behält aber `ADMIN OPTION`** und kann sich damit jederzeit wieder
`SET TRUE` erteilen und die Rolle annehmen. Das ist keine Lücke, sondern die normale
PostgreSQL-Semantik, und es ist auch nötig: genau über diesen Weg ändert eine spätere
Migration die Funktion (Vorlage: `drizzle/0016`). Praktisch heißt das:

- **Heute (M0, eine gemeinsame Rolle):** die App-Rolle ist zugleich die Migrationsrolle
  und damit Erstellerin von `identity_reconciler`. Sie kann sich die Rolle
  zurückverschaffen. Das Reconcile-Fenster ist gegen einen *versehentlichen* oder
  *eingeschleusten* SQL-Aufruf geschützt, nicht gegen jemanden, der die Verbindung
  vollständig kontrolliert — der ist ohnehin Tabelleneigentümer und darf DDL.
- **Nach der Rollentrennung:** Erstellerin ist `app_owner` (NOLOGIN, nur im
  Migrationsjob per `SET ROLE` erreichbar). Die Dienste, die dauerhaft am Netz hängen,
  sind es nicht.

Damit ist die Aussage tragfähig, die dieses ADR wirklich stützt: **die Definer-Rolle ist
für keinen laufenden Dienst annehmbar**, sobald die Trennung steht — und bis dahin fällt
sie mit allem anderen unter die hier dokumentierte Limitation.

### Restrisiko F11 in M0: `EXECUTE` liegt bei der gemeinsamen App-Rolle

`drizzle/0015` entzieht `EXECUTE` auf `reconcile_user_identity` dem PUBLIC und vergibt es
gezielt an die migrierende Rolle. In M0 ist das dieselbe Rolle, mit der die Anwendung
arbeitet — die Funktion ist damit von der App-Verbindung **direkt aufrufbar**, auch
außerhalb des Auth-Hooks. Ein Aufrufer kann so für eine bereits bekannte E-Mail einen
Kopplungsversuch unternehmen; die Funktion verrät ihm dabei nichts über den bestehenden
Zustand (`drizzle/0016`: generische Fehlermeldung), aber sie ist erreichbar.

**Das ist kein eigener offener Punkt, sondern ein Aspekt genau dieser
Rollentrennungs-Limitation** und wird mit ihr geschlossen: Block 4 unten hängt `EXECUTE`
von der Migrationsrolle auf `app_auth` um und entzieht es `app_owner` — ab dann ist die
Funktion ausschließlich über die Auth-Verbindung erreichbar, nicht über die
Portal-Verbindung. Es gilt dieselbe bindende Frist: **vor dem ersten Pilotkunden.**

### Block 1 — Rollen (einmalig, als Rolle mit `CREATEROLE`)

```sql
-- createrole: drizzle/0015 legt die Definer-Rolle identity_reconciler an.
-- Unbedenklich für die RLS-Zusage — seit PG 16 kann eine CREATEROLE-Rolle
-- weder SUPERUSER noch BYPASSRLS verleihen, wenn sie es nicht selbst hat.
create role app_owner    nologin nosuperuser nobypassrls createrole;
create role app_migrator login password :'migrator_pw' nosuperuser nobypassrls;
create role app_runtime  login password :'runtime_pw'  nosuperuser nobypassrls;
create role app_auth     login password :'auth_pw'     nosuperuser nobypassrls;
create role app_worker   login password :'worker_pw'   nosuperuser nobypassrls;

-- inherit false: app_migrator trägt die Owner-Rechte NICHT ständig mit sich
-- herum, sondern muss sie mit SET ROLE bewusst annehmen (PostgreSQL 16+).
grant app_owner to app_migrator with inherit false, set true;
```

### Block 2 — Ownership und Sichtbarkeit (einmalig)

```sql
alter schema public owner to app_owner;

-- Niemand außer app_owner legt in public etwas an.
revoke all on schema public from public;
grant  usage on schema public to app_runtime, app_auth, app_worker;

-- Migrationen legen bei Bedarf neue Schemata an (u. a. "drizzle" für die
-- Migrationsbuchhaltung).
grant create on database :"dbname" to app_owner;

-- pg-boss legt seine Tabellen selbst an und soll dafür kein Recht in public
-- brauchen: es bekommt ein eigenes Schema, das ihm gehört.
create schema if not exists pgboss authorization app_worker;
```

### Block 3 — Migrationslauf als `app_owner`, ohne Codeänderung

`scripts/migrate.mts` liest `POSTGRES_URL_MIGRATE ?? POSTGRES_URL` — die Variable unten
ist also die, die der Code tatsächlich auswertet, keine Erzählung. Die Rollenannahme
steckt in der Verbindungszeichenkette des Migrationsjobs:

```
POSTGRES_URL_MIGRATE=postgres://app_migrator:…@host/db?options=-c%20role%3Dapp_owner
```

Der `options`-Parameter wird im Startup-Paket mitgeschickt und setzt `role` für die
gesamte Sitzung; alle in der Migration erzeugten Objekte gehören danach `app_owner`.
Das Safety-Gate in `scripts/migrate.mts` prüft `current_user` — nach `SET ROLE` ist das
`app_owner`, und die Rolle ist `nosuperuser`/`nobypassrls`, das Gate greift also
unverändert.

### Block 4 — Grant-Skript, **nach jeder Migration** auszuführen

Bewusst **keine** `alter default privileges`-Blankets. Ein Blanket-Default auf alle
künftigen `public`-Tabellen hätte `app_runtime` automatisch DML auf jede neue Tabelle
gegeben — auch auf `auth_*` und auf jede künftige Tabelle, deren Rechtelage noch niemand
entschieden hat. Stattdessen: eine explizite Liste, die zusammen mit dem Schema wächst.
Das ist der Preis dafür, dass ein Vergessen als Laufzeitfehler sichtbar wird, statt als
stilles Zuviel-Recht.

Ausführen als `app_owner` (dieselbe Verbindung wie Block 3), unmittelbar nach
`npm run db:migrate`:

```sql
-- ── app_runtime: tabellenweise, nicht pauschal ───────────────────────────
-- TRUNCATE steht bewusst NICHT in der Liste und wird deshalb auch nie
-- gegrantet; ein nachträgliches "revoke truncate" ist damit überflüssig.
grant select, insert, update, delete on workspace, membership, site to app_runtime;

-- user_identity ist append-only, und die Kopplung auth_user_id trägt
-- ausschließlich die Definer-Rolle nach. Kein UPDATE, kein DELETE.
grant select, insert on user_identity to app_runtime;

-- domain_events und audit_log sind append-only (Trigger aus drizzle/0004 und
-- 0005). Das GRANT bildet das ab, statt sich allein auf den Trigger zu
-- verlassen: kein UPDATE, kein DELETE.
grant select, insert on domain_events, audit_log to app_runtime;

-- ── app_auth: NUR die better-auth-Tabellen ───────────────────────────────
grant select, insert, update, delete on
  auth_user, auth_session, auth_account, auth_verification, auth_rate_limit
  to app_auth;

-- ── Identity-Kopplung: der einzige Berührungspunkt zwischen Auth und Domäne
-- app_auth bekommt bewusst KEIN Recht auf user_identity. Ein Grant würde dort
-- ohnehin nichts nützen (FORCE RLS + membership-basierte SELECT-Policy). Der
-- Pfad ist die SECURITY-DEFINER-Funktion aus drizzle/0014+0015.
--
-- Die Funktion gehört identity_reconciler, nicht app_owner — deshalb muss
-- app_owner die Rolle für diesen einen Schritt annehmen. Danach wird das
-- SET-Recht wieder abgegeben: NIEMAND ausser der Funktion selbst darf in die
-- Definer-Rolle schlüpfen.
grant identity_reconciler to app_owner with inherit false, set true;
set role identity_reconciler;
revoke execute on function reconcile_user_identity(text, text) from public;
-- drizzle/0015 hat EXECUTE an die migrierende Rolle vergeben (in M0 = die
-- App-Rolle). Nach der Trennung ist das app_owner, und der darf es nicht.
revoke execute on function reconcile_user_identity(text, text) from app_owner;
grant  execute on function reconcile_user_identity(text, text) to app_auth;
reset role;
grant identity_reconciler to app_owner with inherit false, set false;

-- ── app_worker ───────────────────────────────────────────────────────────
-- Im Schema pgboss braucht es keine Grants: app_worker ist dort Eigentümer.
-- Domänenzugriff bekommt der Worker NUR pro Job-Klasse und explizit, z. B.
-- wenn M2 pdf.render einführt:
--   grant select on site to app_worker;
-- Kein Blanket, keine Vorratsrechte.
```

Es gibt in `public` derzeit **keine Sequenzen** (alle Schlüssel sind `uuid`), deshalb
fehlt hier ein `grant … on sequences`. Käme eine hinzu, MUSS sie in diesem Skript
auftauchen — sonst schlägt der erste Insert zur Laufzeit fehl.

### Gegenprobe: die Skizze ist ausgeführt worden

Die vier Blöcke sind **nicht** angelesen, sondern am 2026-08-27 einmal vollständig
gegen die embedded-Postgres-Instanz (PG 18) durchgespielt worden. Reproduzierbar:

```bash
npx tsx scripts/adr-0003-probe.mts
```

Das Skript legt die Rollen an, überträgt die Ownership, migriert als `app_migrator` mit
`options=-c role=app_owner`, führt Block 4 aus und prüft danach die Rechtelage. Es ist
bewusst **nicht** Teil von `npm run check` (es braucht eine eigene Instanz und dauert
länger als ein Unit-Test); es ist die Belegkette für dieses Dokument. Ergebnis am
2026-08-27: **24 von 24 Nachweisen grün**.

| Nachweis | Ergebnis |
| --- | --- |
| alle `public`-Tabellen gehören nach dem Migrationslauf `app_owner` | ja (0 fremde Owner) |
| `app_runtime` darf Domänen-DML (unter RLS) | ja |
| `app_runtime` sieht `auth_user` | nein — *permission denied for table auth_user* |
| `app_runtime` darf `TRUNCATE site` | nein — *permission denied for table site* |
| `app_runtime` darf `user_identity` ändern | nein — *permission denied for table user_identity* |
| `app_runtime` darf `domain_events` updaten (append-only) | nein — *permission denied* |
| `app_runtime` darf aus `audit_log` löschen (append-only) | nein — *permission denied* |
| `app_runtime` darf DDL in `public` | nein — *permission denied for schema public* |
| `app_runtime` darf `reconcile_user_identity` ausführen | nein — *permission denied for function* |
| `app_runtime` kann das Reconcile-Fenster von Hand öffnen | nein |
| `app_runtime` / `app_auth` / `app_owner` können `SET ROLE identity_reconciler` | nein — *permission denied to set role* |
| `app_owner` darf `reconcile_user_identity` nach Block 4 noch ausführen | nein — *permission denied for function* |
| `app_auth` darf `auth_user` lesen | ja |
| `app_auth` sieht `user_identity` | nein — *permission denied for table user_identity* |
| `app_auth` darf `reconcile_user_identity` ausführen, idempotent | ja, Kopplung genau einmal in der DB |
| `app_worker` darf im Schema `pgboss` anlegen | ja |
| `app_worker` sieht `auth_user` | nein — *permission denied for table auth_user* |

Die Probe hat dabei einen echten Portabilitätsfehler in `drizzle/0015` aufgedeckt, der
gegen die Test-DB unsichtbar geblieben wäre: dort hat `PUBLIC` noch `USAGE` auf `public`,
in einer nach Block 2 gehärteten Datenbank nicht mehr — die Definer-Rolle konnte die
eigene Funktion im `search_path` nicht auflösen. Der `grant usage` steht deshalb jetzt im
Migrations-DO-Block selbst.

### Env-Variablen

Alle vier werden vom Code tatsächlich ausgewertet — die Namen hier sind kein Vorschlag:

| Variable | Rolle | Wer liest sie |
| --- | --- | --- |
| `POSTGRES_URL` | `app_runtime` (Portal) | `lib/db/client.ts` |
| `POSTGRES_URL_AUTH` | `app_auth` | `lib/db/auth-client.ts` (`POSTGRES_URL_AUTH ?? POSTGRES_URL`) |
| `POSTGRES_URL_MIGRATE` | `app_migrator`, **inklusive** `?options=-c%20role%3Dapp_owner` | `scripts/migrate.mts` (`POSTGRES_URL_MIGRATE ?? POSTGRES_URL`) |
| `POSTGRES_URL_WORKER` | `app_worker` | `worker/index.ts` (`POSTGRES_URL_WORKER ?? POSTGRES_URL`), einmal aufgelöst für pg-boss **und** Health-Probe |

Jede Variable fällt auf `POSTGRES_URL` zurück, solange sie nicht gesetzt ist. Genau
dieser Fallback IST die hier dokumentierte M0-Limitation: ohne die Rollentrennung
arbeiten alle vier Pfade auf derselben Rolle. Der Code ist bereits so geschnitten, dass
die Umstellung eine reine Konfigurationsänderung ist.

Hinweis für Tests: `tests/setup/global-setup.ts` setzt `POSTGRES_URL` **und**
`POSTGRES_URL_MIGRATE` hart auf die Test-DB. Eine von außen gesetzte
`POSTGRES_URL_MIGRATE` hätte sonst Vorrang und würde die Testmigration gegen ein
Dev-/Prod-Ziel fahren — dieselbe Lücke, die Codex-Review #8 für `POSTGRES_URL`
geschlossen hat.

## Konsequenzen

- **M0 bleibt mergefähig**, die Restlücke ist benannt statt unsichtbar.
- Das Safety-Gate in `scripts/migrate.mts` (kein Superuser, kein `BYPASSRLS`) bleibt
  unverändert bestehen und gilt nach `SET ROLE` für `app_owner`.
- `lib/db/auth-client.ts` liest bereits `POSTGRES_URL_AUTH ?? POSTGRES_URL`; das Umstellen
  auf `app_auth` ist danach eine reine Konfigurationsänderung ohne Codeänderung.
- Das Grant-Skript aus Block 4 ist Teil des Deploy-Ablaufs, nicht des Repositories-
  Automatismus: **jede** Migration, die eine Tabelle hinzufügt, muss es erweitern.
  Fehlt der Eintrag, schlägt der erste Zugriff mit *permission denied* fehl — laut und
  früh, nicht still und zu weit.
- Die Testumgebung bildet weiterhin den heutigen Zustand ab: `tests/setup/embedded-postgres.ts`
  legt eine Nicht-Superuser-Rolle `app_test` an, die Eigentümerin ihrer Tabellen ist. Nach
  der Umstellung sollte sie um die gleiche Rollenteilung erweitert werden, sonst testet CI
  eine andere Rechtelage als Produktion. `scripts/adr-0003-probe.mts` ist der Vorgriff
  darauf und kann dafür als Grundlage dienen.
- Solange die Trennung aussteht, gilt: **jeder** Code, der auf `lib/db/client.ts` oder
  `lib/db/auth-client.ts` zugreift, ist sicherheitsrelevant. Die dependency-cruiser-Regeln
  `db-client-nur-ueber-tenant` und `auth-client-nur-fuer-auth` halten diesen Kreis klein.
- Der früher hier offene Folgepunkt — das idempotente Nachtragen von
  `user_identity.auth_user_id` — ist mit `drizzle/0014` + `drizzle/0015`
  **geschlossen**, und zwar unabhängig von dieser Rollentrennung: das Reconcile-Fenster
  hängt an der eigenen Definer-Rolle `identity_reconciler`, nicht an `PUBLIC`. Was diese
  ADR beisteuert, ist nur noch der letzte Schritt — `EXECUTE` von der migrierenden Rolle
  auf `app_auth` umzuhängen (Block 4). `identity_reconciler` wird in Block 1 **nicht**
  angelegt: sie gehört zum Schema, nicht zum Deployment, und kommt deshalb aus der
  Migration.
