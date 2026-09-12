# F11-03c Stoppuhr-Outbox (Offline-Start/Stop + Replay, Katalog F11.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (Unit F1103C 5/5, E2E F1103C-E2E-01/02 1/1, Zeit-Batch 20/20, Unit-Vollsuite 133 Files 1206 bestanden, tsc/eslint/depcruise grün, lokal beobachtet).

Ziel: Dritte vertikale Outbox-Scheibe nach F11-03a/03b (dort steht die
Stoppuhr ausdrücklich noch als online-pflichtig): Ohne Netz gestartete
und/oder gestoppte Stoppuhr geht als gemessenes Zeitpaar in die
Zeit-Outbox und wird beim nächsten Online-Kontakt über dieselbe
Server-Action (`createTimeEntryAction`, `clientKey`-Guard aus F11-03b)
replayt. Kein Reonic-Referenzbeleg; reversible eigene Näherung
(ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Offline-Start legt einen wartenden Start in IndexedDB ab
  (`wmee-time-outbox`/`timer-starts`, DB-Version 2, Schlüssel
  `workspaceId:projectId`: genau ein wartender Start je Projekt;
  Felder Typ/Kommentar/Start-ISO). Erneutes Starten überschreibt
  (kein Stapel wartender Starts).
- Nur OFFLINE gestartete Timer sind offline stoppbar (ein
  Online-Start + Offline-Stop erzeugte Phantom-Doppelzeiten: der
  Server-Timer liefe weiter UND das Paar würde replayt — deshalb
  bleibt der Online-Timer offline-pflichtig wie bisher). Der Stopp
  vollendet das Paar und übersetzt es SOFORT in einen
  `QueuedTimeCreate` (reine Funktion `buildTimerPairCreate`,
  unit-getestet):
  - Beginn/Ende als Berlin-datetime-local (derselbe Helper wie das
    Formular, `isoToBerlinLocalInput`) — der Server parst wie online.
  - Arbeitszeit = gerundete Paar-Minuten, mindestens 1.
  - Pause 0, Typ/Kommentar vom Start (leer → null, wie F11-03b).
- Guards: Ende ≤ Beginn → ehrliche Meldung, Start bleibt wartend;
  Paar > 1440 Minuten (Server-Cap `TIME_MINUTES_MAX`, wie online)
  → ehrliche Meldung, Start bleibt wartend (manuell erfassbar,
  danach verwerfbar). Kein stilles Kappen.
- Online-Stop eines wartenden Offline-Starts replayt DIREKT über
  `createTimeEntryAction` (Muster F11-03b-Online-Pfad: clientKey je
  Absendung? Nein — je Paar genau einmal vergeben, beim Stop;
  Wiederverwendung beim Replay wie 03b). Offline-Stop reiht in die
  Outbox ein (Badge/Sync von F11-03b greifen unverändert).
- Wartender Start ist verwerfbar (IDB-lokal, kein Server-Call).
  Pausen, Freigabe, GPS-Ortung und Bearbeitungen bleiben
  online-pflichtig (kein Ort für Offline-Starts).
- Keine neue Permission (`time.write` wie bisher), keine Migration,
  kein Schema-, kein Rollen-, kein Fixture-Anteil.

## Scopes

1. `time-timer-outbox.ts` (rein): Schlüsselbildung, Paar-Mapping,
   IDB-CRUD für `timer-starts`; `time-outbox.ts`: DB-Version 2 +
   neuer Store (Upgrade-Pfad v1→v2).
2. Timer-UI: Offline-Start fängt ab (wartender Start + Meldung),
   wartender Start rendert eigene Sektion (Beginn Berlin, Stoppen/
   Verwerfen), Offline-Stop eines laufenden Eintrags fängt ab
   (Paar aus Props-Start), Online-Stop replayt direkt.
3. Keine Server-Änderung (bestehende Action + Guard).

## Geschlossene Testmatrix

- Unit (`f1103c-timer-outbox`): Minuten-Rundung (59 s → 1,
  90 s = 1,5 → 2 halb auf), Min-Clamp 1, Ende ≤ Beginn
  fail-closed, >1440 fail-closed, Berlin-Format wie Formular,
  Schlüsselbildung.
- `F1103C-E2E-01`: offline starten → wartend sichtbar → offline
  stoppen → „Offline gespeichert“ → online → synchronisiert +
  genau ein Eintrag „1 Min.“ sichtbar.
- `F1103C-E2E-02`: offline starten → online gehen → stoppen →
  direktes Replay ohne Sync-Umweg, genau ein Eintrag „1 Min.“.

## Bewusst offen

- Pausen während Offline-Timern, GPS für Offline-Starts,
  mehrtägige Offline-Timer (>1440 Min, Server-Cap),
  Online-Start + Offline-Stop (braucht Server-Op gegen
  Phantom-Doppel, Folgeslice), Push.
