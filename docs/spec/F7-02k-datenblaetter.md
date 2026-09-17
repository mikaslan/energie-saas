# SPEC F7-02k — Datenblatt-Punkt (Katalog F7.2)

## Matrix
F7.2 Item-Typen: task/title/description/radio/text/multi/image/
signature/component-list VERIFIED (02c/d/e/f/g/i/j);
`datasheets` offen. Quelle ist entscheidbar OHNE neuen
Provider: Katalogzeilen des gebundenen Varianten-Snapshots
tragen `product.datasheet` (Nullable-Asset: objectKey, sha256,
mediaType=application/pdf, originalFilename —
offers/contract.ts:576-587, catalog/contract.ts:89-102).
`datasheets` rendert diese BESTEHENDEN Datei-Objekte als
Referenz-Liste (Produktname + Dateiname, verlinkt auf die
bestehende Katalogkomponenten-Seite) — kein Upload, keine
neue Route, keine neue Permission. Deferred (je eigener
Slice): Byte-Download (Session-Route nach 02g-Muster),
planned-layout/circuit-plan (Q-F7-LAYOUT-QUELLE: Snapshot-
strictObject ohne Layout/Plan-Keys, Workbook ohne
Layout-Felder, F6 nur abgeleiteter Renderer in der
Angebotsansicht — keine gespeicherte Quelle).

## Ziel
kind=`datasheets`: Anzeige-Punkt (02c-Semantik — weder
Pflicht noch abhakbar), der die Datenblaetter der
gebundenen Variante (je Zeile Produktname + Dateiname,
positions-sortiert, als Link auf die Katalogkomponente)
read-only rendert. Ohne Bindung, ohne Datenblaetter,
fehlendem Leserecht oder Integritaetsfehler steht ehrlich
„Keine Datenblätter verfügbar." — kein Phantom-Text, kein
Page-Crash (03e-Praezedenz). Tree speichert nur die Art
(kein Inhalt, kein Snapshot — 03B „Art nie Inhalt").

## Entwurf (Anzeige-Art, keine neue Op)
- `checklistItemKindSchema` + `datasheets` (Katalog-
  Schreibweise, Plural wie F7.2). Template-Schema erbt
  automatisch (shared Import, template-contract.ts:3/33);
  Kommentar „alle neun" → zehn.
- Display-Status folgt OHNE Regel-Code: App-Refine
  (contract.ts:344-346) und `isChecklistWorkItem`
  (contract.ts:534-540) sind Allowlist-basiert — neue Art
  ist automatisch Anzeige (Tests pinnen das).
- `WorkbookLine` + nullables `datasheet`-Feld
  `{productName, filename, componentId}` (nur Anzeige-
  Referenz, NIE objectKey/sha — Keys bleiben
  serverseitig); `getInstallationWorkbook` befuellt es aus
  dem validierten Snapshot (Katalogzeilen mit
  product.datasheet != null; versteckte + Custom-Zeilen
  → null).
- `projectWorkbookDatasheets(sections)` in
  `modules/installations/workbook-service.ts` (nah am Typ,
  neben `projectWorkbookComponentSections`, keine neue
  Schicht): filtert Zeilen mit Referenz in Projektions-
  Reihenfolge. Keine Preise, keine Keys, keine PII.
- `checkliste/page.tsx`: Workbook-Fetch wie 02j (eine
  `authorizedQuery`, `installation.read`; PermissionDenied/
  null/IntegrityError → null); Prop `datasheetRefs`
  (`... | null`, null = Fallback) an den Manager.
- Manager: Typ-Option „Datenblätter"; Render-Zweig im
  02c-Muster (Titel via displayText + Referenz-Liste oder
  Fallback); Link je Zeile auf
  `/w/[workspaceId]/katalog/[componentId]` (Seite
  existiert); alle Rollen (Viewer read-only identisch);
  Strukturmodus ohne Zusatz-Inputs (Art ohne Inhalt).
- Typwechsel ehrlich (title-Spiegel): zu `datasheets`
  → done/required false, description/value/photo/
  signerRole null; weg davon → Standardzweige wie bisher.
- Template-Manager: Option „Datenblätter" (kind 1:1,
  nie Inhalt — 02i-Praezedenz); `renderFreshBlocks` mappt
  1:1 mit done/required false (kein Code noetig).

## Vertrag DB (0178 — 0177 ist F7-02j; Replace nur `_f704_valid_checklist_blocks`)
- kind-IN (0177-Z.129) + `datasheets` (Vollkopie 0177).
- Anzeige-Regel (0177-Z.179) + `datasheets` (required/
  done true am kind = ungueltig).
- Keine neuen Keys, kein Schemawandel, kein Backfill.
- Rollen-Pin validBlocks neu harvesten (02i-Praezedenz).

## Vertrag App
- Zod: kind-Enum + `datasheets`; Template-Kommentar
  „alle zehn Projekt-Arten".
- Spiegel-Regeln unveraendert (value/photo/signerRole/
  description bleiben kind-fremd → am datasheets-Punkt
  invalid; Tests pinnen je einen Fall).
- Render-Vertrag: je Zeile „{productName} — {filename}"
  (z.B. „PV-Modul X — hersteller-datenblatt.pdf") als
  Link; Fallback-Text exakt „Keine Datenblätter
  verfügbar."; Titel weiter mit Platzhalter-Substitution
  (03c/03e-Kontexte).

## Sicherheit
- Keine neue: read-only-Projektion bestehender Quelle,
  `installation.read`-gated; Helper projiziert nur
  Name+Dateiname+Komponenten-ID (keine Storage-Keys, kein
  sha, keine Preise, keine PII ueber Bestand hinaus);
  Seite crasht nie ohne Workbook.
- Kein Datei-Zugriff per Key (kein Orakel, keine
  Traversal-Flaeche — Links zeigen nur auf die bestehende,
  berechtigungsgepruefte Katalog-Seite).

## Tests (RED zuerst)
- Unit: `tests/unit/f702k-datenblaetter.test.ts` — U-01
  kind im Enum (Projekt + Vorlage); U-02 required/done je
  einzeln invalid; U-03 Fremd-Nutzlast invalid (value,
  photo, signerRole, description); U-04 Projektions-Helper
  (Reihenfolge, Custom/versteckte/asset-lose Zeilen raus,
  keine Keys/sha/Preise); U-05 `isChecklistWorkItem`
  false; U-06 02c/02j-Suiten unveraendert gruen.
- DB: `tests/db/f702k-datenblaetter.test.ts` — DB-01 kind
  persistiert (Save + Re-Read); DB-02 required/done am
  kind verworfen; DB-03 fremder kind weiter verworfen
  (IN-Regression); DB-04 Template-Anwendung erzeugt
  kind-Punkt mit done/required false.
- E2E: `tests/e2e/f7-02k-checklist-datenblaetter.spec.ts`
  (Setup nach f7-10/02j: Projekt + Installation +
  Variantenbindung, Katalogzeile MIT Datenblatt-Asset) —
  E-01 Typ stellen → Referenz-Liste mit Link sichtbar;
  E-02 Link fuehrt auf Katalogkomponenten-Seite; E-03
  Reload stabil; E-04 Viewer sieht Liste; E-05 ohne
  Bindung/ohne Assets → Fallback; E-06 kein
  Pflicht/Abhaken angeboten; E-07 Axe.
- Nachbarn: 02c (Anzeige), 02j (Quell-Muster), 03e
  (Quelle), f7-10 (Setup).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify` gruen; E2E
  Chromium gruen; Heartbeat + Push + CI gruen.
