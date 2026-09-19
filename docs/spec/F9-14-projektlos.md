# F9-14 Projekt-optionale Zeiteinträge (Blaupause F9.1 „Projekt optional")

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2b-f9` · Migration: 0150
Basis: Modulkatalog F9.1 (`docs/blaupause/01-modulkatalog.md:116`):
„manueller Eintrag (Datum, Start/Ende, Pausen, Projekt optional,
Kommentar; >0 min, ≤24 h)". Matrix schweigt zu F9 (keine F9-Zeile).
Vorgänger: F9.1-CRUD, F9.2-Timer, F9-11 (workspace-weit), F9-13 (Widget).

## 1. Befund

`time_entry.project_id` und `time_entry_revision.project_id` sind
`NOT NULL` (`lib/db/schema/time-tracking.ts:57/176`); Composite-FK
`time_entry_project_fk (workspace_id, project_id)` mit MATCH SIMPLE
(NULL ist FK-seitig zulässig — kein FK-Umbau nötig). Projekt-unabhängig
bleiben: Running-Unique `(ws,userId) WHERE end_at IS NULL`
(0054:6), Tenant-RLS (0050), Billing-Service (0 project-Refs).
Projekt-gebunden sind: Create/Start-Guards (Projekt-Existenz),
`listTimeEntries`/`exportTimeEntries` (`projectId: string` Pflicht),
Revision-Copy (Service-Insert), Widget-Join (INNER JOIN project),
Outbox-Replay (`projectId` Pflicht), alle UI-Flächen (Seite ist
projekt-routiert `/anfragen/[projectId]/zeiterfassung` — projektlose
Einträge hätten keine Heimat).

## 2. ESTIMATE (reversibel, DECIDED)

1. **Migration 0150**: nur `DROP NOT NULL` auf beiden Spalten
   (+ Drizzle-Schema + Snapshot-Regenerat, Journal idx 150).
   Kein Backfill (Bestand hat überall Projekte), keine
   RLS-/Rollen-/Index-Änderung (NULL indexiert normal).
2. **Getrennte Reads statt Signatur-Umbau**: `listTimeEntries`
   und `exportTimeEntries` behalten `projectId: string`
   (Projektseiten unverändert, 11 DB-Testdateien unangetastet);
   neu `listProjectlessTimeEntries(tx, ctx, {Filter})` für
   `project_id IS NULL` (gleiche Filter-Semantik: Zeitraum,
   Typen, Nutzer, Archiv-Flag).
3. **UI-Heimat**: neue Workspace-Route für projektlose Einträge
   (Liste + Anlage + Stopp-Formular; Manager-Wiederverwendung
   mit nullablem Projekt in CONTRACTED fixieren). Projektseiten
   zeigen projektlose Einträge NICHT (strikte Trennung, kein
   Misch-Listen-Verhalten).
4. **Timer + manuell**: beide projektlos zulässig (gemeinsames
   Eintrags-Modell; Timer-Guards ausser Projekt-Check
   unverändert).
5. **Folge-Flächen**: Widget auf LEFT JOIN + Link-Fallback
   zur neuen Route bei `projectId NULL`; Abrechnungsläufe
   nehmen projektlose Einträge wie bisher auf (nur beendet +
   freigegeben — keine Sonderregel); F9-11-Mitglieds-Summen
   schliessen sie ein (Mitglieds-Sicht ist projektfrei),
   Slice-D-Projekt-Auslastung exkludiert sie. KEIN
   CSV-Export auf der projektlosen Route in F9-14 (s. §5).

## 3. Vertrag (Migration 0150)

1. **Schema**: `ALTER TABLE time_entry ALTER COLUMN project_id
   DROP NOT NULL` (+ Revision); `lib/db/schema` nachziehen;
   `db:generate` produziert Snapshot-Diff ohne Drift-Rest;
   Journal-Eintrag idx 150.
2. **Contract**: `projectId: z.string().uuid().nullable()` in
   Create-/Start-/Update-Commands; neue Query-Schemas für den
   projektlosen Read; DTOs mit `projectId: string | null`
   (Widget-DTO F9-13: `projectName` nullable + Link-Fallback).
3. **Service**: Projekt-Existenz-Guard nur bei gesetztem
   `projectId`; `listProjectlessTimeEntries` (requireRead);
   Revision-Copy übernimmt NULL; Stopp/Approve/Archive/Pausen
   id-basiert unverändert.
4. **UI**: neue Route + Anlageformular (ohne Projekt-Select) +
   Stopp-Formular; Widget-Null-Fall; 375-px- + Axe-Muster.
5. **Outbox**: Replay mit nullablem `projectId` (client_key-Guard
   unverändert).
6. **Explizit keine**: keine RLS-/Rollen-/Permission-Änderung;
   keine Billing-Logikänderung; keine Bestands-Umschreibung;
   kein XLSX; kein Subunternehmer.

## 4. Tests (TDD RED-first)

### 4.1 DB — `tests/db/f914-projectless-entries.test.ts` (neu)

- **F914-DB-01 create-list-separation**: projektlos anlegen →
  im projektlosen Read enthalten, im Projekt-Read des
  Workspaces NICHT (strikte Trennung beide Richtungen).
- **F914-DB-02 timer-without-project**: Timer ohne Projekt
  starten/stoppen; Running-Unique greift projektübergreifend
  (2. Timer trotz anderem/nullem Projekt → Conflict).
- **F914-DB-03 revision-copies-null**: Edit am projektlosen
  Eintrag → Revision mit `project_id NULL`, Verlauf lesbar.
- **F914-DB-04 widget-read-null-project**: laufender
  projektloser Timer → Widget-Read liefert Zeile mit
  `projectId/projectName NULL`.
- **F914-DB-05 validation-intact** (Guard-Erhalt, gruen
  bei RED wie GREEN): `projectId: "keine-uuid"` → ValidationError
  (nullable heisst nicht validierungsfrei); Create mit
  nicht-existentem UUID → ValidationError (FK-23503-Mapping,
  Bestand); Start mit nicht-existentem UUID → NotFoundError
  (expliziter Guard, Bestand).

### 4.2 E2E — `tests/e2e/f9-14-projectless.spec.ts` (neu)

Isolierter Workspace (F9-13-Muster, niemals W3):

- **F914-E2E-01**: projektlosen Eintrag auf neuer Route per UI
  anlegen → dort sichtbar, auf Projektseite unsichtbar →
  Timer projektlos starten → Widget sichtbar → Stopp dort.
- Viewports 375/768/1440 (kein Horizontal-Scroll),
  Axe ohne Violations, Console/Page-Errors leer.
- RED-first: Spec gegen Code ohne Migration/Route laufen
  lassen (Route 404 / Read fehlt → Fail), dann grün.

## 5. Bewusst offen / Nicht-Ziele (Follow-up-Slice)

- Keine Bearbeiten-/Archiv-/Freigabe-/Pausen-/Verlauf-UI auf
  der projektlosen Route (Service ist id-basiert bereit;
  Actions ausser create/start/stop lehnen projektlose
  Formulare fail-closed ab).
- Kein CSV-Export auf der projektlosen Route (CSV ist
  projektsäulen-frei — Variante ist trivial nachrüstbar,
  aber ungepinnt und ausserhalb des E2E-Vertrags).
- Keine Offline-Anlage projektloser Einträge (neue Route ist
  online-only; Outbox-Replay mit NULL ist service-seitig
  vorbereitet).
- Keine nachträgliche Projekt-Zuordnung („Eintrag ans Projekt
  hängen" — eigener Slice, braucht Move-Semantik + Audit).
- Keine projektlosen Abrechnungslauf-Sichten (Läufe listen
  Einträge id-basiert — reicht).
- Keine Portal-Sichtbarkeit projektloser Zeiten.
- Kein Subunternehmer (eigener Folge-Slice mit
  Geld-Domänen-Konzept + Reonic-Regel-Beleg).

## 6. Akzeptanz

- `npm run check` grün, `db:generate` nur mit 0150-Diff,
  DB-Suite (`f914` + Nachbarn) grün, E2E-Spec grün (CI),
  m111a-Pins auf 151/0150, Rollenvertrag ohne Delta
  (keine Funktions-/Trigger-Änderung erwartet).
- Projektlose Einträge sind anlegbar, sichtbar, stoppbar,
  revisioniert und widget-sichtbar — strikt getrennt von
  Projekt-Einträgen.
