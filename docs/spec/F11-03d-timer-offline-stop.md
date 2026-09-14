# F11-03d Offline-Stopp online gestarteter Timer (Katalog F11.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-14 (DB 9/9 time-tracking-timer inkl. 2 neu, Unit F1103D 3/3, E2E F1103D-E2E-01 1/1, Nachbarn F9.2/F1103C 4/4, tsc/eslint grün, lokal beobachtet).

Ziel: Folgeslice zu F11-03c (dort bleibt der online gestartete Timer
ausdrücklich offline-pflichtig — Phantom-Doppel ausgeschlossen). Ein online
gestarteter Timer lässt sich jetzt offline stoppen: Der Stopp-Instant wird
offline als Intent gespeichert; online übernimmt der Sync exakt diesen
Instant (keine Serverzeit-Ratung, kein Doppel-Eintrag). Kein
Reonic-Referenzbeleg; reversible eigene Näherung (ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Contract (`stopTimeEntryCommandSchema`): optionales `endAt`
  (ISO-datetime). Fehlt es, gilt Serverzeit (bisheriges Verhalten, F9.2
  unverändert inkl. Meldung „Stoppuhr gestoppt.“).
- Service (`stopTimeEntry`): `endAt` fail-closed — vor Start, weiter als
  5 Min. in der Zukunft (Uhr-Skew) oder Spanne > 24 h
  (TIME_MINUTES_MAX-Geist) verweigern; nie still kappen. Update behält das
  `end_at is null`-Prädikat (Race-sicher); Doppel-Stopp → NotFound.
  Event/Audit tragen `endAt` additiv (kein Verbraucher betroffen).
- Action (`stopTimeEntryAction`): optionales `endAt`-Feld (leer =
  Serverzeit, defekt = invalid). Erfolg mit Client-Instant meldet
  „Offline-Stopp übernommen.“ — sonst alte Meldung.
- Client (IDB `wmee-time-outbox`, Version 3, neuer Store `timer-stops`):
  genau ein wartender Stopp je Eintrag (put überschreibt). Reiner Builder
  `buildTimerStopIntent` (Minuten/Anordnung/24-h-Vorprüfung mit bekanntem
  Server-Start; Server prüft erneut). Stopp-Formular fängt offline ab
  (Intent statt Server-Call); wartender Stopp rendert eigene Sektion mit
  „Jetzt synchronisieren“ (manuell, wiederholbar) und „Stopp verwerfen“
  (Server-Timer läuft ehrlich weiter). Sync-Erfolg räumt den Intent;
  `not_found` (anderswo beendet) räumt mit ehrlicher Meldung; Rest behält
  den Intent (Uhr-Skew heilt ggf.).
- Keine Migration (Spalte `end_at` besteht), keine neue Permission
  (`time.write` wie bisher), kein Provider.

## Geschlossene Testmatrix

- DB (`time-tracking-timer`, F1103D-DB-01/02): exakter Client-Instant +
  Replay-NotFound; vor-Start/Zukunft/>24-h/defekt → Validation, Eintrag
  bleibt laufend (Spanne per ehrlich zurückdatiertem Start belegt).
- Unit (`f1103d-timer-offline-stop`): Intent-Builder Minuten/Anordnung/
  24-h-Grenze (inkl. exakt-24-h-ok).
- E2E (`F1103D-E2E-01`): Online-Start → Offline-Stopp (Intent-Sektion) →
  6 s offline warten → online Sync → genau ein Eintrag mit 1 Minute;
  DB-Read-back belegt `end_at` deutlich vor Sync-Beginn (Offline-Instant,
  keine Serverzeit). Nachbarn F9.2 (2/2) + F1103C (2/2) grün.

## Bewusst offen

- Outbox für Fotos und Push (F11-Rest laut STATUS).
- Pausen während Offline-Timern, GPS für Offline-Starts, mehrtägige
  Offline-Timer (>1440 Min, Server-Cap), Online-Start + Offline-Stop mit
  Pausen-Anteil (F11-03c-Offenpunkte).
