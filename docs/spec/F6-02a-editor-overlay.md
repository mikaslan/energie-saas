# F6-02a Editor-Overlay (Bibliothek + deterministischer Merge)

Ziel: Frei platzierbare Ergänzungen zum F6-01-Auto-Gen-Netz — ohne den
Backbone je zu verändern. Slice A: Bibliothek, Merge-Regel, Sperren.
Kein Drag-UI, keine Vorlagen, kein Ask AI, kein JPG/PDF (F6.2-Rest/F6.3).

## Bibliothek (feste Typen, editor-overlay.v1)

| Typ | Bedeutung | Geometrie |
|---|---|---|
| `earthing_point` | Erdungspunkt | Punkt (x, y) |
| `junction_box` | Abzweigdose | Kasten (x, y) |
| `generic` | Generik | Kasten (x, y) + Label |
| `textbox` | Textbox | (x, y) + Text (max 200) |
| `connector` | Konnektor (Kante) | from → to + Label |

Koordinatenraum: F6-01-Raster, `0 ≤ x ≤ 640`, `0 ≤ y ≤ 300`, sichere
Ganzzahlen (JCS-Regel). Max 32 Elemente je Overlay (Formular-Modus).

## Merge-Regel (deterministisch, Backbone-unantastbar)

1. Eingabe: kanonisches F6-01-Netz + Overlay-Elementliste (beliebige Ordnung).
2. Overlay-Knoten erhalten stabile IDs `ovl-1…ovl-n` nach Sortierung
   (Typ-Rang, NFC-Label, x, y) — nie Backbone-IDs (`pv`, `inverter`, …).
3. Konnektoren referenzieren Backbone- oder Overlay-IDs; baumelnde Enden
   und Backbone-Kollisionen sind Validierungsfehler (kein stilles Droppen).
4. Ausgabe: ein Netz (Backbone + Overlay, stabil sortiert), hashbar mit
   `schematic-jcs.v1` — derselbe Hashvergleich wie F6-01 erkennt Drift.
5. Leeres Overlay (0 Elemente) merged identisch (Hash = Backbone-Hash).

## Sperren

- Overlay hängt an `(offer_id, variant_revision)` und pinnt
  `parent_revision` (Revision der `schematic_diagrams`-Zeile beim Anlegen).
- Schreiben nur per CAS (`expectedRevision`); `parent_revision ≠ aktuell`
  → Konflikt (kein Editieren gegen veraltetes Auto-Gen).
- Scope: W-CORE-4-Felder-Gate wie F6-01 (nur residential+b2c+b2c).
- Permission: `project.write` (keine neue Permission).

## Persistenz (0301, Folgeschritt dieses Slices)

`schematic_overlays` je `(workspace_id, offer_id, variant_revision)`:
Elemente als JSONB (CHECK: Objekt + `elements`-Array), eigene `revision`,
RLS `tenant_isolation`, SELECT/INSERT/UPDATE ohne DELETE (Muster 0300).
Migration + Service + Save-Action folgen nach CI-grün von F6-01.

## Ausgeschlossen

Consuel/Normstempel, JPG/PDF-Export, Angebots-PDF-Einbettung,
workspace-weite Vorlagen, Ask AI, Baustellen-Checkliste.
