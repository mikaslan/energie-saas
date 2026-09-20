# F11-05 Mobile Tab-Leiste (Katalog F11.1)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2c-f11` · Basis `85eda01`
Ziel: Jede Workspace-Seite (`/w/[workspaceId]/…`) erhält auf kleinen
Bildschirmen eine untere Tab-Leiste mit genau den 5 Katalognamen aus
F11.1 (Home, Projekte, Aufgaben, Kalender, Mehr). Schließt die
F11.1-Lücke „kein `app/w/[workspaceId]/layout.tsx`, keine Bottom-Bar,
jede Seite eigener Header" aus der Discovery-Matrix.

## Evidenz (FACT, Basis 85eda01)

- Katalog: `docs/blaupause/01-modulkatalog.md:128` — „F11.1 5 Tabs:
  Home (Dashboard/Agenda), Projects (Filter Typ/Status/Tag/Nutzer),
  Tasks, Calendar, More (AR, Chats, Sales Assistant)".
  CAPABILITY-MATRIX ohne F11-Zeile. `docs/parity/STATUS.md:139` F11 PARTIAL.
- Es existiert kein `app/w/[workspaceId]/layout.tsx` (einziger Layout-Fund
  unter `app/w` ist `rechnungen/layout.tsx`); 0 Treffer
  `BottomNav|bottom-nav|TabBar|tab-bar` in `app lib components`.
- Bestehende Workspace-Routen (`app/w/[workspaceId]/`): `anfragen`,
  `angebote`, `aufgaben`, `dashboard`, `einstellungen`, `kalender`,
  `katalog`, `plantafel`, `rechnungen`, `sites`.
- Agenda/Typ-/Status-Filter sind eigene Slices (PARTIAL in der Matrix);
  dieser Slice verlinkt nur bestehende Routen und baut keine Filter um.

## Vertrag

- Tab-Ziele (deutsche Labels, Routen Bestand außer `mehr`):
  - Home → `dashboard` (Dashboard/Agenda-Heimat).
  - Projekte → `anfragen` (Projekt-/Request-Board).
  - Aufgaben → `aufgaben`.
  - Kalender → `kalender`.
  - Mehr → `mehr` (NEU, Hub-Seite, s. unten).
- `mehr/page.tsx` verlinkt die übrigen bestehenden Bereiche mit
  Root-Seite (Angebote, Plantafel, Rechnungen, Sites, Katalog) als
  Liste mit je genau einem Link. Kein Einstellungen-Eintrag:
  `einstellungen/` hat keine Root-`page.tsx` (nur 19 Unterbereiche,
  per Sweep gegen alle 11 Linkziele belegt) — eine
  Einstellungs-Übersichtsseite ist eigener Slice-Scope.
  Keine Einträge für AR/Chats/Sales Assistant:
  Team-Chat ist ABSENT, AR/LiDAR nativ (`05-roadmap.md:56`), ein Sales
  Assistant existiert nicht — tote Links wären kein 1:1-Nachweis.
  F11.5 (Web-only: Angebotsbau, Rechnungen, …) bleibt unberührt; die
  Leiste verlinkt, sie baut nicht um.
- Darstellung: fixierte Leiste am unteren Rand, nur unterhalb des
  `md`-Breakpoints sichtbar (`md:hidden`), Inhalt erhält Abstand nach
  unten, damit nichts verdeckt wird. Aktiver Tab über Pfadpräfix mit
  `aria-current="page"` plus nicht-farblichem Signal (fett statt
  semibold), Touch-Ziele ≥ 44 px, 375 px ohne Überlauf.
- Technik: reines Server-Rendering plus ein Client-Anteil nur für den
  aktiven Pfad; keine Migration, keine neue Permission, keine
  Datenabfrage (reine Links). Ungültige `workspaceId` verhält sich wie
  bisher (Bestand entscheidet, kein neues 404-Verhalten durch das
  Layout); die Leiste selbst wird nur bei UUID-förmiger ID gerendert
  (`isWorkspaceIdForTabs`, unit-gepinnt), damit Fehlerseiten keine
  Navigation mit toten Zielen tragen.
- Kollisionsschutz: Es gibt keine bestehende w-weite Navigation; die
  Leiste ist das erste Element dieser Art. Seiten-eigene Header bleiben.

## Tests

- Unit: reine Tab-Konfiguration (`tabsForWorkspace(workspaceId)` →
  5 Einträge, exakte Labels + Pfade, deutscher Wortlaut) inkl.
  Aktiv-Erkennung (Präfix, kein Teilstring-Fehlmatch z. B.
  `/w/x/anfragen…` vs. `/w/x/angebote…`).
- DB: keine (keine Migration, keine Abfrage).
- Chromium-E2E `F11-05-E2E-01` (isolierter Workspace, Muster
  f11-03a/f7-04c): Leiste auf 375 px sichtbar mit 5 Tabs; jeder Tab
  navigiert zur Zielroute; aktiver Tab trägt `aria-current`; auf 1440 px
  ist die Leiste verborgen; Mehr-Seite listet 5 Links, alle Ziele
  antworten ohne 4xx/5xx nach Login; Axe A/AA; 0 Console-/Page-Errors.
- Regression: keine fachspezifische (additiv, kein Bestand angefasst);
  volles `test:e2e` läuft in der Lane-CI.

## Nicht Umfang

- Filter (Typ/Status/Tag/Nutzer) auf der Projekte-Seite, Agenda-Ansicht,
  Quick Actions (Slice 3), Offline-Verhalten der Leiste, Push/Install.
