# F1-12 Teams (Slice 1: Stammdaten + Termin-Bindung)

Erster fehlender durchgängiger Katalogpfad im CRM (STATUS: „Teams …
bleiben offen“; Kalender-Schema: „team_id bleibt bis zum Team-Slice
nullable und OHNE FK“): Teams mit Mitgliedern verwalten und Termine
einem Team zuordnen. Deliberate Gegenentscheidung F2-08b (keine
Auto-Installation) bleibt unangetastet. Kein Reonic-Referenzbeleg;
Verhalten ist reversible eigene Näherung (ESTIMATE).

## Vertrag

- `team` (Migration 0114): Name 1–120, getrimmt, keine Steuerzeichen,
  je Workspace eindeutig (aktive); `active`-Flag statt Delete
  (F7.3/F16.3-Muster); Revision-CAS bei Umbenennen.
- `team_member`: je (Team, Membership) genau einmal; Membership muss
  intern und im Workspace existieren (Viewer/Editor/Admin, kein
  external_only); Voll-Replace (Last-Writer-Wins, dokumentiert).
- `project_appointment.team_id`: nullable, Composite-FK → team
  (ON DELETE SET NULL); nur aktive Teams zuweisbar; unbekannte/fremde/
  archivierte Teams → fail-closed (Validation, kein Orakel).
- DTO `project-appointment-item.v1` projiziert `teamId` + `teamName`
  (null ohne Zuordnung); Range führt `teams` (id, name) für den Dialog.
- Keine neuen Permissions: Verwaltung `settings.manage` (Admin,
  internalOnly; Verlustgrund-Präzedenz), Lesen/Optionen `calendar.read`,
  Termin-Schreiben `appointment.write` wie bisher.

## Regeln

1. Einstellungen-Seite `einstellungen/teams`: Anlegen/Umbenennen/
   Archivieren/Wiederherstellen + Mitglieder-Checkboxen; Admin-only.
2. Termindialog: Team-Dropdown („Ohne Team“ + aktive Teams);
   Anzeige des Teamnamens am Termin; Revision-CAS bleibt.
3. Archivierte Teams verschwinden aus dem Dropdown, bleiben an
   bestehenden Terminen lesbar (kein stilles Entfernen).
4. Team-Löschung gibt es in Slice 1 nicht (Archiv); Plantafel-
   Blockzuweisung und Kalender-Scopes bleiben Folge-Slices.
5. RLS tenant_isolation + FORCE (beide Tabellen); Rollenvertrag
   (ACL + Policy-Hashes, kein Routine-Pin — kein Funktionswechsel).

## Tests

- DB (`f1012-teams`): CRUD/RBAC/Mitglieder/Revision, FK-Bindung am
  Termin (aktiv ok, archiviert/fremd/unbekannt fail-closed),
  Mandantentrennung, DTO-Projektion mit Teamnamen.
- E2E (`F1-12-E2E-01`): Admin legt Team an + Mitglied hinzu → Termin
  wählen → Team setzen → Name sichtbar; Archivieren → Dropdown ohne
  Team, Termin behält Namen; keine Browser-Fehler.
