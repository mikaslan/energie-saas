# F7.3 Checklisten-Vorlagen — Slice A: Template-CRUD + Anwendung am Projekt

Status: **SPECIFIED** · Lane: `codex/f7-03-checklist-templates` · Migration: 0053
Basis: Modulkatalog F7.3 (Checklisten-Vorlagen, BETA) · **OBSERVED**
Live-Sweep 2026-09-03 + Direkt-Proben (read-only GETs).

## 1. Discovery-Quellen (Clean Room)

- `GET /checklistTemplates` live: 1 Template, Felder `{id, name, description,
  active, position, targets, items, createdAt/By, updatedAt/By}`.
- Template-Items live (9 Stück): `{id, componentId, quantity, position,
  visibleToCustomer, priceOverridesComponent}` — **Komponenten-Referenzen**
  (BOM-artig), keine Freitext-Punkte.
- `GET /checklistTemplates/{id}` → gleiche Struktur (11 Keys).
- Die ANWENDUNG (Template → aktive Projekt-Checkliste) ist per API nicht
  beobachtbar → Mapping in Slice A als **ESTIMATE** gekennzeichnet.

## 2. Scope Slice A (vertikal)

1. **Template-CRUD** (`checklist_template`, Workspace): Name, Beschreibung,
   Position, `active`-Flag (Soft-Archiovierung), `targets` (String-Array,
   z. B. `["residential"]`), `items` (JSONB-Array, OBSERVED-Form:
   `{componentId, quantity, position, visibleToCustomer,
   priceOverridesComponent}`) — `componentId` referenziert den **eigenen
   Katalog** (`catalog_component`, M1-08a) und wird im Service validiert.
2. **Anwendung am Projekt (ESTIMATE-Mapping, DECIDED)**: `applyTemplate` legt
   die Projekt-Checkliste (F7.2) aus einer Vorlage an, sofern noch keine
   existiert (1:1-Conflict sonst): Block = Template-Name, ein Segment
   „Material", Items = `«Komponentenname» × quantity` (done=false). Reonic-
   Item-Typen (radio/image) bleiben Slice B; das Mapping ist als ESTIMATE
   markiert und wird nach Browser-Login-Beobachtung nachgeschärft.
3. **Berechtigungen**: Wiederverwendung `checklist.read`/`checklist.write`
   (Editor) — keine neuen Actions.
4. **UI**: Einstellungsseite `einstellungen/checklisten-vorlagen`
   (Liste/Anlegen/Bearbeiten/Archivieren) + „Aus Vorlage anlegen"-Auswahl
   auf der Projekt-Checklistenseite (F7.2).
5. **RLS**: M1-CRM-Muster (tenant_isolation + FORCE), ACL
   SELECT/INSERT/UPDATE an app_runtime, kein DELETE.

**Nicht in Slice A**: Radio-/Bild-Item-Typen, `priceOverridesComponent`-
Wirkung auf Angebote, Kundenportal-Sichtbarkeit, Vorlagen-Export.

## 3. Verträge

`checklist_template`:

| Feld | Typ | Regeln |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid FK → workspace | not null |
| name | text | 1–200, NFKC, keine Steuerzeichen (POSIX-Klasse) |
| name_normalized | text | lower/trim, partieller Unique-Index auf aktive |
| description | text nullable | ≤ 2000, NFKC, keine Steuerzeichen |
| position | integer | ≥ 0, default 0 |
| active | boolean | default true (Archivierung statt Löschen) |
| targets | jsonb | String-Array 0..20, je 1..100 |
| items | jsonb | Array 0..200, OBSERVED-Form (s. o.) |
| created_by/updated_by, created_at/updated_at | | Standard |

Service (`modules/checklists/templates.ts`):

```
listTemplates(ctx, { includeArchived }) → DTO[]
createTemplate / updateTemplate (Voll-Update wie F1.8) /
  archiveTemplate / restoreTemplate
applyTemplate(ctx, { templateId, projectId }) → Checklisten-DTO
  (Conflict bei bestehender Checkliste; NotFound bei unbekanntem Projekt/
  inaktiver Vorlage; Validierung der componentIds gegen den Katalog)
```

Fehler: NotFound/Conflict/Validation (Reuse der F7.2-Klassen).

## 4. Testmatrix

| ID | Test |
|---|---|
| F703-DB-01 | Template-CRUD happy path + Normalisierung/Sortierung |
| F703-DB-02 | Namenskollision aktiv; Name frei nach Archivierung |
| F703-DB-03 | Items-Validierung: unbekannte componentId, quantity-Grenzen, targets-Form |
| F703-DB-04 | applyTemplate: legt Checkliste an (ESTIMATE-Mapping), zweites Mal → Conflict |
| F703-DB-05 | Cross-Workspace-Isolation + Viewer schreib-blockiert |
| F703-E2E-01 | Editor: Vorlage anlegen, am Projekt anwenden, Checkliste entsteht |
| F703-E2E-02 | Viewer read-only beide Seiten |
| F703-JRN-01 | m111a-Journal: idx 53 / TOTAL 54 |

## 5. Nachweise

`npm run check` · Build · `db:generate` ohne Drift · Rollenproben · E2E
Chromium (F7.3-Grep) · Secret-Scan · Kimi-K3 Review Spec + Code.
