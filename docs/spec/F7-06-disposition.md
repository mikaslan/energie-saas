# F7-06 Disposition Slice 1: Team-Blockzuweisung auf der Plantafel

Folge-Slice zu F1-12 (Plantafel-Code trägt „Blockzuweisung Folge-Slice“;
F1-12-Spec listet Plantafel-Blockzuweisung als Folge). Dispatcher sieht je
Eintrag das Team und weist es auf der Tafel zu. Team-Gruppierung der Zeilen
bleibt F7-07 (Mitglied↔Teams ist n:m, eigenes Design).

## Vertrag

- Board-Eintrag (`planning-board.v1`, additiv wie F1-12-Item): `teamId`,
  `teamName` (nullable), `revision` (CAS für Zuweisung).
- Service projiziert Team je Eintrag (JOIN team, nur Name — keine PII).
- Anlageformular: Team-Dropdown („Ohne Team“ + aktive Teams via
  `listTeamOptions`); Drawer: Zuweisungs-Formular (Team-Select +
  `expectedRevision`, `appointment.write`, aktive-Teams-Guard aus F1-12,
  fremd/archiviert/unbekannt fail-closed).
- Zuweisung läuft über `update_appointment` (Voll-Resend aus
  `listProjectAppointments`, Revision-CAS; Konflikt bleibt Konflikt).
- Keine Migration (team_id aus 0114), keine neue Permission
  (`appointment.read/write`, Team-Optionen `calendar.read` wie F1-12-Range;
  ohne Options-Grant ehrlich ohne Team-Steuerung).
- Seite zeigt Team-Chip je Eintrag + „Team:“-Zeile im Drawer; der alte
  Kommentar („Gruppierung folgt“) wird auf F7-07 umgebogen.

## Regeln

1. Ohne JS bedienbar (Formulare/Links wie bisher).
2. Archivierte Teams bleiben an Einträgen lesbar, fallen aus Dropdowns.
3. „Ohne Team“ ist explizit (null), kein stilles Entfernen.

## Tests

- DB (`f0706-disposition`): Projektion (mit/ohne Team, Archiv-Name bleibt),
  Zuweisung ok, fremd/archiviert fail-closed, Revision-CAS-Konflikt,
  Mandantentrennung.
- E2E (`F7-06-E2E-01`): Tafel → Drawer → Team setzen → Chip sichtbar →
  entziehen → Chip weg; keine Browser-Fehler.
- Nachbarn: f0705, m115-Service/Contract, F1-12-Tests, Portal-Specs
  unberührt (kein Portal-Anteil).
