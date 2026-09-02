# M1-15 — Termine und Kalender (F1.9)

- Status: **DISCOVERED → SPECIFIED** · noch nicht CONTRACTED/RED/IMPLEMENTED
- Datum: 2026-09-02
- F-Bezug: **F1.9** (Modulkatalog „Aufgaben … Kalender (4 Scopes) … E-Mail …
  Notizen … Duplikat-Triage“) — **Termine & Kalender**. Der Slice-Auftrag nennt
  „F1.13 Termine und Kalender“; der Modulkatalog kennt kein F1.13 (F1.x endet
  bei F1.9) → Diskrepanz-Hinweis §0.2 und offene Frage O1.
- Architektur: **ADR 0021**
- Basis-Branch: `01b52e9` (M1-12a „Globale Aufgaben-Inbox“, HEAD
  `codex/m1-12a-global-task-inbox`)
- Geplante Migration: **`0043_m1_15_appointments_calendar.sql`** (nächste freie
  Nummer nach `0039_m1_11a_project_outcome.sql` am Basis-Branch; parallele
  Lanes belegen `0040`=M1-11b, `0041`=M1-13, `0042`=M1-14)
- Ziel: keine — dieser Slice ist reine Spezifikation (Branch `tooling`, nur Doku).

## 0. Quellenlegende

| Kürzel | Quelle | Rolle |
|---|---|---|
| `AMAP` | `docs/parity/REONIC-API-CAPABILITY-MAP.md`, Z. 309–335 | Appointments/Calendars/CalendarCategories-Operationen (F1.9) |
| `OAS` | `/tmp/reonic-openapi.json` (öffentliche OpenAPI `3.11.0`, neu geladen per `curl -sL https://api.reonic.de/rest/v3/openapi`) | maschinenprüfbare Extraktion der Pfade/Schemas/enums/„Allowed API keys“/BETA-Marker |
| `M113` | `docs/spec/M1-13-projektnotizen.md` | Struktur-/Stil-Vorlage (Projekt-Entity, DTO-Minimierung, Gates) |
| `M114` | `docs/spec/M1-14-kontaktdatensatz.md` | Struktur-/Stil-Vorlage (Gap-Analyse, DECIDED-Tabelle) |
| `M110` | `lib/db/schema/project-task.ts` (Basis-Worktree `01b52e9`) | Drizzle-Tabellen-/Constraint-/Index-/Assignee-Muster |
| `M109` | `lib/db/schema/project-assignment.ts` (Basis-Worktree) | membership-basierte Zuweisungs-Muster (M1-09) |
| `M110SVC` | `modules/tasks/service.ts` (Basis-Worktree) | Service-/Contract-/Lock-/RLS-/`emitEvent`+`writeAudit`-Muster |
| `ERASURE` | `lib/db/schema/erasure.ts` + `drizzle/0027_m1_07_gdpr_erasure.sql` | `ErasureGraphIds`, `erase_inactive_lead` |
| `ADR 0021` | `docs/adr/0021-termine-kalender.md` | Architekturentscheidungen M1-15 |

> **Evidenz-Klassifikation (Goal-Prompt §7):** `OBSERVED` (rechtmäßig
> beobachtet), `DOCUMENTED` (öffentliche Spec/Doku), `INFERRED`, `DECIDED`
> (bewusste Eigenentscheidung), `UNKNOWN`, `CONFLICTING`. **Es wurde kein
> API-Call mit Key ausgeführt** — nur die öffentliche OpenAPI-Spec geparst;
> keine Reonic-Texte, Assets oder Werte werden als Produktinhalt übernommen.

### 0.1 Migrationsnummern-Kette am Basis-Branch `01b52e9`

`… → 0036_m1_08b_catalog_import → 0037_m1_09_project_assignment →
0038_m1_10_project_task → 0039_m1_11a_project_outcome` (letzte am Basis-Branch).
M1-11b (`0040`), M1-13 (`0041`), M1-14 (`0042`) sind parallel reserviert
[INTEGRATION-PLAN-M1-WAVE-01]. M1-15 nimmt daher **`0043`**; Integration in der
Reihenfolge `0040 → 0041 → 0042 → 0043`.

### 0.2 F-Nummern-Diskrepanz (CONFLICTING, ungeglättet)

Der Modulkatalog bündelt Aufgaben/Kalender/Notizen/E-Mail unter **F1.9** und
hat **kein** F1.13. Der Slice-Auftrag spricht von „F1.13 Termine und Kalender“.
Diese Spec nutzt **F1.9** als kanonischen F-Bezug (API-Map und Modulkatalog
decken Termine/Kalender unter F1.9) und führt „F1.13“ nur als Auftragslabel;
Bestätigung durch den Root → O1.

---

## 1. Nutzerergebnis (JTBD)

Ein interner **Editor oder Admin** hält in der **Projektakte** Termine fest und
pflegt sie: **erstellen**, **editieren** (Titel, Zeitfenster, Typ, Ort,
Beschreibung, Teilnehmer) und **löschen**. Der Termin hängt an genau einem
Projekt und trägt ein Zeitfenster (`start`/`end`, Zeitzone `Europe/Berlin`,
optional ganztägig), einen Typ und eine Liste interner Teilnehmer. Eine
**Kalender-Ansicht** (Monat/Woche/Liste, FullCalendar) zeigt die Termine des
Projekts; interne **Viewer** sehen sie read-only. External-/Worker-/Fremdtenant-
Akteure bleiben fail-closed. Jede Änderung erzeugt in **derselben Transaktion**
ein Activity-Event **und** eine `audit_log`-Zeile; das Löschen ist ein echtes
Löschen (API-treu), die Historie bleibt über Event/Audit erhalten.

M1-15 erzeugt **keinen** von der Projektakte getrennten Kalender-Bereich und
**kein** workspaceweites Kalender-Objekt (keine `calendar`-Tabelle, keine
Team-/User-/Mandanten-Kalender-Scopes): Alle Termine und die Kalender-Ansicht
leben ausschließlich in der Projektakte (ADR 0021, Entscheidung 2).

## 2. Öffentliche Clean-Room-Evidenz (DOCUMENTED)

### 2.1 API-Operationen

Die öffentliche OpenAPI `3.11.0` dokumentiert für die Tags **Appointments**,
**Calendars** und **Calendar Categories** genau **7 Operationen**:

| Methode + Pfad | Mut. | Request | Response | „Allowed API keys“ |
|---|---|---|---|---|
| `GET /appointments` | — | Query: `calendarIds` (uuid[], 1–100, kommasepariert/wiederholt), `residentialProjectId`/`commercialProjectId` (uuid, **mutually exclusive**), `start.gt`/`start.lt` (date-time), `end.gt` (Default **now** → nur kommende), `end.lt`, `page` (≥1, Default 1), `itemsPerPage` (1–200, Default 50), `sort` (Felder `start`,`end`; Default `start`; `-feld` absteigend), Header `Reonic-Cache-Control` | 200 `{ data: Appointment[], pagination }` | Read-only, Read and Write |
| `GET /appointments/{appointmentId}` | — | Pfad `appointmentId` (uuid), Header `Reonic-Cache-Control` | 200 `{ data: Appointment }` | Read-only, Read and Write |
| `POST /appointments/create` | create | Body `additionalProperties:false`; **required** `calendarId`, `title`, `start`, `end`, `allDay`; optional `customerPortalTitle`, `description`, `customerPortalDescription`, `visibleInCustomerPortal` (Default `false`), `attendeeIds` (uuid[], maxItems 100), `location`, `residentialProjectId`/`commercialProjectId` (mutually exclusive) | 201 `Appointment` | **Read and Write** |
| `POST /appointments/{appointmentId}/update` | update | Pfad `appointmentId`; Body `additionalProperties:false`, **alle Felder optional** („Omit fields to leave them untouched, send `null` to clear them“); **kein** `calendarId` (nicht änderbar) | 200 `Appointment` | **Read and Write** |
| `POST /appointments/{appointmentId}/delete` | delete | Pfad `appointmentId` | 200 `{ data: { id } }` | **Read and Write** |
| `GET /calendars` | — | Header `Reonic-Cache-Control` | 200 `{ data: Calendar[] }` (**ohne** Pagination) | Read-only, Read and Write |
| `GET /calendarCategories` | — | Header `Reonic-Cache-Control` | 200 `{ data: CalendarCategory[] }` (**ohne** Pagination) | Read-only, Read and Write |

### 2.2 API-Schemas (inline — keine benannten `components.schemas`)

`Appointment` (14 Properties; **13 davon** im Response-`required`): `id`* (uuid),
`calendarId`* (uuid), `title` (string, Default `""` — im Response **nicht**
required, im Create-Body **required** minLength 1), `customerPortalTitle`*
(string\|null), `description`* (string\|null), `customerPortalDescription`*
(string\|null), `visibleInCustomerPortal`* (bool), `start`* (date-time),
`end`* (date-time), `allDay`* (bool), `location`* (string\|null),
`residentialProjectId`* (uuid\|null), `commercialProjectId`* (uuid\|null),
`attendeeIds`* (uuid[]).

`Calendar` (8 Felder, **alle required**): `id`*, `name`*, `color`* (Hex,
string\|null), `categoryId`* (uuid\|null), `userId`* (uuid\|null), `teamId`*
(uuid\|null), `type`* (enum `Team | Tenancy | User | Client`), `active`* (bool).

`CalendarCategory` (3 Felder, **alle required**): `id`*, `name`*, `order`*
(integer, „Lower values come first“).

Create-/Update-Body-Limits: `title`/`customerPortalTitle`/`location`
minLength 1, maxLength 2000; `description`/`customerPortalDescription`
minLength 1, maxLength 5000; `attendeeIds` maxItems 100; `allDay`-Semantik:
bei `true` zählen nur die Datumsanteile, „end must be at least one full day
after start“; bei `false` exakte Datetimes.

### 2.3 Entscheidende Befunde (OAS) → sie treiben die Spec

1. **Kein Typ- und kein Erinnerungsfeld.** `Appointment` hat **kein**
   `type`-Enum und **kein** Reminder-Feld. Der einzige `type`-Enum der Domäne
   ist `Calendar.type = Team|Tenancy|User|Client` (die „4 Scopes“). → Termin-Typ
   ist `DECIDED WMEE` (ADR 0021 E3); Erinnerung ist ohnehin Nichtziel.
2. **Inline statt benannte Schemas.** Für Appointments/Calendars/
   CalendarCategories existieren **keine** `components.schemas` (anders als
   `Contact`/`Note`/`Task`); alle Objekte sind inline an den Pfaden definiert.
3. **Delete ist echt.** `POST /appointments/{id}/delete` liefert `{data:{id}}`;
   das Schema hat **kein** `deletedAt` → Hard-Delete (ADR 0021 E4), im
   Gegensatz zu Notes (M1-13, kein API-Delete → Soft-Delete).
4. **Kategorie hat keine Farbe.** `CalendarCategory = {id, name, order}`; die
   Farbe (`color`, Hex) liegt am `Calendar`. → `calendar_category` ohne
   `color`-Spalte (ADR 0021 E1).
5. **Keine BETA-Marker.** Appointments/Calendars/CalendarCategories sind **nicht**
   BETA (anders als Tasks/Time Tracking/Checklists/Wiki/Photogrammetry).
6. **`calendarId` ist Pflicht, die Projektverknüpfung optional.** Termine hängen
   API-seitig am Kalender (required) und optional (nullable, mutually exclusive)
   an `residentialProjectId`/`commercialProjectId`. M1-15 kollabiert den
   Kalender-Scope auf das Projekt (ADR 0021 E2) — `calendarId` wird nicht
   repliziert (`ACCEPTED_EXCEPTION`).
7. **Kalender/Kategorien sind un-paginiert** (`{data:[]}` ohne `pagination`),
   Termine sind paginiert mit reichem Filter (Zeitfenster, Projekt, Kalender).
8. **Appointment trägt keine Zeitstempel/`createdBy`** im Schema (im Gegensatz
   zu Note/Task). Unsere `created_at`/`updated_at`/`revision`/`created_by` sind
   deshalb `DECIDED WMEE`-Hausmuster (wie `project_task`), keine API-Form.

### 2.4 Repo-Realität (FullCalendar-Versionen)

`package.json` installiert `@fullcalendar/react@7.0.2` **neben**
`@fullcalendar/core`/`daygrid`/`timegrid`/`list`/`interaction@6.1.21`. Prüfung
`node_modules`: `@fullcalendar/react@7.0.2` deklariert `@fullcalendar/core@7.0.2`
(und `@full-ui/headless-calendar@7.0.2`) als Abhängigkeit; `@fullcalendar/daygrid@6.1.21`
verlangt `@fullcalendar/core@~6.1.21`. Das ist ein **harter Major-Konflikt**
(zwei `core`-Linien) → vor RED Pflicht-Pin auf **eine** konsistente Linie
(empfohlen `6.1.x` durchgängig; ADR 0021 E5). Ohne Pin ist der Kalender nicht
lauffähig bzw. doppelt gebundelt.

## 3. Capability-Sheet (Goal-Prompt §7)

### 3.1 Gemeinsamer Liefervertrag

- **Modul:** CRM (F1). **Tenant-/Owner-Scope:** Workspace + Project
  (`workspace_id`-Composite-Schlüssel, FORCE-RLS wie Bestand).
- **Akteur/Rolle:** interner Viewer read-only (`appointment.read`); interner
  Editor/Admin mutierend (`appointment.write`, `internalOnly`); `external_only`,
  Worker, Auth, System und Fremdmandant fail-closed.
- **Route/Oberfläche:** Projektakte `/w/[workspaceId]/anfragen/[projectId]`,
  Sektion „Termine“ mit FullCalendar (Monat/Woche/Liste) + Termin-Dialog;
  Server-Actions, keine öffentliche REST-API.
- **Notifications:** nur lokale `aria-live`-Ergebnisse; keine externe
  Mail/Push (Erinnerung ist Nichtziel).
- **Loading/Empty/Error/Success/Disabled/Denied:** echte getrennte Zustände;
  Empty („Noch keine Termine“), Disabled (fehlende Rechte/stale Revision),
  Denied (External/Fremdmandant, ohne Existenz-Leak), Error (Projektions-/
  Konfliktfehler an die Error Boundary; Eingabefehler als ehrliches
  `invalid`/`not_found`).
- **Desktop/Tablet/Mobile:** responsive 320/375/390/768/1024/1440/1920,
  400-%-Reflow, kein Seiten-Overflow, Touchziele ≥ 44 px; FullCalendar
  Month/DayGrid adaptiert, List-Ansicht als Mobile-Fallback.
- **Keyboard:** vollständiger Pfad (Erstellen/Editieren/Löschen, Termin öffnen,
  Ansicht wechseln) ohne Maus; FullCalendar-A11y-Modus aktiv.
- **Offline:** kein Offline-Schreibversprechen; sicherer Online-Fehlerzustand.
- **Paritätsstatus:** FUNCTIONAL (eigenständige Ausgestaltung, API als
  Referenz); kein Anspruch auf private Reonic-Interna.
- **Confidence:** Liste/Zeitfenster/Delete/Scope = `DOCUMENTED`; Typ/
  Zeitzone/Kategorie-Kollaps/Zeitstempel = `DECIDED WMEE`.
- **Owner:** Root; UI-/Test-Lanes mit unabhängigen Abschlussprüfungen.
- **Letzte Prüfung:** 2026-09-02 (Discovery/Spec; noch nicht implementiert).

### 3.2 Feingranulare Capabilities

| ID / F-Nr. | Job, Trigger, Happy Path | Eingaben / Validierungen | Zustand / Nebenwirkung | Recht / Daten / Event | Tests | Status |
|---|---|---|---|---|---|---|
| `M115-01` Create | Editor/Admin legt Projekttermin an | „Neuer Termin“ in der Akte; Project les-/schreibbar; Dialog → Speichern → Termin erscheint in der Ansicht | `projectId`, `title` (1–2000), `start`, `end` (`end > start`), `allDay` (bool), `type` (Enum), `location` (≤2000, opt), `description` (≤5000, opt), `attendeeIds` (0–100), `categoryId` (opt) | `appointment.write`; Vorbild `POST /appointments/create` | `M115-CONTRACT-01`, `M115-DB-01`, `M115-E2E-01` | SPECIFIED |
| `M115-02` Edit | Editor/Admin korrigiert Termin | Termin öffnen; `expectedRevision`; Speichern → Felder aktualisiert, `revision+1` | allowlisteter Patch (Titel/Zeitfenster/Typ/Ort/Beschreibung/Teilnehmer/Kategorie), CAS | `appointment.write`; Vorbild `POST /appointments/{id}/update` | `M115-SVC-01`, `M115-DB-02`, `M115-RACE-01` | SPECIFIED |
| `M115-03` Delete | Editor/Admin entfernt Termin | Löschen mit Bestätigung; `expectedRevision`; → Zeile gelöscht, Event+Audit | `appointmentId`, `expectedRevision`; Hard-Delete + Kaskade | `appointment.write`; Vorbild `POST /appointments/{id}/delete` | `M115-DB-03`, `M115-EVENT-01` | SPECIFIED |
| `M115-04` Read/List (Kalender-Ansicht) | Viewer/Editor/Admin sieht Projekttermine im Monat/Woche/Liste | Projektakte öffnen; serverseitige Range-Query (`[rangeStart, rangeEnd]`) | `projectId`, `rangeStart`, `rangeEnd`, `view` (month/week/list); minimierte DTOs | `appointment.read`; Vorbild `GET /appointments` (Filter `residentialProjectId`, `start.gt/lt`, `end.gt/lt`) | `M115-CONTRACT-02`, `M115-E2E-02` | SPECIFIED |
| `M115-05` Kategorien | Kategorien als kleine read-only Tabelle | Read-Projektion `calendar_category` (leer in M1-15) | `id`, `name`, `order`; keine CRUD | `appointment.read`; Vorbild `GET /calendarCategories` | `M115-CONTRACT-03`, `M115-DB-04` | SPECIFIED |
| `M115-06` RLS/RBAC fail-closed | Viewer/External/Fremdtenant/Worker lesen/mutieren nicht | — | SQL- und Action-Ebene doppelt fail-closed, ohne Event/Audit | FORCE-RLS + Actions | `M115-RBAC-01/02` | SPECIFIED |
| `M115-07` Event/Audit | jede Mutation schreibt Event+Audit in derselben Tx | — | `domain_events` + `audit_log`, Payload ohne PII | Service-Muster `emitEvent`+`writeAudit` | `M115-EVENT-01` | SPECIFIED |
| `M115-08` Erasure | Termine des Contact-Graphen löschen | — | `appointmentIds` im Graphen; quellgepinnter `erase_inactive_lead` | Erasure-Erweiterung | `M115-ERASURE-01/02` | SPECIFIED |
| `M115-09` Race/CAS | paralleler Edit/Delete | — | genau ein Schreiber gewinnt; anderer Conflict ohne Teilstand | Project→Appointment-Lockreihenfolge | `M115-RACE-01/02` | SPECIFIED |
| `M115-10` UI/A11y | FullCalendar + Dialog in allen Zuständen | — | Axe, Tastatur, 375 px, `aria-live`, Touchziele | — | `M115-E2E-01…04`, `M115-A11Y-01` | SPECIFIED |

## 4. Datenmodell und Datenbankvertrag (Migration `0043`)

### 4.1 Tabelle `project_appointment` (Muster `project_task` [M110])

| Spalte | Typ | Semantik / Mapping auf Reonic-`Appointment` |
|---|---|---|
| `id` | uuid PK default gen | `Appointment.id` |
| `workspace_id` | uuid not null | Tenant-Schlüssel (RLS-Anker, nicht im DTO) |
| `project_id` | uuid not null | `residentialProjectId`/`commercialProjectId` → unser `project.id` (composite FK) |
| `title` | text not null | `Appointment.title` (1–2000) |
| `description` | text null | `Appointment.description` (1–5000, optional) |
| `location` | text null | `Appointment.location` (1–2000, optional) |
| `start_at` | timestamptz not null | `Appointment.start` (Zeitzone Europe/Berlin, Speicherung UTC) |
| `end_at` | timestamptz not null | `Appointment.end` |
| `all_day` | boolean not null default false | `Appointment.allDay` |
| `appointment_type` | text not null | **DECIDED WMEE** enum (API hat keins) |
| `category_id` | uuid null | `calendar_category.id` (kollabierter `calendar→category`-Sprung, DECIDED WMEE) |
| `revision` | integer not null default 1 | CAS-Anker (WMEE-Hausmuster) |
| `created_by` | uuid not null | Actor (WMEE; API hat keine `createdBy`) |
| `created_at` | timestamptz not null default now | WMEE |
| `updated_at` | timestamptz not null default now | WMEE |

Constraints (analog [M110]):

- `unique(workspace_id, id)` — zusammengesetzter Tenant-FK-Anker.
- `foreignKey (workspace_id) → workspace.id`; `foreignKey (workspace_id, project_id) → project(workspace_id, id) ON DELETE CASCADE` (Erasure-Pfad, nicht Nutzer-Delete).
- `foreignKey (workspace_id, category_id) → calendar_category(workspace_id, id) ON DELETE SET NULL` (Kategorie ist optional, nie Termin-löschend).
- `check title` 1–2000; `check description` null oder 1–5000; `check location` null oder 1–2000; `check appointment_type in ('on_site','phone','installation','maintenance','consultation','other')`; `check all_day in (true,false)`.
- `check end_at > start_at`; `check all_day ⇒ end_at ≥ start_at + interval '1 day'` (API „end must be at least one full day after start“).
- `check revision between 1 and 2147483647`; `check updated_at >= created_at`; `isfinite` auf `start_at`/`end_at`.
- RLS: `FORCE ROW LEVEL SECURITY` + Tenant-Policy wie `project_task` [M110/M110SVC].

Indexe:

- `project_appointment_ws_project_range_idx` auf `(workspace_id, project_id, start_at, end_at, id)` — trägt die Kalender-Range-Query.
- `project_appointment_ws_project_start_idx` auf `(workspace_id, project_id, start_at DESC, id)` — Liste/kommende Termine.
- `project_appointment_ws_category_idx` auf `(workspace_id, category_id)` (Filter/Readmodell).

### 4.2 Tabelle `project_appointment_attendee` (Muster `project_task_assignee` [M110])

| Spalte | Typ | Semantik |
|---|---|---|
| `id` | uuid PK default gen | — |
| `workspace_id` | uuid not null | Tenant-Schlüssel |
| `appointment_id` | uuid not null | → `project_appointment` |
| `membership_id` | uuid not null | → `membership` (M1-09-Muster; API `attendeeIds` = Workspace-User) |
| `created_at` | timestamptz not null default now | — |

- `unique(workspace_id, id)`; `unique(workspace_id, appointment_id, membership_id)`.
- `foreignKey (workspace_id, appointment_id) → project_appointment ON DELETE CASCADE`; `foreignKey (workspace_id, membership_id) → membership ON DELETE RESTRICT`.
- Index `(workspace_id, membership_id, appointment_id)` (Member-Suche).
- RLS `FORCE ROW LEVEL SECURITY` + Tenant-Policy.

> Teilnehmer werden **membership**-basiert geführt (wie `project_task_assignee`),
> nicht über rohe `user`-IDs — das ist das hausinterne M1-09-Muster. Die API-
> `attendeeIds` (User-IDs) werden an der (späteren) API-Grenze gemappt.

### 4.3 Tabelle `calendar_category` (ADR 0021 E1)

| Spalte | Typ | Semantik / Mapping auf `CalendarCategory` |
|---|---|---|
| `id` | uuid PK default gen | `CalendarCategory.id` |
| `workspace_id` | uuid not null | Tenant-Schlüssel |
| `name` | text not null | `CalendarCategory.name` (1–200) |
| `order` | integer not null default 0 | `CalendarCategory.order` („lower values come first“) |
| `created_at` | timestamptz not null default now | WMEE |

- `unique(workspace_id, id)`; `unique(workspace_id, lower(btrim(name)))` (keine Namensduplikate je Workspace).
- `check name` 1–200, `normalize(name, NFKC)`, kein Steuerzeichen; `check order >= 0`.
- **Kein** `color` (API-führt an der Kategorie keine Farbe).
- Startbestand **leer**; M1-15 **ohne** CRUD (nur Read-Projektion; die API
  exponiert nur `GET /calendarCategories`). → offene Frage O4 (Seed ja/nein).
- RLS `FORCE ROW LEVEL SECURITY` + Tenant-Policy (read-only für alle internen Rollen).

### 4.4 Minimiertes DTO

- `project-appointment-item.v1` projiziert **nur**: `id`, `revision`, `title`,
  `description`, `location`, `start` (ISO, Europe/Berlin-normalisiert), `end`,
  `allDay`, `type`, `categoryId`, `categoryName`, `attendees`
  (`{ membershipId, label }[]`). **Verboten** im Runtime-Schema:
  `workspace_id`, rohe `domain_events`-/`audit_log`-Daten, Fremd-PII außerhalb
  des eigenen Termins, Reonic-`calendarId`.
- `project-appointment-range.v1` = Array von `project-appointment-item.v1` +
  `rangeStart`/`rangeEnd`/`view` (für FullCalendar).
- `calendar-category-item.v1` = `{ id, name, order }`.

## 5. Zustände und Übergänge

Termine besitzen **keine** fachliche Zustandsmaschine (anders als
`project.outcome`). Zwei orthogonale Achsen:

```text
none --create--> active           [kein Status-Feld; Existenz = aktiv]
active --update--> active         [revision+1]
active --delete--> (Zeile gelöscht, Hard-Delete)   [terminal; Historie via Event/Audit]
```

- Es gibt **kein** „completed/archived“-Pendant; ein Termin ist entweder
  vorhanden oder gelöscht (API-treu, kein `deletedAt`).
- `all_day` ist ein Wahrheitswert am Zeitfenster, kein Zustand.

## 6. Commands und Actions

Vertrag `lib/integrations/appointments/contract.ts` (Version
`project-appointment-command.v1`); Service `modules/appointments/`. Jede Action
reauthentifiziert, allowlistet Felder, liest Project/Membership serverseitig
neu und sperrt zuerst das Project (Lock-Ordnung wie [M110SVC] `lockProject` →
Project `FOR KEY SHARE`; `lockReadableProject` für Reads):

- `create_appointment(projectId, { title, start, end, allDay, type, location?,
  description?, attendeeMembershipIds[], categoryId? })` → Insert; `revision 1`;
  `created_by = actor`; Attendee-Inserts in derselben Tx; Event
  `project.appointment_created` + `audit_log` in derselben Tx.
- `update_appointment(appointmentId, expectedRevision, patch)` → CAS auf
  `expectedRevision`; `revision+1`, `updated_at = now`; Attendee-Diff
  (Insert/Delete der Zuordnungszeilen) in derselben Tx; Event
  `project.appointment_updated`.
- `delete_appointment(appointmentId, expectedRevision)` → CAS; `DELETE` der
  Zeile (Hard-Delete, Kaskade auf Attendees); Event `project.appointment_deleted`
  + `audit_log` in derselben Tx. **[DOCUMENTED, API-treu]**
- `list_project_appointments(projectId, { rangeStart, rangeEnd, view })` →
  Read-Projektion via `appointment.read`.

Erwartete Fehler: `invalid`, `not_found`, `conflict` (Revisionskonflikt),
`denied`, `unauthenticated`; unbekannte Fehler bleiben laut [M113/M114].
Keine Fehlermeldung verrät Existenz fremder Termine/Projekte.

## 7. Rollen- und Datenvertrag

Neue Capabilities `appointment.read` und `appointment.write` (Muster
`task.read`/`task.write` [M110SVC]):

| Actor | Termine/Kategorien lesen | erstellen/editieren/löschen |
|---|---:|---:|
| interner Viewer | ja | nein |
| interner Editor | ja | ja |
| interner Admin | ja | ja |
| `external_only` | nein | nein |
| Worker/System (ohne Kapsel) | nein | nein |
| revoked / Fremdtenant | nein | nein |

- `appointment.write` ist `internalOnly`, mindestens Editor (analog `task.write`).
- `appointment.read` ist `internalOnly`; die Kategorie-Projektion hängt an
  `appointment.read`.
- Viewer, External, Worker und Fremdmandant bleiben in SQL (RLS), Service,
  Action und HTML fail-closed; es entsteht dabei **kein** Event/Audit.
- `created_by` ist im M1-15-Pfad stets der aktive interne Actor.

## 8. Event-, Audit- und Activity-Vertrag

- Jede Mutation schreibt in **derselben Transaktion** ein `domain_events`-
  Event (Activity-Feed) **und** eine `audit_log`-Zeile — analog „Activity-Event
  + audit_log in derselben Transaktion“ (Auftrag, Muster [M110SVC]
  `emitEvent` + `writeAudit`).
- Eventtypen (Aggregat `project`, `aggregate_id = project_id`):
  `project.appointment_created`, `project.appointment_updated`,
  `project.appointment_deleted`.
- Der partielle Activity-Index `domain_events_project_activity_idx` [events.ts]
  muss in Migration `0043` **additiv** um die drei Appointment-Eventtypen
  erweitert (neu erzeugt) werden (zusätzlich zu den M1-13-Note-/M1-11a/11b-Outcome-Typen).
- Payloads minimal: `appointmentId`, `projectId`, `revision`; **kein** Titel,
  **keine** Beschreibung/Ort (mögliche PII), **kein** Zeitfenster im Payload.
  Die Projektaktivität rendert ein festes deutsches Label („Termin
  erstellt/geändert/gelöscht“), nie den rohen Payload.

## 9. Lock- und Race-Vertrag

- Mutationsordnung: zuerst Project `FOR KEY SHARE`, danach frischer
  Active-Subject-Snapshot (Contact nicht gelöscht) — wie `lockProject`/
  `lockReadableProject` in [M110SVC]; erst dann Appointment-Insert/Update/Delete.
- Edit/Delete tragen `expectedRevision` im WHERE; `0` Zeilen = Conflict.
- Attendee-Diff läuft in derselben Tx und unter demselben Project-Lock.
- **Erasure-Kreuzung:** `project_appointment` hängt am Projekt und damit am
  Contact-Graphen. `ErasureGraphIds` wird um `appointmentIds?` erweitert;
  `erase_inactive_lead` wird **quellgepinnt** (SHA-Anker, wie [M111B §5.4])
  erweitert und löscht die Termine (kaskadierend Teilnehmer) desselben Graphen.
  Eine während der Mutation committende Erasure gewinnt; die Termin-Mutation
  rollt zurück (`FOR KEY SHARE` aufs Project serialisiert gegen den
  Erasure-Project-Lock).

## 10. UI-Vertrag (Projektakte)

- Neuer Abschnitt „Termine“ in der Projektakte
  (`app/w/[workspaceId]/anfragen/[projectId]/`, neben `project-tasks-section.tsx`).
  Dateien (künftig): `appointment-calendar-section.tsx`,
  `appointment-calendar.tsx` (Client-Wrapper für FullCalendar),
  `appointment-dialog.tsx`, `appointment-actions.ts`, Readmodel über
  `modules/appointments/`.
- **Kein eigenes Mutationstool außerhalb der Projektakte** (Non-Goal
  workspaceweite Kalender-Route / globale Terminsuche).
- FullCalendar: `@fullcalendar/react` + `daygrid` (Monat), `timegrid` (Woche),
  `list` (Liste) + `interaction`; **vor RED Major-Pin** auf eine konsistente
  Linie (ADR 0021 E5); A11y-Modus aktiv; Ansichtswechsel Monat/Woche/Liste.
- Viewer sieht Termine ohne Mutationscontrols („Neu“/Edit/Delete ausgeblendet);
  External wird abgewiesen.
- Termin-Einfärbung über `appointment_type` (feste WMEE-Farbzuordnung, Icon +
  Text, **kein** Farbsignal-Only); `aria-live="polite"` für Erfolg/Fehler;
  Touchziele ≥ 44 px; kein horizontaler Overflow bei 320/375 px; voller
  Tastaturpfad (Dialog öffnen/speichern/löschen, Ansicht wechseln).

## 11. Testmatrix

| Schicht | Fälle |
|---|---|
| Unit (Contract/Service) | `project-appointment-command.v1`-Parsing (jedes Feld, Limits 2000/5000/2000, `end > start`, `allDay`-Tagesregel, Typ-Enum, `attendeeIds` 0–100, Revisions-CAS), DTO-Minimierung (`project-appointment-item.v1` verbietet `workspace_id`/`calendarId`-Leak), `calendar-category-item.v1`, Fehlercodes |
| Contract | `project-appointment-range.v1` (rangeStart/rangeEnd/view), DTO-Schema-Hash gepinnt |
| DB | Create/Edit/Delete gegen echtes PostgreSQL; `end_at > start_at` + `allDay`-Constraint; Attendee-`unique`; Kategorie-FK `SET NULL`; `domain_events_project_activity_idx` deckt Appointment-Typen |
| RLS | Viewer read-only; Editor/Admin schreiben; External/Worker/Fremdtenant/revoked fail-closed (auch ohne Event/Audit-Seite) |
| Race | Revisionskonflikt (stale `expectedRevision`); zwei parallele Edits/Deletes; parallel laufende Erasure gewinnt (Termin-Mutation rollt zurück) |
| Erasure | `erase_inactive_lead` löscht Termine (kaskadierend Teilnehmer) desselben Graphen; `ErasureGraphIds.appointmentIds` korrekt; Tombstone-Hash stabil |
| Chromium E2E | Editor erstellt/editiert/löscht; Kalender-Ansicht Monat/Woche/Liste rendert; Viewer read-only; External abgewiesen; Axe + Tastatur + 375 px (4/4-Muster [M111B]) |
| A11y | FullCalendar-A11y (Tastaturnavigation, Screenreader), `aria-live`, Icon+Text (kein Farbsignal-Only), 44-px-Touchziele, Tastatur-Erstellen/Edit/Delete |

## 12. Abschlussgates

- `npm run check` (Vitest, alle Dateien grün), Rollenproben 88/88, PG18-Proben
  5/5, Fresh-Migration `0043` (inkl. quellgepinnter Erasure-Erweiterung),
  `db:generate` ohne Drift, TypeScript/ESLint/Dependency-Cruiser,
  `git diff --check`, Secret-Scan, Production-Build.
- **FullCalendar-Major-Pin** konsistent (`npm ls @fullcalendar/*` ohne zwei
  `core`-Linien) — Vor-RED-Gate.
- Unabhängiger Review (Security/Race/Privacy) vor VERIFIED; keine offenen
  P0–P2. Visual-/Menschen-Gates bleiben INCONCLUSIVE bis Freigabe.

## 13. Nichtziele (Non-Goals)

- **Gmail-/Microsoft-Kalender-Sync** (F1.9, Sync-Infrastruktur).
- **Workspaceweites Kalender-Objekt / 4 Scopes** (`calendar`-Tabelle,
  Team-/User-/Mandanten-Kalender, `type`-Enum, Google/MS-Sync) — ADR 0021 E2.
- **Öffentliche Buchungsseite / Kundenportal-Sichtbarkeit**
  (`visibleInCustomerPortal`, `customerPortalTitle`/`customerPortalDescription`
  → F10-Kundenportal-Slice).
- **Erinnerung/Benachrichtigung** (Reminder, Mail/Push) — auch API-seitig nicht
  vorhanden.
- **Team-/Ressourcenplanung (F7 Plantafel)**, **Wiederholungsserien**,
  **Zeiterfassungs-Verknüpfung (F9)**.
- **Kategorie-CRUD / Seed-Stammdaten** (M1-15 read-only, leer).
- Keine öffentliche REST-API, kein `POST /appointments/create`-Äquivalent als
  externer Endpunkt in diesem Slice.
- Keine Reonic-Texte, UI, Assets, Taxonomie oder private Implementierungsdetails.

## 14. DECIDED und UNKNOWN

### DECIDED

| ID | Entscheidung | Ablage |
|---|---|---|
| `DEC-M115-01` | `calendar_category` als eigene Tabelle (leer, ohne `color`), kein Enum | ADR 0021 E1 |
| `DEC-M115-02` | Kein `calendar`-Objekt; `project_appointment` hängt am `project`; `calendarId` nicht repliziert (`ACCEPTED_EXCEPTION`) | ADR 0021 E2 |
| `DEC-M115-03` | Kategorie-Sprung `calendar→category` auf `appointment→category` kollabiert (nullable `category_id`) | ADR 0021 E2 |
| `DEC-M115-04` | `appointment_type` = WMEE-Enum `on_site|phone|installation|maintenance|consultation|other` (API hat keins) | ADR 0021 E3 |
| `DEC-M115-05` | Delete = Hard-Delete (API-treu; kein `deletedAt`), Historie über Event/Audit | ADR 0021 E4 |
| `DEC-M115-06` | FullCalendar-Major-Pin (empfohlen `6.1.x`) + CSR; kein SSR der Grid | ADR 0021 E5 |
| `DEC-M115-07` | Zeitzone `Europe/Berlin` an der Service-Grenze; Speicherung `timestamptz` UTC | ADR 0021 E6 |
| `DEC-M115-08` | Teilnehmer membership-basiert (`project_appointment_attendee`, Muster M1-09/M1-10) | §4.2 |
| `DEC-M115-09` | `description`+`location` optional übernommen (API-Felder); `customerPortal*`/`visibleInCustomerPortal` Nichtziel | §2.4/§13 |
| `DEC-M115-10` | Migration `0043`; `ErasureGraphIds.appointmentIds` + quellgepinnter Erasure-Scrub | §0.1/§9 |
| `DEC-M115-11` | Eventtypen `project.appointment_created/updated/deleted`; Activity-Index additiv erweitert | §8 |

### UNKNOWN

- U1: exaktes UI-Verhalten der Reonic-**Kalenderoberfläche** (nicht API) —
  Termin-Typ-Ausprägung, Farben, Drag&Drop-Resize — nicht belegbar ohne private
  Sicht; unsere Typ-/Farb-Entscheidung ist `DECIDED`, nicht `INFERRED`.
- U2: ob `GET /appointments`-`sort` neben `start/end` weitere Felder zulässt —
  Spec nennt nur `start`/`end`; die Liste ist `DOCUMENTED` begrenzt.
- U3: ob Reonic `calendarId` beim Update wirklich unveränderlich ist (Spec
  führt es nicht im Update-Body) — `DOCUMENTED` via Body-Schema, Laufzeit
  nicht beobachtet.
- U4: FullCalendar-Ziel-Major (6.1.x vs 7.0.2) — Empfehlung `6.1.x` (ADR 0021 E5),
  finale Pin-Entscheidung beim Root/Implementierer.

## 15. Offene Fragen an den Root-Integrator

1. **O1 (F-Nummer):** Slice-Auftrag nennt „F1.13 Termine und Kalender“, der
   Modulkatalog/API-Map führt Termine+Kalender unter **F1.9**. Welche
   F-Nummer ist kanonisch für die Matrix/Register (§0.2)?
2. **O2 (Hard-Delete):** `DEC-M115-05` bestätigen — Termine hart löschen
   (API-treu, Historie nur über Event/Audit), oder abweichend Soft-Delete
   (`deleted_at`) für spätere Restore-/Archivsicht?
3. **O3 (Typ-Werteliste):** `appointment_type`-Enum
   (`on_site|phone|installation|maintenance|consultation|other`) bestätigen
   oder eine andere WMEE-Werteliste vorgeben (ESTIMATE/DECIDED)?
4. **O4 (Kategorie-Seed):** `calendar_category` startet leer („Katalog-leer“-
   Prinzip) — oder soll M1-15 einen kleinen WMEE-Default-Satz seeden (wäre
   inventierte Stammdaten)? API-seitig ist nur `GET` dokumentiert.
5. **O5 (Erasure-Erweiterung):** `ErasureGraphIds.appointmentIds` +
   quellgepinnter `erase_inactive_lead`-Erweiterung als **neuer Graphen-Knoten**
   (DELETE, kaskadierend Attendees) — exakten Erasure-Graph-Vertrag für die
   Integrationsmigration `0043` bestätigen.

## Root-Entscheidungen (2026-09-02)

- **O1 → F-Nummer kanonisch: F1.9.** Der Modulkatalog (primäre Abnahmequelle)
  führt Kalender/Termine unter **F1.9** („Aufgaben …, Kalender (4 Scopes,
  Google/MS-Sync, Terminvorlagen, keine Serientermine), …, Notizen …").
  M1-15 deckt den Kalender-Teil von F1.9 ab; die API-Map-Zuordnung F1.9 ist
  korrekt, „F1.13" aus dem Auftragstext ist zu verwerfen.
- **O2 → Hard-Delete bestätigt.** Die API belegt echtes Löschen
  (`POST /appointments/{id}/delete` → `{data:{id}}`, kein `deletedAt`).
- **O3 → Typ-Werteliste bestätigt als ESTIMATE/DECIDED WMEE**
  (`on_site|phone|installation|maintenance|consultation|other`); der
  Eigentümer kann die Werte vor RED anpassen — Änderung vor Vertrags-Pinning.
- **O4 → Kategorien starten leer** (Katalog-Prinzip wie M1-08: keine
  erfundenen Seed-Daten).
- **O5 → bestätigt:** `ErasureGraphIds.appointmentIds` als neuer
  Graphen-Knoten + quellgepinnter Scrub der Appointment-Spalten bei
  Integration (Migration 0043).
