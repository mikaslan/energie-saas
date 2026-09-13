# F16-04b Mehrfach-Bearbeiter aus Aufgaben-Vorlage (Katalog F16.3)

F16-04 „Bewusst offen“: „Mehrfach-Bearbeiter aus Vorlage“. F16-04 weist
beim Anwenden immer den Anwendenden selbst zu (`actorMembershipId`).
Dieser Slice trägt eine Bearbeiterliste in die Vorlage: Das Anwenden
weist alle (noch) gültigen Mitglieder zu, nicht nur den Anwendenden.

## ESTIMATE (reversibel, keine Reonic-Referenz für Vorlagen-Bearbeiter)

- Modell: `assignee_membership_ids uuid[] NOT NULL DEFAULT '{}'` an
  `task_template` (Migration 0145, nur ADD COLUMN + CHECK, kein RLS-/
  Grant-Umbau). Cap 50 = `PROJECT_TASK_MAX_ASSIGNEES` (Task-Vertrag).
- Schreiben (create/update): Membership-IDs müssen interne
  Workspace-Mitglieder sein (viewer/editor/admin, ohne external_only,
  saubere Capabilities — gleiche Predikate wie Task-Validator),
  sonst Validation fail-closed. Leere Liste = „nur Anwendender“
  (Legacy-Verhalten, unverändert).
- Anwenden: gespeicherte IDs gegen aktuelle Memberships auflösen;
  ausgeschiedene entfallen still (F7.3-Präzedenz: Anlage tolerant,
  Validierung strikt); fallen ALLE weg (oder Liste leer), greift der
  Anwender-Fallback wie bisher. Ausgeschiedene NICHT fail-closed —
  sonst würde jede Fluktuation alte Vorlagen unanwendbar machen.
- Suche (Manager-UI): neue workspace-weite Mitgliedersuche
  (`task.write`-Gate, Query ≥ 2 Zeichen, gleiches Limit wie
  Projektsuche) — KEINE Voll-Enumeration: Editoren dürfen heute per
  Projektsuche nur query-gebunden suchen; die Vorlagensuche spiegelt
  exakt diese Schranke (kein PII-Mehr, keine neue Permission).
  `listTeamMemberOptions` (settings.manage, Voll-Liste) wird bewusst
  NICHT wiederverwendet.
- UI (TaskTemplateManager): Suche + Toggle-Checkboxen je Formular
  (Anlage + Bearbeiten), Auswahl als Hidden-JSON; Liste zeigt
  Bearbeiter-Labels; Legacy-Vorlagen ohne IDs verhalten sich wie
  bisher (nur Anwendender).

## Vertrag

- Template-Contract: `assigneeMembershipIds` (UUID-Array, max 50,
  optional in create/update, Pflicht im DTO) in
  create/update/DTO-Schemas.
- Service (`modules/tasks/templates.ts`): Spalte in SELECT/INSERT/
  UPDATE/DTO; Schreib-Validierung gegen Memberships (fail-closed als
  TaskTemplateValidationError); Apply löst auf, filtert Ausgeschiedene,
  Fallback Anwender; neue `searchTaskTemplateMembers` (task.write,
  Query/Limit wie Projektsuche).
- Actions (aufgaben-vorlagen): `assigneeMembershipIds`-JSON in
  create/update (strikt geparst, invalid bei Formfehlern);
  `searchTaskTemplateMembersAction` für die UI-Suche.
- Events/Audit: `task_template.applied`-Payload nennt zusätzlich die
  zugewiesene Anzahl (Beobachtbarkeit, kein PII im Payload).

## Regeln

1. Migration 0145 nur ADD COLUMN + CHECK; keine neue Permission
   (task.read/task.write), kein Provider.
2. Globale Inbox, Task-Revisionen, Labels/Checklisten: unberührt.
3. Rollenvertrag: Grants/Policy unverändert (Spalte ohne RLS-Relevanz);
   m111a-Pins für 0145 ernten.

## Tests

- DB (`f1604b-vorlagen-bearbeiter`, Fixture-Muster F16-04): Vorlage mit
  zwei Bearbeitern → Apply weist beide zu (plus Titel/Offset wie
  bisher); ausgeschiedenes Mitglied entfällt, Anwender-Fallback greift
  bei leerer Auflösung; unbekannte/fremde Membership-ID bei Anlage →
  Validation; Cap-Überschreitung → Validation; Legacy-Vorlage ohne IDs
  → nur Anwendender.
- E2E (`F16-04B-E2E-01`, F16-04-Muster): Vorlage anlegen, Mitglied per
  Suche wählen, im Projekt anwenden → Aufgabe zeigt beide Bearbeiter;
  keine Browser-Fehler, Axe sauber.
- Nachbarn: F16-04/16-03-DB-Suiten, Task-Nachbarschaft (Service unberührt
  bis auf neue Finder-Funktion), m111a-Pins (0145), db:generate ohne
  Drift.

## Bewusst offen

- Vorlagen mit Checklisten-/Label-Inhalt, Fremdsystem-Feeds,
  Bearbeiter-Rollen je Vorlage (wer DARF anwenden — heute task.write),
  Anzeige ausgeschiedener Bearbeiter in der Vorlage (stille Filterung).
