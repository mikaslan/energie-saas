# Runbook: Datenbank-Rollentrennung und Ownership-Cutover

Status: lokal gegen flüchtiges PostgreSQL verifiziert · echte Staging-/Produktion noch
nicht ausgeführt · jede externe Anwendung braucht ein freigegebenes Wartungsfenster.

## Ziel und Reihenfolge

Der Cutover macht aus der bisherigen Ein-Rollen-Datenbank diese Kette:

```text
Admin (nur Provisionierung)
  ├─ app_migrator ─SET ROLE→ app_owner/app_worker ─→ getrennte Owner-Migrationen + ACL-Manifest
  ├─ app_runtime  ─→ Portal, Membership SELECT-only
  ├─ app_auth     ─→ Auth-Tabellen + Reconcile
  ├─ app_worker   ─→ Schema pgboss
  └─ app_system   ─→ isoliertes Bootstrap/Recovery
```

Erst Rollen/Owner, dann Migration 0019 + Grants, dann neue Dienstsecrets, zuletzt alte
Verbindungen/Secrets entziehen. Ownership wird bei einem Rollback nicht hektisch
zurückübertragen.

Der implementierte Legacy-Cutover hält zwei direkte Admin-Sessions offen: eine auf der
Zieldatenbank und eine auf einer **anderen Control-Datenbank desselben PostgreSQL-18-
Clusters**. Host, Port und Admin-Principal müssen in beiden URLs identisch sein; die
Datenbanknamen müssen verschieden sein. Zusätzlich attestiert das Script auf beiden
Verbindungen `system_identifier`, tatsächliche Serveradresse und Serverport.

Der persistente Zustandswechsel ist bewusst mehrstufig:

1. **Read-only Preflight:** Die bereits bestehende Target-Session attestiert Journal,
   Rollen, Owner, ACLs, Struktur, Stichproben und pg-boss-Job, bevor der Freeze beginnt.
2. **Control-Freeze:** Die Control-Session setzt am Target in einer eigenen
   serialisierbaren Transaktion `ALLOW_CONNECTIONS false` und attestiert den Commit.
   Das blockiert auch neue Superuser-Verbindungen, beendet aber keine bestehenden
   Backends.
3. **Drain und Phase 1:** Ausschließlich die bereits geöffnete Target-Admin-Session
   darf verbleiben. Nach erneutem vollständigem Preflight unter exklusiven
   Relationslocks werden Legacy-/Reconciler-Rollen gehärtet und
   `CONNECTION LIMIT 0` gemeinsam committed. Das Target bleibt
   `ALLOW_CONNECTIONS=false`.
4. **Atomarer Owner-Cutover:** Owner, ACLs und Memberships werden übertragen; Daten,
   Struktur und Job werden vor Target-COMMIT nochmals exakt attestiert. Weder
   `ALLOW_CONNECTIONS` noch der ursprünglich bestätigte Connection-Limit-Wert werden
   in dieser Target-Transaktion geöffnet.
5. **Control-Unfreeze:** Erst nach bekannt erfolgreichem Target-COMMIT stellt die
   Control-Session den schriftlich bestätigten Ausgangswert von `CONNECTION LIMIT`
   wieder her und setzt anschließend `ALLOW_CONNECTIONS true`.

Geht an einer Control-COMMIT-Grenze die Antwort verloren oder fällt eine
Zustandsattestierung nach COMMIT aus, ist die ursprüngliche Control-Session ab diesem
Moment kein Beweis mehr. Die CLI verwirft sie **vor** dem Fresh-Connect, damit auch eine
offene Transaktion und ihr `pg_database`-Kataloglock sicher enden. Erst danach
attestiert die neue Einwegverbindung Control-Datenbank, Admin, PostgreSQL 18,
`system_identifier`, reale Serveradresse und Serverport erneut und setzt das Target auf
`ALLOW_CONNECTIONS=false`. Nur ein anschließend gelesener `false`-Wert darf als
fail-closed gemeldet werden. Scheitern Reconnect, Reattestierung oder Refreeze, lautet
die Ausgabe ausdrücklich **„Zustand unbestätigt“**; sie behauptet dann nicht, das
Target sei geschlossen.

Ab Schritt 2 gilt die harte Fail-closed-Grenze: Geht die bestehende Target-Session
verloren, kann auch ein Superuser nicht neu auf das Target verbinden. Ein normaler
Wiederanlauf ist dann unmöglich. Ausschließlich die attestierte Control-Datenbank darf
das Target über den unten dokumentierten, explizit bestätigten Recovery-Modus wieder
öffnen. Manuelles `ALTER DATABASE`, ein Target-seitiger Recovery-Versuch oder ein
blinder Phase-2-Neustart sind verboten.

Control-Freeze und Recovery sind lokal implementiert und gegen PostgreSQL 18
regressionsgeprüft. Für Staging/Produktion bleibt trotzdem ein echtes Provider-Gate:
Der bereitgestellte Admin muss auf **beiden** Datenbanken `rolsuper=true` besitzen und
`ALTER DATABASE ... ALLOW_CONNECTIONS` ausführen dürfen. Kann der Provider das nicht
bereitstellen oder fehlt eine separate Control-Datenbank desselben attestierten
Clusters, ist der Legacy-Cutover NO-GO.

## Harte Vorbedingungen

1. Zwei direkte, ungepoolte Admin-Endpunkte vorbereiten: Target und eine andere
   Control-Datenbank. Beide verwenden exakt denselben Host, Port und Admin-Principal;
   ein Neon-Hostname mit `-pooler` ist falsch. Die Migrations-URL ist ebenfalls direkt.
2. Aktuelles Backup/PITR-Restore nach dem
   [Backup-/DR-Konzept](../konzepte/backup-dr.md) verifiziert.
3. Web, Worker und alle Membership-Schreiber gestoppt; lange/offene Transaktionen
   geprüft.
4. `lock_timeout=5s`, `statement_timeout=300s`,
   `idle_in_transaction_session_timeout=60s` gelten.
5. Exakte Legacy-Ownerrolle schriftlich festhalten; keine geratenen Rollen-/DB-Namen.
   Zusätzlich `datallowconn=true`, den aktuellen `datconnlimit` (`-1` oder positive
   Ganzzahl), beide kanonischen Target-Keys und den historischen Grantor der
   automatisch erzeugten `identity_reconciler`-ADMIN-Kante katalogbasiert festhalten.
6. Auf Target und Control müssen `session_user=current_user` und derselbe echte
   PostgreSQL-18-Superuser (`rolsuper=true`) attestiert werden. `CREATEROLE` allein
   reicht für diesen Legacy-Cutover ausdrücklich nicht.
7. Runtime-/Auth-/Worker-/System-/Migrator-Passwörter getrennt erzeugen und im
   Passwort-Manager ablegen. Keine Secrets in Shell-History, Ticket oder Repo.
8. Dienst-, Migrations-, Target- und Control-URLs enthalten ausschließlich
   `sslmode=verify-full`; für nicht lokale Ziele ist der Wert Pflicht.
   `sslmode=require`, `channel_binding` und Queryparameter wie `user`, `password`,
   `host`, `port`, `database`, `db` oder `options` werden abgelehnt.

Neon-Console/API/CLI-erzeugte Rollen erben `neon_superuser` und sind deshalb als
Runtime/Auth/Worker/System ungeeignet. Limited Roles werden über SQL erstellt.

Bei PostgreSQL 18 mit einem Nicht-Superuser-Provisioning-Admin entstehen pro
`CREATE ROLE` automatische, grantor-genaue ADMIN-Kanten. Vor dem ersten Migrationslauf
müssen daher zusätzlich diese Werte gesetzt werden:

```text
DB_ROLE_PROVISIONING_ADMIN=<exakter SQL-Provisioning-Admin>
DB_ROLE_BOOTSTRAP_GRANTOR=<tatsächlicher Grantor der PG18-Autokanten>
```

Beide Werte sind all-or-none. Sie werden aus `pg_auth_members` ermittelt, nicht aus
einem vermuteten Providernamen. Für ein Legacy-Upgrade kommt
`DB_ROLE_RETAINED_LEGACY_ROLE=<exakte Altrolle>` hinzu. Fresh erwartet der Vertrag
acht automatische ADMIN/NOINHERIT/NOSET-Kanten. Retained Legacy erwartet dagegen nur
die sieben tatsächlich neu entstandenen Autokanten; für `identity_reconciler` bleiben
die historische Kante zur Altrolle und die fachliche Kante zu `app_owner` jeweils
unter dem attestierten Bootstrap-Grantor erhalten. Die fünf Fachkanten und separaten
Self-`SET`-Kanten ausschließlich für `app_owner` und `app_worker` bleiben exakt. Eine
zusätzliche oder anders grantete Kante stoppt Migration und Cutover.

## Rollenbootstrap

Die folgenden Statements laufen über die direkte Admin-Verbindung. Passwortliterale
werden vom freigegebenen Secret-Injektionsweg eingesetzt, nicht in diese Datei kopiert.
Vor jedem `CREATE ROLE` setzt und attestiert ein Nicht-Superuser-Provisioning-Admin
zwingend `createrole_self_grant=''`; ein Rollen-/Datenbankdefault darf nicht heimlich
`SET` oder `INHERIT` in die PG18-Autokante aufnehmen.

```sql
set createrole_self_grant = '';
select pg_catalog.current_setting('createrole_self_grant'); -- exakt leer

create role app_owner nologin noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_migrator login password '<secret>' noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_runtime login password '<secret>' noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_system login password '<secret>' noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_auth login password '<secret>' noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_worker login password '<secret>' noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_erasure nologin noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role app_membership_writer nologin noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;
create role identity_reconciler nologin noinherit nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication;

grant app_owner to app_migrator
  with admin false, inherit false, set true granted by current_user;
grant app_worker to app_migrator
  with admin false, inherit false, set true granted by current_user;
grant app_membership_writer to app_system
  with admin false, inherit false, set false granted by current_user;
grant app_membership_writer to app_owner
  with admin false, inherit false, set false granted by current_user;
grant identity_reconciler to app_owner
  with admin true, inherit false, set false granted by current_user;
```

Ist `current_user` der Nicht-Superuser-Provisioning-Admin, sind danach unter genau
diesem Grantor zusätzlich nur diese beiden Self-`SET`-Kanten erlaubt:

```sql
grant app_owner to <EXAKTER_PROVISIONING_ADMIN>
  with admin false, inherit false, set true granted by current_user;
grant app_worker to <EXAKTER_PROVISIONING_ADMIN>
  with admin false, inherit false, set true granted by current_user;
```

Der Fresh-Vertrag erwartet neun automatische Bootstrap-Kanten. Beim Legacy-Upgrade
existiert `identity_reconciler` bereits aus 0015 und wird nicht erneut angelegt; daher
darf dort keine künstliche neue Bootstrap-Kante zum Provisioning-Admin erzeugt werden.
Erlaubt bleibt ausschließlich die historisch attestierte Kante zum gehärteten
Legacy-Principal plus die fachliche Kante zu `app_owner`; beide haben im Retained-
Vertrag den Bootstrap-Grantor. Diese Fresh-/Legacy-Unterscheidung ist lokal
regressionsgeprüft. Die tatsächlichen Grantor-/Admin-Rechte müssen zusätzlich in der
Staging-Topologie des Providers bewiesen werden.

Idempotentes Produktions-Provisioning wird erst gebaut, wenn der konkrete Neon-
Admin-/Secret-Injektionsweg feststeht. Bis dahin gilt Vier-Augen-Ausführung mit
unmittelbarer Katalogprüfung; keine halbgenerische Script-Automation darf Passwörter
loggen oder ungefragt rotieren.

## Fresh-Datenbank

1. In einer direkten Admin-`psql`-Session zuerst `current_database()`, bisherigen
   Datenbank-/Schemaowner, Datenbank-ACL und das Fehlen von `drizzle`/`pgboss`
   protokollieren. Danach `<EXAKT_BESTÄTIGTE_DB>` ersetzen und diesen Block mit
   `ON_ERROR_STOP` ausführen:

   ```sql
   \set ON_ERROR_STOP on
   begin;
   set local lock_timeout = '5s';
   set local statement_timeout = '300s';
   set local idle_in_transaction_session_timeout = '60s';
   select pg_catalog.pg_advisory_xact_lock(1701734769, 3);

   alter database "<EXAKT_BESTÄTIGTE_DB>" owner to app_owner;
   alter schema public owner to app_owner;
   revoke all on schema public from public;
   create schema pgboss authorization app_worker;

   -- Fresh darf außer PUBLIC und Owner keinen DB-Grantee behalten.
   select pg_catalog.format(
            'revoke all privileges on database %I from %I',
            d.datname,
            grantee.rolname
          )
   from pg_catalog.pg_database d
   cross join lateral pg_catalog.aclexplode(
     coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba))
   ) acl
   join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
   where d.datname = pg_catalog.current_database()
     and acl.grantee <> d.datdba
   group by d.datname, grantee.rolname
   \gexec

   revoke all privileges on database "<EXAKT_BESTÄTIGTE_DB>" from public;
   grant connect on database "<EXAKT_BESTÄTIGTE_DB>" to public;
   revoke temporary on database "<EXAKT_BESTÄTIGTE_DB>" from public;
   commit;
   ```

   Ein bereits vorhandenes `pgboss`/`drizzle` oder ein nicht exakt bestätigter
   Datenbankname ist **kein** Fresh-Pfad und bricht den Lauf ab.
2. Unmittelbar danach katalogbasiert beweisen: Datenbankowner `app_owner`, DB-ACL
   exakt `PUBLIC CONNECT` mit Grantor `app_owner` und ohne `TEMPORARY`,
   `public → app_owner`,
   `pgboss → app_worker`, `drizzle` noch nicht vorhanden. Derselbe Vertrag läuft
   zusätzlich im Migrator vor der ersten Journaländerung fail-closed.
3. Nur diese Variablen für den Migrationsprozess setzen:

   ```text
   DB_ROLE_MODE=strict
   POSTGRES_URL_MIGRATE=postgres://app_migrator:…@<direkt>:5432/<db>?sslmode=verify-full
   DB_ROLE_PROVISIONING_ADMIN=<nur Providervertrag; sonst nicht setzen>
   DB_ROLE_BOOTSTRAP_GRANTOR=<nur Providervertrag; sonst nicht setzen>
   ```

4. `npm run db:migrate` ausführen. Das Script setzt `role=app_owner` intern, migriert,
   prüft beide Migrationsprincipals samt Membership-Closure **vor** der ersten
   Journaländerung, repariert/verifiziert globale und schemaspezifische Default-ACLs
   vor Drizzle, wendet danach das Objekt-ACL-Manifest an und prüft den vollständigen
   Katalog.
5. Einen zweiten Lauf ausführen; er muss idempotent grün sein.

## Legacy-Upgrade mit Bestandsdaten

1. Wartungszustand und Backup erneut bestätigen.
2. Rollen wie oben anlegen. `identity_reconciler`-ADMIN-Recht kontrolliert an
   `app_owner` geben; im Retained-Providervertrag muss diese Fachkante vom exakt
   attestierten Bootstrap-Grantor stammen, nicht vom Provisioning-Admin. Bei einer
   bestehenden Rolle aus Migration 0015 nicht erneut `CREATE ROLE` ausführen, sondern
   ihre Attribute vor Drizzle explizit normalisieren:

   ```sql
   alter role identity_reconciler
     nologin noinherit nosuperuser nobypassrls
     nocreatedb nocreaterole noreplication;
   ```
3. Vor jeder schreibenden Anweisung diese Evidenz protokollieren:
   Journal enthält `created_at=1787963136235` (0018) genau einmal und
   `1787965786722` (0019) noch nicht; DB-/Schema-/Objektowner; Relationsarten,
   Routinenarten und eigenständige Typen; DB-/Schema-/Relations-/Spalten-/Routine-/
   Typ-ACLs; Membership-Kanten samt Grantor/Optionen; Workspace-/Membership-Zahl;
   eine feste Workspace-/User-Stichprobe sowie ID und Zustand eines realen wartenden
   pg-boss-Jobs. Vor dem clusterweiten `NOLOGIN` schriftlich bestätigen, dass die
   Legacy-Rolle in keiner anderen Datenbank oder Anwendung gebraucht wird.
4. Ausschließlich das versionierte, von der lokalen Legacy-Probe mitbenutzte
   [Cutover-Script](../../scripts/db-role-cutover.mts) ausführen. Seine CLI verlangt
   zwei getrennt injizierte, direkte Admin-URLs sowie:

   ```text
   POSTGRES_URL_CUTOVER_ADMIN=<direktes Target mit sslmode=verify-full>
   POSTGRES_URL_CUTOVER_CONTROL=<direkte andere DB desselben Clusters mit sslmode=verify-full>
   CUTOVER_EXPECTED_DATABASE=<exakter DB-Name>
   CUTOVER_EXPECTED_DATABASE_CONNECTION_LIMIT=<-1 oder positiver Ausgangswert>
   CUTOVER_EXPECTED_TARGET=<exakter JSON-Key der Target-URL>
   CUTOVER_EXPECTED_CONTROL_TARGET=<exakter JSON-Key der Control-URL>
   CUTOVER_LEGACY_ROLE=<exakt aufgelöste Rolle>
   CUTOVER_LEGACY_ROLE_SCOPE_CONFIRMED=<Altrolle>,identity_reconciler
   CUTOVER_EXPECTED_IDENTITY_BOOTSTRAP_GRANTOR=<historischer exakter Grantor>
   CUTOVER_SAMPLE_WORKSPACE_ID=<bestehende UUID>
   CUTOVER_SAMPLE_USER_ID=<bestehende UUID>
   CUTOVER_PGBOSS_JOB_ID=<bestehende wartende Job-UUID>
   CUTOVER_CONFIRM=<CUTOVER_EXPECTED_TARGET>:<Altrolle>:OWNERSHIP-CUTOVER
   DB_ROLE_PROVISIONING_ADMIN=<nur Providervertrag; sonst nicht setzen>
   DB_ROLE_BOOTSTRAP_GRANTOR=<nur Providervertrag; sonst nicht setzen>
   DB_ROLE_RETAINED_LEGACY_ROLE=<nur Providervertrag; exakt dieselbe Altrolle>
   ```

   `CUTOVER_RECOVERY_CONFIRM` darf beim normalen Cutover nicht gesetzt sein; sein
   Vorhandensein schaltet die CLI bewusst in den separaten Recovery-Modus.

   Beide `CUTOVER_EXPECTED_*_TARGET`-Werte sind die kanonische, einzeilige
   JSON-Darstellung aus der jeweiligen URL, beispielsweise:

   ```text
   CUTOVER_EXPECTED_TARGET='{"host":"ep-example.neon.tech","port":"5432","database":"app"}'
   CUTOVER_EXPECTED_CONTROL_TARGET='{"host":"ep-example.neon.tech","port":"5432","database":"postgres"}'
   ```

   Keine händische Normalisierung: Das Script verlangt beide Strings exakt. Zusätzlich
   beweist es serverseitig, dass Target und Control verschiedene Datenbanken mit
   identischem `system_identifier`, Serveradresse und Serverport sind.

   Normaler Aufruf: `npx tsx scripts/db-role-cutover.mts`. Das Script führt zuerst den
   read-only Preflight aus, friert das Target anschließend über Control mit
   `ALLOW_CONNECTIONS=false` ein und verlangt danach die exklusive, bereits bestehende
   Target-Session. Phase 1 härtet Rollen und setzt `CONNECTION LIMIT 0`; Phase 2
   verwendet eine eigene serialisierbare Transaktion mit Timeouts,
   Advisory-Xact-Lock und exklusiven Relationslocks. Sie überträgt nur DB und
   `public`/`drizzle → app_owner` sowie `pgboss → app_worker`, einschließlich
   Relationen, Routinen und eigenständiger Typen; `REASSIGN OWNED` ist verboten.
   Legacy-ACLs einschließlich Spalten/Typen und grantor-genaue Membership-Kanten werden
   entzogen. Vor COMMIT müssen Owner, ACLs, Datenstichprobe, Job und exklusiver
   Sessionzustand unverändert stimmen.

   Nach jedem Fehler hinter der Freeze-Grenze versucht das Script, den Zustand erneut
   zu attestieren und `ALLOW_CONNECTIONS=false` idempotent zu setzen. Eine verlorene
   Control-COMMIT-Antwort oder eine unbrauchbare Control-Session wird ausschließlich
   über einen **neuen** PoolClient desselben exakt attestierten Control-Ziels behandelt.
   Nur bei bestätigtem `datallowconn=false` meldet das Script das Target als
   geschlossen. Kann auch die frische Verbindung den Zustand nicht beweisen, endet es
   mit **„Zustand unbestätigt“**. Dann Dienste gestoppt lassen, weder Phase 2 noch
   Recovery blind starten und zuerst Cluster, Target und `datallowconn` administrativ
   über die bestätigte Control-Datenbank neu attestieren.
5. `npm run db:migrate` im Strict-Modus ausführen. 0019 und ACL-Manifest müssen in
   derselben kontrollierten Phase grün werden.
6. Danach `npm run db:roles:verify` und die Ziel-DB-Verifikation ausführen: 0019 genau
   einmal, drei restriktive Principal-Policies plus Trigger, exakter Owner-/ACL-Vertrag,
   unveränderte Daten/Stichprobe/Job, echter Workerzugriff, Runtime-`42501`, erlaubter
   Systempfad. Ein zweiter Strict-Lauf muss idempotent grün sein.

Die lokale Referenzprobe baut genau diesen Verlauf in einer zweiten Datenbank nach:
Legacy-Owner + Schema 0018 + historisches `identity_reconciler INHERIT` + altes
Reconcile-EXECUTE + Bestandsworkspace → Attribut-/ACL-Normalisierung →
Ownership-Cutover → 0019. Daten und Journal bleiben erhalten.

## Fail-closed-Recovery über Control

Recovery ist ein bewusster Admin-Eingriff, kein automatischer Rollback. Vorher anhand
der letzten Scriptausgabe und der Control-Katalogsicht klären, ob der atomare
Target-COMMIT erfolgreich war. Web, Worker, Automationen und alte Legacy-Clients
bleiben währenddessen gestoppt.

Die CLI verlangt auch im Recovery-Modus sämtliche normale Konfiguration einschließlich
`POSTGRES_URL_CUTOVER_ADMIN`, `CUTOVER_EXPECTED_TARGET` und `CUTOVER_CONFIRM`; sie
validiert damit das bestätigte Target, baut aber keine neue Target-Verbindung auf.
Zusätzlich wird exakt gesetzt:

```text
CUTOVER_RECOVERY_CONFIRM='<Control-DB>-><Target-DB>:ALLOW-CONNECTIONS-RECOVERY:<Ausgangs-Connection-Limit>'
```

Beispiel bei Control-Datenbank `postgres`, Target `app` und Ausgangswert `-1`:

```text
CUTOVER_RECOVERY_CONFIRM='postgres->app:ALLOW-CONNECTIONS-RECOVERY:-1' \
  npx tsx scripts/db-role-cutover.mts
```

Der Modus akzeptiert ausschließlich ein Target mit `datallowconn=false` und
`datconnlimit=0` oder dem exakt bestätigten Ausgangswert. Über die Control-Session
stellt er zuerst den Ausgangswert wieder her, setzt dann `ALLOW_CONNECTIONS=true` und
attestiert beides vor und nach COMMIT. Scheitert ein Schritt, versucht das Script das
Target erneut auf `ALLOW_CONNECTIONS=false` festzuhalten und endet rot. Ist die
bisherige Session nach Mutation oder COMMIT nicht mehr beweiskräftig, muss eine frische
Control-Session exakt dieselbe Control-Datenbank, denselben Admin, dieselbe Cluster-ID
und denselben Serverendpunkt attestieren und den Refreeze bestätigen. Andernfalls ist
der Zustand **unbestätigt**, nicht nachweislich geschlossen.

Recovery überträgt keine Owner zurück, reaktiviert keine Rolle, beweist keinen
erfolgreichen Cutover und startet keine Dienste. Nach einer Recovery gilt daher:

1. `CUTOVER_RECOVERY_CONFIRM` aus der Umgebung entfernen.
2. Bei nicht bestätigtem Target-COMMIT den normalen Cutover nach vollständigem Drain
   und Preflight erneut ausführen.
3. Bei bestätigtem Target-COMMIT den Katalog-, Migrations- und Dienstrollenvertrag
   vollständig verifizieren.
4. Erst nach grüner Abnahme Dienste freigeben.

Ist die Control-Datenbank selbst nicht erreichbar oder fehlen dort die attestierten
Superuser-Rechte, bleibt das Target geschlossen. Nicht über einen alternativen
Principal, eine gepoolte URL oder ein manuelles Target-`ALTER DATABASE` umgehen.

## Lokaler Checkpoint

Der aktuelle lokale Nachweis lautet:

```text
npm run db:roles:verify
M1-03 Rollenprobe: 73 Prüfungen grün.
PG18-CREATEROLE-Regressionsprobe: 5 Prüfungen grün.
```

Die 73 Hauptprüfungen enthalten Fresh-/Retained-Legacy-Verlauf,
Control-Freeze/-Unfreeze, Blockade neuer normaler **und** Superuser-Target-Verbindungen,
Drain-/Parallel-DDL-Fail-closed-Verhalten, explizite Recovery sowie Owner-/ACL-/Daten-
und pg-boss-Attestierung. Darin liegen reale Fault-Injections für verlorene Freeze- und
Unfreeze-COMMIT-Antworten, einen fehlgeschlagenen Fresh-Reconnect, eine tote
Control-Session direkt nach erfolgreich quittiertem Unfreeze-COMMIT sowie ein
fehlgeschlagenes `ROLLBACK` bei noch offener Freeze-Transaktion. Diese letzte Probe
belegt zusätzlich, dass der alte Client vor dem Fresh-Connect verworfen wird und der
Refreeze extern committed statt nur innerhalb der alten Transaktion sichtbar ist. Die
fünf separaten PostgreSQL-18-Prüfungen belegen die
Nicht-Superuser-`CREATEROLE`-Bootstrapkante und ihre Grenzen. Das ist der lokale
Checkpoint, ersetzt aber weder einen Restore-Test noch den echten Staging-Nachweis für
Providerrechte, Control-Datenbank und Branch-/Clusteridentität.

## Secret-Ausrollung

| Ziel | Erlaubte DB-Secrets |
|---|---|
| Web/Next.js | `POSTGRES_URL` (`app_runtime`), `POSTGRES_URL_AUTH` (`app_auth`), bei Neon beide erwarteten Tenant-/Timeline-IDs |
| Worker-Container | ausschließlich `POSTGRES_URL_WORKER`, bei Neon beide erwarteten Tenant-/Timeline-IDs |
| Migrationsjob | ausschließlich `POSTGRES_URL_MIGRATE` plus ggf. all-or-none Provider-Topologie |
| App-Bootstrap/System-Recovery | ausschließlich `POSTGRES_URL_SYSTEM`, getrennte Umgebung |
| Legacy-Rollencutover/-Recovery | ausschließlich kurzlebige `POSTGRES_URL_CUTOVER_ADMIN` und `POSTGRES_URL_CUTOVER_CONTROL`, nie in Web/Worker |
| Backup-Host-Cron | ausschließlich `POSTGRES_BACKUP_*` + 0400/0600-Passfile und eigener `S3_BACKUP_*`-Key |

System-, Cutover- und Backup-Credential dürfen nie in Vercel/Web oder Worker-Compose
stehen. Nach Ausrollung alte Instanzen drainieren; erst danach alte Grants/Secrets
endgültig entziehen.

Alle drei laufenden Service-URLs verwenden bei Neon den direkten Endpoint. Vor dem
Start werden `POSTGRES_EXPECTED_NEON_TENANT_ID` und
`POSTGRES_EXPECTED_NEON_TIMELINE_ID` als exakt 32 kleingeschriebene Hexzeichen aus dem
freigegebenen Ziel erfasst. Jeder neue Pool-Client verifiziert Datenbank, Principal,
Rollenattribute, Memberships, Datenbank-/Rollen-Settings und diese serverseitige
Branch-Identität erneut. Nach Branch-Restore oder Endpoint-Transfer müssen beide Werte
bewusst aktualisiert und alle Dienste neu gestartet werden.

## Abnahmeangriffe

- Runtime setzt Actor NULL, fremden Actor und fremden Workspace: Membership-I/U/D
  bleibt `42501`.
- Temporärer Runtime-UPDATE-Grant: Principal-Trigger übernimmt und lehnt ebenfalls ab.
- Runtime/System/Auth/Worker: kein DDL in `public`, kein TRUNCATE.
- Runtime kann weder Owner noch Markerrolle annehmen.
- Auth sieht keine Domänentabelle, darf aber Reconcile.
- Worker schafft pg-boss-Roundtrip mit `createSchema:false`, sieht kein `public`.
- Migrator ohne internes `SET ROLE` besitzt weder Fachrecht noch DDL.
- Ein URL-Queryparameter kann Principal/Host nicht überschreiben; eine transitive
  Marker-Bridge macht den Katalogvertrag rot.
- Fremde Legacy-Grantors, Spalten-/Sequenz-/PUBLIC-Rechte und unklassifizierte neue
  Relations machen den Katalogvertrag rot.
- Driftende Default-ACLs werden vor Drizzle repariert; unbekannte Default-Grantors
  stoppen den Lauf, bevor ein neues Objekt entstehen kann.
- Ein privilegierter oder über eine unbekannte Rolle verbundener Migrator scheitert,
  bevor Drizzle-Schema oder Journal verändert werden.
- `pg_has_role('app_runtime','neon_superuser','MEMBER')` ist false; ebenso für alle
  laufenden Limited Roles.

## Rollback

- Vor Eintritt in den Control-Freeze: neue Dienste stoppen; alte kompatible Secrets nur
  nach Vier-Augen-Freigabe kurz wieder einsetzen. Solange `datallowconn=true` und noch
  keine Rollen-/Owner-Mutation committed ist, wurde die harte Grenze nicht betreten.
- Nach dem Control-Freeze: Ein bestätigtes `ALLOW_CONNECTIONS=false` blockiert auch
  neue Superuser-Verbindungen. Bei einer verlorenen Control-Antwort darf dieser Zustand
  jedoch erst nach frischer Reattestierung und Refreeze behauptet werden. Meldet das
  Script **„Zustand unbestätigt“**, ist weder „offen“ noch „geschlossen“ bewiesen:
  Dienste gestoppt lassen und zuerst über die bestätigte Control-Datenbank neu
  attestieren. Ausschließlich die oben beschriebene, exakt bestätigte Control-Recovery
  darf danach wieder öffnen.
- Nach Schreibtraffic: vorwärts korrigieren. Keine alten Migrationen ändern, keine
  Ownership pauschal zurückschieben, keine Runtime-Membership-DML-Grants als Notlösung.
- Control-Freeze, Phase-1-Quarantäne, atomarer Target-Cutover und Control-Unfreeze sind
  getrennte Commitgrenzen. Ist Phase 1 committed und Phase 2 rot, bleibt der exakte
  Zustand `ALLOW_CONNECTIONS=false` plus `CONNECTION LIMIT 0` bestehen. Ist der
  Target-Cutover committed, aber der Control-Unfreeze rot, refreezt eine frische,
  exakt reattestierte Control-Session das Target. Nur nach bestätigtem Refreeze bleibt
  es nachweislich geschlossen; ohne diesen Beleg ist sein Zustand unbestätigt.
  Control-Recovery stellt dann nur die Erreichbarkeit wieder her. Das deaktivierte
  Legacy-Secret ist nicht automatisch kompatibel und wird nicht als spontaner Rollback
  reaktiviert.
- Grant-/ACL-Fehler vor dem Target-COMMIT rollen die gesamte Phase 2 zurück und halten
  das Target geschlossen. Scheitert erst der nachgelagerte Migrations-/Manifestlauf
  nach erfolgreich committedem Ownership-Cutover, rollt nur dessen Transaktion zurück;
  Ursache vorwärts beheben und kontrolliert erneut laufen lassen.
- Lock-Timeout: Blocker-Transaktion identifizieren/koordiniert beenden, nicht Timeout
  erhöhen und blind wiederholen.
