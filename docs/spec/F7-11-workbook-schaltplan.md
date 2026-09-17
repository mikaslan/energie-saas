# SPEC F7-11 — Workbook: Schaltplan read-only (Katalog F7.6)

## Matrix
F7.6 VERIFIED-Teile: Variantenbindung (F7-08), kWp/kWh-Rollups
(F7-09/F7-10), Stueckliste nach Kategorie (F7-08). Rest offen:
„Layout + Schaltplan read-only" — F7-08 fuehrt das explizit als
„bewusst offen: Layout (3D) und Schaltplan-Einbettung
(F6-01-Renderer wiederverwenden)". Die Schaltplan-Haelfte ist
entscheidbar OHNE neue Quelle: F6-01 liefert einen reinen Builder
`buildSingleLineSchematic` (lib/integrations/schematic/
single-line-v1.ts:75) + SVG-Renderer `SingleLineDiagram`
(angebote/[offerId]/single-line-diagram.tsx), die aus denselben
versiegelten Snapshot-Sektionen ableiten, die
`getInstallationWorkbook` bereits projiziert
(modules/installations/workbook-service.ts:328 — category/title/
sichtbare Zeilen). NEUER Gegenbeweis zu Q-F7-LAYOUT-QUELLE
(F7-02k-Affirmation betrifft gespeicherte Quellen fuer
Checklisten-Arten `planned-layout`/`circuit-plan`): Die Workbook-
Einbettung braucht KEINE gespeicherte Plan-Quelle, weil die
gebundene Variante die Quelle bereits enthaelt — reine
View-Wiederverwendung. Deferred (je eigener Slice / weiter
blockiert): Layout (3D, keine Quelle), Schaltplan-Export
(F6-02-Wiederverwendung), `circuit-plan`-Checklistenpunkt
(weiter Q-F7-LAYOUT-QUELLE).

## Ziel
Das Workbook zeigt unter der Stueckliste den Einlinien-Schaltplan
der gebundenen Variante read-only (F6-01-Renderer, ESTIMATE-
Layout wie Angebotsansicht). Ohne Bindung gilt der bestehende
Fallback („Noch keine Variante gebunden ..."); ohne
verdrahtete Knoten steht ehrlich „Kein Schaltplan verfügbar."
— kein Phantom-SVG, kein Page-Crash (03e/02k-Praezedenz).

## Entwurf (Projektion + View, keine neue Op)
- `WorkbookSection` + nullables `quantityLabel: string | null`
  (Server-Projektion in `getInstallationWorkbook`, Regel wie
  Angebots-`SchematicCard` (offer-detail-view.tsx:608-621):
  genau eine Einheit ueber sichtbare Zeilen → summiertes
  Label via bestehendem `formatQuantity`; gemischt/leer →
  null). DTO-Aenderung, KEIN Schemawandel.
- Reiner Mapper `toSchematicInputs(sections):
  SchematicSectionInput[]` in `workbook-service.ts` (nah am
  Typ, neben `projectWorkbookComponentSections`, keine neue
  Schicht): zeilenlose Sektionen raus (Angebots-Praezedenz);
  unbekannte Kategorie fail-closed → `"other"` (landet in
  der unwired-Hinweisliste, nie Crash); keine Preise, keine
  Keys, keine PII.
- `SingleLineDiagram` nach `app/_components/
  single-line-diagram.tsx` heben (Praezedenz
  `sign-out-button.tsx` dort; kein App-Cross-Import —
  Kommentar-Praezedenz installation-section.tsx:115);
  `offer-detail-view.tsx:3` importiert vom neuen Pfad
  (Byte-identisches Rendering, F6-Regression via E-05).
- `InstallationWorkbookPanel`: Schaltplan-Block
  (`aria-label="Schaltplan"`, `data-testid=
  "workbook-schematic"`) nach der Stueckliste; Server-Page
  rechnet `toSchematicInputs(workbook.sections)` und uebergibt
  als `schematicInputs`-Prop (Client duerfte `@/modules/*`
  nicht zur Runtime importieren — Server-Code im Bundle;
  Muster checkliste/page.tsx); Client ruft nur den puren,
  client-sicheren `buildSingleLineSchematic` aus Props auf
  (reine Funktion, kein Fetch, keine neue Permission —
  `installation.read` wie Workbook).
- Kein Export-Wrapper in diesem Slice (F6-02-Folgeslice).

## Vertrag DB (keine Migration — 0180 ff. bleiben frei)
- Kein Schemawandel, kein Backfill, keine Funktions-
  Aenderung: `quantityLabel` ist abgeleitete Projektion aus
  dem versiegelten Snapshot zur Lesezeit.
- Integritaet folgt dem Workbook-Pfad (SHA-Abgleich,
  korrupt → OfferIntegrityError, F7-08-Praezedenz).

## Vertrag App
- Mapper-Allowlist: module/inverter/battery/wallbox/
  heat_pump/mounting/other; alles andere → other.
- Render-Vertrag: SVG `role="img"` (F6-01-Bestand);
  Fallback-Text exakt „Kein Schaltplan verfügbar." bei
  JEDEM `schematic.empty` mit gebundener Variante (Ziel
  schlaegt unwired-Bedingung — sonst stuende bei
  nur-other-Sektionen eine leere Huelle, da
  SingleLineDiagram bei empty null rendert); Titel weiter
  Workbook-Titel.
- Viewer sieht den Block read-only identisch (kein
  Schreibpfad beruehrt).

## Sicherheit
- Keine neue: read-only-Projektion bestehender, bereits
  `installation.read`-gegateder Quelle; Helper projiziert
  nur Kategorie+Titel+Mengenlabel (keine Storage-Keys,
  kein sha, keine Preise ueber Workbook-Bestand hinaus,
  keine PII ueber Bestand hinaus); Seite crasht nie ohne
  Workbook/Bindung.

## Tests (RED zuerst)
- Unit: `tests/unit/f711-workbook-schaltplan.test.ts` — U-01
  Mapper-Kategorien 1:1 (alle sieben); U-02 unbekannte
  Kategorie → other; U-03 zeilenlose Sektion raus; U-04
  quantityLabel (eine Einheit summiert, gemischt → null);
  U-05 leerer Input → empty-Schematic (Builder-Reuse);
  U-06 F6-Unit-Suite + 02j/02k-Suiten unveraendert gruen.
- DB: keine (keine Migration; Projektion folgt F7-08-Pfad).
- E2E: `tests/e2e/f7-11-workbook-schaltplan.spec.ts`
  (Setup nach f7-10/02k: Projekt + Installation +
  Variantenbindung mit verdrahtbaren Kategorien) — E-01
  Schaltplan-SVG im Workbook sichtbar; E-02 ohne Bindung
  → bestehender Workbook-Fallback, kein Schematic-Block;
  E-03 Variante ohne verdrahtete Knoten → „Kein Schaltplan
  verfügbar."; E-04 Reload stabil; E-05 Angebotsansicht
  zeigt F6-SVG weiter (Move-Regression); E-06 Viewer liest
  Block read-only; E-07 Axe.
- Nachbarn: F6-01 (Renderer), F7-08 (Quelle/Setup), F7-10
  (Setup), 02j/02k (Projektions-Muster).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify` gruen; E2E
  Chromium gruen; Heartbeat + Push + CI gruen.
