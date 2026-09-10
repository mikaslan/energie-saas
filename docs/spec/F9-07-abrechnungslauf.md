# F9-07 Abrechnungslauf (Zeiterfassung)

Erster fehlender durchgängiger F9-Pfad in Katalogreihenfolge: freigegebene
Zeiteinträge werden je Zeitraum in einen Abrechnungslauf übernommen, der Lauf
wird geschlossen (Snapshot-Summen) und danach sind die enthaltenen Einträge
gegen Entsperren/Bearbeiten gesperrt. Auslastung (UI) und CSV-Export bestehen
bereits; Idle-Details, Mobile-/Offline bleiben getrennt offen.

## Vertrag

- `billing_run`: `id`, `workspace_id`, `label` (1–120 Zeichen, getrimmt),
  `period_start`/`period_end` (Kalendertage, Start ≤ Ende, max. 366 Tage),
  `status` (`open`/`closed`), `total_minutes` + `entry_count` (Snapshot, erst
  beim Schließen gesetzt), `created_by`, `closed_by`, `closed_at`, Timestamps.
- `billing_run_entry`: `run_id`, `workspace_id`, `time_entry_id`;
  UNIQUE (`workspace_id`, `time_entry_id`) — ein Eintrag wird höchstens einmal
  abgerechnet (Doppelabrechnung fail-closed).
- Keine neuen Permissions: `time.read` (Liste), `time.write` (Anlegen,
  Schließen). Keine neuen Rollen, keine externen Abhängigkeiten.

## Regeln

1. Anlegen (`open`): nur `time.write`; Validierung fail-closed.
2. Schließen: atomar in einer Transaktion —
   - nur `open`-Läufe; bereits `closed` → Konflikt;
   - übernommen werden beendete (`end_at NOT NULL`), freigegebene
     (`approved_at NOT NULL`), nicht archivierte Einträge, deren Start-Tag
     (Europe/Berlin) im Zeitraum liegt und die in keinem Lauf enthalten sind;
   - Snapshot: `entry_count`, `total_minutes = SUM(working_time_minutes)`
     (brutto wie bestehende Summen; Pausen werden daneben gezeigt, F9-06);
   - Events/Audit wie F9-05 (`billing_run.created`, `billing_run.closed`,
     `time.entry.billed` je Eintrag entfällt — ein Event je Lauf genügt,
     Einträge bleiben über `billing_run_entry` nachweisbar).
3. Sperre: Einträge in einem **geschlossenen** Lauf können nicht mehr
   ent-freigegeben (`unapprove`), bearbeitet oder archiviert werden
   (`TimeTrackingConflictError`, „entry billed"). Freigegebene Einträge sind
   ohnehin unveränderlich (F9-05); `unapprove` erhält den Zusatz-Guard.
   Einträge in einem noch **offenen** Lauf bleiben ent-freigebbar (der Lauf
   verlinkt nur beim Schließen — offene Läufe enthalten keine Einträge).
4. Löschen von Läufen gibt es nicht (Revisionssicherheit, „verbrannte Nummern"
   analog F8.3). Leere Schließung (0 Einträge) ist zulässig und sichtbar
   (`entry_count = 0`).
5. Mandantenisolation: alle Zugriffe über `workspace_id`; RLS
   `tenant_isolation` + FORCE wie `time_entry`.

## UI

Abschnitt „Abrechnungsläufe" auf der Projekt-Zeiterfassungsseite
(`time.write`): Formular (Bezeichnung, Von, Bis), Liste (Zeitraum, Status,
Anzahl, Summe in Std./Min.), Schließen-Button je offenem Lauf mit Feedback.
Read-only-Rolle sieht Liste ohne Aktionen.

## Tests

- DB (`f0907-billing-run`): Anlegen → Schließen mit Snapshot; nur
  freigegebene/beendete/unarchivierte Einträge im Zeitraum; Zeitraumgrenzen
  (Berlin-Tage); Doppelabrechnung über zwei Läufe fail-closed; `unapprove`
  nach Schließung fail-closed; Viewer ohne `time.write` fail-closed;
  Fremd-Workspace-Isolation.
- E2E (`F9-07-E2E-01/02`): Editor legt Lauf an und schließt ihn (Summe
  sichtbar); Viewer sieht nur lesend.
