# SPEC F7-05c — Plantafel Drag-to-create (Katalog F7.5)

## Matrix
Katalog F7.5, Zeile 95
(`docs/blaupause/01-modulkatalog.md:95`)
verlangt „Drag-to-create". F7-05-SPEC
deferriert explizit „Kein Drag-to-create"
(F7-05-plantafel.md:64, Slice 1 = Lesepfad;
Slice 2 = ＋-Klick-Anlage). Dieser Slice
liefert die Drag-Geste auf dem BESTEHENDEN
Tages-Grid; Anlage weiter ueber den
bestehenden CAS-Pfad. Kein Portal-Change,
kein Provider, keine Migration, keine neue
Permission.

## Bestand (verifiziert am Code)
- Grid = TAGESzellen je Mitgliedszeile:
  `row.days.map` → ein `<td>` je Tag
  (page.tsx:341-342), Kopf je Tag
  (Z.311-315). KEIN Stundenraster, keine
  Zeitspalten — Eintraege zeigen nur
  Wanduhr-Text (`wallTime`, Z.142-144,
  Render Z.354-356).
- IST-Anlage = Klick-＋-Link je Tageszelle:
  `?week=&create=&member=` (page.tsx:
  371-379), aria-label je Zelle (Z.374).
- 0 Drag-Handler: `grep -i drag` ueber
  alle vier Plantafel-Dateien = kein
  Treffer (verifiziert).
- Seite = async Server Component
  (page.tsx:155); `?week=`-Parsing Z.162-
  168, `?create=/member=` Z.172-179,
  Ziel-Gate nur aus sichtbaren Zeilen/
  Tagen Z.257-263, Form-Render Z.393-404.
- `canWrite = can(ctx,
  "appointment.write")` (page.tsx:220);
  ＋-Links nur bei canWrite + Mitglieds-
  zeile (Z.369).
- Action `createPlanningBoardEntryAction`
  (actions.ts:56-119): fail-closed
  Validierung, `authorizedAction`
  appointment.write (Z.94-97),
  `executeProjectAppointmentCommand`
  `kind: "create_appointment"` (Z.98-
  112). Start/Ende EINtag-komponiert:
  `` `${date}T${startTime}` `` /
  `` `${date}T${endTime}` `` (Z.103-104).
- Create-Form (planning-board-create-
  form.tsx): hidden workspaceId/date/
  attendeeMembershipId (Z.79-81); Zeit-
  Inputs startTime Default 10:00 (Z.84),
  endTime Default 11:00 (Z.88); Titel
  (Z.92), Projekt (Z.96), Kalender
  (Z.104), Art Default on_site (Z.112),
  Team optional (Z.120), Ort optional
  (Z.129). Client (`"use client"`, Z.1),
  `useActionState` (Z.63).
- Assign-Form (planning-board-assign-
  form.tsx) unberuehrt (Drawer-Pfad).
- drizzle-Stand endet bei 0185
  (`0185_f7_02l_circuit_plan.sql`).
- E2E-Bestand: `tests/e2e/f7-05-
  plantafel.spec.ts` (＋-Klick-Pfad).

## Ziel
Schreibberechtigte ziehen auf einer
Mitgliedszeile ueber Tageszellen und
landen im BESTEHENDEN Anlageformular mit
vorbefuelltem Mitglied + Starttag (+
Endtag bei Mehrtag-Spanne). Eintag-Drag
ist aequivalent zum ＋-Klick. Der ＋-Link
bleibt als Tastatur-/Touch-Fallback.
Unbekannte/wochenfremde Spanne → kein
Formular (tolerant wie `?create=`,
page.tsx:257-263).

## Aufloesung (entschieden, belegt)
1. Granularitaet: TAGES-Spanne je
   Mitgliedszeile. Belegt: IST-Grid hat
   nur Tageszellen (page.tsx:341-342),
   kein Stundenraster. Stunden-Spanne
   VERWORFEN — waere ESTIMATE-Neubau
   ohne Live-Referenz (F7-05-SPEC
   „Exakte Reonic-Darstellung UNKNOWN").
2. Vorbefuellung: `member` = Zeile,
   `create` = Starttag (fruehestes
   Datum der Spanne), NEU `&end=` =
   Endtag nur bei Mehrtag-Spanne
   (Eintag: exakt heutige URL-Form,
   Rueckwaertskompatibilitaet).
   Formular: `endDate`-Prop (Default =
   Starttag) als SICHTBARER, editier-
   barer Date-Input → Tastatur-Nutzer
   waehlen Mehrtag manuell (A11y-
   Paritaet ohne Shift-Pfeil-Neubau).
   Action komponiert `end` aus endDate
   statt date (Z.103-104-Aenderung).
3. Server-Render: Client-INSEL
   `PlanningBoardDragLayer`
   (`"use client"`), die das server-
   gerenderte `<table>` umhuellt und
   per Event-Delegation auf neue
   `data-member`/`data-date`-Attribute
   der `<td>`s lauscht (Attribute =
   einzige Server-Markup-Aenderung,
   rein additiv). Bei Drag-Ende
   `router.push` auf die
   `?week=&create=&member=[&end=]`-URL
   → Server rendert Formular wie bisher
   (Z.393-404 unveraendert im Pfad).
   Hydration: Insel haelt nur Handler
   + transienten Auswahl-State und
   setzt nur eine CSS-Klasse; kein
   server-gerendertes Markup wird
   dupliziert → kein Mismatch.
   Verworfen: ganze Tabelle zum Client
   (Serialisierungs-/Payload-Kosten,
   groesserer Bruch).
4. A11y/Touch: ＋-Link BLEIBT als
   Pflicht-Fallback (fokussierbar,
   aria-label Bestand Z.374) — kein
   Shift-Pfeil-Neubau (kein Praezedenz,
   Testkosten). Touch-Fallback = ＋-Link
   (bleibt): Pointer-Drag auf Touch
   kollidiert mit Scroll; ein eigener
   Touch-Drag waere ESTIMATE ohne
   Referenz. Drag-Layer reagiert nur
   auf Maus-/Pointer-fine.
5. ESTIMATEs (markiert, ohne Live-
   Referenz): Zeit-Defaults bleiben
   10:00–11:00 (Bestand); Max-Spanne
   7 Tage (ESTIMATE: Wochenansicht);
   Auswahl-Highlight-Optik (ESTIMATE).
6. Migration: KEINE (s. Vertrag DB).
   Permission: `appointment.write`
   Bestand (page.tsx:220, actions.ts:
   96) — Insel rendert Handler nur bei
   canWrite-Prop, Server re-validiert
   in der Action. Rollen-Pins: keine —
   keine neue Permission, keine
   DEFINER-Funktion.

## Entwurf (Insel + Param + Formfeld)
- page.tsx: `<td>` erhaelt
  `data-member={row.membershipId}` +
  `data-date={day.date}` (nur wenn
  canWrite + Mitgliedszeile, sonst
  kein Drag-Ziel); Tabelle in
  `<PlanningBoardDragLayer
  canWrite weekStart basePath>` (neu,
  `"use client"`).
- Neue pure Helper (neu, z.B. in der
  Insel-Datei oder `drag-span.ts`):
  `normalizeSpan(a, b)` (Datum-Paar →
  [start, end], min/max) +
  `buildCreateHref(base, week, member,
  start, end)` (end-Param nur wenn !=
  start). Rein + unit-testbar.
- Insel: pointerdown auf Zelle (nur
  `pointerType == mouse` + canWrite)
  → pointermove ueber Zellen DERSELBEN
  Zeile (fremde Zeile = Abbruch/
  Clamp auf Startzeile) → pointerup
  baut URL + `router.push`. ESC bricht
  ab. Auswahl via CSS-Klasse auf den
  Zellen im Lookup (data-Selektor).
- page.tsx Query: `&end=` parsen
  (calendarDaySchema wie Z.174-176);
  Gate erweitern: endDate valide +
  `end >= create` + Spanne <= 7 Tage,
  sonst Fallback end = create
  (tolerant, kein Fehler).
- Create-Form: `endDate`-Prop +
  sichtbarer Date-Input (Default =
  endDate), Hidden-Feld `endDate`
  (bzw. der Date-Input traegt den
  Namen direkt); Titel-Zeile zeigt
  Spanne („am {date}“ vs. „vom {date}
  bis {endDate}“).
- Action: `endDate` (daySchema) lesen;
  Guard `endDate >= date`, `<= +6
  Tage`, sonst `invalid`; `end:`
  `` `${endDate}T${endTime}` ``.
  Rest (CAS-Pfad Z.98-112, teamId,
  Revalidate) unveraendert.

## Vertrag DB (KEINE Migration)
Verifiziert nicht noetig: (a) kein neues
Datum — Drag schreibt nur Query-Params,
Anlage nutzt bestehende Spalten; (b) kein
Tree-/Validator-Wandel; (c) RLS
unberuehrt; (d) kein Rollen-Pin — keine
neue Permission, keine DEFINER-Funktion
(`db:roles:verify` unberuehrt); (e)
drizzle-Stand endet bei 0185 — keine
Nummer zu vergeben, kein Journal-Eintrag,
kein `db:generate`-Drift.

## Vertrag App
- Helper-Signaturen:
  `normalizeSpan(a: CalendarDay, b:
  CalendarDay): [start, end]`;
  `buildCreateHref(basePath, weekStart,
  memberId, start, end): string`
  (end-Param nur bei end != start;
  Inputs bereits validierte
  YYYY-MM-DD/uUid — kein Orakel).
- Insel-Props: `{ canWrite: boolean;
  basePath: string; weekStart: string;
  children: ReactNode }`. Bei
  `canWrite == false` keine Handler
  (reine Huelle) — Server-Gate
  (Z.369/220) bleibt massgeblich.
- Guards (fail-closed): Zeilenwechsel
  = Abbruch; `&end=`-Guards wie
  Entwurf (Fallback, kein Fehler);
  Action-Guards wie Entwurf (invalid).
- Kein Portal-Change, kein Provider,
  kein Service-Op (CAS-Pfad Bestand
  actions.ts:98-112 wiederverwendet).
- ＋-Link-Markup unveraendert
  (Z.369-379), inkl. aria-label.

## Sicherheit
- Autorisierung am Bestand:
  Insel-Gate ist UX, Action-Gate
  (`appointment.write`, Z.94-97) ist
  die echte Pruefung; Lese-Akteure
  erhalten weder Handler noch Formular
  (Z.263-Gate).
- Kein Orakel: wochenfremde/unbekannte
  `create/member/end` → kein Formular
  (Z.257-263-Muster erweitert).
- Keine neuen Datenfluesse an
  Dritte/Storage; keine PII in Logs.

## Tests (RED zuerst)
- Unit (`tests/unit/f705c-drag-span.
  test.ts`, pure Helper):
  U-01 normalizeSpan Ordnung (b vor a
  → getauscht); U-02 gleiche Tage;
  U-03 buildCreateHref ohne end-Param
  bei Eintag (exakte heutige URL-Form);
  U-04 mit `&end=` bei Mehrtag; U-05
  Action-Compose `end` aus endDate
  (pure Compose-Funktion, sofern
  extrahiert); U-06 Guard end < start
  → invalid; U-07 Guard Spanne > 7 →
  invalid/Fallback.
- DB: KEINE eigene Suite — kein
  DB-Anteil (keine Migration, kein
  neuer Service-Op; Anlagepfad durch
  F7-05-Slice-2-Tests gedeckt).
- E2E (`tests/e2e/f7-05c-plantafel-
  drag-create.spec.ts`, M2-01 +
  F7-05-Seeding): E-01 Drag ueber 3
  Zellen EINER Zeile (mouse.move/
  down/move/up) → URL enthaelt
  `create=<start>&member=<id>&end=
  <start+2>`, Formular vorbefuellt
  (Mitglied, Start, Enddatum sichtbar);
  E-02 Eintag-Drag → URL OHNE `&end=`
  (＋-aequivalent); E-03 Submit →
  Termin steht in der Tafelwoche
  (Eintag + Mehrtag); E-04 ＋-Klick
  weiter gruen (Fallback-Regression);
  E-05 ohne Schreibrecht: kein Drag
  (kein Handler, kein ＋); E-06 ESC/
  Zeilenwechsel = Abbruch (keine
  Navigation); E-07 Tastatur: ＋-Link
  per Tab erreichbar + Enddatum im
  Formular manuell aenderbar; E-08
  Reload stabil; E-09 Axe; E-10
  Server-Log ohne Fehler.
- Nachbarn: F7-05 (Slice 1+2),
  F7-06 (teamId), F7-07 (Gruppierung),
  m111a-Pins (unberuehrt).

## Akzeptanz
- `npm run check` + `npm run
  db:roles:verify` gruen; Unit + E2E
  Chromium gruen; Heartbeat + Push +
  CI gruen.
- Nur SPEC in diesem Slice (kein Code).
