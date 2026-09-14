# F7-02f Mehrfachauswahl (Slice B, Katalog F7.2)

Stand: IMPLEMENTIERT/LOKAL VERIFIZIERT (DB f702f + E2E F7-02F-E2E-01 in F7-02-Datei 9/9; Stand 2026-09-14 nachgezogen, kein Code-Eingriff).

F7-02 Spec §Scope: „Reonic-Item-Typen (`radio`/`image`/`description`) sind
**Slice B**“; F7-02c „Bewusst offen“ listet `radio/multi-select/freetext/
image/signature`. F7-02d lieferte `radio` (exklusiv), F7-02e `text`.
Dieser Slice liefert `multi` — Mehrfachauswahl je Segment (mehrere
erledigte Auswahl-Punkte nebeneinander). Bild-/Signatur-Typen bleiben
offen (brauchen Storage-Uploads, Q-STORAGE-UPLOADS).

## ESTIMATE (reversibel, keine Reonic-Referenz für Multi-Semantik)

- Modell: `kind: "multi"` am bestehenden Punkt (kein Optionsmodell, keine
  neue Tabelle). Ein Multi-Punkt ist abhakbar (`done`-Boolean wie Aufgabe).
- KEINE Exklusivität (ESTIMATE, Gegenstück zu F7-02D): beliebig viele
  Multi-Punkte je Segment dürfen `done = true` tragen. Die Auswahl IST die
  Antwort — kein `value`-/Antwortspeicher nötig (anders als `text`).
- `required` an Multi-Punkten ist zulässig (Pflicht-Gate/Zähler zählen sie
  wie Aufgaben; das Gate erzwingt keine Auswahl, es zeigt nur offene
  Pflicht an — Bestandssemantik wie F7-02D).
- Kein `description`/`value` am Multi-Punkt (Mischbestände-Reject wie bei
  `radio`: Spiegel-Regel zu F7-02C, Zod + DB). `irrelevant`/`visibleIf`
  orthogonal wie bei Aufgaben (keine Sonderregeln).
- Typwechsel schreibt ehrlich um (F7-02C-Muster, kein Dialog): nach
  `title`/`description` → `done/required` false + `description`/`value`
  null; nach `multi`/`task` → Flags bleiben (anders als `radio`: dort
  fällt `done`, weil Exklusivität sonst einen speicherbaren Doppel-done
  erzeugen könnte — bei `multi` ist Doppel-done legal, also kein Reset
  nötig), `description`/`value` werden null.

## Vertrag

- Migration `0143_f7_02f_mehrfachauswahl` (nur Funktion, F7-13-Muster):
  `CREATE OR REPLACE _f704_valid_checklist_blocks` — Vollkopie des
  0142-Bodys + `'multi'` in der kind-Whitelist. KEINE neue segmentweite
  Regel (die Radio-Exklusivitätszählung bleibt strikt `kind = 'radio'`).
  `_f704_checklist_structure` bleibt unverändert (kind-agnostisch).
- Rollenvertrag: Funktions-Pin `_f704_valid_checklist_blocks(jsonb)` neu
  ernten (Methode: Hash aus Migrationstext, gegen Nachbar-Pin
  gegengeprüft); keine neuen Routinen, keine Grants, keine Permissions.
- Contract (`checklistItemKindSchema` + Tree-Validator): `"multi"` in die
  Enum; Mischbestands-Regel (`required`/`done` nur an
  task/radio/text/multi) um `multi` erweitert; kein Exklusivitäts-Check
  für `multi` (zwei erledigte Multis passieren — Positiv-Regel).
- UI (`project-checklist-manager`): Typ-Select bekommt `multi`
  („Mehrfachauswahl“); Multi-Punkte rendern als native Checkbox über den
  Standard-Arbeitspunkt-Zweig (kein eigener Toggle-Handler nötig — keine
  Geschwister-Logik); Wechsel nach `multi` schreibt ehrlich um (Flags
  bleiben, `description`/`value` null). Zähler/Pflicht-Gate behandeln
  Multi wie Aufgabe.

## Regeln

1. Keine Migration jenseits 0143, keine neue Permission, kein Provider.
2. Vorlagen (F7-03/F7-13): Template-Items kennen kein `kind`
   (eigenes Schema) — Multi-Punkte entstehen nur in der Projekt-Checkliste;
   Merge/Reset fassen sie nicht an (unverändert).
3. Segment-Complete/Outbox (F7-04/F7-04c): Whole-Tree-Saves laufen durch
   dieselbe Validierung — keine Sonderpfade.
4. Kein Sonden-Vokabularwechsel nötig: F7-02C-Sonden nutzen
   `kind: "video"` als Unbekannt-Probe — `video` bleibt unbekannt
   (Bild-/Signatur-Typen weiter offen), Assertionszahl und Schärfe
   unverändert.

## Tests

- DB (`f702f-mehrfachauswahl`, Fixture-Muster F7-02): Multi-Punkt
  speichern + laden (kind rundheraus); zwei erledigte Multis im Segment
  → Save-Guard + Direkt-Validator AKZEPTIEREN (Gegenprobe zu F7-02D);
  required-Multi blockiert Segment-Complete bis zur Auswahl; Fremdtenant
  sieht nichts (Tenant-Muster).
- E2E (`F7-02F-E2E-01`, isolierter Workspace, F7-02D-Muster): zwei Punkte
  anlegen → beide Typ „Mehrfachauswahl“ (erster Pflicht) → beide
  anwählen → beide bleiben gewählt (keine Exklusivität), Zähler leer →
  Speichern → Reload zeigt beide persistent (Punkte 2/2); Viewer sieht
  deaktivierte Checkboxen; keine Browser-Fehler, Axe sauber.
- Nachbarn: F7-02/02b/02c/02d/02e/04b/04c/13/14-DB-Suiten, m111a-Pins
  (0143), m704-Strict, db:generate ohne Drift.

## Bewusst offen

- Bild-/Signatur-Typen (Q-STORAGE-UPLOADS), Diktat, component-list/
  circuit-plan/datasheets/planned-layout, Radio-Pflichtgruppen-Semantik
  jenseits Segment-Exklusivität, Auswahl-Arten in Vorlagen.
