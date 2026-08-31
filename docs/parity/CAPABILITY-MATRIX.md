# Capability-Matrix

Stand: 2026-08-31 · Workflow:
`DISCOVERED → SPECIFIED → CONTRACTED → RED → IMPLEMENTED → REVIEWED → VERIFIED`

Die vollständige F1–F16-Übersicht steht in `STATUS.md`. Dieses Dokument führt
die feingranularen M1-08b-, M2-01-, M2-02-, M2-03a- und M2-03b1-Capabilities.
Alle fünf Slices sind lokal `REVIEWED/VERIFIED`; ihre technischen Gates sind
**GO**. Die formalen
Visual-Gates bleiben davon getrennt `INCONCLUSIVE`. Eine private
Reonic-1:1-Semantik wird daraus nicht abgeleitet.

## Gemeinsamer Liefervertrag M1-08b

- Ein interner Nutzer lädt ausschließlich eine eigene oder ausdrücklich
  autorisierte CSV bis 1 MiB, 1.000 Datenzeilen und 80 Spalten hoch. Die
  persistierte Preview mutiert den Katalog nicht und speichert keine Rohdatei.
- Start verlangt `catalog.manage`, `price.edit`, `price.read_purchase` und eine
  versionierte, an Actor, Datei, Mapping und Reservation gebundene
  Rechteattestation. Viewer, unvollständige/externe Editor und Fremdtenant
  bleiben fail-closed.
- Jede valide Zeile wird als create/revise/unchanged versiegelt. Ein
  ID-only-Worker claimt höchstens 25 Zeilen, schreibt jede Zeile transaktional
  über enge Definer-Gateways und verarbeitet 1.000 Zeilen in exakt 40
  erfolgreichen Batches.
- Neue/geänderte Produktstände enden als `draft`; Aktivierung bleibt eine
  getrennte bewusste M1-08-Aktion. Ein Reimport verändert weder historische
  Resolutionen noch Angebots-BOMs, sondern macht nur neue operative Stände
  sichtbar und bestehende Ableitungen `stale`.
- Fehlerreport, Pagination, Preview-Ablauf, Recovery und Redaction sind real.
  Import- und Cleanup-Queues transportieren ausschließlich IDs; der Worker
  besitzt kein direktes Katalog-DML.
- Evidence: `docs/spec/M1-08b-katalog-csv-import.md`, ADR 0013 und
  `TEST-EVIDENCE.md`. Reale WMEE-/Lieferantendaten, Assets, Feed-Sync und
  produktiver Deploy sind nicht enthalten.
- Abschlussnachweis: `npm run check` mit 144/144 Testdateien, 1.371 bestanden
  und 1 opt-in übersprungen; 88/88 Rollen plus 5/5 PG18; Chromium 24 bestanden
  plus 1 opt-in übersprungen, davon 7/7 fokussiert; Build und unabhängiger
  P0–P2-Review grün.

## Feingranulare M1-08b-Capabilities

| ID / F-Nr. | Job, Trigger und Happy Path | Inputs / Validierungen | Zustand und Nebenwirkung | Recht / Daten / Event | Tests | Status / Parität / Blocker |
|---|---|---|---|---|---|---|
| `M108B-01` / F16.1 | Nutzer lädt CSV, ordnet Spalten zu und persistiert eine deterministische Vorschau | strict UTF-8; ≤1 MiB, ≤1.000 Zeilen, ≤80 Spalten; vollständiges Mapping | `missing → ready_for_review`; keine Katalogmutation, keine Rohdatei | drei Importrechte; minimierte Preview | `M108B-CONTRACT-01`, `M108B-ROUTE-01`, `M108B-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M108B-02` / F16.1 | System validiert jede Zeile vollständig | bestehender Katalogvertrag, stabile Feld-/Fehlercodes, sichere Größenlimits | valide und fehlerhafte Zeilen getrennt; null valide Zeilen blockiert Start | keine freien Fehlermeldungen in Logs/Events | `M108B-CONTRACT-01`, `M108B-DB-01` | REVIEWED/VERIFIED (lokal) |
| `M108B-03` / F16.1 | System bindet Technik-, EK-/VK-Provenienz und Quellstand | Datei-/Mapping-/Zeilenhash, Rechtebasis und versiegelter Zielstand | Preview und Ergebnis bleiben bis Due prüfbar, danach atomar redigiert | Preise nur für vollständig Berechtigte; keine Vollhashes in Event/Audit | `M108B-PRIVACY-01`, `M108B-RETENTION-01` | REVIEWED/VERIFIED (lokal) |
| `M108B-04` / F16.1 | Worker erzeugt/ändert/überspringt Zeilen idempotent | ID-only; DB-Reload; Lease/CAS; max. 25 eindeutige Zeilen | create/revise/unchanged je eigener Transaktion; Replay dupliziert nichts | Worker nur Definer-Gateways, kein Katalog-DML | `M108B-SVC-01`, `M108B-WORKER-01`, `M108B-DB-01` | REVIEWED/VERIFIED (lokal); 1.000 = 40 Batches |
| `M108B-05` / F16.1 | Importierte Produktstände bleiben bis zur manuellen Aktivierung Entwurf | aktueller SKU-/Revisionslock und hashgleicher Zielstand | create/revise endet `draft`; unchanged erzeugt keine Revision | bestehende M1-08-Lifecycle-Rechte | `M108B-SVC-01`, `M108B-E2E-02` | REVIEWED/VERIFIED (lokal); keine Autoaktivierung |
| `M108B-06` / F16.1/F2.1/F2.3 | Aktivierte Importprodukte erreichen Resolution und neue Angebotsbasis | aktuelles Modul, Wechselrichter, Speicher/weitere Auswahl, exakte Mengen/Centwerte | neue immutable Resolution und Basis-BOM; alte Snapshots unverändert | Projekt-/Offer-Rechte werden erneut geprüft | `M108B-E2E-02` | REVIEWED/VERIFIED (lokal) |
| `M108B-07` / F16.1 | Nur vollständig Berechtigte bedienen Upload, Start, Abbruch und Report | `catalog.manage + price.edit + price.read_purchase`; interne aktive Membership | denied/not-found ohne Objektoracle | Viewer, External, eingeschränkter Editor und Fremdtenant fail-closed | `M108B-RBAC-01`, `M108B-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M108B-08` / F16.1/F2.3 | Reimport mit Änderung erzeugt einen neuen Draft und sichtbaren Drift | neues Intent, aktuelle Revision, getrennte Aktivierung | vorhandene Resolution/alte BOM bleiben unverändert; neue Basis erst nach neuer Resolution | kein stilles Rebase | `M108B-E2E-02`, `M108B-DB-01` | REVIEWED/VERIFIED (lokal) |
| `M108B-09` / F16.1/F2.3 | Nutzer findet importierte aktive SKU auch hinter Eintrag 200 | serverseitige Suche oder exakte autorisierte ID-Auflösung | Auswahl erreicht Resolution/BOM ohne Client-Gesamtliste | `catalog.read`, Tenantbindung | `M108B-E2E-03`, Server-Search-Contract | REVIEWED/VERIFIED (lokal) |

## Gemeinsamer Liefervertrag M2-01

- Modul: Offers; Tenant-/Owner-Scope: Workspace plus Project/Offer.
- Rollen: Viewer read-only, Editor capabilitygebunden, External ohne Assignment
  fail-closed; Admin impliziert wie in der Runtime Capabilities, aktive
  Workspace-Feature-Flags bleiben bindend.
- Oberflächen: Project-CTA, `/w/[workspaceId]/angebote`,
  `/w/[workspaceId]/angebote/[offerId]`.
- Loading/Empty/Error/Success/Disabled/Denied: echte getrennte Zustände gemäß
  Spec; keine Existenz- oder EK-Leaks.
- Desktop/Tablet/Mobile: responsive 320/375/390/768/1024/1440/1920,
  400-%-Reflow, kein
  Seiten-Overflow, 44-px-Touchziele, Preisübersicht adaptiert.
- Keyboard: vollständiger Formularpfad und hoch/runter-Reorder ohne Drag.
- Offline: kein Offline-Schreibversprechen; sicherer Online-Fehlerzustand.
- Notifications: nur lokale `aria-live`-Ergebnisse; keine externe Mail in M2-01.
- Evidence: `SOURCE-REGISTER.md`; detaillierte Verträge:
  `docs/spec/M2-01-angebotsvarianten-snapshot-bom.md`.
- Abschlussnachweis: 87/87 Testdateien mit 856 bestandenen und 1 ausdrücklich
  opt-in übersprungenen Test; 88/88 Rollen- plus 5/5 PG18-Proben; finale
  UI-/Action-/Contract-Matrix 123/123; Targeted-Regressionsmatrix 37/37;
  Chromium-E2E 16/16 (15 funktional/A11y plus 1 Visual-Capture mit 26/26
  maskierten, SHA-verifizierten Kandidaten); Build/Lint/Typecheck/Dependency-Cruiser/Diff/`db:generate`
  grün; keine offenen Produkt-P0–P2.
- Owner: Root; UI-/Test-Lanes mit unabhängigen Abschlussprüfungen.
- Letzte Prüfung: 2026-08-30.

## Feingranulare Capabilities

| ID / F-Nr. | Job, Trigger und Happy Path | Inputs / Validierungen | Zustand und Nebenwirkung | Recht / Daten / Event | Tests | Status / Parität / Blocker |
|---|---|---|---|---|---|---|
| `M201-01` / F2.1 | Editor konvertiert readiness-grüne, operatorqualifizierte B2C-Rechneranfrage per CTA in Draft-Offer | nur Project-ID, erwartete Resolution-/Requirement-/Calculation-Revisionen, Forecast, B2C-Bestätigung und explizite Steuerwahl; Service lädt/verifiziert Hashes intern; request/open/current, keine Blocker | atomar request→offer, Offer+`Basis`-Variante, Offer-Spalte; Digest-Replay oder Conflict | `project.write+phase.convert+price.edit`; Project/Resolution/Offer; `project.phase_changed`, `offer.created` | `M201-SVC-01`, `M201-DB-02`, `M201-ACTION-01`, `M201-RBAC-01`, `M201-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M201-02` / F2.1 | System vergibt workspaceweit dauerhafte Nummer, bindet Rechner→Requirement→Calculation→Resolution und kopiert nur erlaubten Kunden-/Anlagenstandortkontext | serverseitige DB-Werte; Serie gelockt, alle Quellrevisionen/Hashes intern valide; genaue Contact-/Site-Allowlist | Nummer/Scope/B2C immutable; Forecast getrennt vom Preis; keine Rohpayload-Kopie | gleiche Create-Rechte; Offer/Series/Source-Bindings; Event enthält keine PII/Preise | `M201-DB-01/02`, `M201-CONTRACT-01`, `M201-PRIVACY-01` | REVIEWED/VERIFIED (lokal); Nummernformat-UI später |
| `M201-03` / F2.2 | Editor dupliziert eine Variante und bearbeitet sie unabhängig | Offer/Variant-ID, expectedRevision, neuer Name | neue stabile Variant mit Snapshot Revision 1; keine Rückwirkung | `project.write`; Offer/Variant; `offer.variant_duplicated` | `M201-SVC-01`, `M201-E2E-01` | REVIEWED/VERIFIED (lokal); Financing/3D später |
| `M201-04` / F2.3 | Editor gliedert und ändert BOM, freie Zeilen und Positionen | strikt erlaubter kompakter Patch; nichtnegative sichere Menge/Preise, BPS, Steuer, Reihenfolge; max. 500 Zeilen | gebündelter Save erzeugt N+1; Snapshot+Mirror atomar | `project.write`, `price.edit` für Preis/Steuer, `discount.apply` für Rabatt; Variant/Section/Line; `offer.variant_revised` | `M201-CONTRACT-01`, `M201-DB-01`, `M201-ACTION-01`, `M201-RBAC-01`, `M201-E2E-01` | REVIEWED/VERIFIED (lokal); reale Produkte/Preise bleiben externes Datengate |
| `M201-05` / F2.4 | System berechnet reproduzierbar Netto, Rabatt, Steuer und Brutto | serverautoritativ; keine Floats/Clienttotals; Overflow und Cap | pures Resultat im Snapshot; Fehler ohne Teilstand | Service-only; VariantRevision; Event ohne Beträge | `M201-MONEY-01/02` | REVIEWED/VERIFIED (lokal); eigene WMEE-Rundung, private Reonic-Rundung UNKNOWN |
| `M201-06` / F2.2/F2.3 | Editor erkennt Drift und erzeugt bewusst neue Basisvariante | aktuelle Resolution, alte Variant-ID, explizite Steuerwahl; 0 % frisch bestätigt, keine Vererbung | Outdated bleibt sichtbar; alter Snapshot unverändert; neue Variant | `project.write+price.edit`; Resolution/Variant; `offer.variant_created` | `M201-E2E-02`, `M201-DB-02`, `M201-RBAC-01` | REVIEWED/VERIFIED (lokal); kein stilles Rebase |
| `M201-07` / F2.3 | Viewer liest Angebot ohne Einkaufsgeheimnisse | autorisierte Workspace-/Offer-ID | read-only DTO; Denied/NotFound ohne Oracle | `project.read`; EK nur `price.read_purchase`; keine Eventseite | `M201-RBAC-01` | REVIEWED/VERIFIED (lokal); External ohne Assignment fail-closed |
| `M201-08` / F2.1–F2.4 | Nutzer bedient Editor in allen realen UI-Zuständen | Server-DTOs und untrusted FormData | Loading, Empty, Blocked, Outdated, Dirty, Pending, Conflict, Unavailable/Retry-after, Error, Success, Read-only | jede Action reauthentifiziert; 15-Minuten-Quoten 120/Actor und 1200/Workspace; keine externen Nebenwirkungen | `M201-ACTION-01`, `M201-DB-02`, `M201-E2E-01/02`, `M201-A11Y-01`, `M201-VISUAL-01` | REVIEWED/VERIFIED (lokal); technisches Gate 2 GO; Visual ohne freigegebene Baseline INCONCLUSIVE |

## Gemeinsamer Liefervertrag M2-02

- Ergebnis ist ausschließlich ein interner A4-PDF-Entwurf mit sichtbarer und
  maschinenlesbarer Kennzeichnung „nicht versendet · nicht verbindlich“.
- Quelle ist genau eine unveränderliche Variantenrevision. Der autorisierte
  App-Service lädt sie innerhalb der Tenant-Grenze neu; Client und Queue liefern
  keine Dokumentinhalte.
- Zustände: `queued`, `running`, `retry_wait`, `succeeded` und terminal
  `failed_final` (in der Oberfläche „fehlgeschlagen“). Replay repariert den
  Dispatch desselben fachlichen Jobs, statt ein zweites Dokument anzulegen.
- Renderer: offline und sandboxed in einem unprivilegierten Worker; das
  Produktionsrezept bindet `linux/amd64`, Playwright 1.62.1 und den vollständigen
  OCI-Child-Digest. Ein Rezeptwechsel erzeugt einen neuen fachlichen Job.
- Artefakt: höchstens 8 MiB, SHA-256- und längengeprüft, nach Erfolg immutable
  in Tenant-Postgres gestaged und nur über einen reautorisierten privaten
  Download ausgeliefert.
- Rollen: Viewer lesen Status und laden vorhandene Entwürfe; Editor/Admin dürfen
  mit `project.write` anfordern und replayen; External erhält keinen Zugriff;
  ausschließlich `app_worker` darf unter Tenantkontext claimen/finalisieren.
- M2-02 führt bewusst kein Rollout-Flag ein. Bestehende Feature-Flags können
  weder Mitgliedschaft noch Rolle oder Einzelrecht ersetzen.
- Nicht enthalten: `issued`, Versand, E-Mail, Annahme, Signatur, öffentlicher
  Link/Kundenportal, Rechnung, Object Lock oder produktive Archivierung.
- Evidence und Grenzen: `docs/spec/M2-02-angebots-pdf-entwurf.md`, ADR 0010 und
  `SOURCE-REGISTER.md`; menschliches `M202-VISUAL-01` bleibt `INCONCLUSIVE`.
- Abschlussnachweis: 96/96 Vitest-Dateien mit 949 bestandenen Tests und einem
  ausdrücklich opt-in übersprungenen Test; 88/88 Rollen- plus 5/5
  PostgreSQL-18-Proben; 16/16 aktive Chromium-E2E plus ein opt-in
  Visual-Candidate-Fall; Produktionsbuild, Lint, Typecheck,
  Dependency-Cruiser, `db:generate`, Compose-Vertrag und Worker-Bundle grün.
  Der zweifache gepinnte `linux/amd64`-Container-Render war bytegleich und
  bestand Netzwerk-/Print-Netz-/Sandbox-/Same-UID-Isolation; der unabhängige
  Abschlussreview fand keine offenen P0–P2.

## Feingranulare M2-02-Capabilities

| ID / F-Nr. | Job, Trigger und Happy Path | Inputs / Validierungen | Zustand und Nebenwirkung | Recht / Daten / Event | Tests | Status / Parität / Blocker |
|---|---|---|---|---|---|---|
| `M202-01` / F2.7 | Editor fordert aus der aktuellen Variante einen PDF-Entwurf an oder repariert per Replay dessen Dispatch | nur Workspace, Offer, Variante und erwartete Revision; Service lädt Bindungen/Input neu; Unique je Quelle, Template und Rezept | `missing → queued`; Parallelaufruf/Replay bleibt derselbe fachliche Job und berührt keinen Vertragsstatus | `project.write`; External ausgeschlossen; Event/Audit ohne PII, Preise, Bytes oder Vollhashes | `M202-SVC-01`, `M202-RBAC-01`, `M202-DB-02`, `M202-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M202-02` / F2.7 | System versiegelt den kundensicheren Dokumentstand einer exakten Variantenrevision | strikte Allowlist und kanonischer SHA-256; kein Clienttotal, EK, Marge, Kontaktkanal, interne ID oder Rohpayload | Input, Quellbindung und Vorbereitungszeit bleiben immutable; Hidden-Zeilen im internen Draft ausdrücklich markiert | App-Service unter Tenant/RLS; keine externe Nebenwirkung | `M202-CONTRACT-01`, `M202-PRIVACY-01`, `M202-DB-01` | REVIEWED/VERIFIED (lokal); eigene WMEE-Semantik, keine private Reonic-PDF-Wahrheit |
| `M202-03` / F2.7 | `app_worker` claimt und rendert den versiegelten Stand | strikter ID-only-Queue-Payload; DB-Reload; offline/sandboxed Chromium; gepinntes Linux-/Playwright-/OCI-Rezept; ≤8 MiB | `queued/retry_wait → running → succeeded`, bei retryable Fehler `retry_wait`, sonst `failed_final`; Lease/CAS und Recovery | minimaler Worker-Principal; keine Auth-/Katalogvollrechte; kein Netzwerk oder Remote-Asset | `M202-WORKER-01`, `M202-RENDER-01`, `M202-SSRF-01`, `M202-DB-02` | REVIEWED/VERIFIED (lokal); produktiver Deploy weiterhin BLOCKED/NOT RUN |
| `M202-04` / F2.7 | System staged exakt die erfolgreichen PDF-Bytes | `%PDF-`, Struktur, MIME, Größe, SHA-256 und Bytezahl geprüft | Artefakt wird atomar bei Erfolg gesetzt und danach nicht geändert; Draft-Erasure kaskadiert, aktive Lease blockiert Erasure | tenantgeschütztes Postgres-Staging; kein Object Lock/WORM | `M202-DB-01/02`, `M202-RENDER-01` | REVIEWED/VERIFIED (lokal); Issuance-Storage bleibt Folgegate |
| `M202-05` / F2.7 | Viewer/Editor/Admin laden ein erfolgreiches Artefakt privat herunter | Reauth, `project.read`, Tenant-/Offer-/Job-Besitz, Erfolg, Hash/Länge/MIME und sicherer Dateiname | private `no-store`-Antwort; kein Byteinhalt in Liste, Event, Audit oder Log | Viewer/Editor/Admin intern; External und fremde Tenants fail-closed | `M202-ROUTE-01`, `M202-RBAC-01`, `M202-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M202-06` / F2.7 | Nutzer sieht ehrliche Portalzustände des asynchronen Jobs | autorisiertes Status-DTO ohne Dokumentinput/Bytes | getrennte Anzeigen für Warteschlange, Rendern, Retry, Erfolg und endgültigen Fehler; Portal bleibt bei Worker-Ausfall verfügbar | `project.read`; Anforderung getrennt über `project.write` | `M202-E2E-01`, `M202-A11Y-01`, `M202-VISUAL-01` | REVIEWED/VERIFIED (lokal); menschliches Visual-Gate INCONCLUSIVE |

## Gemeinsamer Liefervertrag M2-03a

- Ein Workspace besitzt genau einen stabilen Dokumentprofil-Head mit
  append-only Revisionen und separater Aktivierung des exakten Profilhashes.
  Es gibt keine erfundenen Firmen- oder Rechtstext-Defaults.
- Empfängername, Kontakt und strukturierte Rechnungsadresse werden als
  Offer-lokale append-only Revision gespeichert; der Anlagenstandort bleibt
  davon getrennt.
- Ein Kandidat bindet exakt Variantenrevision, erfolgreichen M2-02-Quelldraft,
  aktive Profilrevision, aktuelle Empfängerrevision und Gültigkeitsdatum.
  Hidden-Zeilen, veraltete Quellen oder ungültige Hashes blockieren fail-closed.
- Der versiegelte `offer-release-candidate-input.v1` enthält nur den nötigen
  Kunden-/Dokumentstand. Queue und Worker erhalten ausschließlich Workspace-
  und Candidate-ID und laden unter Tenantkontext neu.
- Zustände: `queued`, `running`, `retry_wait`, `ready_for_approval` und
  `failed_final`. Die einmalige append-only Freigabe rehashiert die echten
  Bytes und erzeugt nur den abgeleiteten Zustand `approved_not_issued`.
- Vor Freigabe dürfen nur Approver die privaten Bytes laden; danach dürfen
  interne Nutzer mit `project.read` laden. External bleibt vollständig
  ausgeschlossen. Candidate und Bytes bleiben Teil des Offer-Erasuregraphen.
- Nicht enthalten: echte Firmen-/Rechtstextfreigabe, `issued`, Object Lock/WORM,
  Versand, Annahme, Signatur, öffentlicher Link, Rechnung oder Deployment.
- Abschlussnachweis: 111/111 Vitest-Dateien, 1.078 bestanden/1 übersprungen;
  Chromium 17 bestanden/1 opt-in übersprungen; 88/88 Rollen- und 5/5
  PG18-Proben; Production-Build, ESLint, Typecheck und Dependency-Cruiser
  (237 Module/764 Abhängigkeiten) grün. Der gepinnte `linux/amd64`-Container
  belegt den Pflichtstatus auf 11/11 PDF-Seiten. Security-, Regression-,
  Navigation- und lokaler Claude-Code-Opus-Max-Lesereview sind GO ohne offene
  P0–P2. Human Visual bleibt `INCONCLUSIVE`.
- Der Browser-E2E verwendet einen synthetischen DB-Claim/Finalize mit exakt
  geprüften Bytes; die echte Rendererevidenz stammt getrennt aus dem Container.

## Feingranulare M2-03a-Capabilities

| ID / F-Nr. | Job, Trigger und Happy Path | Inputs / Validierungen | Zustand und Nebenwirkung | Recht / Daten / Event | Tests | Status / Parität / Blocker |
|---|---|---|---|---|---|---|
| `M203A-01` / F16.2 | Admin erstellt einen neuen Dokumentprofilstand und aktiviert nach Prüfung exakt dessen Hash | strikte Plain-Text-Schemas; Pflichtfelder; serverseitige ID, Revision, Actor, DB-Zeit, Kanonisierung und SHA | Profil-Head zeigt auf append-only Revision und append-only Aktivierung; keine Defaults | `settings.manage`; interne Profilreads über `project.read`; Events/Audit ohne Rechtstexte oder Vollhashes | `M203A-CONTRACT-01`, `M203A-DB-01/02`, `M203A-SVC-01`, `M203A-RBAC-01` | REVIEWED/VERIFIED (lokal); echte WMEE-Inhalte bleiben fachlich/juristisch offen |
| `M203A-02` / F2.7 | Bearbeiter speichert einen bestätigten Empfänger-/Rechnungsstand | Empfänger, optionale Firma, E-Mail, strukturierte Rechnungsadresse und feste Bestätigung; kein Anlagenadress-Fallback | Offer-lokale append-only Revision mit serverseitigem Hash | `offer.release.prepare`; kein External; keine PII in Event/Audit/Log | `M203A-CONTRACT-01`, `M203A-DB-01/02`, `M203A-PRIVACY-01`, `M203A-RBAC-01` | REVIEWED/VERIFIED (lokal) |
| `M203A-03` / F2.7 | Bearbeiter prüft Readiness und fordert den exakten Freigabekandidaten an | aktuelle Varianten-, Draft-, Profil- und Empfängerrevision; `validThrough` 1–60 Tage; keine Hidden-Zeile; alle Hash-/Tenantbindungen gültig | idempotenter Reservation-Key; gleicher Stand repariert Dispatch, anderer Stand erzeugt neue Candidate-ID | `offer.release.prepare`; Event/Audit nur mit sicheren IDs/Statuscodes | `M203A-HIDDEN-01`, `M203A-SVC-01`, `M203A-DB-02`, `M203A-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M203A-04` / F2.7 | System versiegelt den kundensicheren Candidate-Input | serverautoritatives Profil, Billing, Site, sichtbare Positionen, Summen, Daten und Versionen; strikte Allowlist/JCS/SHA | immutable Input und Quellbindungen; Publication-State bleibt `not_issued` | keine EK, Marge, Katalog-IDs, Kundentelefon/-koordinaten, Rohpayloads, Actor-IDs oder Signaturdaten | `M203A-CONTRACT-01`, `M203A-PRIVACY-01`, `M203A-TEMPLATE-01` | REVIEWED/VERIFIED (lokal); eigene WMEE-Semantik, keine private Reonic-Wahrheit |
| `M203A-05` / F2.7 | `app_worker` claimt, rendert und finalisiert den ID-only-Job | DB-Reload; offline/sandboxed Chromium; gepinntes Rezept; MIME/Größe/Hash; deterministischer Doppelrender | `queued/retry_wait → running → ready_for_approval`, Retry oder `failed_final`; Lease/CAS; immutable Artefaktbytes | minimaler Worker-Principal; keine Portal-, Auth-, Katalog- oder Profilmutationsrechte | `M203A-WORKER-01`, `M203A-DB-02`, `M203A-RENDER-01` | REVIEWED/VERIFIED (lokal); echter Renderer separat im Container belegt, Deploy NOT RUN |
| `M203A-06` / F2.7 | Approver bestätigt vier feste Prüfpunkte und bei Bedarf die 0-%-Steuerbehandlung über die echten Bytes | nur `ready_for_approval`; erneute Source-/Profil-/Byteprüfung; exakte Attestation; Race/Replay sicher | einmalige append-only Approval; abgeleitet `approved_not_issued`; kein Offer-/Vertragsstatus | `offer.release.approve`; Event/Audit ohne Inhalte oder Vollhashes | `M203A-APPROVAL-01`, `M203A-SVC-01`, `M203A-RBAC-01` | REVIEWED/VERIFIED (lokal); Vier-Augen-Regel und Rechtswirkung offen |
| `M203A-07` / F2.7 | Interner Nutzer bedient Profil-, Empfänger-, Prepare-, Status-, Approval- und Downloadpfad | reauthentifizierte Actions/Route; ehrliche Zustände; Fokus-/Fehlerführung; Reflow/Keyboard | kein stiller Formularverlust; privater `no-store`-Download; vor Approval nur Approver, danach `project.read` | UI nie Sicherheitsgrenze; External und fremde Tenants fail-closed | `M203A-ROUTE-01`, `M203A-E2E-01`, `M203A-A11Y-01` | REVIEWED/VERIFIED (lokal); Chromium 17 bestanden/1 opt-in übersprungen |
| `M203A-08` / F2.7 | System bewahrt Privacy, Append-only-Integrität und Löschbarkeit | Tenant-FKs/RLS, exakte Rollen-ACL, Erasure-Tombstone, keine aktive Lease | Candidate, Approval und Bytes kaskadieren im Offer-Erasuregraph; historische Quellen werden nie mutiert | Runtime/Worker nur engste Funktionen/Spalten; keine WORM-Behauptung | `M203A-DB-01/02`, `M203A-PRIVACY-01`, `M203A-RBAC-01` | REVIEWED/VERIFIED (lokal); Object Lock/Retention bleibt M2-03b |

## Gemeinsamer Liefervertrag M2-03b1

- Aus dem exakt freigegebenen Candidate-Input werden neue finale PDF-Bytes
  gerendert; Candidate-Bytes werden niemals kopiert, umetikettiert oder
  promotet.
- Reservation und versiegelter `offer-issuance-input.v1` binden Candidate,
  Candidate-Approval, Input-/Artifact-Hash, Variante, Profil, Empfänger sowie
  Template-, Canonicalization- und Rendererrezept.
- Queue-Payload und Dispatch transportieren nur Workspace- und Issuance-ID.
  Der Worker lädt den versiegelten Input unter Tenantkontext und rendert
  offline/sandboxed; höchstens 8 MiB bleiben bis zur Archivierung
  tenantgeschützt und löschbar in Postgres.
- Der Renderpfad endet bei `ready_for_approval`; zwei verschiedene aktive
  interne Personen geben exakt dieselben Bytes frei, mindestens eine davon
  verschieden vom Candidate-Approver. Maximalstatus ist
  `approved_for_archive_not_issued`.
- Eine append-only Rücknahme ist vor Archivierung terminal. Exakter Replay
  belebt die Issuance nicht wieder; eine Korrektur braucht neuen Candidate und
  neue Issuance.
- Der private Download reautorisiert Tenantgraph, Rolle, MIME, Länge und Hash.
  Vor 2/2 lesen nur Approver, danach interne Nutzer mit `project.read`; nach
  Withdrawal ist kein Artefaktdownload mehr erlaubt.
- Nicht enthalten sind Storageadapter, Archivevidence, Object Lock,
  `issued`, Versand, Link, Annahme oder Signatur. M2-03b2 bleibt `BLOCKED`.
- Abschlussnachweis: 126/126 Vitest-Dateien, 1.184 bestanden/1 übersprungen;
  Rollen 88/88 plus PG18 5/5; Chromium 17 bestanden/1 opt-in übersprungen;
  Build/Lint/Typecheck/Dependency-Cruiser grün. Der doppelte Container-Render
  ist bytegleich (11 A4-Seiten, 97.560 Bytes, SHA-256
  `cb989e765c0c31b8fa82b25e2151b66eabecdc33f2047c2672297a620ed27abe`).
  Code, Security und Claude-Code-Opus-5-Max: GO ohne offene P0–P2; Human Visual
  bleibt `INCONCLUSIVE`.

## Feingranulare M2-03b1-Capabilities

| ID / F-Nr. | Job, Trigger und Happy Path | Inputs / Validierungen | Zustand und Nebenwirkung | Recht / Daten / Event | Tests | Status / Parität / Blocker |
|---|---|---|---|---|---|---|
| `M203B1-01` / F2.7 | Bearbeiter fordert aus einem freigegebenen Candidate die Ausstellungsfassung an; exakter Replay repariert nur Dispatch | Client liefert IDs; Service sperrt und prüft Candidate, Approval, Bytes, Input und aktuelle Quellbindungen; Reservation ist vollständig gebunden | `missing → queued`; gleicher Vertrag bleibt gleiche Issuance-ID, Korrektur braucht neuen Candidate | `offer.issue.prepare`; sichere ID-/Status-Events, keine Inhalte | `M203B1-CONTRACT-01`, `M203B1-SVC-01`, `M203B1-DB-02` | REVIEWED/VERIFIED (lokal) |
| `M203B1-02` / F2.7 | System versiegelt den eigenen Issuance-Input | strikte Allowlist/JCS/SHA; exakte Candidate-/Approval-/Source-/Rezeptbindung; keine Candidate-Bytes, Actor-IDs, EK, Marge oder Secrets | Input, SHA und Bindungen append-only; `artifactIntent=offer_issuance_final` | autorisierter Service unter Tenant/RLS | `M203B1-CONTRACT-01`, `M203B1-PRIVACY-01`, `M203B1-DB-01` | REVIEWED/VERIFIED (lokal) |
| `M203B1-03` / F2.7 | `app_worker` claimt, rendert, retryt/recovert und finalisiert neue Bytes | ID-only, DB-Reload, offline/sandboxed, gepinntes Rezept, deterministischer Doppelrender, ≤8 MiB | `queued/retry_wait → running → ready_for_approval` oder `failed_final`; Lease/CAS; Artefakt append-only | minimaler Worker; kein Storage-Secret und kein Approval-Recht | `M203B1-RENDER-01`, `M203B1-WORKER-01`, `M203B1-DB-02` | REVIEWED/VERIFIED (lokal); Deploy NOT RUN |
| `M203B1-04` / F2.7/F16.2 | System erzeugt eine finale kundenlesbare PDF-Informationsarchitektur | escaped, A4/mehrseitig, Tagged PDF/Outline, keine Remote-Assets und keine Candidate-/Draft-/„nicht ausgestellt“-Marker in den Bytes | neue unveränderliche PDF-Datei; UI bleibt bis Archivgate klar „nicht ausgestellt“ | eigener WMEE-Vertrag, keine private Reonic- oder Rechtswahrheit | `M203B1-TEMPLATE-01`, `M203B1-RENDER-01`, `M203B1-VISUAL-01` | technisch VERIFIED; Human Visual `INCONCLUSIVE` |
| `M203B1-05` / F2.7 | Zwei verschiedene interne Personen geben exakt dieselben Bytes frei | Rehash, vier feste Attestations, bedingte 0-%-Bestätigung, aktuelle Quellen; mindestens eine Person ≠ Candidate-Approver | 0/2 → `approval_pending` 1/2 → `approved_for_archive_not_issued` 2/2; kein Offerstatus | `offer.issue.approve`; append-only Approval je Actor | `M203B1-APPROVAL-01`, `M203B1-SVC-01`, `M203B1-RBAC-01` | REVIEWED/VERIFIED (lokal); noch nicht ausgestellt |
| `M203B1-06` / F2.7 | Approver zieht einen noch nicht archivierten Stand mit festem Ursachencode zurück | erlaubter Code, exakte Issuance, keine Freitext-PII; Race/Replay sicher | append-only, terminal `withdrawn_before_archive`; keine Reaktivierung oder Approval-Mutation | `offer.issue.withdraw`; sichere Ursache in Event/Audit | `M203B1-DB-02`, `M203B1-SVC-01`, `M203B1-E2E-01` | REVIEWED/VERIFIED (lokal) |
| `M203B1-07` / F2.7 | Interner Nutzer bedient Request, Status, Approval, Withdrawal und privaten Download | jede Action/Route reautorisiert; gestufte Leserechte, Feldfehler/Fokus, Keyboard/Reflow/Axe | ehrliche 0/2-, 1/2-, 2/2-, Reset- und Rücknahmezustände; `private, no-store` | `project.read` plus Issue-Capabilities; External/cross-tenant fail-closed | `M203B1-ROUTE-01`, `M203B1-E2E-01`, `M203B1-A11Y-01` | REVIEWED/VERIFIED (lokal); 17+1 Chromium |
| `M203B1-08` / F2.7 | System schützt Tenantgrenze, Append-only-Integrität und Erasuregraph | zusammengesetzte FKs, FORCE RLS, genaue ACL, Drift-/Byte-Guards, aktive Lease | erfolgreiche Bytes/Approvals/Withdrawal unveränderlich; vor Archivierung Offer-löschbar | Runtime/Worker Least Privilege; keinerlei Archivclaim | `M203B1-DB-01/02`, `M203B1-PRIVACY-01`, `M203B1-RBAC-01` | REVIEWED/VERIFIED (lokal); M2-03b2 BLOCKED |

## API-Operationen

M2-01/M2-02/M2-03a/M2-03b1 besitzen keine öffentliche REST-API. Die implementierten internen Commands heißen
`createOfferFromRequest`, `duplicateOfferVariant`, `reviseOfferVariant` und
`createVariantFromCurrentResolution`; M2-02 ergänzt `requestOfferPdfDraft`,
Status-/Listenreads und den reautorisierten privaten Download-Route-Handler.
M2-03a ergänzt Profil-Revision/-Aktivierung, Empfängerrevision,
`requestOfferReleaseCandidate`, `approveOfferReleaseCandidate`, Statusreads und
den privaten Candidate-Download-Route-Handler. M2-03b1 ergänzt
`requestOfferIssuance`, `approveOfferIssuance`, `withdrawOfferIssuance`,
`listOfferIssuances`, `getOfferIssuanceStatus`, `readOfferIssuanceArtifact`,
drei reautorisierte Server Actions und den privaten Issuance-Download-Handler.
Jede Server-Action ist ein direkt erreichbarer POST-Endpunkt und muss den
vollständigen Servicevertrag erneut erzwingen.

M2-03b2 mit Object Lock, Retention, Archivevidence und `issued` bleibt
ausdrücklich `BLOCKED`.
