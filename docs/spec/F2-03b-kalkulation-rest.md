# F2-03b — Kalkulations-Rest (Sektionstitel, Ad-hoc-Katalogzeilen, Op-Testlücken)

Status: **SPEC-DRAFT Lane 7 Welle 2**

Lane 7, Worktree `energie-saas-fleet-7`. Vorgänger: M2-01
(Snapshot-BOM, Revise-Ops, `expectedRevision`-CAS), F2-02
(Strukturvorbild), F16-11/F16-13 (Paket-Vorlagen, Katalog-Bindung
fail-closed). Keine Migration.

## Scope

1. **D3-01 Sektionstitel-Edit** — neuer Revise-Op
   `set_custom_section_title`, revisionspflichtig (Begründung unten).
2. **D3-02 Katalog-Artikel ad-hoc in BOM** — neuer Op
   `add_catalog_line` (Snapshot-Kopie, keine Live-Bindung) plus
   symmetrisches `remove_catalog_line` nur für Ad-hoc-Zeilen.
3. **D3-06 Revise-Op-Testlücken** — fehlende Tests je Op schließen
   (Liste unten, verifiziert gegen `tests/`).
4. **D3-03 echtes Drag-Reorder** — NUR gedeckelter Stretch
   (Abbruchkriterium unten).

## Befund D3-01 (Beweis, gelesen)

- `offer-editor.tsx` Z.1263–1268: Titel-Input existiert nur für
  `draftSection.isNew`; bestehende Sektionen rendern nur `<h2>`.
- `offer-editor-model.ts` Z.635–639: Titel fließt nur in
  `add_custom_section` für neue Sektionen ein; bestehende
  (`sourceSectionById.has → continue`) erzeugen nie eine Titel-Op.
- Kein Titel-Op in Contract (`contract.ts` Z.215–358), Service
  (`service.ts` Z.2523–2762) oder UI-Modell (Suche nach
  `set_section_title`/`rename_section` leer).
- Bestehende 23 Ops (vollständig, Contract + Service deckungsgleich):
  `set_planning_mode`, `set_variant_name`,
  `set_variant_description`, `set_global_discount`,
  `set_global_fix_discount`, `set_custom_deal`,
  `set_section_discount`, `move_section`, `move_line`,
  `set_line_quantity`, `set_line_quantity_link`,
  `clear_line_quantity_link`, `set_custom_line_details`,
  `set_line_position_type`, `set_line_visibility`,
  `set_line_sales_price`, `set_line_purchase_price`,
  `set_line_discount`, `remove_custom_line`, `add_custom_section`,
  `remove_custom_section`, `add_custom_line`, `set_line_tax`.

## Nicht-Ziele

- Keine Migration (auch keine Trigger-Anpassung).
- Kein Hidden-Release-Umbau des VERIFIED-Gates.
- Keine 5b/5d-Slices.
- Kein Provider/Lock/Versand/Auto-Installation.
- Kein Rename von Seed-Sektionen, kein Kategorie-Edit.
- Keine Live-Katalogbindung, keine Geld-/Rabatt-Math-Änderung.

## Datenmodell

Keine Schemaänderung. Beide neuen Ops schreiben nur den
Snapshot-Body plus die bestehenden Sektions-/Zeilenmirrors.
`resolutionLineId: null` als Ad-hoc-Marker ist eine rein additive
Contract-Änderung: Der Mirror-CHECK `offer_bom_line_source_ck`
bindet nur `source_kind` + Komponente + Revision + SHA und bleibt
erfüllt (Verifikation am Deferred-Trigger siehe Offene Punkte).

## Service-Semantik

### D3-01 `set_custom_section_title`

- Schema: `{ operation, sectionDomainId: uuid, title:
  normalizedRequiredText(120) }` (Limit wie `add_custom_section`).
- Custom-only mit demselben Nachweis wie `remove_custom_section`
  (`service.ts` Z.2704): keine Zeile mit `source.kind !== "custom"`;
  leere Sektion gilt als custom. Seed-Sektionen behalten ihren
  Resolution-Titel als Herkunftsnachweis.
- `expectedRevision`: JA, Pflicht. Der Titel ist Teil des
  versiegelten Snapshot-Bodys; Deferred-Trigger binden Body, Hash
  und Mirrors (M2-01). Eine revisionslose Änderung wäre eine stille
  Snapshot-Mutation. Jede Umbenennung → Revision N+1; stale
  `expectedRevision` → `OfferConflictError` (M2-01-Muster).
- Recht: `project.write` (Struktur, kein Preis; analog
  `set_variant_name`). Kategorie bleibt unverändert.
- UI: Titel-Input für bestehende Custom-Sektionen im Editor;
  Draft-Diff erzeugt die Op (Analogie Z.637–639).

### D3-02 `add_catalog_line` / `remove_catalog_line`

- Input: `lineDomainId`, `sectionDomainId`, `position`,
  `catalogComponentId`, `expectedCatalogRevision`, `quantityMilli`,
  `taxTreatment` (+ `zeroConfirmation` bei 0 %, M2-01-Regel).
  Der Client sendet keine Preise/Stammdaten (Fälschungsschutz).
- IDs/Suche (gelesen, `modules/catalog/service.ts`):
  `searchActiveProjectCatalogComponents` (project-scoped, nur
  aktiv, max 50), `listCatalogComponents` (Status/Query inkl.
  SKU-Exaktmatch), `getCatalogComponent` (`current_revision` +
  Snapshot + SHA).
- Validierung serverseitig im Tenant-Scope: Komponente aktiv,
  `commercial ≠ null`, `current_revision == erwartet`, sonst
  fail-closed (Muster `resolveBoundLines`, `package-templates.ts`
  Z.146–212; Drift → Validierungsfehler, nie stiller Preiswechsel).
- Snapshot-Kopie: SKU, Name, Hersteller, Modell, Einheit, EK/VK,
  Provenienz, SHA werden kopiert; `salesPricing`-Provenienz
  `catalog_seed`; `source.kind = "catalog"`,
  `resolutionLineId = null` (kein Resolution-Ursprung).
  Keine Live-Bindung: spätere Katalogänderung ändert die BOM
  nicht; Outdated-Logik unberührt.
- Rechte: `price.edit` + `price.read_purchase` (wie
  `add_custom_line`, `service.ts` Z.2857–2860) + `catalog.read`.
- `remove_catalog_line` nur für Ad-hoc-Zeilen (Guard:
  `resolutionLineId` null; Seed-Zeilen unberührbar), inkl.
  F16-12-Dependenten-Check. Ohne ihn wären Ad-hoc-Zeilen
  unlöschbar, da `remove_custom_line` custom verlangt (Z.2672ff).
- Konsequenz (DECIDED): Eine Custom-Sektion mit Ad-hoc-Katalogzeile
  verliert den Custom-Status für Rename/Remove (Guard prüft
  Zeilen, Z.2704) — konsequent zum M2-01-Seed-Schutz. UI legt
  Ad-hoc-Zeilen bevorzugt in Seed-Sektionen passender Kategorie.

### D3-06 Testlücken (verifiziert gegen `tests/`)

- `set_section_discount`: 0 Treffer → Service-Semantik
  (`discount.apply`-Guard, Sektions-Allokation) völlig unbelegt.
- `remove_custom_section`: nur Stringliste in
  `tests/build/m201-offer-ui-contract.test.ts:256` → keine
  Service-/DB-Semantik (Custom-Guard, Dependenten, Reindex).
- `set_global_fix_discount`: nur Clear-Pfad (`f1603d:642`) →
  Set-Pfad, Range, Zusammenspiel mit Prozent-Deckel fehlt.
- `set_variant_description`: nur Vehikel in Fremd-Slices (m204,
  f1613, f1614) → eigene Form-/Null-/Normalisierungssemantik fehlt.
- Restliche 19 Ops: stichprobengeprüft vorhanden
  (Editor-Modell-, Contract-, Service-Tests).

### D3-03 Stretch (gedeckelt)

Echtes Drag-Reorder nur als UI-Alternative zu den Hoch/Runter-
Buttons (`offer-editor.tsx` Z.1270–1272, 1334–1335); gleiche Ops
(`move_section`/`move_line`), Buttons bleiben (Tastatur).
Abbruchkriterium: Ist Drag in einem Slice nicht tastaturbedienbar
UND getestet (Unit + E2E) lieferbar, entfällt es ersatzlos —
die Buttons bleiben alleinige Wahrheit. Kein neues Backend.

## Tests (IDs F203B-*)

- F203B-01 Rename Custom-Sektion: neue Revision, Titel im
  Snapshot + Mirror, stale `expectedRevision` → Conflict.
- F203B-02 Rename Guards: Seed-Sektion und Sektion mit
  Katalogzeile → `OfferValidationError`; Titel leer/>120 →
  Contract-Ablehnung; Viewer → Permission.
- F203B-03 Ad-hoc-Add: Snapshot-Kopie (Preise/Stammdaten/SHA),
  `catalog_seed`, `resolutionLineId` null; Katalogdrift/inaktiv/
  preislos → fail-closed; Clientpreise ignoriert.
- F203B-04 Ad-hoc-Remove: nur Ad-hoc entfernbar, Seed-Zeile
  abgelehnt, Dependenten fail-closed.
- F203B-05 `set_section_discount`: Guard + Allokation + Audit.
- F203B-06 `remove_custom_section`: Custom-Guard, gemischte
  Sektion abgelehnt, Dependenten, Reindex.
- F203B-07 Fix-Rabatt Set-Pfad + Deckel-Kombi; Description-
  Form/Null/Normalisierung.
- F203B-08 Editor-Diff: Titeländerung erzeugt genau eine
  `set_custom_section_title`; keine Titel-Op ohne Änderung.
- F203B-09 (nur bei Stretch): Drag erzeugt identische Ops wie
  Buttons; Tastaturpfad unverändert (E2E).

## Offene Punkte

1. Vor Implementierung am Deferred-Trigger verifizieren, dass
   `resolutionLineId: null` im Snapshot-Body akzeptiert wird;
   sonst Slice stoppen und Contract-Alternative entscheiden.
2. Katalog-Picker-UI (Suche + Revisionspin): eigener UI-Slice
   nach Service-Slice oder mit darin — Implementierung entscheidet.
3. Seed-Sektions-Rename bleibt bewusst ausgeschlossen; bei Bedarf
   eigener Slice mit Provenienz-Regel.
