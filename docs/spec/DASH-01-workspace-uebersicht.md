# DASH-01 Workspace-Übersicht (eigene Daten, Layout ESTIMATE)

Stand: SPECIFIED (Codex-Slice DASH-01; Gesamtauftrag F1–F16 inklusive
Dashboard). Es existiert kein Reonic-Referenzbeleg (Frage
Q-DASHBOARD-REFERENZ in `fragen an codex/offen`); Layout und
Kennzahlauswahl sind daher eine reversible eigene Näherung (ESTIMATE),
keine behauptete Reonic-Parität. Alle Zahlen stammen aus verifizierten
eigenen Lesemodellen (keine erfundenen Daten).

## 1. Umfang Slice 1

Route `/w/[workspaceId]/dashboard` (Serverkomponente, Muster
Anfragen-Board/Aufgaben-Seite):

- Pipeline-Karte: Anfragenzähler je Kanban-Spalte + Gesamt (Quelle:
  `getDefaultRequestBoard`, Permission `project.read`). Ohne Recht ist
  die Karte verborgen (kein Fehler).
- Aufgaben-Karten: „Meine überfälligen" und „Heute fällig" (Quelle:
  `getGlobalTaskInboxPage`, Filter mine/open, Buckets overdue/today,
  Permission `task.read`); je max. 5 Einträge (Titel, Projekt,
  Fälligkeit) + Hinweis auf weitere + Link in den Posteingang.
- Leere Zustände als Text („keine offenen Anfragen", „nichts
  überfällig"), niemals leere Karten ohne Aussage.
- Hinweiszeile: Layout eigene Näherung (Referenzfrage offen).

## 2. Nichtziele (Folgeslices)

- Termin-Vorschau (Kalender ist projektbezogen; workspace-weite
  Anreicherung folgt).
- Energie-KPIs (Autarkie-/Ersparnis-Aggregate über Projekte).
- Diagramme (Recharts) und Export.

## 3. Sicherheit/Tests

- Keine neue Permission; Viewer+ liest, External fail-closed (Modell-
  und Routenmuster wie Bestand).
- E2E-Rauchtest: isolierter Workspace, Abschnitte sichtbar, Zähler 0,
  Leertexte vorhanden.
