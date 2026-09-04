# F9.2 Zeiterfassung-Stoppuhr — Slice A: laufender Eintrag je Nutzer

Status: **SPECIFIED** · Lane: `codex/f9-02-timer` · Migration: 0054
Basis: Modulkatalog F9.1–F9.3 · **OBSERVED**: Reonic OpenAPI 3.11.0
`TimetrackingEntry` — `startAt`/`endAt`/`workingTimeMinutes` sind
**nullable**, `trackingId` existiert (laufende Erfassung).

## 1. Discovery-Quellen (Clean Room)

- `TimetrackingEntry` (DOCUMENTED): `startAt: string|null`, `endAt:
  string|null`, `workingTimeMinutes: number|null`, `breaks[]`,
  `trackingId` — belegt laufende Einträge (Start gesetzt, Ende offen).
- F9.1 Slice A (0050) hat manuelle Einträge mit Pflicht-`end_at`/
  `working_time_minutes` gebaut — dieser Slice relaxiert genau diese
  beiden Felder für den laufenden Zustand.

## 2. Scope Slice A (vertikal)

1. **Laufender Eintrag**: `startTimeEntry` legt einen Eintrag mit
   `start_at = now`, `end_at = NULL`, `working_time_minutes = NULL` an;
   **maximal ein laufender Eintrag je Nutzer je Workspace** (partieller
   Unique-Index `WHERE end_at IS NULL`). `stopTimeEntry` setzt
   `end_at = now` + `working_time_minutes` (Pflicht-Eingabe 1..1440) +
   optionale Pause/`comment`-Ergänzung.
2. **DB-Vertrag (0054)**: `end_at` und `working_time_minutes` werden
   nullable; CHECKs: laufend ⇔ (`end_at IS NULL AND
   working_time_minutes IS NULL`), gestoppt ⇔ beide gesetzt;
   Intervall-/Minuten-/Pausen-CHECKs gelten nur im gestoppten Zustand.
3. **Liste**: `listTimeEntries` zeigt den laufenden Eintrag zuerst,
   DTO-Feld `running: true`; `archiveTimeEntry` bleibt für gestoppte
   Einträge (laufender Eintrag wird per `stopTimeEntry` beendet oder
   `discardTimeEntry` verworfen).
4. **UI**: Projekt-Zeiterfassung — „Stoppuhr starten"-Button (nur ohne
   laufenden Eintrag), Lauf-Banner mit Startzeit, „Stoppen"-Formular
   (Arbeitsminuten Pflicht, Pause optional).
5. **Berechtigungen/RLS**: unverändert F9.1 (`time.read`/`time.write`,
   M1-CRM-Muster).

**Nicht in Slice A**: mehrere parallele Stoppuhren je Nutzer,
Pausen-Segmente (`breaks[]`), Fremdnutzer-Stopp, Idle-Erkennung.

## 3. Verträge

Service-Erweiterung (`modules/time-tracking`):

```
startTimeEntry(ctx, { projectId, typeId?, comment? }) → DTO (running)
  (Conflict bei bereits laufendem Eintrag des Actors)
stopTimeEntry(ctx, { id, workingTimeMinutes, breakDurationMinutes?, comment? })
  → DTO (gestoppt; NotFound bei fremdem/laufendem-anderen Eintrag;
  Validation bei 0 Minuten oder >1440)
discardTimeEntry(ctx, { id }) → laufenden Eintrag löschen (Hard-Delete
  des laufenden Eintrags, nur eigener; DSGVO-konform ohne Inhaltsdaten)
```

DTO: `timeEntryDtoSchema` + `running: boolean`; bestehende Felder
`endAt`/`workingTimeMinutes` werden nullable.

## 4. Testmatrix

| ID | Test |
|---|---|
| F902-DB-01 | start → running-DTO; Liste zeigt ihn zuerst; stop setzt Ende+Minuten |
| F902-DB-02 | Zweiter start → Conflict (1 je Nutzer); DB-partial-unique direkt geprüft |
| F902-DB-03 | stop mit 0/1441 Minuten → Validation; stop fremden/laufenden-anderen → NotFound |
| F902-DB-04 | discard entfernt nur laufende; gestoppte bleiben; Viewer schreib-blockiert |
| F902-DB-05 | CHECKs: laufend ohne Minuten ok, gestoppt ohne Minuten rejected (DB-Ebene) |
| F902-E2E-01 | Editor: Stoppuhr starten, Banner sichtbar, stoppen mit Minuten → Summe steigt |
| F902-E2E-02 | Viewer: kein Start-Button, laufender Eintrag sichtbar |
| F902-JRN-01 | m111a-Journal: idx 54 / TOTAL 55 |

## 5. Nachweise

`npm run check` · Build · `db:generate` ohne Drift · Rollenproben · E2E
Chromium (F9.2-Grep) · Secret-Scan · Kimi-K3 Review Spec + Code.
