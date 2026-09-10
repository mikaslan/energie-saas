# F15-01 Gewerbe-Bereich (Board-Scope-Umschalter)

Ziel: Das Commercial-Board ist kein totes Modell mehr — die Anfragen-Seite
bietet den Bereichs-Umschalter Wohnbau/Gewerbe, neue Workspaces erhalten
beide Default-Boards, Bestand wird per Backfill versorgt.

## Befund

- `kanban_board.scope` kennt `residential`/`commercial`, aber der
  Provisionierungs-Trigger legt nur das Residential-Board an und
  `getDefaultRequestBoard` filtert `scope = 'residential'` hart.
- Folge: Gewerbe-Projekte sind modellseitig möglich, UI-seitig unerreichbar.

## Umfang

1. Migration `0088`: Trigger provisioniert zusätzlich das Default-
   Commercial-Board („Anfragen Gewerbe", gleiche 4 Spalten); idempotenter
   Backfill für Bestands-Workspaces (nur wo kein aktives Default-
   Commercial-Board existiert; RLS-Zeilen pro Workspace via `set_config`,
   Muster 0032/0076).
2. Service: `getRequestBoard(tx, ctx, { scope })` mit validiertem Scope-Enum
   (Default `residential`); fehlendes Board → `RequestBoardConfigurationError`
   (fail-closed, kein stiller Scope-Fallback). `getDefaultRequestBoard`
   bleibt Residential-Wrapper (Dashboard unverändert).
3. UI: Umschalter auf `/anfragen` (`?bereich=gewerbe`), Board-Name +
   Bereichs-Badge sichtbar; unbekannter `bereich`-Wert → 404-Seite via
   `notFound()` (kein stiller Default; beobachtbarer Inhalt, da das Repo
   keine eigene not-found.tsx trägt).

## ESTIMATE (reversibel)

- Spalten-Setup des Gewerbe-Boards = Kopie Wohnbau (eigene
  Gewerbe-Workflow-Stufen UNKNOWN, keine Reonic-Referenz).
- Keine neuen Permissions (bestehende Board-Leseschranke).
