# F7-15 Drag-to-create (Katalog F7.5: Drag-Gesten-Anlegen auf der Plantafel)

Lane `codex/muse-fleet-6-f1rest` (Agent 6C). Stand: SPEC mit Bau-Empfehlung NEGATIV —
Leitstand-Entscheid ausstehend (Basis divergiert, STOPP für Schreibendes gilt).
Kein Reonic-Referenzbeleg (ESTIMATE, s. D3).

## DISCOVERED (W1, Code-verifiziert)

- Plantafel (`plantafel/page.tsx:342-435`): Server-gerenderte TABELLE Mitglieder ×
  7 Tage; je Tageszelle genau ein ＋-Link (`?create=DATUM&member=ID`, `:415-424`);
  Zellen tragen KEINE data-Attribute (Datum/Member nur im Link-href); NULL
  Drag-Code (kein draggable/onDrag*/Pointer-Handler).
- Anlage (`planning-board-create-form.tsx`, F7-05 Slice 2): Datum fix aus Zelle,
  Start-/Ende-Uhrzeit FREI eingebbar (Berlin-Wanduhr) — kein Raster, keine Slots.
- DnD-Präzedenz im Repo: `@atlaskit/pragmatic-drag-and-drop` NUR in
  `anfragen/board-client.tsx` (Kanban-Karten); `@fullcalendar/interaction` in
  `appointment-calendar.tsx` NUR für Klick (kein Drag konfiguriert).
- Katalog F7.5 nennt „Drag-to-create" als ein Wort ohne Referenz
  (Modulkatalog:95); SOURCE-REGISTER/wmee/UNKNOWN-CONFLICT: null Treffer.
  F7-05-Spec: „Kein Drag-to-create" (Slice 1) + ＋-Pfad als deliberate Lösung (Slice 2).

## SPECIFIED — Entscheidungsvorlage

### Warum „echtes" Drag auf diesem Grid keinen Mehrwert liefert

1. Tageszellen ohne Stundenraster: Eine Drag-Geste innerhalb einer Zelle kann
   KEIN Zeitfenster bestimmen (keine Stunden-Skala) — sie wäre ein Klick-Ersatz
   für denselben `?create=`-Link (Duplikat des ＋-Pfads, kein Zeitvorteil).
2. Echter Drag-Nutzen (Fenster aufziehen) braucht einen Stundenraster-Umbau der
   Tafel (Timeline je Tag) — eigener Produkt-Slice, weit über „Geste fehlt".
3. Touch-Konflikt: Pointer-Drag auf Tabellenzellen kollidiert mit nativem
   Scrollen (touch-action-Feintuning, F11-PWA-Risiko); A11y/Keyboard/No-JS
   braucht den ＋-Pfad ohnehin als Fallback (Fail-closed-Pflicht).
4. Kein Reonic-Beleg → jede Drag-Deutung ist freies ESTIMATE ohne Abnahme-Maß.

### Empfehlung (Agent 6C): NICHT bauen — Negativ-Scope

- Die Funktion „Termin von der Tafel anlegen" ist durch den deliberaten ＋-Pfad
  (F7-05 Slice 2, E2E F7.05-E2E-02 grün) ABGEDECKT; die Geste selbst liefert auf
  Tageszellen keine zusätzliche Information.
- Falls Leitstand Drag trotzdem will: erst Stundenraster-Produktentscheid, dann
  neuer Slice (Drag = Fensterauswahl → vorbefülltes Formular; Schätzung M).
- Verifikation statt Bau (6/6B-Muster): ＋-Pfad-Belege (Service/Guard/UI/E2E) +
  Negativ-Belege (kein Drag-Code, kein Raster, Touch-Risiko) + STATUS-Nachtrag.

### Option A (nur bei Leitstand-Entscheid PRO Bau, Schätzung S)

- Client-Component `planning-board-drag-create.tsx` (Pointer-Events, Maus only,
  `touch-action: pan-x pan-y` erhält Scrollen): Drag über ≥1 Zelle derselben
  Zeile → Navigation `?create=START&member=ID` (+ `&end=` bei Mehrtage-Drag);
  Klick-Verhalten unverändert; ohne Drop-Target kein Create (fail-closed);
  ＋-Pfad unberührt; E2E mit Playwright-mouse-Drag. Keine Migration, keine
  Permission (Range 0321+ bliebe unberbraucht).

## CONTRACTED (Empfehlung B — Docs-only)

- EDIT (max): `docs/parity/STATUS.md` (F7-Zeile: Drag-to-create erledigt-negativ
  mit Begründung), diese Spec-Datei.
- Beweisgrün: DB f0705 + E2E F7.05-E2E-02 (erneut beobachtet) + Grep-Belege
  (kein Drag-Code, kein Raster) — keine neuen Tests (nichts gebaut).
- NICHT: Google/MS-Sync, Serientermine (externe Blocker, VERBOTEN).
