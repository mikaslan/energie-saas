# F1-13 Team-Kalender (Slice 1: Umfang „Team" umsetzen)

Folge zu M1-15b (dort: „team strukturell (später)"): Tabellen-Struktur
(`calendar.team_id` + Scope-CHECKs seit 0052) war bereit, Service/UI
fehlten. Teamkalender bündeln Termine je Team; sichtbar für Mitglieder
(+ Admin), buchbar wie tenancy.

## Vertrag

- `createTeamCalendar` (calendar.write): Name/Farbe wie tenancy, Team muss
  bestehen, gleicher Workspace, aktiv — sonst Validation (kein Orakel,
  F1-12-Muster; deform auch).
- Sichtbarkeit (`calendarVisibleFragment`, alle 6 Stellen): team zusätzlich
  für Team-Mitglieder (+ Admin wie bisher); client nie. Termine auf
  Teamkalendern folgen automatisch (validateCalendar nutzt das Fragment).
- `calendarItemV1` (additiv, v1): `teamId/teamName` nullable (nur type team
  belegt; Tenancy-/User-Einträge null).
- Manager: Umfang-Umschalter (Unternehmen/Team) + Team-Auswahl, Teamname in
  der Liste; Archiv wie tenancy (Service kennt team längst).
- Keine Migration (Spalten seit 0052), keine neue Permission, ohne JS
  lesbar (Umschalter braucht JS nur für die Team-Auswahl-Einblendung;
  Formular-POST ohne JS mit Default-Umfang möglich).

## Regeln

1. Archivierte/fremde Teams → Validation, nie Orakel.
2. Teamname nur projiziert (keine PII über Teamnamen hinaus).

## Tests

- DB (`f1013-team-calendars`): Anlage+Write-Gate, Sichtbarkeit
  Mitglied/Admin/fremd, Buchung auf Teamkalender, fail-closed-Matrix.
- Contract: Kalender-Item mit/ohne Team, Strict ohne Schlüssel.
- E2E (`F1-13-E2E-01`): Team + Zuordnung → Teamkalender per Manager →
  Liste zeigt „Team — Name“ → Dialog-Dropdown enthält ihn; keine
  Browser-Fehler.
- Nachbarn: m115b-Scopes, m115-Service/Contract/Erasure, f1012.
