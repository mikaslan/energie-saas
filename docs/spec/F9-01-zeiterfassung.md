# F9 Zeiterfassung — Slice A: Event-Typen + Projekt-Zeiteinträge

Status: **SPECIFIED** · Lane: `codex/f9-01-time-tracking` · Migration: 0050
Basis: Modulkatalog F9.1–F9.3 · **OBSERVED**: Reonic OpenAPI 3.11.0
(Schemata `TimetrackingEntry`, `TimetrackingEventType`) + Live-Sweep
2026-09-03 (`GET /timetracking/eventTypes` → 4 Einträge mit realen Daten:
id, name, position, textColor, backgroundColor, archivedAt).

## 1. Discovery-Quellen (Clean Room)

- `TimetrackingEventType`: id, name, position, textColor, backgroundColor,
  archivedAt — vollständig beobachtet.
- `TimetrackingEntry`: id, trackingId, userId, createdAt/By, updatedAt/By,
  archivedAt, startAt, endAt, workingTimeMinutes, breakDurationMinutes,
  breaks[], comment, typeId, type, parentId, parentType, parentName.
- `parentType` kann beliebige Objekte referenzieren (Projekt, Aufgabe, …);
  Slice A unterstützt **nur `project`** (Filter `parentId, parentType` der
  API deckt genau diesen Fall ab).

## 2. Scope Slice A (vertikal)

1. **Event-Typen** (`time_event_type`, Workspace-Stammdaten): Name,
   Position, Text-/Hintergrundfarbe (Hex), Soft-Delete (`archived_at`).
   CRUD analog F1.8 Lead-Sources (bewährtes Muster).
2. **Zeiteinträge** (`time_entry`): manuell am Projekt erfasst —
   `user_id` (Erfasser), `project_id` (parentType = project), `type_id`
   (nullable), `start_at`, `end_at`, `working_time_minutes`,
   `break_duration_minutes`, `comment`; Soft-Delete; Audit + Events.
3. **Berechtigungen**: `time.read` (Viewer) / `time.write` (Editor).
4. **UI**:
   - `Einstellungen/ereignistypen`: Liste/Anlegen/Bearbeiten/Archivieren.
   - Projektseite `anfragen/[projectId]/zeiterfassung`: Liste (Summe der
     Arbeitsminuten, archivierte ausgeblendet), Formular anlegen,
     Einträge bearbeiten/archivieren.

**Nicht in Slice A**: laufende Stoppuhr (trackingId/offene startAt),
Pausen-Segmente (breaks[]), Einträge an Aufgaben (`parentType != project`),
Fremdnutzer-Zuordnung (`userIds`-Filter), CSV-Export.

## 3. Verträge

### 3.1 Datenvertrag

`time_event_type` (Workspace): id, workspace_id FK, name (1–120, unique je
Workspace unter AKTIVEN Typen — partieller Index wie F1.8), name_normalized,
position (int ≥ 0, default 0), text_color/background_color (#RRGGBB, nullable),
archived_at, created_at, updated_at.

`time_entry`: id, workspace_id FK, user_id FK → user_identity, project_id FK,
type_id FK → time_event_type (nullable), start_at timestamptz NOT NULL,
end_at timestamptz NOT NULL (CHECK end_at ≥ start_at, beide finite),
working_time_minutes int NOT NULL (0–1440), break_duration_minutes int NOT NULL
default 0 (0–1440, ≤ working_time_minutes), comment text nullable (≤ 500,
trim/NFKC, keine Steuerzeichen — Muster project_loss_reason_text_ck),
archived_at, created_by, updated_by, created_at, updated_at.

### 3.2 Berechtigungen

| Action | minRole | capability | internalOnly |
|---|---|---|---|
| `time.read` | viewer | — | ja |
| `time.write` | editor | — | ja |

### 3.3 Service (`modules/time-tracking`)

```
listEventTypes(ctx, { includeArchived }) → DTO[]
createEventType / updateEventType / archiveEventType / restoreEventType
listTimeEntries(ctx, { projectId, includeArchived }) → DTO[]
createTimeEntry(ctx, { projectId, typeId?, startAt, endAt,
  workingTimeMinutes, breakDurationMinutes, comment? }) → DTO
updateTimeEntry(ctx, { id, ...Felder }) → DTO
archiveTimeEntry(ctx, { id }) → DTO
```

Fehler: NotFound/Conflict/Validation; Permission über `hasPermission`.
DTO: Zeiten als ISO-Strings, Summe `totalWorkingMinutes` in der Liste.

### 3.4 RLS/ACL

M1-CRM-Muster (wie contact/project/project_task): RLS + FORCE mit
permissiver `tenant_isolation` über `app.workspace_id`; Service-Layer-
Rechte; ACL SELECT/INSERT/UPDATE an app_runtime, kein DELETE.

## 4. Testmatrix

| ID | Test |
|---|---|
| F901-DB-01 | Event-Typ CRUD happy path + Normalisierung/Position |
| F901-DB-02 | Event-Typ Namenskollision aktiv; Name frei nach Archivierung |
| F901-DB-03 | Zeiteintrag create/list/update/archive + Summe |
| F901-DB-04 | Validierung: end < start, Minuten-Grenzen, Pause > Arbeitszeit, unbekannter Typ/Projekt |
| F901-DB-05 | Cross-Workspace-Isolation + Viewer schreib-blockiert |
| F901-DB-06 | Projekt-FK: Eintrag nur für eigenes Workspace-Projekt |
| F901-PERM-01 | permissions 37 → 39 Actions |
| F901-E2E-01 | Editor: Typ anlegen, Eintrag am Projekt erfassen, Summe, archivieren |
| F901-E2E-02 | Viewer: read-only beide Seiten |
| F901-JRN-01 | m111a-Journal: idx 50 / TOTAL 51 |

## 4b. Kimi-Review-Befunde (alle geschlossen)

- P1-1: toggleArchived lief auf `lead_source.write`/`lead_source` (Copy-Paste)
  → `time.write`/`time_tracking`.
- P1-2: datetime-local-Zeitzone — naiver Wert wird als UTC geparst
  (`…:00Z`) und um den mitgelieferten Browser-Offset korrigiert; E2E
  prüft die gerenderte Uhrzeit (08:00–10:00 Round-Trip).
- P2-1: Längen-/Steuerzeichen-Refines NACH NFKC-Transform (Zod/DB-symmetrisch).
- P2-2: Anzeige löst gegen ALLE Typen auf (archivierte bleiben benannt);
  Edit-Select führt den archivierten Alt-Typ als disabled Option.
- P2-3: DB-CHECK-Tests (Farbe, Steuerzeichen-Kommentar), Update-Validierung,
  E2E Typ-Archivierung.
- P3-1: Anführungszeichen korrigiert. P3-2: toter Parameter entfernt.
- P3-3: Timestamps kommen als Strings aus dem tx-Layer (bewährtes
  F1.8-Muster, grüne DB-Suite belegt es; kein Datums-Parser nötig).
- P3-4: crafted File-typeId → invalid. P3-5: created_by/updated_by ohne FK
  = Codebase-Muster (einzige Ausnahme catalog_import_job); dokumentiert.

## 5. Nachweise

`npm run check` · `npm run build` · `db:generate` ohne Drift · Rollenproben ·
E2E Chromium (F9.1-Grep) · Secret-Scan · Kimi-K3 Review Spec + Code.
