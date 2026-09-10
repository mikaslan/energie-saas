# F9-06 Pausen-Segmente (Start/Ende-Protokoll je Zeiteintrag)

Ziel: Pausen werden als Zeitsegmente protokolliert (Beginn/Ende je
Segment), nicht nur als Minutensumme — lesbar pro Eintrag, mit
laufender-Pause-Guard.

## Umfang

1. Migration `0089`: Tabelle `time_break_segment` (Eintrag-FK composite
   mit CASCADE, `started_at` Default now, `ended_at` nullable = offene
   Pause, `created_by`; CHECK `ended_at >= started_at`; Partial-Unique
   max. ein offenes Segment je Eintrag; RLS tenant_isolation + FORCE im
   Zeit-Muster).
2. Service in `modules/time-tracking` (bestehende `time.read/write`,
   keine neuen Permissions): `startBreak` (Eintrag vorhanden,
   nicht freigegeben, keine offene Pause), `endBreak` (offene Pause
   schließen, Ende ≥ Beginn, keine Zukunft), `listBreaks`,
   `breakMinutesTotal` (Summe abgeschlossener Segmente, kaufmännisch).
3. UI: Pause starten/beenden je Eintrag in der Zeiterfassung +
   Segmentliste mit Summe. Keine automatische Verrechnung mit
   `workingTimeMinutes`/`breakDurationMinutes` (keine stille
   Neuberechnung — Summe steht daneben).

## Guards (fail-closed)

- Freigegebene Einträge (F9-05-Unveränderlichkeit) nehmen keine Segmente.
- Fremde Workspaces unsichtbar (Tenant-Isolation + Tests).
- Zukunfts-Stempel und Ende-vor-Beginn abgelehnt.

## Geschlossene Testmatrix
- `F906-DB-01`: Start/Liste/Ende plus deterministische
  30-Minuten-Summe; chronologische Segmentliste.
- `F906-DB-02`: Doppel-Start und Ende-ohne-offen fail-closed.
- `F906-DB-03`: Freigegebener und unbekannter Eintrag fail-closed.
- `F906-RBAC-01`: Viewer liest Segmente; Schreiben nur mit
  `time.write`; Fremdnutzer fail-closed.
- `F9-06-E2E-01`: Eintrag per UI → Pause starten → Pause beenden →
  „Pausen (1)" aufklappbar (lokal beobachtet 2026-09-10).

## Bewusst offen
- Idle-Erkennung, automatische Pausenabzüge, Verrechnung mit
  `workingTimeMinutes`, Auswertung, Abrechnungslauf,
  Mobile-/Offline-Verhalten.
