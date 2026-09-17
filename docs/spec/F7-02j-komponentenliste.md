# SPEC F7-02j — Komponentenlisten-Punkt (Katalog F7.2)

## Matrix
F7.2 Item-Typen: task/title/description/radio/text/multi/image/
signature VERIFIED (02c/d/e/f/g/i); `component-list` offen. Quelle
ist entscheidbar: Workbook F7-08 ist implementiert
(`getInstallationWorkbook`, hash-gepruefter Current-Revision-
Snapshot, F7-03e nutzt ihn bereits als Anzeige-Quelle).
`component-list` rendert dieselbe Stueckliste STRUKTURIERT
(Sektionen + Mengen, read-only) statt als Fliesstext-Platzhalter.
Deferred (je eigener Slice): planned-layout, circuit-plan (Workbook
projiziert kein Layout/Schaltplan — Quelle fehlt), datasheets
(braucht Datei-Referenzen je Punkt).

## Ziel
kind=`component-list`: Anzeige-Punkt (02c-Semantik — weder
Pflicht noch abhakbar), der die gebundene Workbook-Stueckliste
(Sektionen, je Zeile Menge + Name, positions-sortiert, ohne
Preise) read-only rendert. Ohne Bindung, bei leerer Liste,
fehlendem Leserecht oder Integritaetsfehler steht ehrlich
„Keine Stueckliste verfuegbar." — kein Phantom-Text, kein
Page-Crash (03e-Praezedenz). Tree speichert nur die Art
(kein Inhalt, kein Snapshot — 03B „Art nie Inhalt").

## Entwurf (Anzeige-Art, keine neue Op)
- `checklistItemKindSchema` + `component-list` (Katalog-
  Schreibweise mit Bindestrich). Template-Schema erbt
  automatisch (shared Import, template-contract.ts:3/33);
  Kommentar „alle acht" → neun.
- Display-Status folgt OHNE Regel-Code: App-Refine
  (contract.ts:339-341) und `isChecklistWorkItem` sind
  Allowlist-basiert — neue Art ist automatisch Anzeige
  (Tests pinnen das).
- `projectWorkbookComponentSections(sections)` in
  `modules/installations/workbook-service.ts` (nah am Typ,
  neben `formatWorkbookComponentsText`, keine neue
  Schicht): projiziert `[{section, lines: [{quantity,
  name}]}]` in Projektions-Reihenfolge, leere Sektionen
  uebersprungen. Keine Preise (F7-08), keine IDs.
- `checkliste/page.tsx`: Workbook-Fetch wie 03e (eine
  `authorizedQuery`, `installation.read`; PermissionDenied/
  null/IntegrityError → null); Prop `componentSections`
  (`... | null`, null = Fallback) an den Manager.
- Manager: Typ-Option „Komponentenliste"; Render-Zweig im
  02c-Muster (Titel via displayText + strukturierte Liste
  oder Fallback); alle Rollen (Viewer read-only identisch);
  Strukturmodus ohne Zusatz-Inputs (Art ohne Inhalt).
- Typwechsel ehrlich (title-Spiegel): zu `component-list`
  → done/required false, description/value/photo/
  signerRole null; weg davon → Standardzweige wie bisher.
- Template-Manager: Option „Komponentenliste" (kind 1:1,
  nie Inhalt — 02i-Praezedenz); `renderFreshBlocks` mappt
  1:1 mit done/required false (templates.ts:408-414,
  kein Code noetig).

## Vertrag DB (0177 — 0176 ist F7-07b; Replace nur `_f704_valid_checklist_blocks`)
- kind-IN (0175-Z.130) + `component-list` (Vollkopie 0175).
- Anzeige-Regel (0175-Z.180) + `component-list` (required/
  done true am kind = ungueltig).
- Keine neuen Keys, kein Schemawandel, kein Backfill.
- Rollen-Pin validBlocks neu harvesten (02i-Praezedenz).

## Vertrag App
- Zod: kind-Enum + `component-list`; Template-Kommentar
  „alle neun Projekt-Arten".
- Spiegel-Regeln unveraendert (value/photo/signerRole/
  description bleiben kind-fremd → am component-list
  invalid; Tests pinnen je einen Fall).
- Render-Vertrag: Sektionstitel + Zeilen „{quantity}
  {name}" (z.B. „8 Stueck PV-Modul X"); Fallback-Text
  exakt „Keine Stueckliste verfuegbar."; Titel weiter
  mit Platzhalter-Substitution (03c/03e-Kontexte).

## Sicherheit
- Keine neue: read-only-Projektion bestehender Quelle,
  `installation.read`-gated; Helper projiziert nur
  Menge+Name (keine Preise, keine IDs, keine PII ueber
  Bestand hinaus); Seite crasht nie ohne Workbook.

## Tests (RED zuerst)
- Unit: `tests/unit/f702j-komponentenliste.test.ts` — U-01
  kind im Enum (Projekt + Vorlage); U-02 required/done je
  einzeln invalid; U-03 Fremd-Nutzlast invalid (value,
  photo, signerRole, description); U-04 Projektions-Helper
  (Reihenfolge, leere Sektionen raus, keine Preise/IDs);
  U-05 `isChecklistWorkItem` false; U-06 02c/02i-Suiten
  unveraendert gruen.
- DB: `tests/db/f702j-komponentenliste.test.ts` — DB-01 kind
  persistiert (Save + Re-Read); DB-02 required/done am
  kind verworfen; DB-03 fremder kind weiter verworfen
  (IN-Regression); DB-04 Template-Anwendung erzeugt
  kind-Punkt mit done/required false.
- E2E: `tests/e2e/f7-02j-checklist-komponentenliste.spec.ts`
  (Setup nach f7-10/03e: Projekt + Installation +
  Variantenbindung) — E-01 Typ stellen → strukturierte
  Liste sichtbar; E-02 Reload stabil; E-03 Viewer sieht
  Liste; E-04 ohne Bindung → Fallback; E-05 kein
  Pflicht/Abhaken angeboten; E-06 Axe.
- Nachbarn: 02c (Anzeige), 03e (Quelle), f7-10 (Setup).

## Akzeptanz
- `npm run check` gruen; E2E Chromium gruen; Heartbeat + Push + CI gruen.
