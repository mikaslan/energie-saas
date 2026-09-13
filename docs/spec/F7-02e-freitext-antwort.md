# F7-02e Freitext-Antwort (Slice B, Katalog F7.2)

Katalog F7.2 nennt „freetext mit Diktat“ unter 12+ Item-Typen. Diktat
(Spracheingabe/Transkription) ist KI-providergebunden und bleibt offen;
dieser Slice liefert den rein lokalen Rest: Textantwort-Wert je Punkt
(F7-02d-Muster: radio ohne Optionen).

## ESTIMATE (reversibel, keine Reonic-Referenz für Antwort-Semantik)

- Modell: optionaler Key `value` (Fließtext, max. 2000 Zeichen wie
  `description`) NUR an `kind: "text"` (Spiegel-Regel wie description,
  F7-02C-Präzedenz: kein Schmuggelpfad, kein stilles Ignorieren).
- Textpunkte sind abhakbar und pflichtfähig wie Aufgaben/Radios
  (`done`-Boolean, `required` zulässig); `value` ist davon orthogonal
  (kein Auto-Check bei Eingabe, keine Pflicht-aus-Wert-Ableitung).
  Zähler/Pflicht-Gate/Complete-Gate behandeln sie wie Aufgaben
  (keine Gate-Codeänderung: Complete zählt required+!done kind-blind).
- Typwechsel schreibt ehrlich um (F7-02C/F7-02D-Muster): weg von Text
  → `value` null; nach Text → `description` null.
- Leerstring ist kein Wert (UI sendet null, Validator lehnt "" ab —
  Spiegel zu description).

## Vertrag

- Migration `0142_f7_02e_freitext_antwort` (nur Funktion, F7-13-Muster):
  `CREATE OR REPLACE _f704_valid_checklist_blocks` — Vollkopie des
  0141-Bodys + `kind IN (..., 'text')` + `value`-Key in der Allowlist +
  Spiegel-Regeln (Typbindung + clean_text 2000). Keine neue Tabelle,
  keine neue Permission (checklist.write), keine RLS-Änderung.
- Rollenvertrag: Funktions-Pin `_f704_valid_checklist_blocks(jsonb)` neu
  ernten (Gate verifiziert bei jedem Lauf); keine neuen Routinen/Grants.
- Contract: `"text"` in die Kind-Enum, `value`-Feld (nullish),
  Baumvalidierung (Wert verlangt Textpunkt), `isChecklistWorkItem` += text.
- UI: Typ-Select „Textantwort“; Textarea (`Antworttext`, leer → null);
  Anzeige des Werts lesend wie Beschreibung; Checkbox bleibt.

## Regeln

1. Keine Migration jenseits 0142, keine neue Permission, kein Provider.
2. Vorlagen (F7-03/F7-13): Template-Items kennen kein `kind`/`value`
   — Textpunkte entstehen nur in der Projekt-Checkliste.
3. Segment-Complete/Outbox: Whole-Tree-Saves, gleiche Validierung.

## Tests

- DB (`f702e-freitext-antwort`): Roundtrip (Wert persistent),
  Pflicht-Text blockiert Abschluss bis erledigt, Wert an Aufgabe →
  Validation fail-closed (Service + Direkt-Validator), Überlänge →
  Reject, Fremdtenant → NotFound.
- Unit: Work-Item-Predicate, Typbindung, Längenkappe, Gate-Zählung.
- E2E (`F7-02E-E2E-01`, isoliert, F7-02C-Muster): Typ wählen → Text
  füllen → Pflicht → Speichern → Reload persistent (Wert + Zähler);
  Viewer sieht Wert ohne Editor; Axe sauber, keine Konsolenfehler.
- Nachbarn: F7-02/02b/02c/02d/04b/04c/13/14-DB, m111a-Pins (0142),
  m204-Gate, generate ohne Drift.

## Bewusst offen

- Diktat/Spracheingabe (KI-Provider), Multi-Select/Optionenmodell,
  Bild-/Signatur-/Komponenten-Item-Typen, Text in Vorlagen,
  Antwort-Pflicht (Wert-statt-done-Gate).
