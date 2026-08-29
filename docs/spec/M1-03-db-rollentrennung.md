# M1-03 — Laufende Dienste besitzen nur ihre eigene Datenbanktür

> Status: REVIEWED/VERIFIED (lokal)
> · lokaler M0-Checkpoint · Pilot/Produktion NO-GO
> · erstellt und implementiert 2026-08-29

## Warum dieser Schnitt vor dem Rechner-Eingang liegt

Der externe Rechner soll später einen Lead in das Portal übergeben. Ab diesem Moment
erreicht öffentlich kontrollierter Input die produktive Datenbank. Bevor dieser Eingang
gebaut wird, muss feststehen, welche DB-Verbindung Kontakte/Standorte schreiben darf und
welche Macht sie gerade **nicht** besitzt.

M1-02 schützte Membership-Mutationen mit Actor-Policies und Triggern. Der verbleibende
P0 war jedoch strukturell: `app.actor_id` und `app.workspace_id` sind frei setzbare
PostgreSQL-Custom-GUCs. Die alte ADR-0003-Skizze gab `app_runtime` gleichzeitig direktes
`INSERT/UPDATE/DELETE` auf `membership`. Beliebiges SQL als Runtime hätte deshalb den
Actor leeren und den dokumentierten Systempfad verwenden können.

Parameter-ACLs schließen das nicht. Custom-GUCs sind Kontexttransport, kein
Authentifizierungsnachweis. Die Grenze muss daher über echte PostgreSQL-Principals und
Objekt-ACLs laufen.

## Sicherheitsvertrag

### Rollen

| Rolle | Login | Vertrag |
|---|---:|---|
| `app_owner` | nein | Eigentümer von `public`, `drizzle` und App-Objekten; nur Ziel des Migrators |
| `app_migrator` | ja | ausschließlich `SET ROLE app_owner/app_worker`; `NOINHERIT`, kein `ADMIN`, keine Fachrechte ohne Rollenwechsel |
| `app_runtime` | ja | Portal: Membership nur lesen; Site-DML; Event/Audit append-only |
| `app_system` | ja | isolierter Bootstrap-/Recovery-Principal; einziger direkter Membership-Schreiber |
| `app_auth` | ja | nur fünf `auth_*`-Tabellen und Reconcile-Funktion |
| `app_worker` | ja | Eigentümer von `pgboss`; enge M1-07-Fachreads/-writes in `public` |
| `app_erasure` | nein | nur EXECUTE auf zwei geschlossene M1-07-Erasure-Routinen; keinerlei Relation-ACL |
| `app_membership_writer` | nein | objektlose Markerrolle für Membership-Policy/Trigger |
| `identity_reconciler` | nein | enger SECURITY-DEFINER-Owner der Reconcile-Funktion |

Alle Rollen sind `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`,
`NOCREATEROLE`, `NOREPLICATION`; nur die fünf Dienstrollen haben `LOGIN`.

`app_owner` braucht kein `CREATEROLE`: Der Admin legt `identity_reconciler` vor der
ersten Migration an und gibt `app_owner` ausschließlich darauf `ADMIN TRUE`, während
`INHERIT` und `SET` aus bleiben. Migrationen 0015/0016 öffnen `SET` nur für ihren
Funktionsschritt und schließen es danach wieder.

PostgreSQL 18 erzeugt bei `CREATE ROLE` durch einen Nicht-Superuser zusätzlich eine
grantor-genaue automatische ADMIN-Kante vom neuen Role-Objekt zum erzeugenden
Provisioning-Admin. Diese Kante erlaubt allein noch kein `SET ROLE`. Der optionale,
all-or-none gesetzte Providervertrag
`DB_ROLE_PROVISIONING_ADMIN` + `DB_ROLE_BOOTSTRAP_GRANTOR` bildet deshalb exakt die
neun automatischen Kanten, die fünf fachlichen Kanten und nur die zwei nötigen
Self-`SET`-Kanten für `app_owner`/`app_worker` ab. Beim Legacy-Upgrade benennt
`DB_ROLE_RETAINED_LEGACY_ROLE` zusätzlich exakt die gehärtete Altrolle, deren vom
Bootstrap-Grantor erzeugte, nicht entziehbare `identity_reconciler`-Kante mit
`ADMIN=true`, `INHERIT=false`, `SET=false` erhalten bleiben darf. Ohne diese Variablen
gilt weiterhin ausschließlich der lokale Superuser-Fixture-Vertrag mit Grantor
`postgres`; eine unbekannte Mischform ist rot.

### Nicht fälschbare Membership-Grenze

Migration 0019 ergänzt drei befehlsspezifische restriktive Policies. Jede verlangt:

```sql
pg_catalog.pg_has_role(current_user, 'app_membership_writer', 'MEMBER')
```

Der Statement-Trigger prüft denselben Principal **vor** Isolation, Workspace-Lock und
Zielzeilen. Dadurch gilt:

1. `app_runtime` besitzt auf Tabellenebene nur `SELECT` auf `membership`.
2. Selbst ein versehentlich wieder erteilter Runtime-DML-Grant reicht nicht: Policy und
   Statement-Trigger lehnen mit `42501` ab.
3. `app.actor_id=''`, eine fremde Actor-ID und ein fremder Workspace-GUC ändern daran
   nichts.
4. `TRUNCATE` bleibt separat ohne Grant; RLS schützt TRUNCATE grundsätzlich nicht.
5. Nur der isoliert gehaltene `app_system` besitzt unter den fachlich laufenden
   Diensten Marker-Mitgliedschaft und Tabellenrechte. `app_owner` trägt den Marker für
   Migrationen; `app_migrator` kann ausschließlich bewusst zum Owner wechseln. Das
   Systemsecret darf nie im Next.js-/Vercel-Prozess liegen.

Die Actor-/Admin-/Self-DML-Regeln aus 0018 bleiben zusätzlich aktiv. Der Marker ersetzt
sie nicht, sondern authentifiziert den DB-Principal vor ihnen.

### Explizites Grant-Manifest

`scripts/db-role-contract.mts` entzieht nach jeder strikten Migration zunächst alle
Dienstrechte auf `public` und grantet anschließend ausschließlich die Allowlist. Neue
Tabellen bekommen keine automatische Runtime-DML-Berechtigung. Das Manifest prüft in
derselben Transaktion:

- exakte Rollenattribute und Mitgliedschaftsoptionen,
- exaktes Nicht-System-Schemainventar (`public`, `drizzle`, `pgboss`), sodass fremde
  Datenflächen oder PUBLIC-erreichbare SECURITY-DEFINER nicht unbemerkt bleiben,
- exaktes Relations- und Funktionsinventar sowie Owner aller Tabellen, Views,
  Materialized Views, Foreign Tables und Sequenzen,
- reale Katalog-ACLs aller Tabellen, Spalten, Sequenzen, Funktionen und Schemas samt
  Grantor und Grant Option — einschließlich PUBLIC und fremder Legacy-Grantors,
- Live-Sicherheitsattribute und SHA-256-Bodyvertrag aller Public-App-Funktionen sowie
  des einzigen Runtime-erreichbaren pg-boss-Dispatchers; SECURITY-DEFINER-Allowlist,
  RLS/FORCE, sämtliche Policy-Ausdrücke und Schutztrigger,
- exakte Tabellen-Grants für Runtime, System, Auth und den minimalen Reconciler,
- fehlendes `CREATE` in `public` sowie exklusives Worker-`CREATE` in `pgboss`,
- ausschließlich `PUBLIC CONNECT` auf der Datenbank; `TEMPORARY` ist entzogen, damit
  `pg_temp` keine unqualifizierte Relation auf gepoolten Sessions überschatten kann,
- effektive Marker- und `neon_superuser`-Closure.

Jede Abweichung rollt die Grant-Transaktion zurück und macht den Migrationslauf rot.

### Migrationsgrenze

`scripts/migrate.mts`:

- liest nur `POSTGRES_URL_MIGRATE`; kein Fallback auf Runtime,
- defaultet fail-closed auf `DB_ROLE_MODE=strict`,
- verlangt den URL-Nutzer `app_migrator`, eine fail-closed Query-Allowlist und für Neon
  einen ungepoolten Host,
- setzt intern als Startup-Option `role=app_owner`,
- prüft vor jeder Schemaänderung tatsächlich `session_user=app_migrator`,
  `current_user=app_owner`, alle verbotenen Attribute, exakte Membership-Kanten und
  fehlende `neon_superuser`-Closure,
- bindet bei einer PG18-Provider-Topologie sämtliche automatischen, fachlichen und
  Self-`SET`-Kanten an ihre exakten Grantors und Optionen,
- begrenzt Connection-, Lock-, Statement- und Idle-in-Transaction-Zeit,
- serialisiert Läufe mit einem Advisory Lock und räumt Pool/Lock in `finally` auf,
- vergleicht jede bereits angewandte Journalzeile mit dem SHA-256 der versionierten
  lokalen SQL-Datei, verlangt ein lückenloses Historienpräfix und wiederholt diesen
  Check nach Erwerb des Advisory Locks vor Drizzle,
- repariert/verifiziert globale und `public`-spezifische Default-ACLs vor Drizzle,
- wendet Migrationen und danach Default-ACL- sowie Objekt-ACL-Manifest erneut an.

Die einzige Ein-Rollen-Ausnahme heißt sichtbar `test-legacy-single`, ist nur unter
Vitest/`NODE_ENV=test` erlaubt und verlangt eine Datenbank mit `test` im Namen.

### Laufzeitkonfiguration

`lib/db/role-env.ts` löst jede Dienst-URL exakt auf:

- `POSTGRES_URL` → `app_runtime`
- `POSTGRES_URL_AUTH` → `app_auth`
- `POSTGRES_URL_WORKER` → `app_worker`

Kein Pfad fällt auf eine andere URL zurück; Runtime und Auth müssen exakt dasselbe
Host-/Port-/Datenbankziel benennen. Vor der Verbindung ist ausschließlich
`sslmode=verify-full` als URL-Queryparameter erlaubt und für nicht lokale Ziele Pflicht;
Authority-/Principal-Overrides, `sslmode=require`, der in node-postgres als URL-Wert
wirkunglose `channel_binding`-Schalter und Startup-`options` sind rot.
Login, Passwort, Host, Port und Datenbank müssen explizit in der URL stehen; rohe
Leer-/Steuerzeichen sowie ambiente `PG*`-/TLS-Overrides sind rot.

Die URL-Vorprüfung ist nicht die Vertrauensgrenze. Jeder Runtime-, Auth-, Health- und
pg-boss-Pool initialisiert **jede neu aufgebaute Verbindung** vor ihrer ersten Ausgabe
mit festem `search_path=pg_catalog,public`, `row_security=on` und wirksamen
Session-Timeouts. Das Pool-Verify-Gate attestiert live:

- exakte Datenbank, `session_user` und `current_user`,
- alle Rollenattribute, Passwortgültigkeit und fehlende Rollen-Konfiguration,
- keine ausgehende Membership sowie keine effektive rollen- oder datenbankweite
  `pg_db_role_setting`-Konfiguration,
- keine Service-Rolle als Datenbankowner und damit keine implizite
  `pg_database_owner`-Macht,
- bei Neon die erwartete 32-stellige Tenant-/Timeline-ID und beide Werte als
  unveränderliche `postmaster`-Settings.

Neon-Dienstrollen müssen deshalb den direkten, ungepoolten Endpunkt verwenden;
`-pooler` wäre zwischen Verifikation und Fachquery backend-wechselnd und ist
fail-closed verboten. Tenant und Timeline werden über
`POSTGRES_EXPECTED_NEON_TENANT_ID`/`POSTGRES_EXPECTED_NEON_TIMELINE_ID` explizit an
den ausgerollten Branch gebunden.

Der Worker startet pg-boss mit `schema: "pgboss"`, `createSchema: false` und dem
offiziellen `db: IDatabase`-Injektionspfad. Dessen eigener Hauptpool verwendet damit
denselben `app_worker`-Live-Vertrag wie die unabhängige Health-Probe. Die Readiness
prüft zusätzlich das vollständige pg-boss-Owner-Inventar; ein permanenter pg-boss-
oder idle-Pool-Fehler läuft genau einmal durch den zentralen fatalen Shutdown, macht
sie rot, beendet den Prozess mit Fehlercode und lässt Compose sichtbar neu starten.
Der Container erhält weder Runtime- noch Systemsecret. Das Image baut
ein fixes `dist/worker.cjs`, installiert Runtime-Abhängigkeiten reproduzierbar per
Lockfile und läuft im finalen Image als vorhandener Non-Root-Nutzer `node`.

`POSTGRES_URL_SYSTEM` ist ausschließlich für einen späteren isolierten
Bootstrap-/Recovery-Prozess dokumentiert; es gibt bewusst noch keinen Systemclient im
Web-Repo. Der Host-Cron nutzt getrennte `POSTGRES_BACKUP_*`-Werte mit Passfile sowie
einen eigenen minimalen `S3_BACKUP_*`-Bucket-Key. Der lokale Lauf bindet das Ziel vor
und nach dem Dump an PG18, Principal, Datenbank und Neon-Tenant/-Timeline beziehungsweise
die PostgreSQL-System-ID; Artefakt und Manifest werden über exakte Version, Checksumme
und Retention attestiert. Wegen FORCE RLS braucht ein vollständiger logischer Dump
weiterhin einen real freigegebenen Backup-/Providerpfad; diese privilegierten
Credentials gehören ebenfalls nie in Web oder Worker.

## Nutzerbediente Membership-Verwaltung ist noch nicht freigegeben

`app_system` ist ein Offline-/Operations-Principal, kein Browser-API. Ein späterer
Membership-Endpunkt darf weder Runtime-DML zurückgranten noch nur einer behaupteten
`actor_id` vertrauen. Vor so einem Endpunkt ist eine eigene Spec bindend:

- Mutation und Auth-Prüfung atomar in einem engen Command-Pfad,
- Actor aus einer live in der DB geprüften Better-Auth-Session oder aus einem wirklich
  isolierten Command-Service ableiten,
- abgelaufene/widerrufene Session ablehnen,
- Erfolgsaudit und Domain-Event in derselben Transaktion,
- keine Tokens in Logs, Audit oder Events,
- separate Bootstrap-/Recovery-Befugnisse.

Bis dahin gibt es produktiv **keinen** Online-Membership-Schreibpfad.

## RED/GREEN und lokale Nachweise

- RED: Der neue Katalogtest fand null statt drei Principal-Policies; die 25 bestehenden
  Membership-Prüfungen blieben grün.
- GREEN: Nach 0019 liefen 26/26 Membership-Prüfungen grün.
- `scripts/adr-0003-probe.mts` bootet eine flüchtige PG-Instanz, provisioniert acht
  Rollen, migriert fresh `0000→0019`, greift mit fünf echten Loginrollen an und wendet
  das Manifest ein zweites Mal an.
- 73 strikte Nachweise sind grün, darunter Runtime-GUC-NULL, DDL/TRUNCATE/SET ROLE,
  absichtlich wieder erteilter Runtime-UPDATE-Grant, URL-Principal-Override,
  privilegierter und indirekt hochgestufter Migrator vor jeder Journaländerung,
  transitive Marker-Bridge, unklassifizierte Zero-ACL-Tabelle, fremder Legacy-Grantor,
  vorab reparierter Default-ACL-Drift, System-Bootstrap, Auth-Reconcile, Migrator ohne
  Owner-Rolle und echter pg-boss-Roundtrip. Eine zweite Datenbank stellt zusätzlich
  den historischen 0015-Zustand `identity_reconciler INHERIT` samt altem
  `app_legacy`-Reconcile-EXECUTE wirklich her und wird
  zunächst als Legacy-Owner bis 0018 aufgebaut; Ownership-Cutover und 0019 erhalten
  danach Workspace, Membership, ein realer wartender pg-boss-Job und Journal
  unverändert. Der Cutover attestiert zuerst Target und separate Control-Datenbank,
  setzt anschließend `ALLOW_CONNECTIONS=false`, blockiert damit auch neue
  Superuser-Verbindungen und verlangt einen kontrollierten Drain. Erst nach erneutem
  vollständigem Preflight werden Rollen/`CONNECTION LIMIT 0` committed und der
  Owner-Cutover ausgeführt. Nur die Control-Session öffnet nach bekannt erfolgreichem
  Target-COMMIT exakt `ALLOW_CONNECTIONS` und den bestätigten Ausgangswert wieder;
  Fehler und paralleles DDL bleiben fail-closed. Verlorene Freeze-/Unfreeze-COMMIT-
  Antworten und eine nach quittiertem Unfreeze-COMMIT ausfallende Session werden über
  einen frischen PoolClient behandelt. Die kompromittierte Session wird vor dem neuen
  Connect zerstört, damit eine offene Transaktion keinen `pg_database`-Kataloglock
  halten oder nur einen uncommitteten `false`-Wert vortäuschen kann. Der neue Client
  muss Control-Datenbank, Admin, PostgreSQL 18, Cluster-ID und tatsächlichen
  Serverendpunkt exakt reattestieren und den Refreeze anschließend lesen. Scheitert
  das, lautet der Zustand ausdrücklich unbestätigt und wird nicht fälschlich als
  `ALLOW_CONNECTIONS=false` ausgegeben. Der Katalogvertrag prüft zusätzlich
  Datenbankowner/-ACL sowie sämtliche pg-boss-Relationen, Funktionen und Typen.
- Eine separate echte PostgreSQL-18-Regressionsprobe belegt 5/5 Eigenschaften der
  Nicht-Superuser-`CREATEROLE`-Semantik: automatische Bootstrap-Kante, fehlendes
  implizites `SET ROLE`, nötige separate Self-`SET`-Kante sowie grantor-genaues
  Revoke-Verhalten.
- Der integrierte lokale Nachweis umfasst zusätzlich 210/210 Vitest-Tests, Lint,
  Typecheck, Modulgrenzen und einen erfolgreichen Next.js-Produktionsbuild.
- Beim Testen wurde zusätzlich entdeckt, dass Vitest 4.1.11 unter der lokalen
  Node-24-Laufzeit trotz fehlgeschlagener Assertions Status 0 lieferte. Der neue
  `scripts/run-tests.mts` wertet zusätzlich den JSON-Abschluss aus. Eine absichtlich
  rote Gegenprobe endete danach verifiziert mit Prozessstatus 1.

## Noch offene Pilot-Gates

Der lokale Schnitt ist kein Produktionsrollout. Pilot/Produktion bleibt NO-GO bis:

1. Zielrollen in der echten Test-/Staging-Datenbank per SQL angelegt sind; Neon-
   Console/API/CLI-Rollen sind wegen geerbtem `neon_superuser` kein Runtime-Principal.
   Provisioning-Admin, tatsächlicher Bootstrap-Grantor und sämtliche PG18-Autokanten
   müssen dort katalogbasiert ermittelt und über den Providervertrag gebunden sein.
2. Der lokal grüne Legacy-Ownership-Cutover `public`/`drizzle → app_owner`,
   `pgboss → app_worker` mit Bestandsdaten in der echten Staging-Topologie und mit
   realem Wartungs-/Rollback-Runbook wiederholt ist.
   Dazu gehört eine separate Control-Datenbank-Route, die
   `ALLOW_CONNECTIONS false/true` samt Recovery und gleicher Cluster-/Branch-Identität
   beweist; `CONNECTION LIMIT 0` allein sperrt PostgreSQL-Superuser nicht.
3. Runtime-/Auth-/Worker-/Migrationssecrets tatsächlich getrennt ausgerollt und alte
   Verbindungen drainiert/entzogen sind.
4. Backup/PITR und Restore mit einer vollständigen, RLS-tauglichen Quelle praktisch
   getestet sind.
5. System- und Backup-Credentials nachweislich weder Web- noch Worker-Environment
   erreichen.
6. Die echte Neon-Branch-Identität, direkte Endpoint-Semantik und die beiden
   `postmaster`-GUCs in einer autorisierten Staging-Branch praktisch attestiert sind.
7. Der logische Dump zusammen mit einem ausführbaren Rollen-/Owner-/ACL-Restore-
   Vertrag sowie Lock, Gesamttimeout, Fehleralarm und Retention-Readback praktisch
   bewiesen ist. `--no-owner --no-privileges` allein ist ausdrücklich kein
   vollständiges M1-03-Wiederherstellungsartefakt.
8. Unabhängiger Security-, Migration- und Betriebsreview ohne offene P0/P1 vorliegt.

Die operative Reihenfolge, Secret-Matrix und Rollback-Grenze stehen in
`docs/runbooks/db-role-cutover.md`.

## Primärquellen

- PostgreSQL 18: Role Membership, GRANT/SET-Optionen, Row Security und Custom Options
  (`postgresql.org/docs/18`).
- Neon: SQL-erzeugte Limited Roles, Database Access und Connection Pooling
  (`neon.com/docs/manage/roles`, `/manage/database-access`,
  `/connect/connection-pooling`).
