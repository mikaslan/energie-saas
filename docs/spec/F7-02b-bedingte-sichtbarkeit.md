# F7-02B — Bedingte Sichtbarkeit (if/then) am Checklisten-Punkt

Status: **IN ARBEIT** · Lane: `codex/m1-wave-02`
Basis: Modulkatalog F7.2 („if/then-Konditionallogik") · Q-unblockiert
(Reonic-Helpcenter belegt Konditionallogik als Checklisten-Kern; exakte
Reonic-Regeltypen bleiben ohne Live-Referenz ESTIMATE, s.u.)

## Ziel und Abgrenzung

Erster fehlender durchgängiger F7.2-Pfad: Ein Punkt kann seine
Sichtbarkeit an den Erledigt-Status eines anderen Punkts derselben
Checkliste binden („Zeige mich, wenn X erledigt / nicht erledigt").
Durchgängig: Regel-Editor (Formular/Validierung) → Persistenz
(Whole-Tree-Save, Migration) → Auswertung (Server-Gate + Projektion) →
Anzeige (Render, Required-Gate, Outbox-neutral).

Nicht in diesem Slice: weitere Regeltypen (Wertvergleich bei
Radio/Select, Datums-/Rollen-Bedingungen), Template-Autorenschaft von
Regeln (Template-Items sind komponentengebunden, s. „Bewusst offen"),
Regel-Editor im Kundenportal.

## Evidenz (öffentlich)

- Reonic-Modulkatalog F7.2: Checklisten-Engine mit „if/then-
  Konditionallogik" als Kernstück neben Pflichtfeldern und Irrelevant-
  Markierung (`docs/blaupause/01-modulkatalog.md`).
- `[ESTIMATE]` Exakte Reonic-Regeloperatoren/-UI sind ohne Live-Referenz
  nicht belegbar; dieser Slice baut die belegte Kernsemantik (Zeigen nach
  Erledigt-Status) als reversible Näherung. Keine erfundene Livebehauptung.

## Datenmodell (additiv, Migration 0129)

`editableChecklistItemSchema` + optional:

```text
visibleIf: { itemId: <uuid eines anderen Punkts desselben Segments>,
             equals: <boolean> } | null
```

- `null`/fehlend = keine Regel (heutiges `visible`-Flag gilt allein).
- Single-Hop-Semantik: Die effektive Sichtbarkeit liest das RAW-
  `done`-Flag des referenzierten Punkts, NICHT dessen effektive
  Sichtbarkeit. Zyklen (A↔B) sind damit deterministisch und können nicht
  schleifen; nur Selbstreferenz wird abgewiesen (sinnlos).
- Fehlende Referenz zur Lesezeit → sichtbar (Display fail-open);
  Schreibzeit verweigert baumelnde Referenzen (fail-closed, s.u.).
  Über unsere Writes ist der Lese-Fall nur per Direkt-DB erreichbar.

## Validierung (fail-closed)

- Shape: strictObject `{itemId: uuid, equals: boolean}`, nur als Ganzes
  oder gar nicht (halbe Regeln verweigern).
- Service (TS, vor Kapselaufruf, race-frei da Whole-Tree-Payload atomar):
  `itemId` ≠ eigene ID, `itemId` existiert im selben Segment.
  Verstoß → `ChecklistValidationError` (kein stilles Streichen).
- DB-CHECK `_f704_valid_checklist_blocks` (Migration 0129, Muster 0127):
  erlaubt optionales `visibleIf`-Objekt mit exakten Keys und Typen
  (uuid-Regex, boolean); alles andere weiter abgewiesen.

## Auswertung (Server + Projektion, identisch)

`isItemEffectivelyVisible(item, byId)` (pure, `contract.ts`):

```text
effektiv = item.visible && (item.visibleIf == null
             || referenziert == null
             || referenziert.done === item.visibleIf.equals)
```

- `segmentRequiredRemaining` / `segmentItemProgress` zählen nur effektiv
  sichtbare Punkte (irrelevante weiter ausgenommen, F7-04b-Semantik bleibt).
- Complete-Gate (SQL, Migration 0129, Muster 0127): versteckte
  Pflichtpunkte blockieren den Segmentabschluss nicht.
- Segment-Outbox-Replay (F7-04c) bleibt neutral: Replay entscheidet gegen
  `completedAt`, nicht gegen Sichtbarkeit.

## Anzeige / Editor

- Render: effektiv versteckte Punkte werden nicht gerendert; Zähler
  (`segmentItemProgress`, „Noch N Pflichtpunkte offen") folgen der
  Projektion — kein zweiter Zählpfad im Client.
- Regel-Editor (nur `canConfigure`): je Punkt Auswahl „Sichtbar, wenn …"
  (keine Regel / Geschwisterpunkt-Dropdown) + „… erledigt ist" (equals
  true/false). Geschwister = Punkte desselben Segments außer sich
  selbst (kleinste sinnvolle Domäne, keine segmentübergreifenden
  Referenzen in diesem Slice).
- Umschalten des referenzierten Punkts aktualisiert die Sichtbarkeit nach
  Save/Revalidierung (kein clientseitiges Ghost-Rendering vor Persistenz).

## Akzeptanz

- Unit: Single-Hop-Matrix (equals true/false × done true/false),
  fehlende Referenz, Selbst-/Fremdreferenz-Validierung, Gate-Ausschluss.
- DB: Validator-Shape (gültig/überschüssiger Key/falscher Typ),
  Complete-Gate mit verstecktem Pflichtpunkt, Save mit baumelnder Regel
  (Service-Guard), Outbox-Neutralität.
- E2E (isolierter Workspace, eigenes Projekt): Regel setzen →
  Zielpunkt verschwindet; Referenz erledigen → erscheint; Pflichtpunkt
  versteckt → Segmentabschluss trotz unerledigtem Pflichtpunkt möglich;
  Axe sauber.
- Gates: tsc/eslint/depcruise grün; keine neuen Permissions; keine
  Änderung an Template-/Outbox-/Signatur-Verträgen.

## Bewusst offen

- Template-Autorenschaft von Regeln (Template-Items sind
  komponentengebunden; Apply mappt heute ohne Regeln).
- Weitere Operatoren (Radio-Wert, Datum, Rolle), segmentübergreifende
  Referenzen, Regel-Import/-Export.
- Exakte Reonic-Regel-UI bleibt ESTIMATE bis Live-Beleg.
