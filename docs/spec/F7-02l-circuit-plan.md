# SPEC F7-02l — Schaltplan-Punkt (Katalog F7.2)

## Matrix
F7.2 Item-Typen: task/title/description/radio/text/multi/image/
signature/component-list/datasheets VERIFIED (02c/d/e/f/g/i/j/k);
`circuit-plan` (Katalog-Schreibweise mit Bindestrich wie
component-list — Blaupause 01-modulkatalog.md:92) offen.
Q-F7-LAYOUT-QUELLE ist fuer circuit-plan ENTSCHIEDEN: F7-11
liefert den Gegenbeweis — `toSchematicInputs`
(workbook-service.ts:296) + `buildSingleLineSchematic`
(single-line-v1.ts:75) + `SingleLineDiagram`
(app/_components/single-line-diagram.tsx:12) leiten den
Schaltplan aus der GEBUNDENEN Variante ab; keine gespeicherte
Plan-Quelle noetig (F7-11-SPEC Z.16-20; Q betraf gespeicherte
Quellen). `circuit-plan` rendert diese BESTEHENDE Ableitung
als Anzeige-Punkt read-only — kein Upload, keine neue Route,
keine neue Permission, kein Provider. Deferred (weiter
blockiert): `planned-layout` — kein 3D-Renderer, keine
gespeicherte Layout-Quelle.

## Ziel
kind=`circuit-plan`: Anzeige-Punkt (02c-Semantik — weder
Pflicht noch abhakbar), der den Einlinien-Schaltplan der
gebundenen Variante (F7-11-Renderer, ESTIMATE-Layout wie
Workbook) read-only rendert. Ohne Bindung, ohne verdrahtete
Knoten, fehlendem Leserecht oder Integritaetsfehler steht
ehrlich „Kein Schaltplan verfügbar." — kein Phantom-SVG,
kein Page-Crash (F7-11/02k-Praezedenz). Tree speichert nur
die Art (kein Inhalt, kein Snapshot — 03B „Art nie Inhalt").

## Entwurf (Anzeige-Art, keine neue Op)
- `checklistItemKindSchema` + `circuit-plan` (contract.ts:115;
  zehn → elf Arten). Template-Schema erbt automatisch
  (shared Import, template-contract.ts:3/33); Kommentar
  „alle zehn" → „alle elf" (template-contract.ts:31-32).
- Display-Status folgt OHNE Regel-Code: App-Refine
  (contract.ts:376-378) und `isChecklistWorkItem`
  (contract.ts:567-574) sind Allowlist-basiert — neue Art
  ist automatisch Anzeige (Tests pinnen das).
- `checkliste/page.tsx`: vierte `authorizedQuery` im
  02k-Muster (page.tsx:165-186, `installation.read`):
  `getInstallationWorkbook` → `toSchematicInputs(
  workbook.sections)` (workbook-service.ts:296-303);
  ohne Workbook/Recht/bei Integritaetsfehler null
  (PermissionDenied/OfferIntegrityError → null, wie 02k).
  Prop `schematicInputs: SchematicSectionInput[] | null`
  (null = Fallback) an den Manager.
- Manager (`project-checklist-manager.tsx`, Client Z.1):
  Props-Muster wie `datasheetRefs` (Z.106-119, durchgereicht
  Z.398-401/582-584 — Client importiert aus `@/modules/*`
  nur Typen, F7-11-Kommentar installation-workbook-panel.
  tsx:77-82). Client-sichere Imports: `SingleLineDiagram`
  aus `@/app/_components/single-line-diagram` (F7-11-Pfad,
  Panel Z.4) + `buildSingleLineSchematic` /
  `type SchematicSectionInput` aus
  `@/lib/integrations/schematic/single-line-v1` (reine
  Funktion, keine Server-Imports — single-line-v1.ts:1-24).
- Render-Zweig im 02k-Muster (nach Z.768-793, vor `text`
  Z.795): Titel oben via displayText (Z.719-720), dann
  `schematicInputs !== null &&
  !buildSingleLineSchematic(schematicInputs).empty`
  (Panel-Praezedenz Z.88, `empty`-Flag single-line-v1.ts:44/
  168/170) → `<SingleLineDiagram schematic={...}/>`
  (Props single-line-diagram.tsx:12, `data-testid=
  "checklist-schematic"`); sonst Fallback.
- Fallback-Text exakt „Kein Schaltplan verfügbar."
  (F7-11-Text panel Z.240 wiederverwenden — gleicher
  Renderer, gleiche Bedeutung; bei null UND bei empty).
- Strukturmodus: 02j/02k zeigen bewusst AUCH im
  Strukturmodus (Manager Z.740-743/764-767) — uebernehmen,
  gleiche Begruendung: Art ohne Zusatz-Inputs, keine
  Kollisionsflaeche (description/text/image/signature sind
  dort ausgeblendet, weil sie Edit-Inputs haben — Z.737/
  795/813/825).
- Typwechsel ehrlich (title-Spiegel, neuer Zweig nach
  Z.1730-1734): zu `circuit-plan` → done/required false,
  description/value/photo/photos/signerRole null; Option
  „Schaltplan" im Typ-Dropdown nach Z.1748.
- Template-Manager: Option „Schaltplan"
  (template-manager.tsx:230, nach Datenblaetter);
  `renderFreshBlocks` mappt kind 1:1 mit done/required
  false (templates.ts:398-411 — kein Code noetig,
  02k-Praezedenz).
- KEIN Portal-Bezug: Checklisten-Punkt ist intern
  (w/-Routen); app/p + app/s enthalten 0 Treffer fuer
  checklist/workbook/schematic (grep RC=1).

## Vertrag DB (0185 — 0185-0189 frei, 0184 latest per Journal)
- Basis ist 0180 (juengster `_f704_valid_checklist_blocks`-
  Rumpf — 0180 ist Vollkopie von 0178 plus photos),
  NICHT 0178: Vollkopie von 0180 plus kind=
  `circuit-plan` an zwei Stellen — kind-IN (0180:129)
  und Anzeige-Regel (0180:217, required/done true am
  kind = ungueltig).
- Beide CREATE-Ruempfe enthalten (0177/0178-Muster):
  nur `_f704_valid_checklist_blocks` (0180:9) aendern;
  `_f704_checklist_structure` (0180:293) byte-identisch
  (Art ohne Nutzlast, kein Strip — 02j/02k-Praezedenz).
- Keine neuen Keys, kein Schemawandel, kein Backfill.
- Rollen-Pin `validBlocks` neu harvesten
  (scripts/db-role-contract.mts:515 — Gate-Lauf nach
  0185-Anwendung, 02k/F7-15-Praezedenz Z.500-505);
  `checklistStructure`-Pin (Z.512) unveraendert.

## Vertrag App
- Zod: kind-Enum + `circuit-plan`; Template-Kommentar
  „alle elf Projekt-Arten".
- Spiegel-Regeln unveraendert (value/photo/photos/
  signerRole/description bleiben kind-fremd → am
  circuit-plan-Punkt invalid; Tests pinnen je einen Fall).
- Render-Vertrag: SVG via F7-11-Renderer (`role="img"`,
  F6-01-Bestand) oder Fallback-Text exakt „Kein Schaltplan
  verfügbar."; Titel weiter mit Platzhalter-Substitution
  (03c/03e-Kontexte); alle Rollen (Viewer read-only
  identisch).

## Sicherheit
- Keine neue: read-only-Projektion bestehender Quelle,
  `installation.read`-gated; Helper projiziert nur
  Kategorie+Titel+Mengenlabel (keine Storage-Keys, kein
  sha, keine Preise, keine PII ueber Bestand hinaus —
  F7-11-Praezedenz); Seite crasht nie ohne Workbook.
- Kein Datei-Zugriff, kein Fetch im Client (reine
  Funktion aus Props), keine Traversal-Flaeche.

## Tests (RED zuerst)
- Unit: `tests/unit/f702l-circuit-plan.test.ts` (Muster
  f702k-datenblaetter.test.ts) — U-01 kind im Enum
  (Projekt + Vorlage); U-02 required/done je einzeln
  invalid; U-03 Fremd-Nutzlast invalid (value, photo,
  photos, signerRole, description); U-04
  `isChecklistWorkItem` false; U-05 Render-Vertrag
  (null → Fallback, leere Inputs → empty → Fallback;
  kein neuer Mapper — `toSchematicInputs` ist F7-11-
  getestet); U-06 02c/02j/02k/F7-11-Suiten unveraendert
  gruen.
- DB: `tests/db/f702l-circuit-plan.test.ts` (Fixture-
  Muster 02k) — DB-01 kind persistiert (Save + Re-Read);
  DB-02 required/done am kind verworfen; DB-03 fremder
  kind weiter verworfen (IN-Regression); DB-04 Template-
  Anwendung erzeugt kind-Punkt mit done/required false.
- E2E: `tests/e2e/f7-02l-checklist-circuit-plan.spec.ts`
  (Setup nach f7-10/02k: M2-01-Fixture
  `seedM201AdditionalReadyProject` + Installation +
  Variantenbindung mit verdrahtbaren Kategorien) —
  E-01 Typ stellen → Schaltplan-SVG sichtbar; E-02 ohne
  Bindung → Fallback; E-03 Variante ohne verdrahtete
  Knoten → Fallback; E-04 Reload stabil; E-05 Viewer
  sieht SVG read-only; E-06 kein Pflicht/Abhaken
  angeboten; E-07 Axe.
- Nachbarn: 02c (Anzeige), 02j/02k (Quell-/
  Verdrahtungs-Muster), F7-11 (Renderer/Quelle),
  f7-10 (Setup).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify` gruen; E2E
  Chromium gruen; Heartbeat + Push + CI gruen.
