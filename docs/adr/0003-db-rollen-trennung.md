# ADR 0003: Datenbank-Rollentrennung — Known-Limitation für M0

Datum: 2026-08-26 · Status: akzeptiert (als Known-Limitation für M0)

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

### Zielbild der Rollen

| Rolle | Login | Zweck | Rechte |
| --- | --- | --- | --- |
| `app_owner` | **NOLOGIN** | Eigentümerin aller Objekte, Ziel von `SET ROLE` im Migrationslauf | DDL auf `public`; niemals von einem laufenden Dienst genutzt |
| `app_migrator` | ja | führt `scripts/migrate.mts` aus | `GRANT app_owner TO app_migrator`, im Migrationsjob `SET ROLE app_owner`; sonst keine Rechte |
| `app_runtime` | ja | Next.js-Portal (Domänen-Zugriff über `withTenant`/`withAuthorizedTenant`) | `SELECT/INSERT/UPDATE/DELETE` auf Domänentabellen; **kein** DDL, **kein** TRUNCATE, **kein** Zugriff auf `auth_*` |
| `app_auth` | ja | ausschließlich better-auth (`lib/db/auth-client.ts`, `POSTGRES_URL_AUTH`) | DML auf `auth_*` + `INSERT`/gezieltes `UPDATE` auf `user_identity`; **kein** Zugriff auf Domänentabellen |
| `app_worker` | ja | pg-boss-Worker | DML im Schema `pgboss`, lesender/schreibender Domänenzugriff nur so weit wie Jobs es brauchen; **kein** DDL |

### Grants (Skizze für das Neon-Setup)

```sql
create role app_owner nologin;
create role app_migrator login password :'migrator_pw' nosuperuser nobypassrls;
create role app_runtime  login password :'runtime_pw'  nosuperuser nobypassrls;
create role app_auth     login password :'auth_pw'     nosuperuser nobypassrls;
create role app_worker   login password :'worker_pw'   nosuperuser nobypassrls;

grant app_owner to app_migrator;               -- Migrationsjob macht SET ROLE app_owner

-- Niemand außer dem Owner legt Objekte an:
revoke create on schema public from public;
grant  usage  on schema public to app_runtime, app_auth, app_worker;

-- Domänen-Runtime: DML, aber kein TRUNCATE und kein DDL.
grant select, insert, update, delete on workspace, membership, user_identity,
      site, domain_events, audit_log to app_runtime;
revoke truncate on all tables in schema public from app_runtime;

-- Auth-Rolle sieht NUR die Auth-Tabellen (+ die Identity-Kopplung).
grant select, insert, update, delete on auth_user, auth_session, auth_account,
      auth_verification, auth_rate_limit to app_auth;
grant insert, update, select on user_identity to app_auth;

-- Worker: eigenes Schema, Domänenzugriff nach Bedarf.
grant usage on schema pgboss to app_worker;
grant select, insert, update, delete on all tables in schema pgboss to app_worker;

-- Default-Privilegien, damit künftige Migrationen die Grants nicht vergessen:
alter default privileges for role app_owner in schema public
  grant select, insert, update, delete on tables to app_runtime;
```

Zusätzlich: `alter default privileges … revoke truncate …` bzw. ein expliziter
`revoke truncate` nach jeder Migration, damit append-only nicht allein am Trigger hängt.

### Env-Variablen

- `POSTGRES_URL` — `app_runtime` (Portal)
- `POSTGRES_URL_AUTH` — `app_auth` (bereits in `lib/db/auth-client.ts` vorbereitet und
  ausgewertet; solange nicht gesetzt, fällt Auth auf `POSTGRES_URL` zurück — genau das ist
  die hier dokumentierte Limitation)
- `POSTGRES_URL_MIGRATE` — `app_migrator`, nur im Deploy-/Migrationsschritt
- Worker: eigene Variable für `app_worker`

## Konsequenzen

- **M0 bleibt mergefähig**, die Restlücke ist benannt statt unsichtbar.
- Das Safety-Gate in `scripts/migrate.mts` (kein Superuser, kein `BYPASSRLS`) bleibt
  unverändert bestehen und gilt auch für `app_migrator`.
- `lib/db/auth-client.ts` liest bereits `POSTGRES_URL_AUTH ?? POSTGRES_URL`; das Umstellen
  auf `app_auth` ist danach eine reine Konfigurationsänderung ohne Codeänderung.
- Die Testumgebung bildet weiterhin den heutigen Zustand ab: `tests/setup/embedded-postgres.ts`
  legt eine Nicht-Superuser-Rolle `app_test` an, die Eigentümerin ihrer Tabellen ist. Nach
  der Umstellung sollte sie um die gleiche Rollenteilung erweitert werden, sonst testet CI
  eine andere Rechtelage als Produktion.
- Solange die Trennung aussteht, gilt: **jeder** Code, der auf `lib/db/client.ts` oder
  `lib/db/auth-client.ts` zugreift, ist sicherheitsrelevant. Die dependency-cruiser-Regeln
  `db-client-nur-ueber-tenant` und `auth-client-nur-fuer-auth` halten diesen Kreis klein.
- Offener Folgepunkt, der von derselben Entscheidung abhängt: das idempotente Nachtragen
  von `user_identity.auth_user_id` für bereits eingeladene Identitäten (siehe
  `drizzle/0011_user_identity_auth_link.sql` und `lib/auth.ts`). Eine eigene `app_auth`-Rolle
  ist der saubere Ort, um diesen Bootstrap-Pfad zu erlauben, ohne die Identity-RLS für alle
  aufzuweichen.
