# Capability-Matrix

Stand: 2026-08-30 · Workflow:
`DISCOVERED → SPECIFIED → CONTRACTED → RED → IMPLEMENTED → REVIEWED → VERIFIED`

Die vollständige F1–F16-Übersicht steht in `STATUS.md`. Dieses Dokument führt
die feingranularen M2-01- und M2-02-Capabilities. Beide Slices sind lokal
`REVIEWED/VERIFIED`; ihre technischen Gates sind **GO**. Die formalen
Visual-Gates bleiben davon getrennt `INCONCLUSIVE`. Eine private
Reonic-1:1-Semantik wird daraus nicht abgeleitet.

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

## API-Operationen

M2-01/M2-02 besitzen keine öffentliche REST-API. Die implementierten internen Commands heißen
`createOfferFromRequest`, `duplicateOfferVariant`, `reviseOfferVariant` und
`createVariantFromCurrentResolution`; M2-02 ergänzt `requestOfferPdfDraft`,
Status-/Listenreads und den reautorisierten privaten Download-Route-Handler.
Jede Server-Action ist ein direkt erreichbarer POST-Endpunkt und muss den
vollständigen Servicevertrag erneut erzwingen.
