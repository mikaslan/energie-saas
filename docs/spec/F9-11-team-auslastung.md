# F9-11 Workspace-Team-Auslastung (intern, read-only)

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: off `origin/codex/m1-wave-02` (keine Migration).
Vorgänger: F9.1 (CRUD), F9.2 (Stoppuhr), F9.3 (`userIds`-Filter),
F9.4-D (Projekt-Auslastung), F9-09 (Zeitraum + Ereignistyp).
Katalog: F9.3-Rest „Team-Ansichten, Auslastungs-Dashboards"
(Modulkatalog M9, `docs/blaupause/01-modulkatalog.md` Z. 118).

## Befund

`getTimeUtilization` (`modules/time-tracking/service.ts`, Z. 1200–1244)
ist strikt projektgebunden (`projectId` Pflicht, Query =
`timeEntryListQuerySchema`): Die Projektleitung sieht pro Projekt, wer
wie viele Minuten gebucht hat — aber nicht, wer workspace-weit
ausgelastet ist. Wer in drei Projekten je 2 Stunden bucht, erscheint
nirgends mit 6 Stunden. Die Blaupause F9.3 nennt „Team-Ansichten,
Auslastungs-Dashboards" als Portal-/Team-Sicht; gebaut ist nur die
Projekt-Sektion („Auslastung" in `time-entry-manager.tsx`, Z. 844–872).
F9-11 hebt dieselbe Aggregation auf Workspace-Ebene: eine interne,
rein lesende Team-Seite, kein Portal, keine Abrechnung.

## ESTIMATE (reversibel)

- Neue Service-Funktion `getWorkspaceTimeUtilization(tx, ctx,
  { userIds?, startDate?, endDate? })` in
  `modules/time-tracking/service.ts` — gleiche Aggregations-Logik wie
  `getTimeUtilization` (je `user_id`: `entryCount`, Summe gestoppter
  Minuten, `running`-Flag), aber ohne `projectId` (Filter nur
  `workspace_id` + optionale Filter). Reiner Lese-Pfad, keine Migration
  (nur `SELECT` auf `time_entry` + Member-Label-Join wie bisher), keine
  neue Permission (`time.read`), kein Provider (keine Karte, kein
  Kalender-Sync, keine XLSX-Lib).
- Contract in `lib/integrations/time-tracking/contract.ts`: Query
  `workspaceTimeUtilizationQuerySchema` (`userIds` max 50 UUIDs
  nullish, `startDate`/`endDate` Kalendertag `YYYY-MM-DD` mit
  `startDate <= endDate`, `calendarDaySchema` wiederverwendet; KEIN `projectId`,
  KEIN `includeArchived` — Archiv ist fix ausgeschlossen, kein Toggle);
  Zeilen-/DTO-Shape = bestehende `timeUtilizationRowDtoSchema` /
  `timeUtilizationDtoSchema` wiederverwendet (kein neuer Dialekt).
  Sortierung wie F9.4-D: Summe absteigend, `userId` aufsteigend.
- UI: neue Workspace-Seite
  `app/w/[workspaceId]/team-auslastung/page.tsx` (kein neues
  Verzeichnis unter `anfragen/` — die Sicht ist projektübergreifend).
  Layout-ESTIMATE: Filterformular (GET, Mitglieder + Zeitraum) oben,
  Tabelle darunter; Spalten Mitglied / Einträge / Summe / Status wie
  F9.4-D. Route und Spalten sind ESTIMATE (kein Reonic-Live-Beleg für
  die Darreichung), die Filter-Semantik ist Pin (F9.3/F9-09).

## Vertrag

`getWorkspaceTimeUtilization(tx, ctx, value)`:

- Gate zuerst: `requireRead(ctx)` (`time.read`, `minRole: viewer`,
  `internalOnly: true` — `lib/permissions.ts` Z. 95). Viewer liest,
  Externe (`external_only`) erhalten `PermissionDeniedError`, nie
  Teildaten. UI fängt das wie die Projektseite auf `DeniedState`
  (`page.tsx`-Muster, Permission-Gate VOR jedem Lookup).
- Query-Validierung via `workspaceTimeUtilizationQuerySchema`;
  ungültig → `TimeTrackingValidationError` (fail-closed). `userIds`:
  F9.3-Semantik (fehlend/`[]`/`null` = kein Filter; nicht-leer =
  `IN`-Liste via `sql.join`, max 50; Schnittmenge mit bekannten
  Workspace-Usern leer → leeres Ergebnis, kein Fehler, kein Leak).
- Archiv: `archived_at is null` fix (kein `includeArchived`-Parameter —
  das Dashboard zeigt aktive Auslastung; F9.4-D-Default verhärtet).
- Laufende Einträge (`end_at is null`, `working_time_minutes is null`):
  zählen in `entryCount`, fallen aus `sum()` (NULL-Semantik, kein
  Sondercode), setzen `running: true` (`bool_or`). Belegte Zeilen
  erscheinen auch bei Summe 0 (nur-laufender Nutzer → Zeile mit
  „läuft", F9.4-D-Muster).
- Zeitraum: F9-09-Muster, `(start_at at time zone 'Europe/Berlin')::date`
  in `[startDate, endDate]` (eintägig erlaubt, nur `startDate` oder nur
  `endDate` = offene Grenze). Ohne Datum = unbegrenzt (kein stiller
  Default-Monat).
- Member-Labels via `listTimeMemberOptions` (gleicher Read-Pfad,
  E-Mail-Label, Limit 200); fehlendes Mitglied → `"Unbekannt"`
  (F9.4-D-Muster, kein Orakel über Fremd-User).
- Keine Migration (reines `SELECT`/`GROUP BY` auf `time_entry`, gleiche
  Tabelle wie F9.4-D), keine neue Permission, kein Provider (kein
  Portal-Resolver, keine Karten-/Kalender-Dependency, keine XLSX-Lib).
  `db:generate` bleibt drift-frei.

## UI

- Neue Seite `/w/[workspaceId]/team-auslastung` (Server-Komponente nach
  Projektseiten-Muster: `routeParamsSchema` nur `workspaceId`,
  `authorizedQuery(workspaceId, "time.read", "time_tracking", …)`,
  `NotAuthenticatedError` → Login-Redirect mit `next`,
  `PermissionDeniedError` → `DeniedState`).
- Filter (GET-Formular, Muster `UserFilterForm` + F9-09-Datumsfelder):
  Mitglieder-Multi-Select (Checkboxen aus `listTimeMemberOptions`,
  Auswahl-Cap 50 clientseitig, Server-Validation authoritative) +
  Von/Bis-Datumsfelder (`YYYY-MM-DD`, ungültig → tolerant leer wie
  Listen-Muster, Service bleibt strikt) + Reset-Link (leert alles).
- Tabelle Mitglied / Einträge / Summe (`formatDuration`-Muster:
  „2 Std. 0 Min.") / Status („läuft" / „—"), gleiche Section-Optik wie
  F9.4-D. Leere Menge → „Keine Einträge im Filter." (gleicher Wortlaut,
  kein toter Tabellenkopf).
- Breakpoints 375 / 768 / 1440 ohne horizontales Scrollen (Zellen
  umbrechen), Axe-Prüfung (`AxeBuilder`-Muster der Repo-E2E,
  z. B. `m1-09-project-assignment.spec.ts`) auf der Seite.

## Tests

- DB `tests/db/f911-workspace-utilization.test.ts` (Muster
  `f904d-time-utilization.test.ts`: eigener Workspace per `randomUUID`,
  Editor + Zweit-Editor + Viewer + Extern, zwei Projekte im selben
  Workspace): (a) Aggregation über Projekte (90 Min Projekt A + 60 Min
  Projekt B desselben Mitglieds → eine Zeile, 150 Min);
  WYSIWYG-Pin: Workspace-Summe = Σ `listTimeEntries.totalWorkingMinutes`
  je Projekt bei gleichem Filter (eigene Test-Aussage); (b) laufender
  Eintrag zählt nicht, markiert „läuft"; archivierte zählen nicht;
  `userIds`-Filter treu (ein Nutzer → eine Zeile; nur-fremde UUID →
  leer); Zeitraumfilter (Berlin-Tage: Eintrag außerhalb → raus,
  Grenzeintrag → drin); (c) Viewer lesen ok / Extern denied
  (`PermissionDeniedError`); Sortierung Summe absteigend.
- E2E `tests/e2e/f9-11-team-auslastung.spec.ts`: EIGENER isolierter
  Workspace per `randomUUID` + Membership-Insert (F16-14-Muster),
  NIEMALS W3 — der Read ist workspace-weit, W3-Projekte wuerden
  fremde Spec-Eintraege mitsummieren (F9.4-D-Projektmuster greift
  hier NICHT, dort sind Reads projektgebunden). Zwei Projekte im
  Isolations-Workspace per DB-Fixture seeden (Projektanlage ist
  F1/F12-Flaeche), je ein Eintrag per UI in beiden
  Projekten (90 + 60), Team-Seite zeigt Mitglied + „2 Std. 30 Min.";
  Nutzerfilter blendet Zweitmitglied aus; Viewports 375/768/1440 +
  Axe; keine Browser-Fehler. RED-first: Spec und DB-Cases werden vor
  der Implementierung rot gefahren.
- Regression: F9.4-D-DB/E2E und F9-09-Nachbarn grün (kein
  Behavior-Change an `getTimeUtilization`/`listTimeEntries`).

## Nicht-Ziele / Bewusst offen

- Kein Portal-Resolver (keine Kunden-/Externen-Sicht auf Auslastung;
  Portal-Contract kennt heute keine Zeitdaten — verifiziert; Externe
  bleiben per `internalOnly` draußen).
- Kein XLSX (nur Leseseite; CSV-Export bleibt projektgebunden F9.4-A;
  kein Excel-Writer, keine neue Dependency).
- Keine Subunternehmer-Abrechnung (kein Rechnungs-Bezug, keine
  Fremdfirmen-Kennzeichnung — eigener Abrechnungs-Slice).
- Keine Wochen-/Monats-Aggregation (nur Zeitraumfilter + Summe je
  Mitglied; keine Kalenderwochen-Gruppierung, kein Chart).
- Kein Freigabe-/Abrechnungsstatus je Zeile (F9-05/F9-07 bleiben
  Projekt-Sichten), keine Anonymisierung (Leser sehen E-Mail-Labels
  bereits heute via Member-Options).
- Kein Ereignistyp-Filter (nur Mitglieder + Zeitraum; Typ-Aufschlüsselung
  bleibt Listen-/Export-Sache F9-09).

## Offene Punkte

- Routenname `team-auslastung` ist ESTIMATE (Alternative:
  `zeiterfassung/team`); ohne Gegenstimme gilt der Spec-Name.
- Ob die Seite später in `dashboard/` verlinkt wird, entscheidet der
  Dashboard-Slice (kein Link-Zwang hier).
