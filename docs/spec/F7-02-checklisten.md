# F7.2 Checklisten — Slice A: Projekt-Checkliste mit Blocks/Segmenten/Items

Status: **SPECIFIED** · Lane: `codex/f7-02-checklists` · Migration: 0051
Basis: Modulkatalog F7.2 (aktive Checkliste am Projekt) · **OBSERVED**
Live-Sweep 2026-09-03 + Direkt-Proben 2026-09-04 (read-only GETs).

## 1. Discovery-Quellen (Clean Room)

- `GET /checklists/{projectId}` live: Envelope `{version, updatedAt,
  updatedById, blocks[]}` — beobachtet: 3 Blocks mit `{id, name, position,
  backgroundColor, textColor, versionHash, segments[]}`; Segmente mit
  `{id, name, position, Farben, versionHash, completedAt, completedById,
  items[]}`; Items beobachtet als `type ∈ {description, title, radio, image,
  …}`, `title`, `description?`, `required?`, `items?` (Radio-Optionen).
- `GET /checklistTemplates` live: `{id, name, description, active, position,
  targets[], items[]}` — Template-Items referenzieren Katalog-Komponenten
  (`{id, componentId, quantity, position, visibleToCustomer,
  priceOverridesComponent}`).

## 2. Scope Slice A (vertikal)

1. **Projekt-Checkliste** (`project_checklist`): eine aktive Checkliste je
   Projekt mit `version` (CAS) und `blocks` als JSONB-Snapshot.
   - Struktur (OBSERVED-Teilmenge, DECIDED): `blocks[]` mit
     `{name, position, segments[]}`, Segmente mit `{name, position,
     items[]}`, Items mit `{title, done:boolean}`.
   - Reonic-Item-Typen (`radio`/`image`/`description`) sind **Slice B**
     (ESTIMATE-Vermerk); Slice A führt `title` + Erledigt-Status.
2. **Service**: `getProjectChecklist` (Leer-Checkliste, wenn keine Zeile —
   Read-Semantik wie F4.6), `saveProjectChecklist` (CAS über `baseVersion`:
   Insert bei 0, Update bei match, sonst Conflict), Items togglen über Save.
3. **Berechtigungen**: `checklist.read` (Viewer) / `checklist.write`
   (Editor), internalOnly.
4. **UI**: Projektroute `anfragen/[projectId]/checkliste` — Blocks als
   Karten, Segmente als Gruppen, Items als Checkboxen, Fortschritt
   (erledigt/gesamt), Speichern mit Versionskonflikt-Hinweis.
5. **RLS**: M1-CRM-Muster (tenant_isolation + FORCE), ACL
   SELECT/INSERT/UPDATE an app_runtime, kein DELETE.

**Nicht in Slice A**: Checklisten-Vorlagen (F7.3, eigene Lane), Item-Typen
radio/image/description, Komponenten-Referenzen in Items, Checklist-PDF
(F7.7), Kundenportal-Sichtbarkeit.

## 3. Verträge

`project_checklist`:

| Feld | Typ | Regeln |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid FK → workspace | not null |
| project_id | uuid FK → project (Komposit) | not null, unique je Projekt (1:1) |
| version | integer | 1..2^31-1, CAS |
| blocks | jsonb | validiert durch Service-Zod; DB-CHECK `jsonb_typeof = 'array'` |
| created_by / updated_by | uuid | Codebase-Muster ohne FK (wie time_entry) |
| created_at / updated_at | timestamptz | Standard |

Blocks-Validierung (Service, ESTIMATE-Form): Array 0..50; Block
`{name 1..200, position ≥ 0, segments 0..100}`; Segment
`{name 1..200, position ≥ 0, items 0..500}`; Item
`{title 1..500, done boolean}`. NFKC + keine Steuerzeichen; keine
erfundenen Inhalte (leere Checkliste startet leer).

### Service-Signatur (`modules/checklists`)

```
getProjectChecklist(ctx, projectId) → DTO (leer bei keiner Zeile)
saveProjectChecklist(ctx, { projectId, baseVersion, blocks }) → DTO
  (baseVersion 0 → Insert; sonst CAS-Update; 0 Zeilen → NotFound/Conflict)
```

DTO: `{schemaVersion, projectId, version, blocks, updatedAt,
permissions.canWrite}`; Fehler `ChecklistNotFoundError`,
`ChecklistConflictError`, `ChecklistValidationError`.

## 4. Testmatrix

| ID | Test |
|---|---|
| F702-DB-01 | Leer-Read (keine Zeile) + Insert + CAS-Update + Stale-Konflikt |
| F702-DB-02 | Blocks-Validierung (Form, Längen, Steuerzeichen, done-Typ) |
| F702-DB-03 | 1:1 je Projekt (zweites Insert → Konflikt), Cross-Workspace-Isolation |
| F702-DB-04 | Viewer read, write blockiert; External fail-closed |
| F702-PERM-01 | permissions 39 → 41 Actions |
| F702-E2E-01 | Editor: Items anlegen/togglen/speichern, Reload persistiert, Fortschritt |
| F702-E2E-02 | Viewer read-only; External „Zugriff eingeschränkt" |
| F702-JRN-01 | m111a-Journal: idx 51 / TOTAL 52 |

## 5. Nachweise

`npm run check` · Build · `db:generate` ohne Drift · Rollenproben · E2E
Chromium (F7.2-Grep) · Secret-Scan · Kimi-K3 Review Spec + Code.
