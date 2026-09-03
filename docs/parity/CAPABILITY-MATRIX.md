# Capability-Matrix

Stand: 2026-08-30 · Workflow:
`DISCOVERED → SPECIFIED → CONTRACTED → RED → IMPLEMENTED → REVIEWED → VERIFIED`

Die vollständige F1–F16-Übersicht steht in `STATUS.md`. Dieses Dokument führt
die feingranularen M2-01-Capabilities. Gate 1 ist freigegeben; der finale
Gesamt-, Browser- und unabhängige Abschlusslauf ist grün. Die folgenden
Capabilities sind lokal `REVIEWED/VERIFIED`; technisches Gate 2 ist **GO**.
Das formale Visual-Gate bleibt davon getrennt `INCONCLUSIVE`. Eine private
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

## API-Operationen

M2-01 besitzt keine öffentliche REST-API. Die implementierten internen Commands heißen
`createOfferFromRequest`, `duplicateOfferVariant`, `reviseOfferVariant` und
`createVariantFromCurrentResolution`. Jede Server-Action ist ein direkt
erreichbarer POST-Endpunkt und muss den vollständigen Servicevertrag erneut
erzwingen.

## M1-14 Kontakt-Datensatz (0042) — REVIEWED/VERIFIED (2026-09-03)

- `M114-01` Projektakte liest vollständigen Contact-Datensatz (minimiertes DTO) — GREEN
- `M114-02` Revisionsgebundenes Edit (CAS, Advisory-Lock erster Sync-Punkt) — GREEN
- `M114-03` Namens-Split (btrim-gepinnter Splitter, TS/SQL-Divergenz dokumentiert) — GREEN
- `M114-04` Consent-/UTM-Felder (Boolean intake-owned, Version/Text/Link patchbar) — GREEN
- `M114-05` RLS/RBAC: Viewer read-only, External fail-closed (404 ohne Leak) — GREEN
- `M114-06` DSGVO: Consent-CHECK (NOT VALID), deletedAt-Tombstone, Scrub-Erweiterung — GREEN
- Races: M114-RACE-01 (parallele Edits), M114-RACE-02 (Edit↔Erasure Advisory) — GREEN
- E2E 4/4; Visual INCONCLUSIVE.

## M1-15 Termine/Kalender (0043) — REVIEWED/VERIFIED (2026-09-03)

- `M115-01…04` Create/Edit/Delete/CAS mit Berliner Wanduhrzeit (DST-Datumsebene) — GREEN
- `M115-05` Kategorien read-only (leerer Bestand) — GREEN
- `M115-08` Erasure: appointmentIds im Graphen, echter erase_inactive_lead-Lauf — GREEN
- `M115-09` Races: paralleler Edit/Delete; Guards ohne 42501 für app_runtime — GREEN
- E2E 6/6; Visual INCONCLUSIVE. Kalender-Scopes = M1-15b (0047, SPECIFIED).

## M2-04 E-Signatur (0044) — REVIEWED/VERIFIED, integriert (2026-09-03)

Vorbereitungs-Slice F2.8: 5-Zustands-Modell (pending/signed/expired/withdrawn/
revoked_by_customer), Token-Locator (RLS-frei, Definer-Kapseln), öffentliche
Guard-Route ohne Dokument-Leak, interner Widerruf mit strukturiertem Grund,
Analog-Upload, View-Zähler, kopierbarer Signaturlink, Erasure-Graph-Erweiterung.
Send/Issued + Click-to-sign/Draw folgen in M2-04b (Gate: M2-03b2 issued).
Belege: Vollcheck 180/180, E2E 4/4 (Lane) + 62/62 (Integration), Kimi 0 P0.

## M3-00 Workspace-Stammdaten (0045) — REVIEWED/VERIFIED, integriert (2026-09-03)

F8.2: Ausstellungsdetails-Singleton (Upsert + CAS-Revision), Nummernserien-
Defaults (6 Typen, {NUMBER}-Pflicht), RLS-Schreibmatrix (Admin ODER Editor mit
Invoicing-Capability), Issuing-Details-Minimierung, Precondition-Gate.
Belege: Vollcheck 186/186, E2E 4/4 (Lane) + 66/66 (Integration),
M300-DB-RBAC-01, Kimi FREIGABE.

## M3-01 Rechnungs-Kern (0046) — REVIEWED/VERIFIED, integriert (2026-09-04)

F8.3/F8.x: generisches commercial_document-Modell (6 Typen, typ-gebundene
Datums-CHECKs, Geldvertrag M2-01-verbatim), Gruppen, Nummernkreise
(workspaceweit je Typ/Jahr, verbrannte Nummern, Race-sicher), Ausstellen
(CAS draft→issued, GoBD-Snapshot + SHA-256, O4-Precondition), Versand-
Achse, Storno (Pflichtgrund-Festliste, voided terminal), Zahlungsachse
(Ableitung NUR aus paid_cents, paid/uncollectable terminal, Überzahlungs-
Delta), Archiv-Achse (reversibel), Listen/Filter je Typ (Keyset-Cursor,
Spec §7), Berichte (Berlin-Monats-KPIs, disjunkte Buckets, Vormonats-
Delta für Fluss-KPIs) + CSV-Export (UTF-8, ;, Formula-Guard), UI-Bereich
mit Tabs + Server-Actions, Dialog-Fokus/A11y.
Belege: Lane-Vollgates 96–194 Dateien (1874 passed/1 skipped), Rollenprobe
88/88 + PG18 5/5, Kimi je Slice (A1–A4 FREIGABE, UI NACHBESSERUNG→zu,
Integration FREIGABE), Chromium-E2E 5/5 (Lane) + **71/71 (Integration)**.
Visual INCONCLUSIVE. Offen als Folgeslices: Teilrechnungsketten (F8.5),
PDF-Rendering (M3-02), E-Rechnung/DATEV (F8.6/8.7), GoBD-Durchsetzung,
Erasure-Verkabelung (M3-10), Nummern-Template-Verkabelung (UNK-M301-02).

## F4.6 Workspace-Simulationsdefaults (0047) — REVIEWED/VERIFIED, integriert (2026-09-04)

M4/F4.6: Workspace-weite Simulations-Defaults (Strompreis, Eskalation,
Öl-/Gaspreis, Cashflow-Horizont) als Singleton mit CAS-Revision;
nullable-Semantik „leere Felder → Länderreferenz" (UNK-F4-03-konform:
keine erfundenen Zahlen), RBAC economics.read/write, UI
`/einstellungen/wirtschaftlichkeit`. Belege: 1883/1 Tests, 88/88 + 5/5,
E2E 73/73 (Integration), Kimi SPEC+CODE+INTEGRATION. Offen: echte
Default-Werte (UNK-F4-03, Mikail), F4.5-Rechenkern (ADR + Mikail-Fragen).
