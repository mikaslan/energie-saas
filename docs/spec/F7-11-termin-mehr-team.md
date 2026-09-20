# F7-11 Termin-Mehr-Team (Katalog F7.5 Block-Ebene: mehrere Teams parallel je Termin)

Lane `codex/muse-fleet-6-f1rest` (Agent 6B). Migration **0320** (Range 0320-0329, Nr. 1).
Kein Reonic-Referenzbeleg; Semantik ist reversible eigene Näherung (ESTIMATE).
NICHT verwechseln mit F7-05b (Checklisten-Block-Teams — existiert, 0128).

## DISCOVERED (W1, Code-verifiziert)

- `project_appointment.team_id` ist EIN Team (0114, Composite-FK, SET NULL);
  Legacy-Pfad (F1-12/F7-06: Dialog-Dropdown, Drawer-Assign, Chip) bleibt unverändert.
- Präzedenz F1-20 (0233, Aufgaben-n-Teams, nächstes Muster): Junction-Tabelle +
  eigene CAS-Domäne `team_assignment_revision` + Guard-Carve-out (Fach-Revision
  bumpt nicht) + Cap 50 + team-FK RESTRICT + Events `project.task_team_*`
  (ID-only, PII-frei) + `changeTaskTeamAssignment` in eigener Service-Datei
  (`modules/tasks/team-assignment-service.ts`) + `*TargetError/*LimitError`.
- Präzedenz F7-05b (0128): Junction-RLS tenant_isolation + FORCE, keine Grants
  in der Migration (Rollenvertrag: ACL-Menge + GRANT select/insert/delete +
  Policy-Hash-Pin, live ernten).
- Guard `_m115_guard_project_appointment` (0043:183-256) verlangt
  `revision = OLD.revision + 1` bei JEDEM UPDATE → Carve-out nötig (F1-20-Block-Muster).
- Appointment-Command-Schema ist strict (`contract.ts:173` teamId Pflichtfeld,
  nullable) → Mehr-Team-Felder nur ADDITIV (neue Commands/Outputs, kein Umbau).
- Tenant-Invarianten laufen automatisch über neue Tabellen (keine Registrierung;
  0128/0233 stehen in keiner Scope-Menge).
- Nummern-Lücke 0291-0319 lane-lokal unkritisch: `_journal.json`-idx steuert
  Reihenfolge; `migration-history.mts` prüft lückenloses Präfix angewandt-vs-lokal,
  keine Nummern-Kontiguität (F8-0195-0200-Verkettungs-Präzedenz).

## SPECIFIED

### Datenmodell (0320, additiv)

- NEU `project_appointment_team_assignment`: `id` uuid PK, `workspace_id`,
  `appointment_id`, `team_id`, `assigned_by`, `assigned_at` (finite-CK);
  UNIQUE(ws,id), UNIQUE(ws,appointment,team); Composite-FK appointment
  → CASCADE, team → RESTRICT (F1-20; Teams sind eh archiv-only);
  Index (ws,team,appointment); RLS tenant_isolation + FORCE, keine Grants.
- `project_appointment.team_assignment_revision` int DEFAULT 0 + CHECK 0..2^31-1.
- Guard-Carve-out in `_m115_guard_project_appointment` (CREATE OR REPLACE,
  F1-20-Block): reine `team_assignment_revision`-Änderung ohne Fach-Bump;
  Fachfelder-Mitveränderung → 23514; Rest byte-identisch.
  Rollenvertrag: `_m115_guard`-Quell-Pin aktualisieren (F1-20-`_m110`-Präzedenz),
  ACL-Menge + GRANT + Policy-Hash-Pin für neue Tabelle (live ernten).

### Service (`modules/calendar/team-assignment-service.ts`, neu)

- `changeAppointmentTeamAssignment(tx, ctx, { appointmentId, projectId,
  kind: assign_team|unassign_team, teamId, expectedTeamAssignmentRevision })`:
  `appointment.write` (editor+, internalOnly; Viewer/External denied);
  Termin-Scope (fremd/unbekannt → NotFound, kein Orakel); CAS auf
  `team_assignment_revision` (Mismatch → Conflict mit aktuellem Stand);
  assign: Team aktiv+eigener WS sonst `AppointmentTeamTargetError`
  (archiviert/fremd/unbekannt/deform — kein Orakel); Cap 50 sonst
  `AppointmentTeamLimitError`; Idempotenz: assign-bestehend + unassign-fehlend
  sind Noops MIT Revisions-Bump? NEIN — Noop OHNE Bump (F7-05b-Mengen-Idempotenz
  für den Mengenteil, CAS schützt nur echte Änderung; F1-20-Relation prüfen:
  dort bumpt jeder Change — SPEC-Entscheid: Noop ohne Bump, dokumentiert).
- Events `project.appointment_team_assigned/unassigned` (ID-only: projectId,
  appointmentId, teamId, revision; PII-frei) + Audit (Pattern F1-20).
- Lesen: `getAppointmentTeamAssignmentContext` (canAssign, teams[{id,name}],
  external → null); DTO-ADDITIV `teams[]` in Range + Board-`entryOf` +
  Termindialog-Output; `teamId/teamName` UNVERÄNDERT (Legacy).

### Unabhängigkeits-Regel (team_id vs Junction, dokumentiert, ESTIMATE)

- `team_id` (Single, F1-12/F7-06) und Junction sind zwei unabhängige
  Zuordnungen, kein Auto-Sync in beide Richtungen.
- Disjunktheit NUR beim Assign: assign auf das aktuelle `team_id`-Team →
  Validation ("bereits als Team gesetzt"). Späterer `team_id`-Wechsel berührt
  die Junction NICHT (F1-12-Regel-3-Präzedenz: kein stilles Entfernen, lesbar).
- UI trennt sichtbar: "Team" (Single-Chip, Bestand) vs "Weitere Teams"
  (Junction-Chips, neu).

### UI (Plantafel)

- Board-Eintrag: Junction-Chips (`planning-board-extra-team-chip-<id>`) neben
  Bestands-Chip; Drawer-Sektion "Weitere Teams" mit Checkboxen über
  `listTeamOptions` + Speichern (eigene Server-Action mit CAS-Roundtrip,
  Revision aus Context); Anlageformular unverändert (Single only — Mehr-Team
  ist expliziter Zweitakt, kein stiller Default).
- Archivierte Junction-Teams: lesbar (Name), nicht erneut zuweisbar.

### Tests

- DB (`tests/db/f711-appointment-teams.test.ts`): Assign/Unassign-Roundtrip +
  CAS (Mismatch → Conflict), Noop-ohne-Bump, Target-Matrix (archiviert/fremd/
  unbekannt/deform → TargetError), Cap 50 → LimitError, Disjunktheit zu
  team_id (assign → Validation), team_id-Wechsel berührt Junction nicht,
  Legacy team_id-Pfad unverändert (update_appointment), Mandantentrennung,
  RBAC (Viewer/External denied, Context null), Events/Audit PII-frei,
  RESTRICT (Team mit Zuweisung nicht löschbar — via Deferrable? Teams
  archiv-only: DELETE-Versuch → RESTRICT-Fehler), Revision: Fach-Revision
  bumpt NICHT bei Team-Change.
- E2E (`F7-11-E2E-01`): Admin weist 2 Teams parallel zu (2 Chips) → Reload
  persistent → eines entziehen (1 Chip) → Archiv-Team nicht zuweisbar →
  keine Browser-Fehler.
- Nachbarn: f1012/f1013/f112-s1/s2/f0705/f0706/f0707/m115b/m115-service/f1014,
  E2E f7-06/f7-05/f1-12/f1-13.

### NICHT (Verbot / Folge)

- Google/MS-Sync, Serientermine (externe Blocker → STOPP + melden).
- Kein Umbau von `team_id`-Pfaden, kein Contract-Break (strict), kein Provider.

## CONTRACTED

- NEU (max): `lib/db/schema/project-appointment-team-assignment.ts`,
  `drizzle/0320_f7_11_appointment_team_assignment.sql` (+ Journal/Snapshot via
  `db:generate` + Rename auf 0320-Tag), `modules/calendar/team-assignment-service.ts`,
  `tests/db/f711-appointment-teams.test.ts`,
  `tests/e2e/f7-11-termin-mehr-team.spec.ts`, `docs/spec/F7-11-termin-mehr-team.md`.
- EDIT (max): `lib/integrations/calendar/contract.ts` (neue Command/Output-Schemas,
  additiv), `modules/calendar/service.ts` (Read-Projektion `teams[]` in Range +
  `entryOf`), `modules/calendar/index.ts` (Export), `scripts/db-role-contract.mts`
  (ACL + GRANT + Policy-Pin + `_m115_guard`-Pin), Plantafel
  (`page.tsx` Chips, neue `planning-board-extra-teams-form.tsx`, `actions.ts`
  neue Action), `docs/parity/STATUS.md` (F7-Zeile Nachtrag bei CLOSE).
- Beweisgrün: DB f711 + Nachbarn (s.o.) + E2E F7-11 + Nachbarn-E2E +
  tsc/eslint/depcruise + `db:roles:verify` + `migration-history`-Gate.
