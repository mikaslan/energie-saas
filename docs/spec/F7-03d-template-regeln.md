# SPEC F7-03d — Template-Regel-Editor (Conditional Logic)

## Matrix
Katalog Zeile 217 (offener Backlog): „Conditional-Logic-Editor der
Checklisten-Templates". Projektseite hat if/then-Regeln (F7-02B,
visibleIf→Item-ID, Single-Hop); Vorlagen haben keine. Keine Migration
(items=jsonb ohne Item-CHECK; kind-Präzedenz F7-03B: Vertrag-only).

## Ziel
Regel je Vorlagen-Position: „Sichtbar, wenn [Geschwister-Komponente]
erledigt". Speichern validiert (Ziel muss Geschwister sein, kein
Selbstbezug); Anwenden/Reapply-Merge mappen Komponenten-ID → erzeugte
Punkt-ID (visibleIf); Projekt-Engine unverändert (F7-02B-Semantik).

## Entwurf
- Template-Item + `visibleIfComponentId` (uuid, nullish). Items-Refine:
  gesetzt → muss Komponente EINER ANDEREN Position derselben Vorlage
  sein (fail-closed: baumelnd/Selbst = ungültig). Keine Ketten-Prüfung
  ( Single-Hop gilt erst im Projekt; Vorlage prüft nur Existenz).
- Apply (`renderFreshBlocks`) + Reapply-Merge (Ergänzungspfad): Regel
  mappen (componentId → neue Item-ID); unauflösbar → fail-closed
  (darf nach Save-Validierung nicht vorkommen; Guard trotzdem).
- UI template-manager: pro Position Select „Sichtbar, wenn" (Optionen:
  Keine Regel + Geschwister-Komponentennamen), Speichern wie bisher.
- Keine neue Permission (Vorlagen-Rechte wie bisher), keine DB-Änderung.

## Vertrag App
- `checklistTemplateItemSchema` + Feld; `checklistTemplateItemsSchema`
  + Refine (Geschwister-Existenz, kein Selbstbezug). Fehlermeldungen
  deutsch („Bedingung verlangt eine andere Position derselben Vorlage").
- Merge-Pfad: gleiche Abbildung (Helper teilen, kein Fork).
- Merge-Robustheit: Duplikat-Komponenten erhalten je eigene Regel
  (Referenz statt find); Regelziel per Titel gematcht
  (Legacy/umbenannte Vorlage) → Titel-Fallback im Segment-Scope
  (Werterhalt: kein Merge-Abort); unauffindbar bleibt fail-closed.
- Duplikat-Ziel deterministisch last-wins (Maps); Duplikate bleiben
  erlaubt (kein Refine-Verbot — Altbestand-kompatibel).
- Editor-Sanitize: Entfernen/Ummappen räumt baumelnde Regeln auf
  null (statt generischem Save-Fehler); rein, getestet (U-04/U-05).

## Sicherheit
- Fail-closed: baumelnde Regeln nie ins Projekt; Save-Guard + Apply-
  Guard doppelt (Defense in Depth, F7-02B-Spiegel).

## Tests (RED zuerst)
- Contract-Unit: `tests/unit/checklist-template-rules.test.ts` — ok,
  baumelnd, Selbstbezug, null, Mehrfach-Regeln.
- DB: `tests/db/f703d-template-rules.test.ts` — Vorlage mit Regel
  anwenden → visibleIf gesetzt (ID-Auflösung); Merge ergänzt Regel;
  Save mit baumelnder Regel scheitert; Merge mit Duplikat-Komponenten
  (DB-04) + Titel-Fallback bei Legacy-Komponente (DB-05).
- E2E: `tests/e2e/f7-03d-template-rules.spec.ts` — Regel in Vorlage
  setzen → anwenden → abhängiger Punkt versteckt bis Referenz
  abgehakt; Axe.
- Nachbarn: F7.3 (Vorlagen), F7.2/F7.4 (Engine).

## Akzeptanz
- `npm run check` gruen; E2E Chromium gruen; Heartbeat + Push + CI gruen.
