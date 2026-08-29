# M1-02 — Der Akteur wird in der Datenbank sichtbar

> Status: REVIEWED · lokaler M0-Checkpoint · Pilot/Produktion NO-GO
> · erstellt 2026-08-28 · sicherheitsverschärft und geprüft 2026-08-29
> Anlass: Ist-Bericht vom 2026-08-28, Befund „Rechteschichten 2 und 3 ohne strukturellen
> Rückhalt — membership-Selbstbeförderung möglich".

## Der gemeldete Befund und was darunter liegt

Gemeldet wurde: `tenant_isolation` auf `membership` (`drizzle/0001_rls_core.sql:17-21`)
gilt `FOR ALL` und filtert ausschließlich den Workspace, nicht die Rolle. Ein `viewer`
kann in seiner eigenen, regulären Mandantentransaktion

```sql
update membership set role = 'admin' where user_id = <selbst>;
```

ausführen. Weder eine restriktive Policy noch ein Trigger noch ein Test steht dem
entgegen. Heute ist das nicht erreichbar, weil es keinen Endpunkt für Mitgliedschaften
gibt — ab dem ersten ist es akut.

Beim Nachsehen zeigt sich die eigentliche Ursache, und sie ist größer als der Befund:
**die Datenbank weiß nicht, wer handelt.** Gesetzt wird ausschließlich
`app.workspace_id` (`lib/db/tenant.ts`). Die einzige weitere Sitzungsvariable im
System, `app.identity_reconcile_email` (`drizzle/0014`), ist transaktionslokal für den
Auth-Reconcile reserviert.

Eine Policy kann deshalb prinzipiell keine Aussage über den Handelnden treffen. Das
trifft nicht nur diesen einen Fall:

- `modules/README.md` kündigt `external_only` und Assignment-Sichtbarkeit als
  **restriktive Policies** an. Beide sind Aussagen über den Akteur („dieser Nutzer sieht
  nur die ihm zugewiesenen Projekte"). Ohne Akteur in der Sitzung sind sie nicht
  formulierbar.
- `lib/permissions.ts:5` führt `external_only` bereits als Capability.
- Die Architektur nennt Bereichs-Toggles und Teams als additiv nachrüstbar — auch das
  sind Akteur-Aussagen.

Der Akteur in der Sitzung ist damit kein Zusatz für diesen Befund, sondern eine
nicht-nachrüstbare Tag-1-Position, die in M0 gefehlt hat. Heute kostet sie eine
Migration über sechs Tabellen. Nach M1 sind es sechsundzwanzig.

## Zu bauen

### 1. `app.actor_id` als zweite Sitzungsvariable

`lib/db/tenant.ts` verwaltet sie transaktionslokal, direkt neben `app.workspace_id`:

- Jeder verwaltete Tenant-Start setzt als **erste** SQL-Anweisung die Transaktions-
  isolation explizit auf `READ COMMITTED`. Damit gilt der Membership-Sperrvertrag auch,
  wenn ein Pool-Default versehentlich auf `REPEATABLE READ` geändert wurde.
- Jeder verwaltete Tenant-Start setzt `app.actor_id` zuerst per `SET LOCAL` auf den
  Leerwert zurück. Damit kann weder ein vorheriger autorisierter Aufruf noch ein
  sessionweit vergifteter Pool-Parameter in einen späteren `withTenant`-Aufruf wirken.
- `withSessionTenant` überschreibt den Leerwert mit der über `auth_user_id` aufgelösten
  `user_identity.id`, aber erst **nach** Membership-Lookup, Rollenvalidierung und
  vollständig gebautem `ServiceCtx`.
- `withAuthorizedTenant` setzt ebenfalls erst danach einen Actor, authentifiziert die
  übergebene `userIdentityId` aber bewusst nicht selbst. Es ist deshalb ausschließlich
  eine privilegierte Adaptergrenze und strukturell kein Browser-/Produktpfad.
- `withTenant` belässt den Leerwert. Dieser Pfad ist der privilegierte System-/Worker-
  Bypass ohne Nutzerbezug (`lib/db/tenant.ts`); ein erfundener Akteur wäre
  schlimmer als gar keiner.

Die Leseseite bekommt eine Helferfunktion in SQL, analog zum bestehenden
`nullif(current_setting('app.workspace_id', true), '')`-Muster:

```sql
-- Gibt die handelnde user_identity.id zurück, oder NULL auf System-/Worker-Pfaden.
-- nullif(): nach einer Transaktion mit SET LOCAL reverted der Wert auf einer
-- wiederverwendeten Pool-Verbindung auf '' statt auf NULL (siehe die ausführliche
-- Begründung in drizzle/0001_rls_core.sql).
create or replace function public.app_actor_id() returns uuid
  language sql stable parallel safe security invoker
  set search_path = pg_catalog as $$
  select nullif(pg_catalog.current_setting('app.actor_id', true), '')::pg_catalog.uuid
$$;
```

### 2. Erste Schranke: actorbasierte restriktive Policies

Der kanonische P0-Auftrag fordert nicht nur den Actor-Kontext, sondern auch eine erste
actorbasierte restriktive Policy. `membership` ist bereits die passende reale Entität:
Die Datenbank kann dort jede Selbstmutation verhindern, ohne die SELECT-Sichtbarkeit der
eigenen Membership zu verändern.

Es entstehen drei **restriktive**, befehlsspezifische Policies für INSERT, UPDATE und
DELETE. Ihr Prädikat ist jeweils sinngemäß:

```sql
public.app_actor_id() is null or user_id <> public.app_actor_id()
```

- `NULL` ist die ausdrücklich erlaubte System-/Worker-Ausnahme.
- Bei INSERT und UPDATE steht das Prädikat in `WITH CHECK`; bei UPDATE und DELETE auch in
  `USING`, sodass sowohl alte als auch neue Identität geschützt sind.
- Keine Policy gilt für SELECT. Der Membership-Lookup muss den eigenen Datensatz weiter
  sehen können, bevor `app.actor_id` gesetzt wird.
- Alle Zusatz-Policies sind `AS RESTRICTIVE`; die einzige permissive Policy bleibt
  `tenant_isolation`. So kann keine zweite OR-verknüpfte Policy die Tenant-Grenze öffnen.

Diese Schicht blockiert eigene INSERT-, UPDATE- und DELETE-Versuche einschließlich
`user_id`-Transfer. Sie entscheidet bewusst noch nicht, **wer fremde** Memberships
verwalten darf; das ist die zweite Schranke.

### 3. Zweite Schranke: vollständige Membership-DML-Trigger

Zwei Trigger auf `INSERT OR UPDATE OR DELETE` erzwingen den restlichen Vertrag unabhängig
von einem späteren Membership-Service:

1. Ein `BEFORE … FOR EACH STATEMENT`-Trigger verlangt einen existierenden
   `app.workspace_id`, lehnt jede andere Isolation als `READ COMMITTED` stabil mit
   SQLSTATE `25001` ab und sperrt die zugehörige Workspace-Zeile `FOR UPDATE` — bevor
   PostgreSQL eine Ziel-Membership sperren kann.
2. Der `BEFORE … FOR EACH ROW`-Trigger hält `id`, `workspace_id`, `user_id` und
   `created_at` bei UPDATE unveränderlich —
   auch auf dem Systempfad. Eine Identität wird nicht „umgehängt"; Recovery erfolgt
   explizit als DELETE+INSERT oder als eigene Forward-Migration.
3. Ist `app_actor_id()` NULL, sind danach Bootstrap- und Recovery-Schreibvorgänge auf
   dem actorlosen Systempfad erlaubt. Die bestehende Tenant-RLS gilt trotzdem.
4. Ist ein Actor gesetzt, blockiert der Row-Trigger jede Mutation, bei der `OLD.user_id`
   oder `NEW.user_id` dem Actor entspricht. Damit bleiben auch Self-DELETE,
   Self-INSERT und Identitätstransfers geschlossen, falls eine Policy versehentlich
   entfernt oder umgangen wird.
5. Für jede fremde Membership ermittelt der Row-Trigger die Actor-Rolle im **selben
   Ziel-Workspace**. Nur `admin` darf anlegen, ändern oder löschen. Viewer/Editor,
   fehlende Membership und „Admin in A, aber Viewer in B" enden fail-closed.
6. Die Statement-Sperre serialisiert gegensinnige Admin-Aktionen ohne die Lock-Reihenfolge
   `Ziel-Membership → Workspace`, die bei gegenseitigem DELETE einen Deadlock erzeugen
   würde. Unter erzwungenem `READ COMMITTED` sieht die anschließende Rollenprüfung eine
   inzwischen gelöschte oder herabgestufte Actor-Membership und lehnt den zweiten Vorgang
   ab. `REPEATABLE READ` ist ausdrücklich nicht zugelassen, weil dessen alter Snapshot
   diese Änderung weiter sehen könnte.
7. Autorisierungsablehnungen verwenden SQLSTATE `42501` (`insufficient_privilege`), die
   Isolationsablehnung `25001` (`active_sql_transaction`). Beide Funktionen sind
   ausdrücklich `VOLATILE` und `SECURITY INVOKER`, haben einen festen `search_path` und
   referenzieren ihre Objekte schemaqualifiziert. `VOLATILE` ist für die Rollenabfrage
   nach dem Workspace-Wait Teil des frischen `READ COMMITTED`-Snapshot-Vertrags.

**Vier-Augen-Folge:** Ein Actor kann die eigene Membership niemals ändern oder löschen.
Ein alleiniger Admin kann sich deshalb nicht selbst herabstufen und keinen Workspace
ohne Admin erzeugen. Ein anderer Admin bleibt für jede Änderung nötig. Der actorlose
Systempfad ist die dokumentierte Bootstrap-/Recovery-Ausnahme.

### 4. Trust Boundary und bewusst vertagte Filter

Custom-GUCs sind Kontexttransport, keine Datenbank-Authentifizierung: Ein SQL-Caller kann
`set_config` selbst aufrufen. `withTenant` und `app_actor_id() IS NULL` sind daher
privilegierte Vertrauensgrenzen. M1-02 schützt gegen vergessene Serviceprüfungen und
normale Produktpfade, nicht gegen eine vollständig kompromittierte Runtime-Verbindung;
ADR 0003 muss den actorlosen Membership-DML vor dem ersten Pilotkunden auf echte
Runtime-/Systemrollen begrenzen. Produktive Browserpfade nutzen ausschließlich
`withSessionTenant`; `withAuthorizedTenant` bleibt ein vertrauenswürdiger Adapterpfad,
weil seine `userIdentityId` vom Aufrufer stammt.

Kein `external_only`, keine Assignment-Sichtbarkeit, keine Teams: Dafür fehlen noch die
fachlichen Entitäten. M1-02 liefert aber bereits eine echte actorbasierte restriktive
Policy auf `membership` und macht spätere Filter formulierbar.

## Tests

`tests/db/membership-schutz.test.ts` bildet eine vollständige Rechte-Matrix:

1. Actor-Kontext: Systempfad NULL; Session- und Trusted-Adapter-Pfad tragen exakt die
   aufgelöste `user_identity.id`; fehlgeschlagene Membership-Auflösung setzt keinen
   Actor.
2. Pool-Sicherheit: Commit **und** Rollback lecken auf derselben `max: 1`-Verbindung
   keinen Actor; `pg_backend_pid()` beweist dieselbe Verbindung. Ein vorher sessionweit
   gesetzter Fremdwert wird innerhalb jedes verwalteten Tenant-Starts auf NULL gesetzt.
3. Self-DML: Upgrade, Downgrade, Capability-Änderung, DELETE, zweiter INSERT und
   `user_id`-Transfer bleiben wirkungslos beziehungsweise werden mit RLS/`42501`
   abgelehnt; die ursprüngliche Zeile bleibt unverändert.
4. Fremd-DML: Viewer und Editor dürfen fremde Memberships weder anlegen, ändern noch
   löschen. Ein Admin darf alle drei Operationen bei einem anderen Mitglied.
5. Cross-Tenant: Dieselbe Identität als Admin in A und Viewer in B erhält in B keine
   Adminrechte. Payload-/SQL-Werte können den Ziel-Workspace nicht umschalten.
6. Systempfad: erste Membership anlegen sowie Rolle/Capabilities ändern und löschen
   bleibt möglich; unveränderliche Identitätsspalten bleiben auch dort geschützt.
7. Zwei parallele Admins können sich weder gegenseitig löschen noch herabstufen: pro
   Probe committed exakt ein Vorgang, exakt einer endet mit `42501`, und es bleibt exakt
   ein Admin. Ein sessionweiter `REPEATABLE READ`-Default wird am verwalteten Start auf
   `READ COMMITTED` zurückgesetzt; direktes Membership-DML in einer manuell begonnenen
   `REPEATABLE READ`-Transaktion endet mit `25001`.
8. Katalogvertrag: genau drei actorbasierte Membership-Policies, alle `RESTRICTIVE` und
   befehlsspezifisch; beide Trigger und alle Funktionen sind vorhanden,
   die Triggerfunktionen sind `VOLATILE`/`SECURITY INVOKER` und tragen den festgelegten
   Funktionsvertrag.

## Abnahme

- RED-Nachweis vor Implementierung; danach Fokuslauf, `npm run check` und
  `npm run build` grün.
- Leere Datenbank und Upgrade 0017 → 0018 mit vorhandenen Membership-Zeilen sind
  erfolgreich; `npm run db:generate` meldet keinen Drift.
- Commit-/Rollback-/Poisoning-Tests belegen, dass der Actor innerhalb der verwalteten
  Transaktionsgrenze nicht leckt.
- Self-, Viewer-/Editor-, Admin-, System- und Cross-Tenant-Matrix ist vollständig grün.
- Die Delete- und Demote-Races beweisen jeweils exakt einen Commit, eine
  `42501`-Ablehnung und einen verbleibenden Admin; nicht unterstützte Isolation wird
  DB-seitig mit `25001` abgewiesen.
- Unabhängiger Security- und Migrationsreview ohne offene P0/P1-Funde innerhalb des
  deklarierten verwalteten Produktpfads. Das folgende Pilot-Gate bleibt separat bindend.
- `docs/blaupause/04-architektur.md` und `modules/README.md` erwähnen `app.actor_id` als
  verfügbare Grundlage, die erste echte restriktive Membership-Policy, den actorlosen
  Vertrauenspfad und die Pflicht zur Service-seitigen Audit-Ablehnung.

### Verifikation vom 2026-08-29

- RED vor Implementierung: 18 von 19 Fokusprüfungen schlugen gegen Migration 0017 fehl.
  Die nachgeschärften Parallelitätsprüfungen deckten anschließend zusätzlich den
  `REPEATABLE READ`-Snapshot und eine falsche Lock-Reihenfolge auf.
- Fokuslauf nach Korrektur: 25/25 lokal, anschließend fünf weitere vollständige Läufe
  mit 125/125; der unabhängige Security-Review führte nochmals vier parallele Läufe mit
  100/100 aus.
- `npm run check`: Lint, TypeScript, Dependency-Cruiser und 20 Testdateien mit 163/163
  Tests grün. Der bewusst ergänzte Import-Negativtest macht die Architekturregel rot,
  sobald ein Fachmodul `lib/db/tenant.ts` direkt importiert.
- Produktionsnaher Next.js-Build mit nicht geheimen Build-Platzhaltern: grün.
- `npm audit --omit=dev --audit-level=high`: keine hohen oder kritischen Befunde.
  Sechs moderate Befunde bleiben bewusst ohne automatischen Force-Fix: das betroffene
  alte `esbuild` hängt nur transitiv am Drizzle-Entwicklungswerkzeug und der angebotene
  Fix wäre ein inkompatibler Downgrade; `fast-xml-parser` kommt über das noch ungenutzte
  `node-zugferd` und hat dort keinen verfügbaren Fix. Letzteres ist vor dem ersten
  E-Rechnungs-Einsatz erneut zu prüfen beziehungsweise zu ersetzen.
- `npm run db:generate`: kein Drift. Unabhängig geprüft wurden Fresh `0000 → 0018`,
  Upgrade `0017 → 0018` mit Bestandsdaten, Katalog, tatsächliche Statement-vor-Row-
  Lock-Reihenfolge sowie atomarer Fehler-Rollback und Retry.
- Unabhängiger Security-, Threat-Model- und Migrationsreview: kein offener P0–P3 im
  deklarierten verwalteten Produktpfad. Die Einschränkung auf diesen Pfad und das
  nachfolgende Pilot-/Produktions-Gate bleiben Bestandteil der Abnahme.

## Recovery

Rollback ist eine neue Forward-Migration: zuerst die drei Membership-Policies, dann beide
Trigger und ihre Funktionen entfernen; `app_actor_id()` erst zuletzt und nur, wenn keine
weitere Policy sie inzwischen verwendet. Die Anwendung darf den Custom-GUC weiter
setzen, solange die Funktion fehlt; umgekehrt darf die Funktion nicht vor abhängigen
Policies entfernt werden. Es gibt keinen Backfill und keinen Tabellenrewrite.

Wie jede nummerierte Migration ist 0018 nach der ersten Anwendung auf einer dauerhaften
Datenbank unveränderlich. Falls eine frühere Fassung dort bereits lief, erfolgt jede
Korrektur zwingend als neue 0019; dieselbe Journalnummer würde nicht erneut ausgeführt.

## Pilot-/Produktions-Gate

M1-02 ist lokal ein Backstop gegen vergessene Handler-/Serviceprüfungen. M1-03 hat die
damals offene Membership-Lücke inzwischen lokal geschlossen: Runtime ist Nicht-Owner,
hat nur SELECT auf `membership`, und Principal-Policies/Trigger verlangen zusätzlich
die nicht fälschbare Markerrolle des isolierten `app_system`. Das ist weiterhin keine
allgemeine Garantie gegen beliebiges SQL auf allen anderen Tenant-Tabellen.

Vor dem ersten Pilotkunden ist daher zusätzlich nachzuweisen:

- produktive Browserpfade verwenden ausschließlich `withSessionTenant` und ausschließlich
  parametrisierte Queries;
- `withTenant`/`withAuthorizedTenant` sind strukturell aus Browser-/Produktmodulen
  ausgeschlossen;
- Runtime-, System-/Bootstrap- und Migrationsrechte sind getrennt; direkter actorloser
  Membership-DML der Runtime ist entzogen und an den getesteten `app_system`-Principal
  plus NOLOGIN-Markerrolle gebunden;
- Runtime-Grant-, Actor-Spoofing-, TRUNCATE- und Cross-Tenant-Gegenproben sind grün.
- `app_system` besitzt genau das für `workspace … FOR UPDATE` nötige SELECT/UPDATE;
  Runtime scheitert bereits an der Tabellen-ACL. Eine Grant-Drift-Negativprobe erteilt
  Runtime temporär UPDATE und beweist, dass dann der Principal-Trigger mit `42501`
  übernimmt, ohne DDL-/Systemrechte zu öffnen.
- Jeder spätere Membership-Service hält dieselbe globale Lock-Reihenfolge ein:
  **Workspace vor Membership**. Er darf vor dem eigentlichen DML keine Membership-Zeile
  per `FOR UPDATE`/`FOR SHARE` sperren; Paralleltests sichern dies ab. Für normale
  Lock-Contention definiert der Endpunkt ein begrenztes Timeout und eine kontrollierte
  Retry-/Fehlerantwort.
- Der Deployment-Job begrenzt `lock_timeout` und `statement_timeout`, damit die neue
  Metadaten-DDL nicht unbegrenzt hinter einer langen Membership-Transaktion wartet.
- Ein künftiger Mixed-Version-Rollout führt zuerst die additive DB-Migration und danach
  den App-Code aus; Rollback bleibt vorwärtsgerichtet. Vor dem ersten Membership-Endpunkt
  wird diese Reihenfolge als Deploy-Gegenprobe automatisiert.

Bis dieses Gate erfüllt ist: **lokaler M0-Checkpoint zulässig, Pilot/Produktion NO-GO**.
