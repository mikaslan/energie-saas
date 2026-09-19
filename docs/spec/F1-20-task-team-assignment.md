# F1-20 Projektaufgaben n-Teams (T5) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. Migration **0233**. Quelle: Schwarm-Spec S5 (reviewed).

## DISCOVERED

- Ist: Task-Assignees nur Memberships (Vollmodell, CAS, Cap 50).
- Vorbild F1-14 1:1: eigene Tabelle + eigene Revision + RLS + Cap 50 +
  Idempotenz + Events/Audit + Panel + Rollenvertrag ohne UPDATE.

## SPECIFIED

- Tabelle `project_task_team_assignment` (UQs, FK task CASCADE / team
  RESTRICT, finite-Check) + EIGENE `project_task.team_assignment_revision`
  (kein Mitnutzen von `task.revision`).
- Contract `project-task-team-assignment-command.v1` (assign/unassign,
  Cap 50); Guards (aktiv/fremd/archiviert fail-closed; Entzug auch
  archiviert); Rechte `task.write/read`, External sieht nichts, KEINE
  Sichtvererbung; Lockordnung F1-14-nah; Events
  `project.task_team_assigned/unassigned` + Audit (PII-frei).
- UI: Teams-Sektion im Task-Dialog (Liste/Dropdown/Stand N/eigene Action).

## CONTRACTED

- NEU: 0233 + Snapshot, Schema, Contract+Service (+Barrel), Actions,
  `f1020` DB (15: F1014-Spiegel + Entkopplungs-Test), E2E-Spec, diese Spec.
- EDIT: Task-Dialog, `db-role-contract.mts`, Fixtures (+2), m111a-Pins.
- Nachbarn: M1-10, F1-14, F1-12, Inbox (keine Vererbung) grün halten.
