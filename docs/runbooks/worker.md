<!-- docs/runbooks/worker.md -->
# Runbook Worker-Host

- Deploy: auf dem Hetzner-Host mit ausschließlich `POSTGRES_URL_WORKER` sowie den
  nicht geheimen erwarteten Neon-Tenant-/Timeline-IDs im Compose-Environment:
  `docker compose -f worker/compose.yaml up -d --build`. Die URL verwendet den
  direkten Neon-Endpoint, nicht `-pooler`.
- Health: `curl -s localhost:8080/health` → `{"ok":true,"startedAt":"..."}`
- Degradation: Worker-Ausfall verzögert Jobs (PDF/Simulation), blockiert NIE das Portal.
- Logs: `docker compose -f worker/compose.yaml logs -f worker`
- Neustart: `docker compose -f worker/compose.yaml restart worker`
- Alarm: `/health` bleibt ausschließlich auf `127.0.0.1` für Compose/Hostchecks.
  Externes Monitoring läuft über den Dead-Man-Ping; kein unauthentifizierter
  Reverse-Proxy auf den Health-Port.
- Hetzner-Provisionierung selbst ist ein Deploy-Schritt bei M2-Bedarf, kein M0-Blocker.
- Container: Multi-Stage-Build bündelt den Worker nach `dist/worker.cjs`; das finale
  Image basiert auf dem per OCI-Digest gepinnten, zur installierten
  Playwright-Version passenden Noble-Image und läuft als Non-Root-User
  `pwuser`. Das Dateisystem ist read-only, alle Linux-Capabilities sind
  entfernt, `no-new-privileges` und das eingecheckte Seccomp-Profil bleiben
  bindend. Eine root-owned Preload-Bibliothek setzt ausschließlich den
  Node-Elternprozess vor Anwendungscode non-dumpable; Chromium erhält ein
  eigenes secretfreies Environment ohne diesen Preload. Ein Lade-/`prctl`-
  Fehler beendet den Worker vor der Initialisierung mit Exitcode 127.
- Renderer-Rezept und Compose sind auf `linux/amd64`, Playwright 1.62.1 und
  den OCI-Child-Digest
  `sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac`
  gepinnt. Der produktive Host muss `uname -m = x86_64` liefern; ARM oder ein
  neuer Image-Digest brauchen vor Nutzung eine neue Recipe-Version und neue
  Determinismusevidenz.

## Doku-Abweichungen von der Aufgabenskizze (context7, Stand 2026-08-26)

Pflichtschritt vor der Implementierung war ein context7-Doku-Abgleich gegen
`pg-boss` (`/timgit/pg-boss`), weil die Aufgabenskizze noch von einer
v10-API ausging. Tatsächlich installiert (und aktuell auf npm) ist **v12.28.0**.
Abweichungen gegenüber der Skizze bzw. gegenüber einzelnen context7-Snippets:

1. **Kein Default-Export.** Sowohl die Aufgabenskizze als auch eines der
   context7-Doku-Snippets (`docs/database-backends.md`) zeigen
   `import PgBoss from "pg-boss"`. Das im installierten Paket
   (`node_modules/pg-boss/dist/index.js`, `.d.ts`) tatsächlich exportierte
   Symbol ist aber ausschließlich der **named export** `PgBoss`
   (`export class PgBoss extends EventEmitter …`, kein `export default`).
   Der Default-Import lief zunächst durch (TypeScript/esbuild synthetisieren
   bei fehlendem Default einen Namespace-Objekt-Default), scheiterte aber zur
   Laufzeit mit `TypeError: default is not a constructor` — im RED/GREEN-Test
   unten reproduziert. Korrektur: `import { PgBoss } from "pg-boss"` in
   `tests/db/worker-queue.test.ts` und `worker/index.ts`. Ein
   context7-Doku-Snippet aus dem README (`const { PgBoss } = require('pg-boss')`)
   hatte den korrekten (named) Export bereits richtig gezeigt — bei
   widersprüchlichen Snippets hat der tatsächlich installierte Code
   (`node_modules`) den Ausschlag gegeben, nicht die Doku.
2. **v10 → v12: `work()`-Handler erhält weiterhin ein Job-Array**, wie in der
   Skizze vermutet (`batchSize` default 1, siehe `docs/api/workers.md`,
   Typdefinition `WorkHandler<ReqData>: (job: Job<ReqData>[]) => Promise<…>`).
   Kein Anpassungsbedarf an der Skizze.
3. **`createQueue()` vor `send()`** ist weiterhin Pflicht (Skizze korrekt) —
   `createQueue(name, options?)` legt Policy/Retry/Dead-Letter-Konfiguration an.
   M1-07 initialisiert `calculation.execute` vor 0025 historisch mit
   `policy: exclusive`, `retryLimit: 0`, `expireInSeconds: 900`. Migration
   0029 hebt ausschließlich technische Vor-Claim-Zustellungen auf
   `retryLimit: 10`, eine Sekunde Startverzug, Backoff und maximal 60 Sekunden.
   M2-02 initialisiert `pdf.render` direkt mit Retry 10, maximal 60 Sekunden
   technischem Backoff und 180 Sekunden Ablauf; drei fachliche Versuche werden
   davon getrennt in `offer_pdf_draft` per Lease/CAS erzwungen. M2-03a nutzt
   mit `offer.release-candidate.render` denselben technischen Queuevertrag,
   aber einen getrennten, ebenfalls auf drei Fachversuche begrenzten
   Lease-/CAS-Zustand in `offer_release_candidate`. M2-03b1 nutzt zusätzlich
   `offer-issuance.render.v1` für die neu gerenderte finale
   Ausstellungsfassung. Auch diese Queue transportiert ausschließlich
   Workspace- und Issuance-ID; der normale Worker pinnt alle vier aktuellen
   Verträge.
4. **`fetch(name, options?)`** liefert ein Array (`Job<T>[]`); `complete(name,
   id | id[], data?, options?)` akzeptiert sowohl eine einzelne ID als auch ein
   Array. Die Skizze nutzt `complete(name, [job.id])` — passt unverändert.
5. **`stop(options?)`**: `{ graceful?: boolean; close?: boolean; timeout?:
   number }`, Default `graceful: true, close: true, timeout: 30000`. Im
   Roundtrip-Test genügt `{ graceful: false }` (Skizze); der Worker selbst
   nutzt beim Signal-Shutdown `{ graceful: true, timeout: 15_000 }` für ein
   sauberes Draining laufender Jobs. Compose gewährt dafür 60 Sekunden: neben den
   15 Sekunden pg-boss-Drain bleiben damit Zeit für den begrenzten failWip-DB-Pfad,
   Health-Server-Close und Sentry-Flush, ohne Docker-SIGKILL mitten im Jobzustand.
6. **Schema/Extensions:** pg-boss v12 könnte sein Schema selbst anlegen
   (`createSchema: true` per Default), das würde `app_worker` aber unnötig
   `CREATE ON DATABASE` geben. Seit M1-03 legt der Admin das Schema `pgboss`
   einmalig mit Owner `app_worker` an; der Worker startet fest mit
   `schema: "pgboss", createSchema: false`. Er darf innerhalb dieses Schemas
   seine pg-boss-Tabellen/Migrationen verwalten, besitzt aber weder USAGE noch
   CREATE in `public` und keine Fach-/Auth-Grants. Die strikte Rollenprobe führt
   unter genau dieser Rolle einen echten Queue-Roundtrip aus. Eine Extension
   braucht pg-boss v12 weiterhin nicht.
   `TENANT_EXEMPT_PREFIXES` enthält weiterhin `"pgboss_"` als reiner
   Doku-Eintrag ohne Wirkung: die Tenant-Invarianten-Suite scannt laut
   `tests/db/tenant-invariants.test.ts` ausschließlich `n.nspname = 'public'`
   — pg-boss' eigenes Schema `pgboss` liegt außerhalb dieses Scans, unabhängig
   von Tabellennamen-Präfixen.
7. **Verifizierter Hauptpool:** pg-boss erhält über seinen offiziell unterstützten
   `db: IDatabase`-Konstruktorpfad einen eigenen `pg.Pool`, dessen `verify`-Callback
   jede neue Verbindung vor dem ersten Checkout als exakten `app_worker`-Principal
   und – bei Neon – als exakten Tenant/Timeline-Branch attestiert. Die separate
   Health-Probe benutzt denselben Vertrag. Auch Fehler eines idle Pool-Clients werden
   synchron abgefangen und zusammen mit pg-boss-Fehlern genau einmal in den zentralen
   fatalen Shutdown geroutet; die Readiness wird rot, WIP wird geordnet beendet und
   Compose startet den Prozess nach Exitcode 1 neu.
8. **Node-Version:** pg-boss v12 verlangt laut Doku Node **>= 22.12** (für
   `require(esm)`). Der Build nutzt `node:22-slim`; das per Digest gepinnte
   Playwright-Runtime-Image wurde im echten Container-Smoke mit dem
   installierten Paket verifiziert. Der Zielhost-Smoke prüft diese Kombination
   vor jedem Rollout erneut.
9. **`.dockerignore` ergänzt** (nicht in der Aufgabenskizze aufgeführt, aber
   notwendig): `worker/compose.yaml` baut mit `context: ..` (Repo-Root). Ohne
   `.dockerignore` würde `COPY . .` im Dockerfile das lokal für diese Maschine
   (macOS/arm64) gebaute `node_modules` über das im Image per `npm ci` für
   Linux installierte kopieren und native Bindings (esbuild,
   embedded-postgres, better-sqlite3 u.a.) brechen. `.dockerignore` schließt
   `node_modules`, `.next`, `.git`, `.superpowers/pgdata`, `*.tsbuildinfo` und
   `.env*` aus.

## PDF-, Freigabekandidaten- und Ausstellungsfassungs-Recovery

- Der Worker startet den PDF-Recovery-Sweep sofort und danach alle 60 Sekunden.
  Ein Lauf ist auf 25 Workspaces mit jeweils 25 Jobs begrenzt und überlappt
  nicht mit seinem Vorgänger. Kandidaten werden ausschließlich aus dem
  strikt ID-only gehaltenen `pdf.render`-Verlauf ermittelt; jede Fachabfrage
  und jede Statusänderung läuft anschließend mit dem jeweiligen
  Workspace-Kontext unter `FORCE RLS`.
- Ein fälliges `retry_wait` wird atomar wieder auf `queued` gesetzt und neu
  zugestellt. Ein abgelaufenes `running` bleibt fachlich unverändert und erhält
  nur eine neue N+1-Zustellung; Claim, Lease und CAS verhindern doppelte
  Verarbeitung. Recovery- und Worker-Retries verlängern die fachliche
  Lead-/Offer-Aktivität nicht.
- Jeder autorisierte, exakte Benutzer-Replay stellt dagegen **jeden**
  nichtterminalen Zustand (`queued`, `running`, `retry_wait`) idempotent erneut
  zu und bucht den Replay als Offer-Aktivität. Damit bleibt eine manuelle
  Reparatur möglich, auch wenn die ursprüngliche Queue-Zustellung fehlt.
- Die autonome Workspace-Ermittlung ist bewusst an die vorhandene pg-boss-
  Historie gebunden. pg-boss v12 hält Queuezeilen mit dem aktuellen
  Standardvertrag nur begrenzt vor (`retention_seconds = 14 Tage`,
  `deletion_seconds = 7 Tage`). Nach einem Worker-/Queue-Ausfall über diese
  Historie hinaus oder nach einem Restore ohne alte Dispatchzeilen kann der
  Sweep einen allein im Fachzustand verbliebenen Job nicht selbst entdecken;
  der Benutzer-Replay repariert ihn weiterhin. Ein Betriebs-SLO, das auch nach
  Verlust der gesamten Queuehistorie autonome Reparatur verlangt, benötigt
  vor Freigabe eine eigene dauerhafte, migrationsgebundene Recovery-Registry.
- Der M2-03a-Sweep folgt demselben begrenzten und nicht überlappenden Muster,
  liest aber ausschließlich strikt validierte ID-only-Dispatches der Queue
  `offer.release-candidate.render` und mutiert nur deren eigene Candidate-
  Zustände. Ein Kandidat bleibt bei Erfolg `ready_for_approval`; die separate
  menschliche Freigabe erzeugt lediglich `approved_not_issued` und führt weder
  Ausstellung noch Versand aus.
- Der M2-03b1-Sweep liest ausschließlich ID-only-Dispatches der Queue
  `offer-issuance.render.v1`. Er erzeugt neue finale PDF-Bytes aus dem
  validierten Candidate-Input; Candidate-Bytes werden nie weitergereicht oder
  umetikettiert. Zwei getrennte menschliche Freigaben führen höchstens zu
  `approved_for_archive_not_issued`. Dieser Worker hat bewusst keine
  Archiv-/Storage-Credentials und kann weder WORM archivieren noch den Zustand
  `issued` setzen. Das bleibt ein separates, reales M2-03b2-Provider-Gate.

## Fresh-Install- und Upgrade-Reihenfolge für M1-07/M2-02/M2-03a/M2-03b1

Die Reihenfolge ist bindend, weil die unveränderlichen Migrationen 0025/0026
noch den historischen Retry-0-Startvertrag prüfen und erst 0029 auf den
aktuellen technischen Retry-10-Vertrag hebt:

1. Rollen und das Schema `pgboss` mit Owner `app_worker` provisionieren.
2. Mit ausschließlich `POSTGRES_URL_WORKER` und den erwarteten
   Neon-Tenant-/Timeline-IDs `npm run db:pgboss:bootstrap` ausführen. Der
   Befehl initialisiert pg-boss v38, `calculation.execute` im historischen
   Retry-0-Vertrag sowie `pdf.render`, `offer.release-candidate.render` und
   `offer-issuance.render.v1` bereits in ihren aktuellen Verträgen.
3. Mit `POSTGRES_URL_MIGRATE` `npm run db:migrate` bis einschließlich 0035
   ausführen. 0029 aktualisiert Calculation-Queue und wartende Zustellungen auf
   Retry 10; 0033 attestiert `pdf.render` und installiert ausschließlich die
   minimale PDF-Dispatchroutine. 0034 attestiert die getrennte M2-03a-Queue und
   installiert nur deren ID-only-Dispatchroutine. 0035 attestiert analog die
   getrennte M2-03b1-Queue und deren ID-only-Issuance-Dispatchroutine.
4. Auf dem tatsächlichen Zielhost vor dem Rollout ausführen:
   `test "$(uname -m)" = x86_64` und danach
   `docker compose -f worker/compose.yaml --profile renderer-smoke run --rm renderer-smoke`.
   Ein Fehler bei Seccomp, unprivilegierten User-Namespaces, Sandbox,
   Netzwerkblockade (einschließlich print-only CSS), Same-UID-`/proc`-Zugriff
   auf Eltern-Environment/offenen FD oder Determinismus ist ein Deploy-NO-GO.
5. Erst danach den normalen Worker starten; dessen `createQueue()` erhält die
   aktuellen Verträge.

Der Bootstrap ist idempotent und liest als `app_worker` keinen
Drizzle-Journalinhalt. Er erkennt den Migrationsstand an der worker-owned
Dispatchfunktion: Ein partieller 0025-/0026-Stand bleibt auf Retry 0, ein
wirksamer 0029-Stand bleibt auf Retry 10. Eine versehentlich vor 0025 durch den
neuen Worker erzeugte Retry-10-Queue wird nur dann auf den historischen
Startvertrag repariert, wenn sie noch keinen Job enthält. Alle anderen
Queue-/Funktionsabweichungen enden fail-closed mit
`calculation_queue_bootstrap_drift`; der Befehl gibt weder URL noch Passwort
aus.

## Verifikationsstand

- Dockerfile-Lint, expandierte Compose-Konfiguration und ein echter lokaler
  Multi-Stage-Imagebuild sind grün. Der gehärtete `renderer-smoke` lief am
  2026-08-30 als `pwuser` mit read-only, Null-Capabilities,
  `NoNewPrivs=1`, aktivem Seccomp und `network_mode: none` erfolgreich; ohne
  Seccomp-Profil scheiterte Chromium erwartungsgemäß fail-closed. Der erste
  Zielhost-Deploy samt tag-/digest-basiertem Rollback bleibt ein eigenes
  Pilot-Gate; lokal wurde weder gepusht noch deployed.
- Zwei lokale macOS/arm64-Diagnoserender derselben 500-Positionen-Eingabe waren
  bytegleich; sie sind keine Produktionsrezept-Evidenz. Bindend ist
  ausschließlich der zweifache `linux/amd64`-Container-Smoke mit exakt
  gepinntem OCI-Child. Er belegt zusätzlich blockierte Same-UID-Leseversuche
  auf Eltern-Environment und offenen Eltern-FD. Der aktuelle Byte-/Hashwert
  wird nach jedem bewussten Recipe-Bump in `docs/parity/TEST-EVIDENCE.md`
  aktualisiert; plattformübergreifende Bytegleichheit wird nicht behauptet.
- Derselbe secretfreie Smoke gibt zusätzlich `M203B1-RENDER-01` aus. Er rendert
  dieselbe synthetische Eingabe zweimal, prüft Byte-/Hash-/Größengleichheit,
  A4, Tagged PDF, Outline, Netzwerk-Fail-Closed sowie die Abwesenheit aller
  Candidate-/Provisional-Marker. Außerdem muss die finale Ausstellungsfassung
  byte- und hashverschieden vom Candidate sein. Erst ein grüner
  `linux/amd64`-Containerlauf ist Produktionsrezept-Evidenz.
- Das Seccomp-Profil basiert auf dem offiziellen Playwright-v1.62.1-Profil und
  ergänzt genau die im Smoke erforderliche `chroot`-Freigabe innerhalb des
  Chromium-User-Namespace. `SYS_ADMIN`, `seccomp=unconfined` und
  `--no-sandbox` bleiben verboten.
- Der lokale Worker-Start (`npx tsx worker/index.ts` gegen die
  embedded-postgres-Test-Instanz, `curl localhost:8080/health`) wurde
  verifiziert — siehe Task-11-Report für den genauen Log-Auszug.

## Calculation-Reservation-Rate-Limit v1

- Die App reserviert unter
  `project-calculation-reservation-rate-limit.v1` höchstens 30 neue Jobs je
  Actor und 300 je Workspace in einer rollenden Stunde; zwischen zwei neuen
  Reservations desselben Actors liegen mindestens 10 Sekunden.
- Aktive und terminale Jobs zählen gleichermaßen. Operatoren dürfen
  `failed_final`-Zeilen deshalb nicht löschen oder umetikettieren, um Kapazität
  freizugeben. Das Fenster läuft automatisch anhand der DB-Zeit aus.
- `rate_limited` ist kein Worker-/Providerfehler und erzeugt keinen halben
  Domainzustand. Die UI zeigt die aufgerundeten `retryAfterSeconds` an und kann
  danach denselben Confirm erneut senden.
- Ein exakter Replay ist immer erlaubt und repariert weiterhin eine fehlende
  Zustellung eines `queued` Jobs. Steigt die Rate von Replays ohne neue Jobs,
  sind daher Dispatcher-/Client-Wiederholungen zu prüfen; die Quota darf nicht
  als Ersatz für die idempotente Reparatur verschärft werden.
- Änderungen an Schwellen oder Zählsemantik werden als neue Policy-Version mit
  Actor-/Workspace-Race-Tests ausgerollt. Es gibt keinen undokumentierten
  Laufzeit-Override in Environment-Variablen.

## Heartbeat & Backup

- **Dead-Man-Switch:** Ist `HEALTHCHECKS_PING_URL` gesetzt, pingt der Worker
  die URL nach jeder erfolgreichen DB-Probe (60-s-Takt, `startHeartbeat` in
  `worker/health.ts`). Kein Ping bei kaputter Probe — das Ausbleiben löst den
  Alarm bei healthchecks.io aus (Check dort: Period 1 min, Grace 5 min).
- **Sentry:** Ist `SENTRY_DSN` gesetzt, initialisiert der Worker `@sentry/node`
  (App-seitig: `instrumentation.ts` / `instrumentation-client.ts`).
- **Backup:** `worker/backup/backup.sh` (pg_dump → zstd → age → S3-Upload) läuft
  als Host-Cron ausschließlich mit getrennten `POSTGRES_BACKUP_*`-Werten,
  0400/0600-Passfile und eigenem `S3_BACKUP_*`-Bucket-Key, niemals mit
  Runtime-/Worker-/Archiv-Credentials.
  FORCE RLS verlangt dafür vor Pilot einen eigens freigegebenen Backup- oder
  providerseitigen Exportpfad samt Restore-Test; Details in
  `docs/konzepte/backup-dr.md`. Der aktuelle `--no-owner --no-privileges`-Dump ist
  ohne separaten Rollen-/Owner-/ACL-Restorevertrag noch **kein** vollständiges
  M1-03-Wiederherstellungsartefakt. Lock, Payload-Timeout/Prozessbaum-Shutdown,
  eigener Fehleralarm, exakter PG18-/Branch-Readback sowie versionierte
  Object-Lock-/Checksum-/Retention-Readbacks sind lokal implementiert und adversarial
  getestet. Der reale Provider-/IAM-Nachweis und ein echter Restore-Drill bleiben
  Pilot-NO-GO. Host-Pakete: PostgreSQL-18-Client (`psql`, `pg_dump`), zstd, age,
  AWS CLI v2, curl, openssl und GNU coreutils (`date`, `timeout`, `sha256sum`).
