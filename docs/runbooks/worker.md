<!-- docs/runbooks/worker.md -->
# Runbook Worker-Host

- Deploy: auf dem Hetzner-Host `docker compose -f worker/compose.yaml up -d --build`
- Health: `curl -s localhost:8080/health` → `{"ok":true,"startedAt":"..."}`
- Degradation: Worker-Ausfall verzögert Jobs (PDF/Simulation), blockiert NIE das Portal.
- Logs: `docker compose -f worker/compose.yaml logs -f worker`
- Neustart: `docker compose -f worker/compose.yaml restart worker`
- Alarm: Uptime-Check auf /health (z. B. UptimeRobot) → einrichten, sobald der Host produktiv ist.
- Hetzner-Provisionierung selbst ist ein Deploy-Schritt bei M2-Bedarf, kein M0-Blocker.

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
4. **`fetch(name, options?)`** liefert ein Array (`Job<T>[]`); `complete(name,
   id | id[], data?, options?)` akzeptiert sowohl eine einzelne ID als auch ein
   Array. Die Skizze nutzt `complete(name, [job.id])` — passt unverändert.
5. **`stop(options?)`**: `{ graceful?: boolean; close?: boolean; timeout?:
   number }`, Default `graceful: true, close: true, timeout: 30000`. Im
   Roundtrip-Test genügt `{ graceful: false }` (Skizze); der Worker selbst
   nutzt beim Signal-Shutdown `{ graceful: true, timeout: 10_000 }` für ein
   sauberes Draining laufender Jobs statt eines abrupten Stopps.
6. **Schema/Extensions:** pg-boss v12 legt sein eigenes Schema (`pgboss`,
   konfigurierbar) selbst an (`createSchema: true` per Default) und benötigt
   dafür laut aktueller Doku (`docs/install.md`) **nur** das
   Datenbank-Privileg `CREATE ON DATABASE …` — **keine** `CREATE EXTENSION
   pgcrypto` o.ä. mehr (das war eine ältere Anforderung). Die
   embedded-postgres-Testrolle `app_test` (siehe
   `tests/setup/embedded-postgres.ts`) bekommt bereits beim Bootstrap
   `grant all privileges on database energie_saas_test to app_test`, was das
   nötige `CREATE`-Recht einschließt. Ergebnis: **kein Fix nötig** — der
   Roundtrip-Test lief unter der nicht-superuser `app_test`-Rolle beim ersten
   Versuch durch (nach Behebung des Import-Bugs oben), pg-boss legte sein
   `pgboss`-Schema anstandslos an. Kein Extension-Workaround erforderlich.
   `TENANT_EXEMPT_PREFIXES` enthält weiterhin `"pgboss_"` als reiner
   Doku-Eintrag ohne Wirkung: die Tenant-Invarianten-Suite scannt laut
   `tests/db/tenant-invariants.test.ts` ausschließlich `n.nspname = 'public'`
   — pg-boss' eigenes Schema `pgboss` liegt außerhalb dieses Scans, unabhängig
   von Tabellennamen-Präfixen.
7. **Node-Version:** pg-boss v12 verlangt laut Doku Node **>= 22.12** (für
   `require(esm)`). `worker/Dockerfile` nutzt `node:22-slim` — dieser Tag
   trackt den jeweils aktuellen 22.x-Patch und erfüllt die Anforderung; beim
   ersten echten Build auf dem Hetzner-Host lohnt ein kurzer
   `node -v`-Check im Container.
8. **`.dockerignore` ergänzt** (nicht in der Aufgabenskizze aufgeführt, aber
   notwendig): `worker/compose.yaml` baut mit `context: ..` (Repo-Root). Ohne
   `.dockerignore` würde `COPY . .` im Dockerfile das lokal für diese Maschine
   (macOS/arm64) gebaute `node_modules` über das im Image per `npm ci` für
   Linux installierte kopieren und native Bindings (esbuild,
   embedded-postgres, better-sqlite3 u.a.) brechen. `.dockerignore` schließt
   `node_modules`, `.next`, `.git`, `.superpowers/pgdata`, `*.tsbuildinfo` und
   `.env*` aus.

## Verifikationsstand

- Docker/Compose konnte auf dieser Maschine **nicht** ausgeführt werden (kein
  Docker installiert) — `Dockerfile`/`compose.yaml` wurden nur statisch
  geprüft (YAML-Parse via `js-yaml`, Pfad-/Kontext-Abgleich, keine
  Tab-Einrückung). Ein echter `docker compose -f worker/compose.yaml up
  --build` steht auf dem Hetzner-Host aus.
- Der lokale Worker-Start (`npx tsx worker/index.ts` gegen die
  embedded-postgres-Test-Instanz, `curl localhost:8080/health`) wurde
  verifiziert — siehe Task-11-Report für den genauen Log-Auszug.

## Heartbeat & Backup (Gerüste aus der Tooling-Mission, 2026-08-27)

- **Dead-Man-Switch:** Ist `HEALTHCHECKS_PING_URL` gesetzt, pingt der Worker
  die URL nach jeder erfolgreichen DB-Probe (60-s-Takt, `startHeartbeat` in
  `worker/health.ts`). Kein Ping bei kaputter Probe — das Ausbleiben löst den
  Alarm bei healthchecks.io aus (Check dort: Period 1 min, Grace 5 min).
- **Sentry:** Ist `SENTRY_DSN` gesetzt, initialisiert der Worker `@sentry/node`
  (App-seitig: `instrumentation.ts` / `instrumentation-client.ts`).
- **Backup:** `worker/backup/backup.sh` (pg_dump → zstd → age → S3-Upload) per
  Host-Cron, siehe Kopfkommentar; Schutzziele und Restore-Test in
  docs/konzepte/backup-dr.md. Host-Pakete: postgresql-client, zstd, age, awscli.
