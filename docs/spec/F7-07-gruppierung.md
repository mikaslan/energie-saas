# F7-07 Team-Zeilengruppierung auf der Plantafel (Slice 2)

Folge zu F7-06 (dort vertagt: Mitglied↔Teams ist n:m). Die Tafel gruppiert
Mitgliedszeilen je Primär-Team; ohne Leserecht oder ohne Zuordnung bleibt
die flache Ansicht (kein vorgetäuschtes Wissen, kein Rauschen).

## Vertrag

- `listTeamMemberships` (modules/teams, `calendar.read` wie Team-Optionen):
  `{teamId, teamName, membershipId}` über aktive Teams, deterministisch
  nach Teamname/IDs, keine PII (Labels kommen aus dem Board-Lesepfad).
- Gruppierung seitenlokal (`groupBoardRows`): Primär-Team = erster Teamname
  alphabetisch, Mehrfach-Mitglieder erscheinen einmal; Sektionen
  alphabetisch, „Ohne Team“ danach, „Nicht zugeordnet“ zuletzt.
- Keine DTO-/Vertragsänderung am Board (f0705/m115 unberührt), keine
  Migration, keine neue Permission. Ohne JS lesbar (Server-Render).

## Regeln

1. Archivierte Teams verschwinden aus Sektionen (Eintrags-Chips aus F7-06
   bleiben lesbar).
2. Leere Teams bilden keine Sektionen.

## Tests

- DB (`f0707-team-grouping`): nur aktive Teams, exakte Schlüssel ohne PII,
  Mandantentrennung, Viewer-Leserecht.
- E2E (`F7-07-E2E-01`): zwei Teams, Editor nur Alpha → Alpha-Sektion mit
  Editor-Zeile, kein Beta/„Ohne Team“ → Alpha archivieren → flach, Zeile
  bleibt; keine Browser-Fehler.
