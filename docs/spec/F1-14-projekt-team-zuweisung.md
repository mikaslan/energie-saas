# F1-14 Projekt-Team-Zuweisung (ENTWURF)

STATUS: SPECIFIED+CONTRACTED (Entwurf, keine Implementierung).
Ziel/Norm: Modulkatalog M1:24 — Teams einem Projekt operativ
zuordnen (informativ, sichtbar in der Projektakte). Vorbild
M1-09-Commands (CAS, Guards, Cap), Team-Optionen via F1-12
`listTeamOptions`, Zuweisungs-Muster F7-05b (0128). Alle
Fixentscheidungen unten sind DECIDED.

## Non-Goals

- KEINE Sichtvererbung: Zuweisung gründet kein `project.read`
  (Folgeslice); KEINE neue Permission; KEIN Auto-Routing (F1-10);
  KEINE Termin-/Block-Bindung (F1-12/F7-06); KEIN Team-CRUD.

## Vertrag

- Migration 0210: `project_team_assignment` (id, workspace_id,
  project_id, team_id, assigned_by, assigned_at timestamptz);
  UNIQUE (ws, projekt, team); UNIQUE (ws, id); FK project
  CASCADE, FK team RESTRICT (0128-Gegenentscheidung: kein
  stilles Lösen); `project.team_assignment_revision` int ≥ 0,
  eigene CAS-Spalte (`assignment_revision` NICHT mitgenutzt).
- Commands `project-team-assignment-command.v1`: `assign_team` /
  `unassign_team` { schemaVersion, projectId, teamId,
  expectedTeamAssignmentRevision }; strict, UUIDs lowercase.
- Validierung: Projekt im WS sonst `project_not_found`; Team
  aktiv im WS sonst `team_target_not_found` (fail-closed, kein
  Orakel); archiviert/fremd/unbekannt identischer Code. Entzug
  wirkt auch auf archivierte Teams (nur Existenz-im-WS).
  Cap 50 Teams je Projekt → `team_assignment_limit_reached`;
  Idempotenz: assign bestehend / unassign fehlend → changed:false,
  Revision fix.
- Fehlercodes: `invalid_team_assignment_command` (Zod),
  `project_not_found`, `team_target_not_found`,
  `team_assignment_revision_conflict` (+currentRevision),
  `team_assignment_limit_reached`; Permission via
  PermissionDeniedError (`project.assign` / `project.read`).
- Lockordnung (DECIDED, F7-05b-nah): 1. project FOR UPDATE
  (serialisiert je Projekt), 2. Team-Zeile aktiv-pruefen
  (FOR SHARE), 3. Assignment-Zeilen lesen OHNE FOR UPDATE
  (Projekt-Lock genuegt; ACL bleibt ohne UPDATE-Grant),
  4. Revision-CAS-Update (`+1`, Guard INT_MAX). KEIN
  Workspace-Gegenlock (anders als M1-09): Team-DML nimmt keine
  Workspace-Locks, kein Zyklus mit Membership-Offboarding moeglich.
  Races: Doppel-Assign → UNIQUE gewinnt, Verlierer Conflict (23505);
  Assign-vs-Delete → 23503 fail-closed Target; Assign-vs-Archiv →
  Aktiv-Check entscheidet; Revoke-vs-Assign → Deny, nie halb.
- RLS tenant_isolation + FORCE (0114/0128-Muster); Grants nur über
  Rollenvertrag, keine Grants in der Migration.

## RBAC-Matrix (DECIDED, keine neue Permission)

- Schreiben `project.assign` internal-only: Admin/Editor ok;
  Viewer denied; External (external_only) denied; Worker denied
  (kein project.assign); revoked denied; cross-tenant not_found.
- Lesen `project.read` intern: Admin/Editor/Viewer sehen Sektion;
  External sieht NICHTS (External-View unberührt, kein Grant);
  Worker/revoked/cross-tenant wie M1-09 (denied/not_found).
- Optionen: nur aktive Teams via `listTeamOptions` (F1-12-Guard);
  archivierte bleiben an Zuweisungen lesbar, nie neu zuweisbar.

## Events/Audit

- `project.team_assigned` / `project.team_unassigned` (aggregate
  project, actor, payload { projectId, teamId,
  teamAssignmentRevision, commandKind }); Audit action
  `project.assign`, resource `project_team_assignment`,
  allowed:true, gleiche Evidence — UUIDs/Revision nur, KEINE
  PII (kein Teamname/Label).

## UI-Verhalten (Zuweisungs-Panel, intern-only)

- Neue Sektion „Teams" im Panel (M1-09-Bestand unberührt): Liste
  (Teamname + Entfernen), Dropdown aktiver Teams + Zuweisen,
  Revisions-Stand sichtbar („Stand N" wie Personen-Sektion);
  External-View unverändert.
- Leer: „Keine Teams zugewiesen."; Disabled ohne `project.assign`:
  Liste lesbar, Hinweistext wie Personen-Sektion; Fehlertexte
  analog M1-09 (invalid/conflict/target/limit/not_found/denied);
  Conflict → Akte neu laden; Suche entfällt (Dropdown ≤ MAX).

## Tests

- DB (`f1014`, Migration 0210): F1014-DB-01 assign ok + Revision+1;
  -02 unassign ok; -03 Idempotenz (changed:false, Revision fix);
  -04 CAS-Konflikt (stale → currentRevision); -05 archiviert/
  fremd/unbekannt → team_target_not_found; -06 Cap 50 (51. denied);
  -07 RESTRICT (Team mit Zuweisung nicht löschbar); -08 CASCADE
  (Projekt-Delete räumt auf); -09 Mandantentrennung; -10 RBAC
  (Viewer/External/Worker/revoked denied); -11 Events/Audit ohne PII.
- E2E (`f1-14`, Haus-Muster, isoliertes Seed-Projekt): Editor weist
  Team zu → sichtbar; Reload → persistent; Viewer sieht, kann nicht
  ändern; External sieht Sektion nicht; unassign → weg; Axe; keine
  Browser-Fehler; Viewports 375/768/1440.
- Nachbarn: M1-09 (Personen-Panel unverändert, Revisionen entkoppelt),
  F1-12 (Teams/Archiv-Guard), F7-06 (Block-Muster, keine Kollision).

## Pins/Rollenvertrag

- F7-05b-Muster (0128) 1:1 in scripts/db-role-contract.mts: eigene
  PROJECT_TEAM_ASSIGNMENT_RELATIONS-Menge, Grant-Block
  (SELECT/INSERT/DELETE app_runtime, kein UPDATE), Presence-Probe
  (to_regclass), ACL-/Pin-Listen, tenant_isolation-Policy-Hash per
  Embedded-Probe geerntet. db:roles:verify 88/88 + PG18 bleiben grün.

## Risiken

- Zwei Revisionen je Projekt (assignment + team_assignment): UI muss
  je Sektion die eigene Revision senden (falsche → Conflict).
- RESTRICT-Fehlannahme: Team-Delete blockiert bei Zuweisung —
  beabsichtigt, Archiv nutzen (F1-12).
- Cap-/Guard-Drift gg. M1-09/F1-12 bei späteren Änderungen.
