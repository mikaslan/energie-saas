# F7-02C — Anzeige-Punkte (title/description) am Checklisten-Punkt

Status: **IN ARBEIT** · Lane: `codex/m1-wave-02`
Basis: Modulkatalog F7.2 (Item-Typen; F7-02-Spec Slice B) · Q-unblockiert

## Ziel und Abgrenzung

Live beobachtet (F7-02-Spec §1, Clean Room): Item-`type ∈ {description,
title, radio, image, …}`. Dieser Slice macht die beiden
nicht-interaktiven Anzeige-Typen durchgängig: `title` (Überschrift/
Separator) und `description` (Titel + Fließtext, z. B. Arbeitsanweisung).
Radio/image/freetext/signature bleiben eigene Slices (Antwort-/Upload-
Speicherung fehlt).

Durchgängig: Typ-Wahl (Formular/Validierung) → Persistenz
(Whole-Tree-Save, Migration) → Auswertung (Gates schließen Anzeige-
Punkte aus) → Anzeige (Render ohne Checkbox).

## Datenmodell (additiv, Migration 0130)

`editableChecklistItemSchema` + optional (nullish wie
irrelevant/visibleIf — fehlend/null = Aufgabe, kein Bestand bricht):

```text
kind: "task" | "title" | "description" | null
description: string (1..2000, clean text) | null
```

## Validierung (fail-closed)

- `description`-Text nur bei `kind == "description"` (sonst verweigern —
  kein stilles Ignorieren fremder Inhalte).
- `required == true` nur bei Aufgabe (`kind` task/null); Anzeige-Punkte
  können nie Pflicht sein (Verweigerung, kein Auto-False).
- `done == true` nur bei Aufgabe (Anzeige-Punkte sind nicht abhakbar).
- DB-CHECK (Migration 0130, Muster 0129): optionale Keys `kind`
  (Enum) + `description` (string, clean-text 2000); required-Kopplung
  wie oben per SQL mitgeprüft.

## Auswertung

- Anzeige-Punkte zählen weder in `segmentRequiredRemaining` noch in
  `segmentItemProgress` (Gegenstück zu F7-04b/F7-02B-Skips).
- Complete-Gate (SQL): Anzeige-Punkte blockieren nie (sie können kein
  required tragen — Validator garantiert, Gate zählt required ohnehin).
- Outbox-Replay neutral (entscheidet gegen `completedAt`).

## Anzeige / Editor

- Render: `title` → Überschriften-Zeile; `description` → Titel +
  Fließtext; beide ohne Checkbox, ohne Pflicht-Badge, ohne
  Irrelevant-/Regel-Editor (nichts zu konfigurieren außer Inhalt).
- Editor (`canEditStructure`, neben Titel-Input): Typ-Auswahl
  (Aufgabe/Titel/Beschreibung); Beschreibungs-Textarea nur bei
  `kind == "description"`; Pflicht-Checkbox nur bei Aufgabe sichtbar.
- Typwechsel schreibt ehrlich um (kein separater Dialog, Felder
  verschwinden sichtbar mit der Auswahl): weg von Aufgabe → done/required
  auf false; weg von Beschreibung → description auf null. Der Validator
  lässt keine Mischbestände zu.

## Akzeptanz

- Unit: kind-Matrix (Gates schließen aus), required/done/description-
  Kopplungen, Shape-Rejects.
- DB: Validator-Shape, Save mit Anzeige-Punkten, required+description-
  Reject, Complete bei offenen Anzeige-Punkten möglich.
- E2E (isolierter Workspace): Beschreibungs-Punkt anlegen → Text ohne
  Checkbox sichtbar, Zähler ignorieren ihn, Reload persistent, Axe sauber.
- Gates: tsc/eslint/depcruise grün; keine neuen Permissions; keine
  Änderung an Template-/Outbox-Verträgen.

## Bewusst offen

- radio/multi-select/freetext/image/signature (+Antwortspeicherung),
  component-list/circuit-plan/datasheets/planned-layout.
- Template-Autorenschaft von Anzeige-Punkten (Template-Items sind
  komponentengebunden).
- Exakte Reonic-Darstellung bleibt ESTIMATE bis Live-Beleg.
