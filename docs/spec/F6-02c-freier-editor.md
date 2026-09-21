# F6-02c-A Freier Editor: Drag-Positionierung + ID-Anzeige (SPEC)

Ziel: F6.2 schließen — Overlay-Elemente per Drag auf dem 640×300-Raster
positionieren, vergebene `ovl-*`-IDs sichtbar (schließt Review-P1-2 aus
5H). Keine Migration, kein Wire-Format-Wechsel, keine Auto-Saves.

## Umfang

1. **Canvas** (`schematic-overlay-canvas.tsx`, client, controlled):
   rendert NUR Overlay-Elemente als SVG im selben 640×300-Raum wie das
   Diagramm (eigenes SVG, keine Diagramm-Änderung). Props: Zeilen,
   IDs, `onPositionChange(index, x, y)`, disabled.
2. **Drag** (`@atlaskit/pragmatic-drag-and-drop`, Muster
   `board-client.tsx`): `draggable` je Element + ein Canvas-Drop-Target;
   Drop → Pixel in Canvas-Koordinaten → clamp 0..640/0..300 → `round`
   (ganzzahlig). Nur Overlay-Elemente (Backbone nie draggable);
   Konnektoren folgen ihren Knoten (kein eigenes Drag).
3. **ID-Anzeige**: gespeicherte Elemente zeigen ihre `ovl-*`-ID (Chip
   auf Canvas + Spalte in Form-Zeile). Quelle: Server-Mapping
   (deterministisch, s. Contract) — nie raten, nie client-seitig
   erfinden. Ohne Mapping (frischer Entwurf): kein Chip.
4. **A11y**: fokussiertes Element per Pfeil ±1 (±10 mit Shift);
   sichtbarer Fokus, `role="application"`-frei (native Buttons als
   Griffe), axe-Pflicht wie OVL-04.
5. **Persistenz**: unverändert (Formular-Save mit neuen x/y, CAS +
   Parent-Pin wie bisher). Kein Auto-Save beim Drop (Sperre).

## Contract

- Neu (rein, server+node): `assignOverlayIds(backboneIds, elements)`
  in `editor-overlay-v1.ts` → `Array<{ index, id }>` (Eingabereihen-
  folge, Duplikate per stabilem Index-Tiebreak, disjunkt zu
  Backbone-IDs). `mergeEditorOverlay` nutzt sie intern (eine Quelle;
  abgedeckt durch bestehende Merge-Tests).
- Loader erweitert: `LoadSchematicOverlayResult` + `elementIds:
  (string | null)[]` (paralleles Array, Wire-Format unberührt).
  IDs aus Diagramm-Zeile (Knoten-IDs) + `assignOverlayIds`; bei
  fehlender/fehlerhafter Zeile alles `null` (fail-closed: keine
  Anzeige). Versionen unverändert (`editor-overlay.v1`).
- Formular/Canvas zeigen `elementIds[i]` an; neue (ungespeicherte)
  Zeilen haben keine ID.

## Sperren (SHALL-NOT)

- Kein Backbone-Drag; kein Konnektor-Drag; kein Wire-Format-Wechsel
  (from/to bleiben freie ID-Strings); keine Migration (0303 gehört B);
  kein Auto-Save (Drop → Entwurf, Save explizit); kein Snap-Zwang
  (frei + clamp genügt); kein Touch-Drag-E2E (Pointer-Matrix nur
  Maus + Tastatur); keine IDs ohne Server-Mapping.

## RED-Testliste (nächster Schritt)

1. Unit `f602c-id-assign.test.ts`: Sortierung (Rang/NFC/x/y),
   Index-Tiebreak bei Duplikaten, Disjunktheit zu Backbone-IDs,
   Leereingabe → `[]`, Ausgabereihenfolge = Eingabereihenfolge.
2. E2E (Erweiterung `f602a-overlay.spec.ts`): Drag Maus → Save →
   Reload → Position persistiert; ID-Chips nach Save sichtbar;
   Tastatur-Nudge ±1/±10; Backbone-Knoten nicht draggable;
   Axe ohne critical/serious.
3. Keine DB-Tests (kein Schema), keine Gold-Tests (JCS unberührt).

## Ausgeschlossen

Klick-Connect (Kante per Klick ziehen), Snap-Grid-Optionen,
Multi-Select, Touch-Drag-E2E, Vorlagen (B), Export (C), Ask AI,
Consuel.
