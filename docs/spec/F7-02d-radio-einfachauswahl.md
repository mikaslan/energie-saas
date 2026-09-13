# F7-02d Radio-Einfachauswahl (Slice B, Katalog F7.2)

F7-02 Spec §Scope: „Reonic-Item-Typen (`radio`/`image`/`description`) sind
**Slice B**“; Code-Stand (`modules/checklists/templates.ts:315`):
„Radio-/Bild-Typen = Slice B“. F7-02c lieferte title/description. Dieser
Slice liefert `radio` — Einfachauswahl je Segment. Bild-Typ bleibt offen
(braucht Storage-Uploads, Q-STORAGE-UPLOADS).

## ESTIMATE (reversibel, keine Reonic-Referenz für Radio-Semantik)

- Modell: `kind: "radio"` am bestehenden Punkt (kein Optionsmodell, keine
  neue Tabelle). Ein Radio-Punkt ist abhakbar (`done`-Boolean wie Aufgabe).
- Exklusivität je Segment (ESTIMATE, spiegelt die Segment-Lokalität von
  `visibleIf` F7-02B): höchstens EIN Radio-Punkt je Segment hat
  `done = true`. Segment-, nicht Block-Scope.
- `required` an Radio-Punkten ist zulässig (Pflicht-Gate/Zähler zählen sie
  wie Aufgaben; das Gate erzwingt keine Auswahl, es zeigt nur offene
  Pflicht an — Bestandssemantik). `irrelevant`/`visibleIf` orthogonal wie
  bei Aufgaben (keine Sonderregeln).
- Typwechsel schreibt ehrlich um (F7-02C-Muster, kein Dialog): nach
  `title`/`description` → `done/required` false; nach `radio`/`task` →
  Flags bleiben, `description` wird null.

## Vertrag

- Migration `0141_f7_02d_radio_einfachauswahl` (nur Funktion, F7-13-Muster):
  `CREATE OR REPLACE _f704_valid_checklist_blocks` — Vollkopie des
  0131-Bodys + `kind IN ('task','title','description','radio')` +
  Exklusivitätsprüfung je Segment (mehr als ein Radio-Punkt mit
  `done = true` → false). `_f704_checklist_structure` bleibt unverändert
  (kind-agnostisch, streicht nur `done`).
- Rollenvertrag: Funktions-Pin `_f704_valid_checklist_blocks(jsonb)` neu
  ernten (Methode: Hash aus Migrationstext, gegen Nachbar-Pin
  gegengeprüft); keine neuen Routinen, keine Grants, keine Permissions.
- Contract (`checklistItemKindSchema` + Tree-Validator): `"radio"` in die
  Enum; SuperRefine verbietet >1 erledigten Radio-Punkt je Segment
  (fail-closed, gleiche Fehlermeldung wie DB).
- UI (`project-checklist-manager`): Typ-Select bekommt `radio`
  („Einfachauswahl“); Radio-Punkte rendern als runder Radio-Input
  (native Segment-Gruppe); Anwählen setzt `done` und löscht `done`
  aller Radio-Geschwister im selben Segment (optimistisch,
  Whole-Tree-Save persistiert; Server validiert erneut). Typwechsel
  nach `radio` schreibt ehrlich um (`done` fällt — kein speicherbarer
  Doppel-done). Zähler/Pflicht-Gate behandeln Radio wie Aufgabe.

## Regeln

1. Keine Migration jenseits 0141, keine neue Permission, kein Provider.
2. Vorlagen (F7-03/F7-13): Template-Items kennen kein `kind`
   (eigenes Schema) — Radio-Punkte entstehen nur in der Projekt-Checkliste;
   Merge/Reset fassen sie nicht an (unverändert).
3. Segment-Complete/Outbox (F7-04/F7-04c): Whole-Tree-Saves laufen durch
   dieselbe Validierung — keine Sonderpfade.
4. Deklarierter Vertragswechsel: F7-02C-Sonden nutzten `kind: "radio"` als
   Unbekannt-Probe (Unit-U-05, DB-03). Seit 0141 ist `radio` bekannt; beide
   Sonden prüfen denselben Reject neu mit `kind: "video"` — gleiche
   Assertionszahl, gleiche Schärfe, nur aktualisiertes Vokabular.

## Tests

- DB (`f702d-radio-einfachauswahl`, Fixture-Muster F7-02): Radio-Punkt
  speichern + laden (kind rundheraus); zwei erledigte Radios im Segment
  → Validation/Conflict fail-closed (Service + Direkt-Validator);
  zwei Segmente je ein erledigter Radio → ok; required-Radio zählt im
  Pflicht-Gate; Fremdtenant sieht nichts (Tenant-Muster).
- E2E (`F7-02D-E2E-01`, isolierter Workspace, F7-02C-Muster): drei Punkte
  anlegen → alle Typ „Einfachauswahl“ (dritter vorher als Aufgabe
  erledigt → Wechsel fällt ehrlich auf unerledigt) → ersten (Pflicht)
  anwählen → Zähler leer → zweiten anwählen → erster automatisch leer,
  Zähler wieder offen → ersten erneut wählen → Speichern → Reload zeigt
  Auswahl persistent (Punkte 1/3); Viewer sieht deaktivierte Radios;
  keine Browser-Fehler, Axe sauber.
- Nachbarn: F7-02/02b/02c/04b/04c/13/14-DB-Suiten, m111a-Pins (0141),
  m704-Strict, db:generate ohne Drift.

## Bewusst offen

- Bild-Typ (Q-STORAGE-UPLOADS), Diktat/Freitext-Werte, Multi-Select,
  Radio-Pflichtgruppen-Semantik jenseits Segment-Exklusivität,
  Signatur-/Komponenten-Item-Typen, Radio in Vorlagen.
