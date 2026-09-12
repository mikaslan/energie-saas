# F7-04b Punkt als irrelevant markieren (Katalog F7.2, mit Begründung)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12
(DB 4/4 in `tests/db/f704b-item-irrelevant.test.ts`, E2E 1/1 in
`tests/e2e/f7-04b-item-irrelevant.spec.ts`, Nachbarn 14/14, tsc/eslint grün)

## Ziel und Abgrenzung

Modulkatalog F7.2 verlangt „Mark as irrelevant“ mit Begründung. F7-04 hat
den Segmentabschluss geliefert und (u. a.) diesen Punkt ausdrücklich
offengelassen. Dieser Slice: Pflichtpunkte mit Begründungspflicht als
irrelevant markieren bzw. aufheben; irrelevante Pflichtpunkte zählen im
Complete-Gate nicht. Kein Reonic-Referenzbeleg für die Detailsemantik;
Verhalten ist reversible eigene Näherung (ESTIMATE).

## Vertrag

- Markierung ist Item-Attribut (`irrelevant: {reason, by, at} | null`) wie
  done/required — Whole-Tree-Saves erhalten es (Validator 0127 prüft die
  Form), setzen/löschen darf nur die dedizierte Op
  `set_project_checklist_item_irrelevant` (Begründungspflicht, CAS).
- Nur sichtbare Pflichtpunkte in sichtbaren, offenen Segmenten (fail-closed:
  versteckt → StateError hidden, abgeschlossen → StateError completed,
  optional → Validation, unbekannt/fremd → NotFound).
- reason 1–500 UTF-16-Einheiten, NFKC+trim wie Titel (Validator
  `_f704_valid_clean_text`); `null` = aufheben (idempotent, kein
  Versionsverbrauch ohne Änderung).
- Keine neue Permission (`checklist.write`); keine neue Tabelle (kein
  RLS-/ACL-Tabellenwechsel); Funktions-ACL im Rollenvertrag
  fortgeschrieben (Routine + Body-Hashes).

## Evidenz

- Bestehende Pfade: `saveProjectChecklist` (Validator),
  `completeChecklistSegment` (Gate), Capsule-Event/Audit-Muster F7-04.
- Events `checklist.item_marked_irrelevant` /
  `checklist.item_marked_relevant` + Audit (`checklist.write` /
  `project_checklist_item`, mit operation + baseVersion).

## Validierung (fail-closed, keine stillen Defaults)

- Leere/blanke/501-Zeichen/Kontrollzeichen-Begründung → Validation.
- Optionaler/versteckter Punkt, unbekannte IDs, fremder Workspace →
  Validation/StateError/NotFound (kein Orakel).
- Veraltete Version → Conflict; abgeschlossenes Segment → StateError;
  Viewer → denied.
- Präzedenzfalle dokumentiert: `-` bindet stärker als `->` — Schlüssel-
  Subtraktion auf `->`-Zugriff braucht Klammern
  (`(x->'k') - ARRAY`), sonst impliziter text→jsonb-Cast (22P02).

## Anzeige

Checkliste je Pflichtpunkt (schreibberechtigt, offen): Button
„Als irrelevant markieren“ → Begründungsformular → Badge
„Irrelevant: <Grund>“ + „Markierung aufheben“. Zähler
(`segmentRequiredRemaining`) und Complete-Button folgen dem Gate-Skip.

## Akzeptanz

- `F704B-DB-01`: Markierung (DTO + Zähler 0) → Abschluss gelingt,
  Event/Audit belegt.
- `F704B-DB-02`: Begründungspflicht, Pflichtpunkt-Bindung,
  Mandantenschranke.
- `F704B-DB-03`: Aufheben stellt Sperre wieder her; CAS, Siegel, Viewer.
- `F704B-DB-04`: Verborgen-Schranke; Save-Roundtrip erhält Markierung.
- `F704B-E2E-01`: Admin-UI-Fluss (Badge, Reload-Persistenz, Aufheben),
  axe WCAG-A/AA ohne Befund, keine Browser-Fehler.

## Bewusst offen

- if/then-Konditionallogik, 12+ Itemtypen, Fotos/Signaturen,
  Block-Zuweisung (F7-04-Grenzen, unverändert).
- Container-Auswahl, Bulk-Markierung, Portal-Sicht der Markierung.
