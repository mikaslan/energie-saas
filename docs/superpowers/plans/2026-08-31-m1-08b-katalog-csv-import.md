# M1-08b Implementierungsplan — Katalog-CSV bis Angebots-BOM

Basis: `a06f961`

Branch: `codex/m1-08b-catalog-csv-import`

Worktree: `/Users/mikail/Projects/energie-saas-m108b-catalog-csv-import`

Größe: **large** — neuer Datei-/Contract-Boundary, drei Tabellen,
Autorisierung, Worker, UI und Golden-Path-E2E.

Gate 1 und Gate 2 sind durch Mikails frühere ausdrückliche Freigabe aller
Gates vorautorisiert. Kein Push, Deploy, produktiver Import oder Providerzugriff
ist dadurch autorisiert.

## Eigentum und Konfliktgrenzen

- Root/Integrator ist alleiniger schreibender Owner dieses Worktrees.
- Subagents arbeiten read-only als Explorer, Paritätsprüfer und Reviewer.
- Zentrale Schema-, Migration-, Rechte-, Worker- und Paritätsdateien haben
  genau einen schreibenden Owner.
- Bestehende Migration 0035 und ältere Migrationen bleiben unverändert.
- Neue Migration ist ausschließlich forward-only 0036.

## Task 1 — Vertrag und Parser RED → GREEN

Dateien:

- `lib/integrations/catalog/import-contract.ts`
- `contracts/catalog-csv-import.v1.schema.json`
- `tests/contracts/m108b-catalog-import-contract.test.ts`
- `tests/unit/m108b-catalog-csv-parser.test.ts`
- `scripts/generate-catalog-csv-import-contract.mts`
- `package.json` für den deterministischen `contract:catalog-import`-Check

RED:

- UTF-8/BOM und Windows-1252;
- Semikolon/Komma, Quoting und Zeilennummern;
- Mapping-Eindeutigkeit und ignorierte Spalten;
- sieben Typzweige;
- JSON-Attributes und exakte deutsche/kanonische Geld-, Basispoint- und
  Hundredths-Konvertierung ohne Rundung;
- 1-MiB/1.000-Zeilen/4.096-Zeichen-Limits;
- Datei-/Mapping-/Zeilen-/Commandhashing;
- 100 Zeilen mit genau sieben stabilen Fehlern;
- keine Rohzeile im Fehlervertrag.

GREEN:

- geschlossene Zod-Verträge;
- Papaparse nur hinter eigener Boundary;
- deterministische Contract-Schema-Generierung;
- kein DB-, Auth- oder UI-Import im Parsermodul.

## Task 2 — Schema und Migration RED → GREEN

Dateien:

- `lib/db/schema/catalog-import.ts`
- `lib/db/schema/index.ts`
- `drizzle/0036_*.sql` und generierte Metadaten
- `scripts/pgboss-bootstrap.mts`
- `scripts/db-role-contract.mts`
- Tenant-/Rollenfixtures
- `tests/db/m108b-catalog-import-{migration,schema,rls}.test.ts`
- Bootstrap-/Queue-/Funktionshash-Vertragstests
- Rollenvertrags- und Fresh-/Upgrade-Proben

RED/GREEN:

- `catalog_import_job`, `catalog_import_row`,
  `catalog_import_row_result`;
- Intent+Reservation, Mapping-Snapshot, historische User-FKs und exakte
  Workspace/Job/Row/Result-Grenzen;
- Status-/Shape-/Hash-/Count-Checks;
- ENABLE/FORCE RLS und restriktive Policies;
- immutable Inputs/Results mit atomarer Due-Redaction sämtlicher Dateinamen-/SKU-,
  Mapping-/Command-/Zielstand-/Canonical-Body- und
  Fehler-Quellheader-Payloads, Quoten/Budget,
  Due-/Idempotenz-/Teilredactionstests, kein TRUNCATE und eng begrenzte
  Jobzustands-/Leaseupdates;
- BEFORE-Guards plus deferred Job-/All-Rows-Constraint-Validator mit identischer
  DB-Redactionzeit, Due-CAS und Owner-Negativproben;
- `app_runtime`/`app_worker` ohne Importtabellen-DML, `app_worker` ohne
  Katalog-DML, bestehende manuelle Runtime-Katalogrechte unverändert und
  exakte `EXECUTE`-ACL;
- enge Runtime-Gateways für atomare Preview/Start/Cancel/Read/Report;
- enge Worker-Gateways für Claim/Row/Batch/Failure/Recovery/Cleanup;
- appworker-eigene `SECURITY INVOKER`-Locators ausschließlich auf pg-boss-
  ID-only-Jobs; keine globalen Domainreads, danach tenantgebundene CAS-Gateways;
  fester Suchpfad, schemaqualifizierter Body, PUBLIC-Entzug, app_worker-only
  EXECUTE sowie Owner-/Security-/ACL-/Bodyhash-Attestation; NULL-Cursor nur
  für die erste Seite, danach existierende UUID-Cursor, jeweils Limit 1–100;
- Worker-Row-Gateway mit ausschließlich IDs/Leaseparametern; immutable
  versiegelte Zielstände und Targetbody genau für `create|revise`, beide
  Targetwerte zwingend `NULL` für `unchanged`, JCS-Bodybytes,
  PostgreSQL-18-`pg_catalog.sha256`, JSON-Semantikvergleich und vollständige
  Spalten-/Embedded-Bindung samt IFF-Negativtests;
- `unchanged` nur nach erneutem Lock und kanonischer Nutzdatengleichheit der
  aktuellen Revision mit dem gespeicherten Quellcommand an Prepare, Start und
  Apply;
- geschlossene Failure-Count-/Retry-Code-Matrix, eindeutige nicht-NULL
  Lease-Zeilen 2 bis 1001 und echte DB-Negativproben für NULL-,
  Partial-Binding-, Digest- und Zustandsdrift;
- private Strict-JSON-Validatoren für alle Mapping-/Command-/Expected-/Target-
  und Error-Schlüssel; Prepare/Start/Apply binden Source-Datei-/Mappinghash
  gegen den gesperrten Job und testen jeden fehlenden/falschen Key sowie
  `unchanged`-Payloaddrift separat;
- Per-Body-Maxima 32/64/256/64 KiB und DB-abgeleitetes 30-MiB-Budget aus
  tatsächlichen `octet_length`-/`pg_column_size`-Werten unter Workspace-Lock;
  atomare Redaction setzt alle Payloadzähler auf 0;
- bytegenaue Rights-Attestation v1 samt festem Text/Digest sowie Negativtests
  für Version, Digest, Actor und Start-Replay;
- exakte Gatewaygrenzen (`batch_limit` 1–25, Pagination/Recovery/Cleanup 1–100,
  After-Row 1–1001, dreiteilige Retrycode-Allowlist) plus Runtime-/Worker-
  Kreuzmatrix und Tenant-/Objektbindung;
- ID-only pg-boss-Enqueue für Import+Cleanup, identische Queueoptionen in
  Bootstrap/Worker/0036 und atomare Kopplung bereits bei Preview-Erzeugung
  sowie mit jeder weiteren Domaintransition;
- Migration aus leerer DB und Upgrade von 0035;
- neues Schema durch `npm run db:generate`, kein Umschreiben alter Migrationen.

## Task 3 — Service und Worker RED → GREEN

Dateien:

- `modules/catalog/import-service.ts`
- schmale gemeinsame Katalog-Revisionshelfer in `modules/catalog/service.ts`
- `modules/catalog/index.ts`
- `worker/catalog-import.ts`
- `worker/catalog-import-database.ts`
- `worker/index.ts`
- Service-/Worker-/Privacy-/Concurrency-Tests

RED/GREEN:

- Preview persistiert alle Inputs atomar und nur versiegelte Snapshots;
- Start/Cancel/replay mit vollständiger Reautorisierung;
- ein aktiver Job je Workspace und Rate-/Größenlimits;
- Claim mit DB-gebundenen 25 Rownummern, unbeschränkter Leasegeneration,
  getrenntem technischem Dreierfehlerzähler, Create/Revise/Unchanged, Result
  und DB-abgeleitetem Finalize;
- jede Zeile eigene Transaktion;
- narrow SECURITY-DEFINER-Vollzeilengateway mit gleichem Seal, Lockfolge,
  N+1, Event, Audit und Project-Stale wie manuell, ohne Worker-Katalog-DML;
- Import-Event/Audit ohne Rohwerte und ohne Vollhash; Äquivalenztest für
  TypeScript-Seal ↔ DB-Digest/Zielstand;
- Drift/Archiv/Typkollision nur als Zeilenresultat;
- 40 erfolgreiche Batches, atomarer Sentinel/Next-Dispatch, Crash-/Queued-/
  Retry-/Lease-/malformed-Locator-Recovery, First-page-/Cursor-/Unbekannt-ID-
  Negativproben und Concurrent-CAS-Nachweise;
- Actor-Revocation fail-closed;
- keine Preise, Rohzeilen oder freien Quellen in Events/Audit/Logs;
- stündlicher Cleanup mit Due-CAS, atomarer vollständiger Payloadredaction,
  SLO-Metrik (`due + 1h`), Alarm (`due + 24h`) und manuellem Recoverydispatch.
- sieben Tage Preview-TTL mit atomarem Auto-Cancel, 30-Tage-Erstellungsdue,
  Start-vs-Expiry-CAS und pg-boss-only globalem Locator.

## Task 4 — Portal und Route RED → GREEN

Vor jedem Next.js-Write sind die installierten Next-16.3.3-Dokumente für
Forms, Server Actions, Auth, Caching, Error Handling und Route Handler zu lesen.

Dateien:

- `app/w/[workspaceId]/katalog/import/**`
- `app/w/[workspaceId]/katalog/importe/[importId]/**`
- `app/w/[workspaceId]/katalog/actions.ts` nur falls eine gemeinsame dünne
  Boundary nötig ist
- Katalogseite für echten Importlink/Status
- serverseitige Katalogsuche/Pagination und ID-basierte Projektauflösung
- Action-/Route-/UI-State-Tests
- `tests/contracts/m108b-catalog-import-route-contract.test.ts`

RED/GREEN:

- lokale Headerhilfe plus serverautoritatives Mapping; binäres Wire-v1-
  Envelope aus Längenpräfix, max. 32-KiB-Metadaten und rohen CSV-Bytes über
  same-origin Route Handler mit begrenztem Stream statt Server Action;
- Upload-/Mapping-/Previewzustände und klare Limits;
- persistierte Detailseite mit rechtegeschützten normalisierten Preisen,
  Start-Attestation, Cancel/Progress/Resultaten;
- ehrlicher `snapshot_redacted`-Zustand nach verbindlichem stündlichen
  30-Tage-Cleanup samt SLO, Alarm und manuellem Runbook-Recovery;
- private Template- und Formel-sichere Fehlerreport-Route;
- jede Action/Route reautorisiert;
- kein Preis-/Hash-Orakel für nicht Berechtigte;
- Session-, Denied-, Not-found-, Retry- und Terminalzustände;
- Tastatur, Fokus und responsive Reflow.

## Task 5 — Golden Path und Regression

Dateien:

- `tests/e2e/m1-08b-catalog-import.spec.ts`
- bestehende M1-08/M2-01-Tests nur additiv erweitern, nie abschwächen

Browserpfade:

1. 100 Zeilen → 93 valide/7 Fehler → Start → 93 Resultate → Report.
2. Modul/Wechselrichter/Speicher aktivieren → aktuelle Projektauflösung →
   neue Angebotsbasis → exakte Snapshot-BOM.
3. Preisreimport → importiertes Produkt `draft`, alte Resolution stale,
   bestehende BOM byte-/wertgleich, neue Resolution/neue Basis erhält neue
   Revision.
4. Viewer/Editor ohne Preisrechte/External/fremder Tenant denied.
5. Keyboard, Fokus, 320 CSS px, 400 %, Axe und kein Browser-Consolefehler.
6. Identische Bytes mit neuem Intent nach behobenem Drift; SKU hinter Eintrag
   200 wird über Suche aktiviert, aufgelöst und landet in der neuen BOM.

## Task 6 — Abschlussgates

- gezielte Contract-/Unit-/DB-/Worker-/Route-/E2E-Tests;
- `npm run db:generate` muss danach diff-frei sein;
- `npm run check`;
- `npm run build`;
- vollständiger Chromium-E2E-Lauf;
- `docs/runbooks/worker.md` mit Fresh-/Upgrade-Reihenfolge, Queueoptionen,
  Recovery, Shutdown und geschützter Snapshot-Cleanup aktualisieren;
- unabhängiger Code-/Security-/Tenant-/Regression-/Parity-Review;
- alle P0–P2 schließen;
- Human Visual bleibt ohne Mikails Baseline ausdrücklich `INCONCLUSIVE`;
- Capability Matrix, STATUS, Test Evidence, Domain Model, State Machines,
  RBAC, Source Register und Unknown Log aktualisieren;
- Vault `Reonic Clone Final` mit lokalem Checkpoint aktualisieren;
- explizite Dateien stagen, kein `git add .`;
- atomarer lokaler Commit, kein Push/Merge/Deploy.

## Merge-Gate / Handoff

GO nur wenn:

- M108B-01 bis M108B-09 objektiv belegt sind;
- 93/7-Teilerfolg und Replay real funktionieren;
- importiertes Produkt tatsächlich eine neue M2-01-BOM erreicht;
- alte Resolution/BOM bei Reimport unverändert bleiben;
- DB-/Rollen-/Worker-/Security-/Build-/E2E-Gates grün sind;
- keine Critical/High oder offenen P0–P2 verbleiben;
- externe Wahrheit weiterhin korrekt als NOT RUN/BLOCKED markiert ist.
