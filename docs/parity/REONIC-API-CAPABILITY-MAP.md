# Reonic REST API v3 — API-Capability-Map

Stand: 2026-09-02 · Spec-Version: **3.11.0** · Quelle: `https://api.reonic.de/rest/v3/openapi`
Klassifikation: **DOCUMENTED (öffentliche OpenAPI-Spec)**. Es wurde **kein** API-Call mit einem Key ausgeführt; reine Spec-Analyse. Keine Reonic-Texte, Assets oder Werte werden als Produktinhalte übernommen.

Zweck: Mapping jedes dokumentierten v3-Endpunkts auf die F-Nummern des kanonischen
Modulkatalogs (`docs/blaupause/01-modulkatalog.md`), damit die Paritäts-Milestones
M1/M2/M3 gezielt gegen die real beobachtbare API-Oberfläche geplant werden können.

---

## 1. Eckdaten & Statistik

| Kennzahl | Wert |
|---|---|
| Dokumentierte Pfade | **124** (63 GET + 61 POST; keine PUT/PATCH/DELETE — Schreiben erfolgt über `POST …/create|update|delete`) |
| Mutationen gesamt | **61** = 23 create + 25 update + 12 delete + **1 export** |
| Reads | **63** GET |
| Schemas (`components.schemas`) | **97** |
| BETA-markierte Operationen | **40** |
| Deprecated Operationen | **2** (`GET /tasks/count`, `GET /tasks/tags`) |
| Tags (Ressourcen-Gruppen) | 31 (inkl. 2 reine Doku-Tags: „Migrating from API v2 to v3", „Changelog") |

### Auth & Key-Scopes (DOCUMENTED)

- Header: `X-Authorization` (apiKey), Wert = `rnc_v3_…`-Key.
- 3 Scopes, je Endpunkt dokumentiert über den Hinweis **„Allowed API keys"**:
  - `Read-only, Read and Write` → **62** GETs (alle reinen Reads) + `GET /me` (1, mit Zusatzscope).
  - `Read and Write` → **57** POST-Mutationen.
  - `Read and Write, Lead creation only` → **4** POSTs: `contacts/create`, `residentialProjects/create`, `commercialProjects/create`, `notes/create` (eigener „Lead-Creation"-Key-Typ).
- Read-only-Key kann alle 63 GETs ausführen (kein einziger GET verlangt „Read and Write").

### Antwort-Envelope & Betriebsregeln (DOCUMENTED)

- Listen sind paginiert und gewrappt: `{ data: [...], pagination: { page, perPage, total, next, prev } }`; `itemsPerPage` (Default 50, max 200).
- Create-Endpunkte antworten mit **201** (Response-Schema liegt unter `201`), Reads/Updates/Deletes mit **200**.
- `GET` wird bis 1 h gecacht; `Reonic-Cache-Control: no-cache` erzwingt frisches Lesen (zählt gegen den uncached-Bucket).
- Rate-Limits pro Client/Minute: `cached` 500, `uncached` 30 (Cache-Misses, no-cache-GETs, alle POSTs); Header `X-RateLimit-*`, `429` mit `Retry-After`.
- Fehlerform: `{ message }`, bei 400 zusätzlich `code` + `issues[]` + `errors` (`ValidationError`).
- HTTP: 400/401/403/404/429/500/503; 403 = Read-only-Key trifft Schreib-Endpunkt.

### Methoden-/Mutationsverteilung je Tag

| Tag | Pfade | GET | Mutation |
|---|---|---|---|
| Wiki | 10 | 3 | 7 |
| Tasks | 7 | 5 | 2 |
| Components | 6 | 4 | 2 |
| Activities | 6 | 3 | 3 |
| Photogrammetry | 6 | 2 | 4 |
| Residential Projects | 5 | 4 | 1 |
| Residential Project Offer Variants | 5 | 2 | 3 |
| Files | 5 | 2 | 3 |
| File Folders | 5 | 2 | 3 |
| Appointments | 5 | 2 | 3 |
| Time Tracking | 5 | 2 | 3 |
| Planning Packages | 5 | 2 | 3 |
| Offer Templates | 5 | 2 | 3 |
| Checklist Templates | 5 | 2 | 3 |
| Users | 4 | 2 | 2 |
| Commercial Projects | 4 | 2 | 2 |
| Tags | 4 | 2 | 2 |
| Notes | 4 | 2 | 2 |
| Contacts | 4 | 2 | 2 |
| Teams | 4 | 2 | 2 |
| Planning Templates | 4 | 2 | 2 |
| Checklists | 2 | 1 | 1 (export) |
| Lead Sources | 2 | 2 | 0 |
| Kanban Columns | 2 | 2 | 0 |
| Kanban Boards | 2 | 2 | 0 |
| Residential Project Payment Options | 1 | 1 | 0 |
| Residential Project Subsidies | 1 | 1 | 0 |
| Residential Project Signature Requests | 1 | 1 | 0 |
| Calendars | 1 | 1 | 0 |
| Calendar Categories | 1 | 1 | 0 |
| Me | 1 | 1 | 0 |
| Upload | 1 | 0 | 1 |
| Links | 1 | 1 | 0 |

> **Wichtig (Clean-Room):** Mutationen (create/update/delete/export) sind hier **nur
> dokumentiert**, nicht aufgerufen. Der im Projekt verifizierte Key ist read-only
> (siehe `COMPLIANCE-REONIC-API.md`).

### Legende Endpunkt-Tabellen

- **Mut.** = Mutationsart: `create` / `update` / `delete` / `export` / `—` (Read).
  Mutationen dürfen nie aufgerufen werden.
- **F-Mapping** = F-Nummer(n) aus `01-modulkatalog.md`; `NEU`/`Querschnitt` = kein direkter F-Match (Webhooks, Me, Upload, Links, User/Team-Verwaltung u. ä.).
- **Schema** = `Response → Request`-Schema (Response für 200/201; Listen-`data`-Wrapper weggelassen; `object` = inline/unbenanntes Schema, teils `{data: …}`-Wrapper).
- **Hinweise** = Sonder-Scope (Lead-creation-only), BETA, deprecated, wesentliche Query-Filter.
- Endpunkt-`parameters` (Pfad-/Query-/Header) sind der Spec entnommen; die Query-Filter der Listen-Endpunkte sind die für Parity relevanteste Dimension und unten kompakt angegeben.

---
## 2. Endpunkt-Mapping (tag-weise)

Spalten: **Mut.** = Mutationstyp, **F-Mapping** = F-Nummer(n), **Schema** = Response→Request, **Hinweise** = Sonder-Scope/BETA/deprecated/Query-Filter.

### Me

_F: NEU/Querschnitt — Identität/Auth: Workspace, User, API-Key_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /me` | — | NEU/Querschnitt | inline: clientId, clientName, locale, currency, accessLevel | Lead-only-Key |

### Contacts

_F: F1.1 — Kontaktverwaltung (inkl. UTM-/Integrations-Felder)_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /contacts` | — | F1.1 | object → — | Filter: email, phoneNumber, createdAt.gt, createdAt.lt, updatedAt.gt, updatedAt.lt, page, itemsPerPage, sort |
| `GET /contacts/{contactId}` | — | F1.1 | ContactDetail → — | — |
| `POST /contacts/create` | create | F1.1 | ContactDetail → ContactCreate | Lead-only-Key |
| `POST /contacts/{contactId}/update` | update | F1.1 | ContactDetail → object | — |

### Lead Sources

_F: F1.8 — Lead Sources_ · **2** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /leadSources` | — | F1.8 | object → — | Filter: projectDomain, archived |
| `GET /leadSources/{leadSourceId}` | — | F1.8 | LeadSource → — | — |

### Tags

_F: Querschnitt (Tags) — Labels für Projekte/Kontakte/Tasks_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /tags` | — | Querschnitt (Tags) | object → — | Filter: parentType, archived |
| `GET /tags/{tagId}` | — | Querschnitt (Tags) | Tag → — | — |
| `POST /tags/create` | create | Querschnitt (Tags) | Tag → object | — |
| `POST /tags/{tagId}/update` | update | Querschnitt (Tags) | object | — |

### Kanban Boards

_F: F1.5 — Kanban-Boards_ · **2** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /kanbanBoards` | — | F1.5 | object → — | Filter: projectDomain, projectStage, archived |
| `GET /kanbanBoards/{boardId}` | — | F1.5 | KanbanBoard → — | — |

### Kanban Columns

_F: F1.5 — Kanban-Spalten_ · **2** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /kanbanColumns` | — | F1.5 | object → — | Filter: boardId, archived |
| `GET /kanbanColumns/{columnId}` | — | F1.5 | KanbanColumn → — | — |

### Residential Projects

_F: F1.2–F1.6 · F2.1 · F7.1 — Ein Datensatz Request→Offer→Installation_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /residentialProjects` | — | F1.4 · F1.5 · F2.1 (Liste über alle Stages) | object → — | Filter: stage, dealState, archived, tagIds, leadSourceIds, kanbanBoardIds, kanbanColumnIds, customerNumber, contactId, projectCreatedAt.gt, projectCreatedAt.lt, requestCreatedAt.gt, requestCreatedAt.lt, offerCreatedAt.gt, offerCreatedAt.lt, installationCreatedAt.gt, installationCreatedAt.lt, updatedAt.gt, updatedAt.lt, page, itemsPerPage, sort |
| `GET /residentialProjects/{projectId}` | — | F1.3 · F1.4 · F2.1 (Detail: building/heatLoad/subsidies/…) | ResidentialProjectDetail → — | — |
| `POST /residentialProjects/create` | create | F1.2 (API-Intake-Pfad) | ResidentialProjectDetail → object | Lead-only-Key |
| `POST /residentialProjects/{projectId}/update` | update | F1.3 · F1.4 · F1.6 · F2.1 (Stage/Deal/Kanban/offerNumber/closedAt) | ResidentialProjectDetail → object | — |
| `GET /residentialProjects/{projectId}/heatingLoad/roomWise` | — | F5.1 · F5.4 (Heizlast raumweise) | object → — | Filter: useReplacementRadiators |

### Residential Project Offer Variants

_F: F2.2 · F2.3 — Varianten + BOM_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /residentialProjects/{projectId}/variants` | — | F2.2 (Variantenliste) | object → — | — |
| `GET /residentialProjects/{projectId}/variants/{variantId}` | — | F2.2 · F2.3 (Variante + BOM-Zeilen, Marge) | ResidentialVariant → — | — |
| `POST /residentialProjects/{projectId}/variants/create` | create | F2.2 (BETA) | object | BETA |
| `POST /residentialProjects/{projectId}/variants/{variantId}/update` | update | F2.3 (BETA) | object | BETA |
| `POST /residentialProjects/{projectId}/variants/{variantId}/delete` | delete | F2.2 (BETA) | object → — | BETA |

### Residential Project Payment Options

_F: F2.5 — Zahlarten (BETA)_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /residentialProjects/{projectId}/paymentOptions` | — | F2.5 | object → — | BETA; Filter: offerVariantId |

### Residential Project Subsidies

_F: F2 (SubsidyLineItem) · F16.3 — Förderungen (BETA)_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /residentialProjects/{projectId}/subsidies` | — | F2 (SubsidyLineItem) · F16.3 | object → — | BETA; Filter: offerVariantId |

### Residential Project Signature Requests

_F: F2.8 — E-Signatur_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /residentialProjects/{projectId}/signatureRequests` | — | F2.8 | object → — | — |

### Commercial Projects

_F: F15.1 — 360B-Gewerbe_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /commercialProjects` | — | F15.1 | object → — | Filter: stage, dealState, archived, tagIds, leadSourceIds, kanbanBoardIds, kanbanColumnIds, customerNumber, contactId, projectCreatedAt.gt, projectCreatedAt.lt, requestCreatedAt.gt, requestCreatedAt.lt, offerCreatedAt.gt, offerCreatedAt.lt, installationCreatedAt.gt, installationCreatedAt.lt, updatedAt.gt, updatedAt.lt, page, itemsPerPage, sort, projectNumber, search, lastEditedAt.gt, lastEditedAt.lt |
| `GET /commercialProjects/{projectId}` | — | F15.1 | CommercialProjectDetail → — | — |
| `POST /commercialProjects/create` | create | F15.1 | object | Lead-only-Key; BETA |
| `POST /commercialProjects/{projectId}/update` | update | F15.1 | object | BETA |

### Notes

_F: F1.9 — Notizen_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /notes` | — | F1.9 | object → — | Filter: parentType, parentId, createdById, sort, page, itemsPerPage |
| `GET /notes/{noteId}` | — | F1.9 | object → — | — |
| `POST /notes/create` | create | F1.9 | Note → object | Lead-only-Key |
| `POST /notes/{noteId}/update` | update | F1.9 | object | — |

### Tasks

_F: F1.9 — Aufgaben_ · **7** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /tasks/tags` | — | F1.9 (deprecated) | object → — | deprecated |
| `GET /tasks/count` | — | F1.9 (deprecated) | object → — | deprecated; Filter: parentId, parentType |
| `GET /tasks` | — | F1.9 | object → — | Filter: parentType, parentId, dueAt.gt, dueAt.lt, completedAt.gt, completedAt.lt, assignedUserId, assignedTeamId, completed, page, itemsPerPage, sort |
| `POST /tasks/create` | create | F1.9 | object | BETA |
| `GET /tasks/{taskId}` | — | F1.9 | object → — | — |
| `POST /tasks/{taskId}/update` | update | F1.9 | object | BETA |
| `POST /tasks/{taskId}/delete` | delete | F1.9 | object → — | — |

### Files

_F: Querschnitt Dokumente · F7.8 · F10.2 — Dateien am Projekt/Kontakt_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /files` | — | Querschnitt Dokumente · F7.8 · F10.2 | object → — | Filter: parentType, parentId, createdById, createdByCustomer, page, itemsPerPage, sort |
| `GET /files/{fileId}` | — | Querschnitt Dokumente · F7.8 · F10.2 | File → — | — |
| `POST /files/create` | create | Querschnitt Dokumente · F7.8 · F10.2 | File → object | — |
| `POST /files/{fileId}/delete` | delete | Querschnitt Dokumente · F7.8 · F10.2 | object → — | — |
| `POST /files/{fileId}/update` | update | Querschnitt Dokumente · F7.8 · F10.2 | object | — |

### File Folders

_F: Querschnitt Dokumente — Ordner_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /fileFolders` | — | Querschnitt Dokumente | object → — | Filter: parentType, parentId |
| `GET /fileFolders/{folderId}` | — | Querschnitt Dokumente | FileFolder → — | — |
| `POST /fileFolders/create` | create | Querschnitt Dokumente | object | — |
| `POST /fileFolders/{folderId}/update` | update | Querschnitt Dokumente | object | — |
| `POST /fileFolders/{folderId}/delete` | delete | Querschnitt Dokumente | object → — | — |

### Activities

_F: Querschnitt Aktivitätshistorie — Activity-Feed + manuelle Aktivitäten_ · **6** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /activities` | — | Querschnitt Aktivitätshistorie | object → — | Filter: parentId, parentType, type, from, to, page, itemsPerPage |
| `GET /activities/manual` | — | Querschnitt Aktivitätshistorie | object → — | Filter: parentId, parentType, page, itemsPerPage |
| `GET /activities/manual/{activityId}` | — | Querschnitt Aktivitätshistorie | ManualActivity → — | — |
| `POST /activities/manual/create` | create | Querschnitt Aktivitätshistorie | ManualActivity → object | — |
| `POST /activities/manual/{activityId}/update` | update | Querschnitt Aktivitätshistorie | object | — |
| `POST /activities/manual/{activityId}/delete` | delete | Querschnitt Aktivitätshistorie | object → — | — |

### Time Tracking

_F: F9.1–F9.3 — Zeiterfassung (BETA)_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /timetracking/eventTypes` | — | F9.1–F9.3 | object → — | BETA; Filter: showArchived |
| `GET /timetracking` | — | F9.1–F9.3 | object → — | BETA; Filter: page, archived, userIds, eventTypeIds, parentId, parentType, startAt.gt, startAt.lt |
| `POST /timetracking/create` | create | F9.1–F9.3 | object | BETA |
| `POST /timetracking/{entryId}/update` | update | F9.1–F9.3 | object | BETA |
| `POST /timetracking/{entryId}/archive` | update | F9.1–F9.3 | TimetrackingEntry → object | BETA |

### Checklists

_F: F7.2 — aktive Checkliste am Projekt_ · **2** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /checklists/{projectId}` | — | F7.2 | Checklist → — | BETA |
| `POST /projects/{projectId}/checklist/export` | export | F7.2 · F7.7 (Checklist-PDF; generischer /projects/-Pfad) | PDF (binär) | — |

### Checklist Templates

_F: F7.3 — Checklisten-Vorlagen (BETA)_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /checklistTemplates` | — | F7.3 | object → — | BETA; Filter: target, active, includeAny |
| `GET /checklistTemplates/{checklistId}` | — | F7.3 | ChecklistTemplate → — | BETA |
| `POST /checklistTemplates/create` | create | F7.3 | ChecklistTemplate → object | BETA |
| `POST /checklistTemplates/{checklistId}/update` | update | F7.3 | object | BETA |
| `POST /checklistTemplates/{checklistId}/delete` | delete | F7.3 | object → — | BETA |

### Calendars

_F: F1.9 — Reonic-Kalender_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /calendars` | — | F1.9 | object → — | — |

### Calendar Categories

_F: F1.9 — Kalender-Kategorien_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /calendarCategories` | — | F1.9 | object → — | — |

### Appointments

_F: F1.9 — Termine_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /appointments` | — | F1.9 | object → — | Filter: calendarIds, residentialProjectId, commercialProjectId, start.gt, start.lt, end.gt, end.lt, page, itemsPerPage, sort |
| `GET /appointments/{appointmentId}` | — | F1.9 | object → — | — |
| `POST /appointments/create` | create | F1.9 | object | — |
| `POST /appointments/{appointmentId}/update` | update | F1.9 | object | — |
| `POST /appointments/{appointmentId}/delete` | delete | F1.9 | object → — | — |

### Components

_F: F16.1 — Komponentenkatalog_ · **6** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /components` | — | F16.1 | object → — | Filter: componentType, archived |
| `GET /components/{componentId}` | — | F16.1 | Component → — | — |
| `GET /components/{componentId}/versions` | — | F16.1 | object → — | — |
| `GET /components/{componentId}/versions/{versionId}` | — | F16.1 | Component → — | — |
| `POST /components/create` | create | F16.1 | Component → object | — |
| `POST /components/{componentId}/update` | update | F16.1 | Component → object | — |

### Planning Templates

_F: F16.2 — Planning Templates_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /planningTemplates` | — | F16.2 | object → — | Filter: target, inactive |
| `GET /planningTemplates/{templateId}` | — | F16.2 | PlanningTemplate → — | — |
| `POST /planningTemplates/create` | create | F16.2 | PlanningTemplate → PlanningTemplateCreate | — |
| `POST /planningTemplates/{templateId}/update` | update | F16.2 | object → PlanningTemplateUpdate | — |

### Planning Packages

_F: F16.2 — Pakete_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /planningPackages` | — | F16.2 | object → — | Filter: projectDomain, target, inactive, page, itemsPerPage |
| `GET /planningPackages/{packageId}` | — | F16.2 | PlanningPackage → — | — |
| `POST /planningPackages/create` | create | F16.2 | PlanningPackage → PlanningPackageCreate | — |
| `POST /planningPackages/{packageId}/update` | update | F16.2 | PlanningPackage → PlanningPackageUpdate | — |
| `POST /planningPackages/{packageId}/delete` | delete | F16.2 | object → — | — |

### Offer Templates

_F: F16.2 — Offer Templates_ · **5** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /offerTemplates` | — | F16.2 | object → — | BETA |
| `GET /offerTemplates/{offerTemplateId}` | — | F16.2 | OfferTemplate → — | BETA |
| `POST /offerTemplates/create` | create | F16.2 | OfferTemplate → object | BETA |
| `POST /offerTemplates/{offerTemplateId}/update` | update | F16.2 | object | BETA |
| `POST /offerTemplates/{offerTemplateId}/delete` | delete | F16.2 | object → — | — |

### Wiki

_F: Querschnitt Firmen-Wiki · F11.3 — Wiki (BETA)_ · **10** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /wiki` | — | Querschnitt Firmen-Wiki · F11.3 | object → — | BETA |
| `GET /wiki/pages/{pageId}` | — | Querschnitt Firmen-Wiki · F11.3 | [object Object],[object Object] → — | BETA |
| `POST /wiki/pages/create` | create | Querschnitt Firmen-Wiki · F11.3 | WikiPage → object | BETA |
| `POST /wiki/pages/{pageId}/update-content` | update | Querschnitt Firmen-Wiki · F11.3 | object | BETA |
| `POST /wiki/pages/{pageId}/update-details` | update | Querschnitt Firmen-Wiki · F11.3 | object | BETA |
| `POST /wiki/pages/{pageId}/delete` | delete | Querschnitt Firmen-Wiki · F11.3 | object → — | BETA |
| `POST /wiki/folders/create` | create | Querschnitt Firmen-Wiki · F11.3 | WikiFolder → object | BETA |
| `POST /wiki/folders/{folderId}/update` | update | Querschnitt Firmen-Wiki · F11.3 | object | BETA |
| `POST /wiki/folders/{folderId}/delete` | delete | Querschnitt Firmen-Wiki · F11.3 | object → — | BETA |
| `GET /wiki/search` | — | Querschnitt Firmen-Wiki · F11.3 | object → — | BETA; Filter: q |

### Photogrammetry

_F: F3.7 — Photogrammetrie (BETA)_ · **6** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /photogrammetry/jobs` | — | F3.7 | object → — | BETA; Filter: page, archived, status |
| `GET /photogrammetry/jobs/{jobId}` | — | F3.7 | PhotogrammetryJob → — | BETA |
| `POST /photogrammetry/jobs/create` | create | F3.7 | PhotogrammetryJob → object | BETA |
| `POST /photogrammetry/jobs/{jobId}/update` | update | F3.7 | object | BETA |
| `POST /photogrammetry/jobs/{jobId}/assets/add` | update | F3.7 | PhotogrammetryJob → object | BETA |
| `POST /photogrammetry/jobs/{jobId}/assets/delete` | delete | F3.7 | object | BETA |

### Users

_F: Querschnitt (Rechte/Org) — Workspace-Mitglieder_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /users` | — | Querschnitt (Rechte/Org) | object → — | Filter: archived, deleted |
| `GET /users/{userId}` | — | Querschnitt (Rechte/Org) | User → — | — |
| `POST /users/create` | create | Querschnitt (Rechte/Org) | object → UserCreate | — |
| `POST /users/{userId}/update` | update | Querschnitt (Rechte/Org) | object → UserUpdate | — |

### Teams

_F: Querschnitt (Teams) — Teams_ · **4** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /teams` | — | Querschnitt (Teams) | object → — | Filter: parentId, ancestorId, memberIds, archived |
| `GET /teams/{teamId}` | — | Querschnitt (Teams) | Team → — | — |
| `POST /teams/create` | create | Querschnitt (Teams) | Team → TeamCreate | — |
| `POST /teams/{teamId}/update` | update | Querschnitt (Teams) | object → TeamUpdate | — |

### Upload

_F: NEU/Querschnitt — Zweistufiger File-Upload_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `POST /uploads/create` | create | NEU/Querschnitt | object → — | — |

### Links

_F: NEU/Querschnitt — Deep-Link → Portal-URL_ · **1** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|
| `GET /links` | — | NEU/Querschnitt | inline: url | Filter: type, id, subPath |

### Webhooks

_F: NEU/Querschnitt — Nur Doku/Portal-Konfig — keine API-Endpunkte_ · **0** Operation(en)

| Methode + Pfad | Mut. | F-Mapping | Schema | Hinweise |
|---|---|---|---|---|

### Webhooks

Kein eigener Endpunkt unter `paths`. Webhooks werden **im Reonic-Portal konfiguriert** (Settings → API/Developers → Webhooks). Die Spec dokumentiert nur das Lieferformat (prosa): JSON-POST mit `version/type/occurredAt/data` (dünne Payloads, nur IDs, kein Snapshot), Signatur `X-Reonic-Signature = sha256=` + HMAC-SHA-256 über `${timestamp}.${rawBody}`, Retry-Plan (1 min, 5 min, 30 min, 2 h, 5 h, 12 h, 1 d, 2 d), Idempotenz über `X-Reonic-Event-Id`. → **NEU/Querschnitt** (F: »API/Integrationen«, Webhooks + Delivery-Log).

## 3. Schemas (`components.schemas`), gruppiert nach Domäne

Nur Struktur (Feldnamen), keine Werte. `*` = required-Feld. `Detail`-Schemas erweitern ihr Basis-Schema über `allOf`.

### Querschnitt (Envelope/Fehler)

- `Pagination` — 2 Felder: data*, pagination*
- `ValidationError` — 4 Felder: message*, code*, issues*, errors*

### Contacts

- `Contact` — 14 Felder: id*, fullName*, firstName*, lastName*, salutation*, primaryEmail*, secondaryEmail*, mobile*, phone*, phoneReachability*, address*, createdAt*, updatedAt*, deletedAt*
- `ContactDetail` — = `Contact` + zusätzlich: commercialProjectIds, residentialProjectIds, marketingConsent, marketingConsentText, marketingConsentDataProtectionLink, utm, integrations
- `ContactCreate` — 14 Felder: firstName*, lastName*, salutation, primaryEmail, secondaryEmail, mobile, phone, phoneReachability, address, marketingConsent*, marketingConsentText, marketingConsentDataProtectionLink, utm, integrations
- `ContactReference` — 1 Felder: id*

### Users & Teams

- `User` — 11 Felder: id*, fullName*, firstName*, lastName*, email*, phone*, role*, isExternal*, imageUrl*, archivedAt*, deletedAt*
- `UserCreate` — 7 Felder: firstName*, lastName*, email*, phone, role*, isExternal, sendWelcomeEmail
- `UserUpdate` — 3 Felder: role, isExternal, archived
- `Team` — 9 Felder: id*, name*, description*, parentId*, leaderIds*, memberIds*, createdAt*, updatedAt*, archivedAt*
- `TeamCreate` — 5 Felder: name*, description, parentId, leaderIds, memberIds
- `TeamUpdate` — 6 Felder: name, description, parentId, leaderIds, memberIds, archived

### Residential Project

- `ResidentialProject` — 23 Felder: id*, name*, stage*, latLng*, address*, customerContact*, customerNumber*, customerMessage*, keyAccountManagerId*, kanbanPlacements*, kanbanBoardId*, kanbanColumnId*, primaryOfferVariantId*, leadSourceId*, tagIds*, deal*, projectCreatedAt*, requestCreatedAt*, offerCreatedAt*, installationCreatedAt*, updatedAt*, archivedAt*, primaryOfferVariant*
- `ResidentialProjectDetail` — = `ResidentialProject` + zusätzlich: customerContact, offerVariantIds, assignedUserIds, assignedTeamIds, customerPortalUrl, closedAt, requestedPackages, existingSystems, building, heatLoad, offerNumber, meterNumber, targetSignatureDate, subsidies, variantIds, signatureRequests, integrations
- `KanbanPlacement` — 2 Felder: boardId*, columnId*
- `KanbanPlacementInput` — 2 Felder: boardId*, columnId
- `DealSetOpen` — 1 Felder: state*
- `DealSetWon` — 2 Felder: state*, notes
- `DealSetLost` — 3 Felder: state*, lostReason*, notes

### Offer-Varianten & BOM

- `ResidentialVariant` — 7 Felder: id*, name*, isPrimary*, totalPrice*, totalPriceOverride*, systems*, optionalBundles*
- `Price` — 3 Felder: net*, gross*, vat*
- `VariantSystem` — 2 Felder: price*, lineItems*
- `VariantLineItem` — 15 Felder: componentId*, componentVersionId*, componentType*, name*, brand*, articleNumber*, gtin*, quantity*, visibleToCustomer*, unitSalesPrice*, totalSalesPrice*, unitPurchasePrice*, totalPurchasePrice*, purchasePriceOverridden*, margin*
- `VariantOptionalBundle` — 6 Felder: id*, name*, description*, selected*, price*, lineItems*

### Zahlarten (Payment Options)

- `ResidentialProjectPaymentOption` — 4 Felder: id*, offerVariantId*, type*, parts*
- `ResidentialProjectPaymentOptionPart` — oneOf: ResidentialProjectPaymentOptionPartCash, ResidentialProjectPaymentOptionPartFinancing, ResidentialProjectPaymentOptionPartLease
- `ResidentialProjectPaymentOptionPartCash` — 9 Felder: type*, id*, appliesTo*, netBeforeRebates*, rebates*, totalNet*, totalVat*, vatBreakdown*, totalGross*
- `ResidentialProjectPaymentOptionPartFinancing` — 14 Felder: type*, id*, appliesTo*, netBeforeRebates*, rebates*, totalNet*, totalVat*, vatBreakdown*, totalGross*, durationMonths*, durationYears*, providerName*, monthlyPayment*, yearlyPayment*
- `ResidentialProjectPaymentOptionPartLease` — 8 Felder: type*, id*, appliesTo*, durationMonths*, durationYears*, vatMode*, monthlyPayment*, yearlyPayment*
- `ResidentialProjectPaymentOptionRebate` — oneOf: ResidentialProjectPaymentOptionAbsoluteRebate, ResidentialProjectPaymentOptionPercentageRebate
- `ResidentialProjectPaymentOptionAbsoluteRebate` — 4 Felder: type*, description*, deductedNet*, basisNet*
- `ResidentialProjectPaymentOptionPercentageRebate` — 5 Felder: type*, description*, rate*, deductedNet*, basisNet*

### Subventionen

- `ResidentialSubsidy` — oneOf: ResidentialSubsidyAbsolute, ResidentialSubsidyPercentage, ResidentialSubsidyTaxDeduction
- `ResidentialSubsidyAbsolute` — 7 Felder: type*, id*, offerVariantId*, name*, internalDescription*, customerDescription*, amount*
- `ResidentialSubsidyPercentage` — 9 Felder: type*, id*, offerVariantId*, name*, internalDescription*, customerDescription*, rate*, maximumAmount*, appliesTo*
- `ResidentialSubsidyTaxDeduction` — 8 Felder: type*, id*, offerVariantId*, name*, internalDescription*, customerDescription*, durationYears*, basis*
- `SubsidyTaxDeductionBasisAbsolute` — 2 Felder: type*, amount*
- `SubsidyTaxDeductionBasisPercentage` — 2 Felder: type*, rate*

### E-Signatur

- `ResidentialProjectSignatureRequest` — 13 Felder: id*, projectId*, status*, offerDocuments*, signedVariantId*, signedPaymentOptionId*, signedPdfUrl*, revocationPdfUrl*, createdAt*, expiresAt*, signedAt*, withdrawnAt*, revokedByCustomerAt*

### Commercial Project

- `CommercialProject` — 25 Felder: id*, name*, stage*, latLng*, address*, customerContact*, customerNumber*, customerMessage*, keyAccountManagerId*, kanbanPlacements*, kanbanBoardId*, kanbanColumnId*, primaryOfferVariantId*, leadSourceId*, tagIds*, deal*, projectCreatedAt*, requestCreatedAt*, offerCreatedAt*, installationCreatedAt*, updatedAt*, archivedAt*, type*, companyName*, projectNumber*
- `CommercialProjectDetail` — = `CommercialProject` + zusätzlich: customerContact, offerVariantIds, assignedUserIds, assignedTeamIds, customerPortalUrl, closedAt

### Notes & Tasks

- `Note` — 9 Felder: id*, parent*, text*, createdAt*, createdById*, editedAt*, editedById*, pinnedAt*, pinnedById*
- `TaskListItem` — 15 Felder: id*, title*, description*, parent*, checklist*, createdAt*, createdById*, dueAt*, reminderAt*, completedAt*, completedById*, completionNote*, assignedUserIds*, assignedTeamIds*, tagIds*
- `TaskDetail` — = `TaskListItem` + zusätzlich: checklist

### Files

- `File` — 12 Felder: id*, name*, type*, url*, parent*, folderId*, sharedWithTeamIds*, sharedWithUserIds*, position*, visibleInCustomerPortal*, createdAt*, createdById*
- `FileFolder` — 7 Felder: id*, name*, description*, parent*, visibleInCustomerPortal*, createdAt*, createdById*

### Activities

- `Activity` — 8 Felder: id*, type*, associatedType*, associatedId*, parentId*, parentType*, createdAt*, createdById*
- `ManualActivity` — 10 Felder: id*, type*, outcome*, note*, parentId*, parentType*, createdAt*, createdById*, updatedAt*, updatedById*

### Time Tracking

- `TimetrackingEntry` — 19 Felder: id*, trackingId*, userId*, createdAt*, createdById*, updatedAt*, updatedById*, archivedAt*, startAt*, endAt*, workingTimeMinutes*, breakDurationMinutes*, breaks*, comment*, typeId*, type*, parentId*, parentType*, parentName*
- `TimetrackingEventType` — 6 Felder: id*, name*, position*, textColor*, backgroundColor*, archivedAt*

### Checklists

- `Checklist` — 4 Felder: version*, updatedAt*, updatedById*, blocks*
- `ChecklistTemplate` — 11 Felder: id*, name*, description*, active*, position*, targets*, items*, createdAt*, createdById*, updatedAt*, updatedById*

### Kanban

- `KanbanBoard` — 7 Felder: id*, name*, description*, projectDomain*, projectStage*, columns*, archivedAt*
- `KanbanColumn` — 5 Felder: id*, name*, boardId*, position*, archivedAt*

### Tags & Lead Sources

- `Tag` — 8 Felder: id*, label*, parentType*, textColor*, backgroundColor*, createdAt*, updatedAt*, archivedAt*
- `LeadSource` — 6 Felder: id*, name*, projectDomain*, createdAt*, updatedAt*, archivedAt*

### Planning/Packages/Offer Templates

- `PlanningTemplate` — 10 Felder: id*, name*, description*, active*, targets*, items*, createdAt*, createdById*, updatedAt*, updatedById*
- `PlanningTemplateCreate` — 5 Felder: name*, description, active, targets*, items
- `PlanningTemplateUpdate` — 5 Felder: name, description, active, targets, items
- `PlanningTemplateCatalogItemInput` — 6 Felder: componentSource*, componentId*, quantity*, visibleToCustomer, salesPrice, vatRate
- `PlanningTemplateCustomItemInput` — 8 Felder: componentSource*, componentType, name*, description, quantity*, visibleToCustomer, salesPrice*, vatRate*
- `PlanningPackage` — 7 Felder: id*, name*, description*, active*, projectDomains*, target*, items*
- `PlanningPackageCreate` — 6 Felder: name*, description, active, target*, projectDomains, items
- `PlanningPackageUpdate` — 5 Felder: name, description, active, projectDomains, items
- `PlanningPackageCatalogItemInput` — 6 Felder: componentSource*, componentId*, quantity*, visibleToCustomer, salesPrice, vatRate
- `PlanningPackageCustomItemInput` — 8 Felder: componentSource*, componentType, name*, description, quantity*, visibleToCustomer, salesPrice*, vatRate*
- `OfferTemplate` — 13 Felder: id*, name*, description*, position*, active*, targets*, solarPackageId*, batteryStoragePackageId*, evChargerPackageId*, heatPumpPackageId*, optionalPackageId*, additionalPackageId*, updatedAt*

### Wiki

- `WikiPage` — 10 Felder: id*, title*, icon*, isPublished*, position*, folderName*, createdAt*, updatedAt*, createdBy*, updatedBy*
- `WikiFolder` — 4 Felder: id*, name*, position*, pages*

### Photogrammetry

- `PhotogrammetryJob` — 16 Felder: id*, name*, status*, assets*, gltfFileUrl*, orthophotoFileUrl*, coordinateFileUrl*, createdAt*, createdById*, updatedAt*, updatedById*, startedAt*, startedById*, stoppedAt*, preRenderCompletedAt*, archivedAt*

### Components (Katalog)

- `Component` — oneOf über 25 konkrete Typen (Diskriminator `componentType`): ComponentModule, ComponentInverter, ComponentMicroinverter, ComponentOptimizer, ComponentVirtualBattery, ComponentBatteryStorage, ComponentEvCharger, ComponentHeatPump, ComponentAirHeatPump, ComponentHotWaterHeatPump, ComponentHeatingStorage, ComponentHotWaterStorage, ComponentHeatingRod, ComponentRadiator, ComponentIndoorUnitAirHeatPump, ComponentAccessoryToEvCharger, ComponentAccessoryToHeatPump, ComponentAccessoryToModule, ComponentAccessoryToInverter, ComponentAccessoryToBatteryStorage, ComponentOther, ComponentModuleFrameConstruction, ComponentServiceFee, ComponentInstallationFee, ComponentMcsMountingSystem
- Alle 25 Typen teilen 20 identische Felder: id, versionId, name, description, brand, articleNumber, gtin, salesPrice, vatRate, purchasePrice, quantityUnit, imageUrl, datasheetUrl, warrantyUrl, instructionsUrl, createdAt, updatedAt, archivedAt, componentType, attributes
- `ComponentVersionInfo` — 3 Felder: versionId*, createdAt*, createdById*

## 4. Paritäts-Relevanz je Milestone

### M1 — CRM & Leads (F1.x)

Vollständig abgedeckt durch die API: **Contacts** (F1.1), **Lead Sources** (F1.8), **Tags**, **Kanban Boards/Columns** (F1.5), **Residential Projects** inkl. `create` (F1.2, API-Intake) und `update` (F1.3/F1.4/F1.6), **Notes** + **Tasks** (F1.9), **Users/Teams** (Assignees), **Appointments/Calendars** (F1.9), **Activities** (Aktivitätshistorie), **Commercial Projects** als Gewerbe-Leads (F15.1). `POST /residentialProjects/create` und `POST /contacts/create` sind explizit per »Lead-creation-only«-Key nutzbar (Broker-Intake-Äquivalent zu F1.2).

### M2 — Angebote & Signatur (F2.x)

API bildet den **Angebots-/Varianten-Kern** ab: **Residential Project Offer Variants** (F2.2/F2.3 — Variante + BOM-Zeilen inkl. EK/Marge), **Payment Options** (F2.5), **Subsidies** (F2/SubsidyLineItem), **Signature Requests** (F2.8), **Components** (F16.1, Katalog für die Stückliste), **Planning Templates/Packages** und **Offer Templates** (F16.2). Wichtig: Varianten-CRUD ist erst ab 3.10.0 vorhanden und BETA; E-Signatur ist nur **lesbar** (kein API-Create eines Signatur-Links — der geht über das Portal).

### M3 — Rechnungen (F8.x)

**Keinerlei Rechnungs-Endpunkte in der REST v3.** Es gibt weder `invoices` noch Beleg-/Teilrechnungs-/Gutschrift-Ressourcen, keinen Zahlungsstatus, keinen DATEV/Steuerberater-Export, kein Zahlungs-PDF. → F8 ist **nicht** über die API referenzierbar; der einzige API-nahe Geld-Bezug ist `deal.totalPriceOverride` am Projekt. M3 muss daher gegen Portal-/Doku-Verhalten geplant werden, nicht gegen die API.

### In der API fehlende Produktbereiche (wichtig für den Parity-Freeze)

Nicht über REST v3 exponiert: **F4 Simulation** (nur Ergebnis-Felder lesbar), **F6 Schaltplan**, **F8 Rechnungen**, **F10 Kundenportal-Inhalte**, **F12 Energiehaus-Funnel**, **F13 Service-Marktplatz/Filing** (Netzanmeldung, KfW, Finanzierung, Factoring), **F14 KI-Schicht**, **F2.7 PDF-Engine**, **F3 3D-Editor** (keine Roofs/Strings/Panels), **F5 Heizlast-Schreiben** (nur ein Read: `heatingLoad/roomWise`), **F11 Mobile-App**. Die API ist also ein CRM/Angebots-/Betriebs-Subset, kein 1:1-Abbild des Gesamtprodukts.

## 5. Offene Fragen / UNKNOWNs

- **Webhooks**: keine Endpunkte; Payload-Schemas nur als Prosa, nicht als OpenAPI-Schema. Konkrete Event-Typ-Liste und `data`-Felder → UNKNOWN (aus Doku-Beschreibung ableitbar, hier nicht vollständig transkribiert).
- **Enum-Werte** (stage `request/offer/installation`, Deal-Zustände, `componentType`, Activity-Typen, Note-/Task-`parentType`, Signatur-Status, Checklist-Item-Typen) sind teils in der Spec als `enum` dokumentiert, hier aber nicht einzeln transkribiert — bei Bedarf maschinell extrahierbar (DOCUMENTED, nicht INFERRED).
- **Export-Endpunkt** `POST /projects/{projectId}/checklist/export` liefert PDF (binär); Response-Schema in der Spec nur `object` — exakte Struktur UNKNOWN (bewusst nicht aufgerufen, Mutation).
- **E-Signatur schreiben**: Signatur-Requests sind nur lesbar; ob/wie ein Signatur-Link per API erzeugt wird → UNKNOWN (vermutlich Portal-only, F2.8).
- **Heizlast (F5)**: nur raumweises Read existiert; LiDAR/Raummodell-Schemata (Story/Room/Wall, DIN EN 12831) sind **nicht** in der Spec → Bestätigung, dass F5-Schreiben portal-/app-seitig liegt.
- **Deprecations mit Ablaufdaten** (aus Changelog, `x-sunset`): `variantIds`, `primaryOfferVariant`, variant-level `price`/`totalPrice*`, `kanbanBoardId/kanbanColumnId`, `signatureRequests`-Feld, `durationYears`, Task-`parentId/parentType`-Body, `/tasks/count`, `/tasks/tags` — exakte Removal-Daten sind in der Spec hinterlegt (nicht alle hier gelistet).
- **Key-Scope-Zuordnung »Lead creation only«**: welche Mutationen genau unter diesem Scope liegen (4 create-Endpunkte) ist DOCUMENTED; ob weitere Lead-Schreibpfade (z. B. `files/create`, `tasks/create` für Leads) dazu zählen → nicht explizit markiert, als UNKNOWN zu führen.
- **v2-Abschaltung**: Changelog nennt »1 Oct« als v2-Ende; exaktes Datum/Jahr im Intro nicht als Maschinenwert → UNKNOWN (nur für Migrationskontext relevant).
- **`/uploads/create` + `PUT uploadUrl`**: zweistufiger Upload ist die einzige Stelle, an der die Spec einen direkten `PUT` (außerhalb von `paths` als uploadUrl) vorsieht — der Upload-Endpunkt selbst ist POST; der PUT auf die signierte URL ist Teil des beschriebenen Flows, nicht als eigener Pfad modelliert.
