# F9-10 Idle-Hinweis (Inaktivitäts-Anstoß zur Pause)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02`
Basis: F9-06 Pausen-Segmente (Start/Ende-Protokoll je Eintrag).

## Ziel und Abgrenzung

Katalog F9 „Idle-Details": Läuft ein Zeiteintrag (Stoppuhr) und der Nutzer
ist am Gerät inaktiv, zeigt die Zeiterfassung einen Hinweis („Keine
Aktivität seit … — Pause vergessen?") mit direkter Aktion
[Pause starten] (bestehendes `startBreak`, keine neue Permission) und
[Weiter arbeiten] (Hinweis zurücksetzen). Kein Automatismus: Es wird nie
still eine Pause gebucht oder Zeit gekürzt (F9-06-Prinzip: keine stille
Neuberechnung). Offene Pause und freigegebene Einträge unterdrücken den
Hinweis (es gibt nichts anzustoßen).

## ESTIMATE (reversibel)

- Schwelle `IDLE_AFTER_MS = 5 Minuten`: Inaktivitäts-Volumen, keine
  Reonic-Referenz. Reine Client-Beobachtung (pointer/key/scroll/touch);
  versteckter Tab erzeugt keine Events und wird daher idle (ehrlich:
  keine Hintergrund-Tracking-Behauptung).
- Hinweis ist Erinnerung, kein Nachweis von Abwesenheit.

## Umfang

1. `lib/time-tracking-idle.ts`: reine Entscheidungsfunktion
   `idleState(lastActivityMs, nowMs)` → `{ idle, idleSinceMs }`
   (idle ab `now - last >= IDLE_AFTER_MS`; Zukunfts-Stempel durch
   Uhrversatz → nicht idle, fail-closed).
2. UI `IdleHint` (Client, neben dem Lauf-Banner): 5-s-Takt, Banner mit
   Startzeit der Inaktivität (Client-Zeit, Berlin-Format), Aktionen wie
   oben. Nur mit `canWrite`, laufendem Eintrag, ohne offene Pause.
3. Tests: Unit (Grenzen/Uhrversatz), E2E mit `page.clock` (deterministisch
   ohne 5-min-Wartezeit): Start → kein Hinweis → +5:01 min ohne Input →
   Hinweis → „Weiter arbeiten" → weg → erneut +5:01 → Hinweis →
   „Pause starten" → offene Pause.

## Bewusst offen

- Automatische Pausenabzüge, Verrechnung, Mobile-/Offline-Verhalten.
