# ADR 0003: Getrennte Datenbankrollen und nicht fälschbarer Membership-Principal

Datum: 2026-08-27 · grundlegend nachgeschärft 2026-08-29 · Status: akzeptiert

## Kontext

Eine einzige DB-Rolle war gleichzeitig Tabellenowner, Portal, Auth, Worker und Migrator.
FORCE RLS schützte zwar den Tabellenowner vor dem normalen Owner-Bypass, nicht aber vor
DDL (`DISABLE ROW LEVEL SECURITY`, Policy-/Trigger-Änderung), TRUNCATE oder zu breiten
Objekt-Grants.

M1-02 ergänzte `app.actor_id`, restriktive Self-DML-Policies und Membership-Trigger.
Dabei wurde die frühere Fassung dieser ADR widerlegt: Sie gab `app_runtime` weiterhin
direktes Membership-DML. Custom-GUCs sind frei setzbare Placeholder und können keinen
SQL-Principal authentifizieren. Eine Runtime-Verbindung hätte den Actor leeren und den
actorlosen Systempfad verwenden können.

## Entscheidung

### Statische Rollen

| Rolle | Login | Rechte |
|---|---:|---|
| `app_owner` | nein | Owner von `public`, `drizzle` und App-Objekten; keine laufende Verbindung |
| `app_migrator` | ja | nur `SET ROLE app_owner`, `INHERIT FALSE` |
| `app_runtime` | ja | Tenant-Lesen, Site-DML, Event-/Audit-INSERT; Membership SELECT-only |
| `app_system` | ja | isolierter Bootstrap/Recovery; Membership-DML und dafür nötiges Workspace-Lock |
| `app_auth` | ja | fünf `auth_*`-Tabellen und Reconcile-EXECUTE |
| `app_worker` | ja | Owner des Schemas `pgboss`, keine Rechte in `public` |
| `app_membership_writer` | nein | objektlose Markerrolle für Membership-DML |
| `identity_reconciler` | nein | Owner der engen Reconcile-Definer-Funktion |

Alle Rollen sind `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`,
`NOCREATEROLE` und `NOREPLICATION`. Nur die fünf Dienstrollen tragen `LOGIN`.

Die Mitgliedschaftsmatrix ist exakt:

```text
app_owner               → app_migrator  ADMIN false · INHERIT false · SET true
app_membership_writer   → app_system    ADMIN false · INHERIT false · SET false
app_membership_writer   → app_owner     ADMIN false · INHERIT false · SET false
identity_reconciler     → app_owner     ADMIN true  · INHERIT false · SET false
```

`identity_reconciler` wird vor der ersten Migration angelegt. Damit braucht
`app_owner` kein globales `CREATEROLE`; das enge ADMIN-Recht reicht für den kurzzeitigen
SET-Schritt der Migrationen 0015/0016 und des Grant-Manifests.

### Membership ist zusätzlich an eine echte Rolle gebunden

Migration 0019 ergänzt für INSERT, UPDATE und DELETE je eine restriktive Policy mit:

```sql
pg_catalog.pg_has_role(current_user, 'app_membership_writer', 'MEMBER')
```

Der BEFORE-STATEMENT-Trigger prüft denselben Ausdruck als erste Anweisung und antwortet
bei einer fremden Rolle stabil mit `42501`. Damit sind zwei unabhängige Schranken aktiv:

1. `app_runtime` besitzt kein Membership-I/U/D/TRUNCATE.
2. Ein später versehentliches DML-Re-Grant bleibt wegen Rollen-Policy und Trigger
   wirkungslos.

GUC-Spoofing ist für Membership-DML dadurch irrelevant. Die bestehenden Tenant-,
Actor-, Admin-, Self-DML-, Lock- und READ-COMMITTED-Regeln bleiben zusätzlich bestehen.

`app_system` ist kein Online-Nutzerpfad. Sein Secret liegt ausschließlich in einem
isolierten Bootstrap-/Recovery-Prozess und nie in Next.js/Vercel oder dem Worker. Ein
späterer Membership-Endpunkt braucht eine eigene Command-Spec mit live DB-verifizierter
Session; er darf Runtime-DML nicht zurückbringen.

### Ownership und Objekt-ACLs

- `app_owner`: `public`, `drizzle`, alle Tabellen/Sequenzen darin und alle
  Anwendungsfunktionen außer Reconcile.
- `identity_reconciler`: Owner und einziger Definer-Principal von
  `reconcile_user_identity(text,text)`; darunter nur `membership: SELECT` sowie
  `user_identity: SELECT/INSERT/UPDATE`, die die Funktion selbst benötigt.
- `app_worker`: `pgboss` und dessen Objekte.

`scripts/db-role-contract.mts` ist das ausführbare Allowlist-Manifest. Es entzieht nach
jeder strikten Migration alle Dienstrechte auf `public`, grantet nur den beschriebenen
Satz und verifiziert Rollenattribute, Mitgliedschaften, Owner, Tabellen- und
Funktions-ACLs katalogbasiert innerhalb derselben Transaktion. Es gibt keine
Default-DML-Grants auf künftige Tabellen. Die Mitgliedschaftsprüfung betrachtet jede
Kante mit mindestens einem App-Principal sowie die effektive transitive Closure;
unbekannte Provider-/Bridge-Rollen und `neon_superuser` sind damit ebenfalls Drift.
Tabellen-, Spalten-, Sequenz-, Funktions- und Schema-ACLs werden direkt per
`aclexplode` geprüft, damit Rechte fremder Legacy-Grantors nicht durch die
Sichtbarkeitsregeln des `information_schema` verschwinden. Die Allowlist umfasst jeden
Nicht-Owner-Grantee; auch ein alter, unbekannter Login-Principal macht den Vertrag rot.
Ein exaktes
Relationsinventar erzwingt außerdem die bewusste Klassifikation jeder neuen Tabelle,
View, Materialized View, Sequenz oder Foreign Table.
Das vollständige Nicht-System-Schemainventar ist exakt `public`, `drizzle`, `pgboss`;
damit kann kein fremdes Legacy-/Extension-Schema mit Runtime-, PUBLIC- oder
SECURITY-DEFINER-Zugriff außerhalb der Objekt-Allowlist liegen. Ein providerseitiges
Staging-Schema muss vor Pilot bewusst klassifiziert werden und bleibt bis dahin rot.
Zusätzlich attestiert der Zielkatalog live RLS/FORCE, alle Policy-Ausdrücke und
Schutztrigger sowie Sprache, Volatilität, Parallelität, `search_path`, Definer-Flag und
SHA-256 des Katalogbodys jeder App-Funktion. Nur `reconcile_user_identity(text,text)`
steht auf der SECURITY-DEFINER-Allowlist.

Globale und `public`-spezifische Default-ACLs von `app_owner` und
`identity_reconciler` werden bereits **vor** Drizzle entzogen und katalogbasiert
verifiziert. Damit kann eine neue Relation/Funktion auch bei späterem Default-ACL-Drift
nicht vorübergehend Runtime-, PUBLIC- oder Fremdrollenrechte erben. Nach der Migration
wird derselbe Vertrag erneut angewandt.

### Verbindungs- und Migrationsvertrag

| Variable | Principal | Ort |
|---|---|---|
| `POSTGRES_URL` | `app_runtime` | Portal |
| `POSTGRES_URL_AUTH` | `app_auth` | Better Auth |
| `POSTGRES_URL_MIGRATE` | `app_migrator` | direkter, ungepoolter Migrationsjob |
| `POSTGRES_URL_WORKER` | `app_worker` | Worker/pg-boss |
| `POSTGRES_URL_SYSTEM` | `app_system` | nur isoliertes Bootstrap/Recovery |
| `POSTGRES_BACKUP_*` + Passfile | eigener privilegierter Backupweg | nur Host-Cron/Restore-Probe |

Es existiert kein Fallback zwischen diesen Variablen. `DB_ROLE_MODE` defaultet auf
`strict`; `test-legacy-single` ist nur unter Test/Vitest und für eine Datenbank mit
`test` im Namen erlaubt.

Der Migrator verbindet direkt als `app_migrator`, setzt intern beim Startup
`role=app_owner`, prüft tatsächlichen Session-/Current-User, Superuser/BYPASSRLS,
serialisiert Läufe per Advisory Lock, setzt harte Timeouts und wendet anschließend das
Grant-Manifest an. Startup-`options` in Dienst-URLs sind verboten. Bei Neon ist für
Migrationen der direkte Endpoint Pflicht; Transaction-Pooling trägt keinen
sessionweiten Rollenwechsel zuverlässig.

Noch vor Advisory Lock und Drizzle prüft der Migrator beide Principals vollständig:
`app_migrator` muss LOGIN und sonst unprivilegiert sein, `app_owner` NOLOGIN und
unprivilegiert; die vier erlaubten fachlichen Membership-Kanten sind exakt. Jede Bridge- oder
`neon_superuser`-Mitgliedschaft endet vor Journal-/Schemaänderung. Datenbankowner
`app_owner` und die Schemaowner `public → app_owner`, `pgboss → app_worker` sowie
`drizzle → app_owner` (falls bereits vorhanden) sind ebenfalls Pre-Drizzle-Gates.
Bereits angewandte Journalzeilen müssen außerdem exakt den SHA-256-Hashes der
versionierten lokalen SQL-Dateien und einem lückenlosen Präfix entsprechen; der Check
läuft nach Erwerb des Advisory Locks erneut. Historische Migrationen sind immutable.

Nach dem Advisory Lock, aber weiterhin vor Drizzle, repariert und prüft eine eigene
Transaktion die globalen und schemaspezifischen Default-ACLs. Unbekannte Grantors
bleiben fail-closed und stoppen den Lauf vor neuen Objekten.

Postgres-Queryparameter können bei `node-postgres` Authority-Felder überschreiben. Alle
Dienst- und Migrations-URLs werden deshalb vor dem Verbindungsaufbau über eine kleine
Allowlist geparst: ausschließlich `sslmode=verify-full` ist zulässig und für jedes
nicht lokale Ziel Pflicht. `sslmode=require` prüft den Hostnamen nicht ausreichend;
`channel_binding` ist kein wirksamer node-postgres-URL-Schalter und wird nicht als
Scheinsicherheit akzeptiert. Insbesondere `user`, `password`, `host`, `port`,
`database`, `db` und `options` sind fail-closed verboten.

Authority-Passwort und Port sind Pflicht; rohe Leer-/Steuerzeichen sowie ambiente
`PG*`-Ziel-/Startup-Overrides werden ebenfalls fail-closed abgelehnt.

Der Legacy-Ownership-Cutover besitzt eine separate Control-Datenbank desselben
PostgreSQL-18-Clusters. Sobald eine Freeze-/Unfreeze-COMMIT-Antwort verloren geht oder
eine Zustandsattestierung nach der Control-Mutation fehlschlägt, gilt der bisherige
PoolClient als nicht beweiskräftig. Er wird vor dem Fresh-Connect verworfen, sodass
auch eine offene Transaktion und ihr `pg_database`-Kataloglock enden. Eine frische
Einwegverbindung muss danach Control-Datenbank, Admin, PostgreSQL-Version,
`system_identifier` und tatsächlichen Serverendpunkt exakt reattestieren,
`ALLOW_CONNECTIONS=false` idempotent setzen und den Wert erneut lesen. Nur dann darf
der Fehlerpfad „fail-closed“ behaupten. Schlägt
einer dieser Schritte fehl, ist die fachlich ehrliche Ausgabe „Zustand unbestätigt“;
Phase 2 und Recovery bleiben bis zur administrativen Reattestierung gesperrt.

Neon-Console/API/CLI-erzeugte Rollen erben `neon_superuser` und damit BYPASSRLS. Alle
laufenden Limited Roles werden deshalb per SQL erzeugt und per Katalogprüfung gegen eine
Mitgliedschaft in `neon_superuser` geprüft, bevor ein Pilot freigegeben wird.

## Verworfene Optionen

1. **Ein Owner für alles:** DDL-/TRUNCATE- und Blast-Radius bleiben zu groß.
2. **Runtime-DML plus Actor-GUC:** GUC ist vom SQL-Caller fälschbar.
3. **Parameter-ACL auf Custom-GUC:** entzieht einem USERSET-Placeholder das Setzen nicht.
4. **SET ROLE pro Nutzer:** skaliert nicht mit Pooling; mit SET-Recht vom Runtime-SQL
   selbst wählbar, ohne SET-Recht auch für legitimen Code unbrauchbar.
5. **Security-Definer-Funktion, die nur Actor-ID annimmt:** verschiebt denselben Spoof in
   eine privilegierte Funktion. Ein künftiger Command muss eine live Session prüfen.
6. **Pauschale Default-Grants:** jede neue Tabelle wäre vor fachlicher Prüfung sofort
   beschreibbar.

## Konsequenzen

- Der öffentlich erreichbare Runtime-Principal kann Memberships weder actorlos noch mit
  gefälschtem Actor schreiben, selbst bei einem einzelnen Grant-Drift.
- Auth, Worker und Migrator verlieren gegenseitig ihre Datenflächen.
- Neue Tabellen machen den strikten Migrationslauf rot, bis ihre ACL bewusst ergänzt ist.
- Migrations- und Betriebssetup werden aufwendiger: Rollen müssen vorab provisioniert,
  Legacy-Ownership kontrolliert übertragen und Secrets getrennt betrieben werden.
- FORCE RLS bleibt bindend, ist aber nicht mehr die einzige Schicht.
- Andere direkt beschreibbare Tenant-Tabellen vertrauen weiterhin dem Workspace-GUC und
  parametrisierten, strukturell begrenzten Anwendungspfaden. Diese ADR behauptet keine
  Sicherheit gegen beliebiges SQL auf allen Fachobjekten.

## Verifikation und Rollout-Gate

`npm run db:roles:verify` bootet flüchtiges PostgreSQL und prüft fresh `0000→0019`,
Idempotenz, exakte Katalog-ACLs, GUC-NULL/Spoof, Grant-Drift, DDL/TRUNCATE/SET ROLE,
System-Bootstrap, Auth-Reconcile, Migrator ohne Ownerrolle und echten pg-boss-Betrieb.
Eine zweite Datenbank beweist zusätzlich Legacy-Ownership mit Bestandsdaten auf 0018,
Cutover und anschließendes 0019 ohne Daten-/Journalverlust.

Pilot/Produktion bleibt NO-GO, bis zusätzlich der Legacy-Ownership-Cutover mit
Bestandsdaten, reale Neon-Rollen ohne `neon_superuser`, getrennte Deployment-Secrets,
vollständiger Backup/PITR-Restore und unabhängiger Security-/Betriebsreview grün sind.
Das ausführbare Betriebsverfahren ist in `docs/runbooks/db-role-cutover.md` festgehalten.

## Quellen

- PostgreSQL 18: Role Membership, `GRANT`, `SET ROLE`, Row Security Policies, Custom
  Options und SECURITY DEFINER (`postgresql.org/docs/18`).
- Neon: Roles, Database Access und Connection Pooling (`neon.com/docs`).
