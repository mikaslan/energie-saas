# MUSE-MONITOR — 5-Stunden-Überwachung (2026-09-05, Mission von Mikail)

Kanonische Quelle der Befunde; Kurzfassung geht an Mikail, Details hier.

## Runde 1 (≈ 01:45)

- Stand: Welle-03-Nachholblock + 6 Slices integriert in `codex/m1-wave-02`
  (`e178425`); alle Gates grün (check 215/1988+1, Rollen 88/88, PG18 5/5,
  Build, E2E 96/96).
- Muse aktiv: neuer Commit `668fee3` (F16.3-D Fix-Modell global,
  Snapshot-v2). CI zu dem Zeitpunkt billing-tot (alle Runs sterben nach
  3–4 s, „payments have failed or spending limit").
- **Befund A (kritisch):** Muse hat die bereits angewendete Migration
  `0059_f10_portal_appointments.sql` nachträglich verändert — mein
  Owner-Wrapper (SET-ROLE-Ersatz für CREATE OR REPLACE) wurde
  zurückgedreht auf das reine CREATE OR REPLACE, das im
  test-legacy-single-Modus mit „must be owner of function" scheitert.
  Migrationen sind forward-only — nachträgliche Änderung = Kettenbruch.

## Runde 2 (≈ 02:55)

- **GitHub umgestellt:** Repo wieder PUBLIC (unlimitierte kostenlose
  CI-Minuten) → CI läuft erstmals seit dem Billing-Ausfall wirklich
  (Runs `in_progress` mit >1 min statt 3-s-Tod). Workflows
  kostenoptimiert (paths-ignore für Doku-Pushes, altes `ci.yml` nur noch
  main/manuell).
- Muse: Turn 23 („F16.3-D-Push und CI-Lage festgeschrieben") + F16.3-E-
  Spec Cap-Prozent mit Snapshot-v3; Lane `codex/muse-welle-03-e2e` →
  `dfece96`. Journal 64 Einträge (0061 subsidy_templates,
  0062 portal_signature_status, 0063 snapshot_v2_check).
- Gates auf Lane-Head: lint/typecheck/depcruise grün, db:generate ohne
  Drift. Full-Check läuft — erwarteter Bruch an Befund A (0059).
- Offen: 0059-Wrapper auf Lane-Head wiederherstellen, m111a-Zähler
  prüfen (0061–0063), volle Gates, Integration nach Grün.
