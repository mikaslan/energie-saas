# M1-15b — Kalender-Scopes (F1.9, Folgeslice zu M1-15)

- Status: **DISCOVERED → SPECIFIED** · noch nicht CONTRACTED/RED/IMPLEMENTED
- Datum: 2026-09-03
- F-Bezug: **F1.9** (Modulkatalog „… Kalender (4 Scopes, Google/MS-Sync,
  Terminvorlagen, keine Serientermine) …“) — **Kalender-Scopes**. Kanonische
  F-Nummer ist F1.9 (Root-Entscheidung in M1-15, §Root-Entscheidungen).
- Architektur: **ADR 0021** (E1/E2 werden in M1-15b aufgelöst/präzisiert) +
  **ADR 0025** (supersedes ADR 0021 E2 formell — Root O2).
- Basis: **M1-15-Stand (`0043`)** — M1-15b baut **additiv** auf M1-15 auf
  (M1-15 selbst basiert auf `01b52e9`/M1-12a).
- Geplante Migration: **`0049_m1_15b_calendar_scopes.sql`** (Root-Arbitrage:
`0047` = F4.6-Defaults, `0048` = v5-Leadquelle; M3-02 rückt auf `0050`).
  Integrationsreihenfolge: nach der M3-Welle.
- Ziel: keine — reine Spezifikation (Branch `tooling`, nur Doku; Root committet).

## 0. Quellenlegende

| Kürzel | Quelle | Rolle |
|---|---|---|
| `OAS` | öffentliche OpenAPI **`3.11.0`**, abgerufen **2026-09-03** per `curl -sL https://api.reonic.de/rest/v3/openapi` (Snapshot: `/tmp/reonic-openapi.json`, flüchtig) | maschinenprüfbare Extraktion der Kalender-Pfade/`Calendar`-Schemas/enums |
| `AMAP` | `docs/parity/REONIC-API-CAPABILITY-MAP.md`, Z. 309–315 | `GET /calendars` (F1.9) |
| `PORTAL` | `docs/parity/REONIC-PORTAL-AUDIT-MAP.md` (Stand 2026-09-03) | Portal-Kalenderbereich (OBSERVED) |
| `PCSV` | `docs/parity/reonic-portal-audit/reonic_portal_audit_gesamt.csv` (2026-09-02) | Primärbeleg der Portal-Sicht (Zeilen 8, 22, 56–60, 65) |
| `M115` | `docs/spec/M1-15-termine-kalender.md` | Vor-/Grundlage; M1-15b präzisiert §4.1 |
| `ADR0021` | `docs/adr/0021-termine-kalender.md` | E1/E2 (Kategorien-Tabelle, kein `calendar`-Objekt) |
| `UNKLOG` | `docs/parity/UNKNOWN-CONFLICT-LOG.md` (`UNK-M115-01`, `UNK-M115-02`) | Auftrag + Erasure-Entscheidung |
| `M109`/`M110` | `lib/db/schema/project-assignment.ts` / `project-task.ts` (Basis `01b52e9`) | membership-basierte Muster |
| `CORE` | `lib/db/schema/core.ts` (Basis `01b52e9`) | `membership` (1:1 User↔Workspace) |
| `ERASURE` | `lib/db/schema/erasure.ts` + `drizzle/0027_m1_07_gdpr_erasure.sql` | `ErasureGraphIds`, `erase_inactive_lead` |

> **Evidenz-Klassifikation (Goal-Prompt §7):** `OBSERVED` (Portal-Audit,
> read-only-Sweep, keine Aktionen), `DOCUMENTED` (öffentliche Spec), `INFERRED`,
> `DECIDED` (bewusste Eigenentscheidung), `UNKNOWN`, `CONFLICTING`. **Kein
> API-Call mit Key** — nur die öffentliche OpenAPI-Spec. Keine Reonic-Texte,
> Assets, PII oder Werte werden übernommen.

### 0.1 Migrationsnummer (RESOLVED)

M1-15 hat `0043` reserviert (parallel zu `0040`=M1-11b, `0041`=M1-13,
`0042`=M1-14). M1-15b liegt **nach der M3-Welle** und erhält die
**`0049_m1_15b_calendar_scopes.sql`** (Root-Arbitrage 2026-09-04/05: `0047` =
F4.6-Defaults, `0048` = v5-Leadquelle; M3-02 rückt auf `0050`). Integrationsreihenfolge: nach der
M3-Welle (siehe DEC-M115B-11, §15).

### 0.2 Einordnung (warum M1-15b)

M1-15 hat bewusst **kein** `calendar`-Objekt gebaut und `calendarId` nicht
repliziert (`DEC-M115-02`, `ACCEPTED_EXCEPTION`; ADR 0021 E2). `UNK-M115-01`
registriert die Lücke: „API verlangt `calendarId` (Pflicht) mit 4 Scopes
(Team/Tenancy/User/Client); Portal zeigt Unternehmens-/Benutzer-/persönliche
Kalender + Kalenderauswahl“. M1-15b schließt diese Lücke: Es führt das
`calendar`-Objekt ein, bindet Termine an Kalender und regelt Sichtbarkeit
(RBAC) je Scope.

---

## 1. Nutzerergebnis (JTBD)

Ein interner **Editor/Admin** legt Termine nicht mehr nur „am Projekt“, sondern
**in einem Kalender** an — der Termin-Dialog zeigt eine **Kalenderauswahl**
(Pflicht, API-treu `calendarId`). Es existieren **Kalender mit 4 Scopes**
(`Tenancy` = Unternehmenskalender, `User` = persönlicher Kalender,
`Team` = Teamkalender, `Client` = Kundenportal-Kalender, letzterer Nichtziel),
jeweils mit Name und Farbe. **Admin** verwaltet die Unternehmenskalender
(anlegen/umbenennen/archivieren); **persönliche Kalender** werden je
Mitgliedschaft automatisch bereitgestellt. Die Sichtbarkeit folgt dem Scope:
Unternehmenskalender sehen alle internen Rollen, persönliche nur der Owner
(plus Admin), Teamkalender nur das Team (strukturell vorbereitet, Teams folgen
später). Termine bleiben projektgebunden (Projektakte) **und** kalendergebunden;
ihre Farbe kommt vom Kalender. External-/Worker-/Fremdtenant-Akteure bleiben
fail-closed; jede Kalender-Änderung schreibt Event + Audit in derselben
Transaktion.

## 2. Clean-Room-Evidenz (API + Portal)

### 2.1 API (DOCUMENTED) — `GET /calendars`

| Methode + Pfad | Mut. | Request | Response | „Allowed API keys“ |
|---|---|---|---|---|
| `GET /calendars` | — | nur Header `Reonic-Cache-Control`; **keine** Query-Filter | 200 `{ data: Calendar[] }` (**ohne** Pagination) | Read-only, Read and Write |

`Calendar` (inline, 8 Felder, **alle required**):

| Feld | Typ | Hinweis |
|---|---|---|
| `id`* | uuid | — |
| `name`* | string | — |
| `color`* | string\|null | Hex-Code (Beispiel `#000000`) |
| `categoryId`* | uuid\|null | → `CalendarCategory` |
| `userId`* | uuid\|null | → User (Scope `User`) |
| `teamId`* | uuid\|null | → Team (Scope `Team`) |
| `type`* | enum `Team \| Tenancy \| User \| Client` | die **4 Scopes** |
| `active`* | bool | aktiv/archiviert-Signal |

**Entscheidende API-Befunde:**

1. **Keine Kalender-Mutationen.** Die REST v3 exponiert für Kalender **nur**
   `GET /calendars`; es gibt **kein** `POST /calendars/create`,
   `/calendars/{id}/update` oder `/delete`. Die Kalender-Verwaltung (anlegen,
   anbinden, Standardkalender) ist **Portal-only**, nicht API-exponiert.
2. **`Calendar.type` ist der einzige Beleg der „4 Scopes“** — `Team | Tenancy |
   User | Client`. `userId`/`teamId` sind nullable und tragen den Owner
   (`User`/`Team`); `Tenancy`/`Client` tragen weder `userId` noch `teamId`.
3. **Farbe liegt am Kalender** (`color`, Hex, nullable), **nicht** an der
   Kategorie (vgl. M1-15 §2.3 Befund 4).
4. **`Appointment.calendarId` ist Pflicht** (Create-Body required) und im
   Update-Body nicht änderbar (vgl. M1-15 §2.1) — die Bindung Termin→Kalender
   ist API-treu ein Pflicht-Fremdschlüssel.
5. `GET /calendars` ist **un-paginiert** und **ohne Filter** (kein
   `archived`/`active`-Filter) — die Filterung/Sichtbarkeit ist eine
   Portal-/Client-Angelegenheit, nicht API-Verhalten.

### 2.2 Portal (OBSERVED) — Kalenderbereich

Primärbeleg `PCSV` (read-only-Sweep, keine Aktionen, keine PII übernommen):

| Beleg | Beobachtete Semantik (paraphrasiert) | Scope-Mapping (INFERRED) |
|---|---|---|
| `/calendar` (PCSV:8) | Monatsansicht, **„vier Kalender/Alle“**, „Heute“, neuer Termin, **Kalenderauswahl**, Planungsmodus, Monat/Woche/Tag/Agenda | workspaceweite Kalendersicht mit Auswahl „Alle + einzelne Kalender“ |
| Installation – Terminierung `/360h/installation/{id}/calendar` (PCSV:22) | Kalenderansicht (KW36) + **Kalenderauswahl**, „**fünf Kalender**“ | projektgebundene Kalendersicht mit derselben Auswahl |
| Einstellungen → Organisation → **Persönliche Terminkalender** `?settings=calendars&tab=personal-calendars` (PCSV:56) | „Standard-Reonic-Kalender“; Microsoft-Kalender hinzufügen, Google-Account verbinden, Standardkalender | **User**-Scope (persönlich) |
| Einstellungen → Organisation → **Unternehmenskalendar** `?settings=calendars&tab=company-calendars` (PCSV:57) | Google Workspace verbinden, Google-Kalender hinzufügen, **„Reonic-Kalender erstellen“** | **Tenancy**-Scope (Unternehmen); explizites Anlegen |
| Einstellungen → Organisation → **Benutzer-Kalender** `?settings=calendars&tab=user-calendars` (PCSV:58) | „**Automatisch generierte Benutzer-/Teamkalender**“ (zwei Nutzer sichtbar) | **User**- und **Team**-Scope, automatisch provisioniert |
| Terminvorlagen `?settings=calendar-templates` (PCSV:59) | Terminvorlage erstellen, Archiviert (keine vorhanden) | Nichtziel M1-15b (eigener Vorlagen-Slice) |
| Kalender-Kategorien `?settings=calendar-categories` (PCSV:60) | Kategorie erstellen, Archiviert (keine vorhanden) | Kategorie-CRUD: Portal-belegt, M1-15 hatte sie read-only |
| Einstellungen → Features (PCSV:53) | Feature-Schalter **„Kalender“** | Feature-Flag „Kalender“ existiert |
| Persönliche Benachrichtigungen (PCSV:65) | E-Mail-Schalter u. a. für **Termine** | Erinnerung/Benachrichtigung (Nichtziel) |

**Portal-/API-Lücken (ehrlich):**

- Die **exakte Zuordnung** der drei Portal-Tabs (`personal/company/user`) zu den
  vier API-Scopes ist `INFERRED`: `personal`→`User`, `company`→`Tenancy`,
  `user`→`User`+`Team`. Der vierte Scope **`Client`** ist im Kalender-Bereich
  **nicht** beobachtet → vermutlich Kundenportal-/Buchungskalender (F10) →
  `UNKNOWN` und Nichtziel (F10).
- Die **exakten Sichtbarkeitsregeln je Scope** (wer sieht welche
  User-/Team-Kalender; ob Admins alle sehen) sind Portal-seitig **nicht**
  vollständig beobachtet (nur „zwei Nutzer sichtbar“ im Tab) → `UNKNOWN`,
  RBAC in §7 als `DECIDED WMEE` mit Muster aus M1-09/ROLE-PERMISSION-MATRIX.
- „Planungsmodus“, Drag&Drop-Resize, Wochen-/Tages-/Agenda-Details der
  Kalenderansicht sind nicht auswertbar beobachtet → `UNKNOWN`, nicht
  spezifiziert (bleibt M1-15-Basis FullCalendar).

## 3. Capability-Sheet (Goal-Prompt §7)

### 3.1 Gemeinsamer Liefervertrag

- **Modul:** CRM (F1). **Tenant-/Owner-Scope:** Workspace + Calendar +
  Membership/Team (siehe §7). `workspace_id`-Composite-Schlüssel, FORCE-RLS.
- **Akteur/Rolle:** `calendar.read` internalOnly (Viewer+); `calendar.write`
  internalOnly, mindestens Admin (Verwaltung), Editor wählt Kalender im
  Termin-Dialog via `appointment.write`. External/Worker/Fremdtenant fail-closed.
- **Route/Oberfläche:** Projektakte `/w/[workspaceId]/anfragen/[projectId]`
  (Termin-Dialog mit Kalenderauswahl) + workspaceweite Kalenderroute
  `/w/[workspaceId]/kalender` (Monatsansicht mit Scope-Filter, §10) +
  Einstellungsbereich „Kalender“ (Admin). Server-Actions, keine öffentliche
  REST-API.
- **Notifications:** nur lokale `aria-live`; keine Mail/Push (Erinnerung und
  Google-/MS-Sync sind Nichtziele).
- **Loading/Empty/Error/Success/Disabled/Denied:** echte getrennte Zustände;
  Kalenderauswahl leer/„keine Kalender“ als Empty; Denied ohne Existenz-Leak.
- **Desktop/Tablet/Mobile:** responsive 320/375/390/768/1024/1440/1920,
  400-%-Reflow, Touchziele ≥ 44 px, kein Seiten-Overflow.
- **Keyboard:** vollständiger Pfad (Kalender wählen, Kalender verwalten) ohne
  Maus; Farbsignale immer Icon + Text.
- **Offline:** kein Offline-Schreibversprechen.
- **Paritätsstatus:** FUNCTIONAL (eigenständige Ausgestaltung, API+Portal als
  Referenz); kein Anspruch auf private Reonic-Interna.
- **Confidence:** `type`-Enum/`color`/`calendarId`-Pflicht = `DOCUMENTED`;
  Tabs/Auto-Provisionierung/„Reonic-Kalender erstellen“ = `OBSERVED`;
  Scope↔Tab-Zuordnung und Sichtbarkeitsregeln = `INFERRED`/`DECIDED`.
- **Owner:** Root; UI-/Test-Lanes mit unabhängigen Abschlussprüfungen.
- **Letzte Prüfung:** 2026-09-03 (Discovery/Spec; noch nicht implementiert).

### 3.2 Feingranulare Capabilities

| ID / F-Nr. | Job, Trigger, Happy Path | Eingaben / Validierungen | Zustand / Nebenwirkung | Recht / Daten / Event | Tests | Status |
|---|---|---|---|---|---|---|
| `M115B-01` Calendar-Objekt | Kalender als erstklassiges Objekt (4 Scopes) | Tabelle `calendar`; `type ∈ team\|tenancy\|user\|client`, `name` 1–200, `color` Hex|null, `active` | additive Migration; Kategorie-FK am Kalender | `calendar.read`; Vorbild `GET /calendars` + `Calendar`-Schema | `M115B-DB-01`, `M115B-CONTRACT-01` | SPECIFIED |
| `M115B-02` Kalender anlegen/verwalten | Admin legt Unternehmenskalender an (Portal „Reonic-Kalender erstellen“) | `name`, `color`, `categoryId?`, `type=tenancy`; umbenennen/archivieren | `calendar.created/updated/archived`; kein Hart-Löschen | `calendar.write` (Admin); Portal-only (kein API-Pendant) | `M115B-SVC-01`, `M115B-DB-02` | SPECIFIED |
| `M115B-03` Auto-Provisionierung User-Kalender | persönlicher Standardkalender je Mitgliedschaft | 1:1 je `membership`; `type=user`, `membership_id` | automatisch (lazy oder bei Membership-Anlage) | System-/Service-Schritt | `M115B-DB-03` | SPECIFIED |
| `M115B-04` Kalenderauswahl im Termin-Dialog | Editor/Admin wählt Pflicht-Kalender beim Anlegen | `calendar_id` required; Auswahl der sichtbaren Kalender | Termin erscheint im gewählten Kalender | `appointment.write`; Vorbild `Appointment.calendarId` (Pflicht) | `M115B-E2E-01`, `M115B-CONTRACT-02` | SPECIFIED |
| `M115B-05` Termin-Bindung an Kalender | `project_appointment.calendar_id` (not null) ersetzt M1-15-Kollaps | FK → `calendar`; `category_id` wandert an `calendar` | M1-15 §4.1 wird präzisiert (DEC-M115B-03) | `appointment.write` | `M115B-DB-01/04` | SPECIFIED |
| `M115B-06` RBAC je Scope | Sichtbarkeit folgt dem Scope | Tenancy=alle intern; User=Owner+Admin; Team=Team; Client=Nichtziel | RLS-Policies je Scope | `calendar.read`/`calendar.write` | `M115B-RBAC-01/02` | SPECIFIED |
| `M115B-07` Kalender-Read/DTO | minimiertes Kalender-DTO für Auswahl+Ansicht | `id, name, color, type, categoryId`; keine Fremd-PII | — | `calendar.read` | `M115B-CONTRACT-03` | SPECIFIED |
| `M115B-08` RLS/Erasure | Kalender bleibt außerhalb des Kontakt-Erasure-Graphen | Termine (`appointmentIds`) bleiben im Graphen | Erasure löscht Termine, nicht Kalender | FORCE-RLS + Erasure | `M115B-ERASURE-01` | SPECIFIED |
| `M115B-09` Event/Audit | Kalender-Änderung schreibt Event+Audit in derselben Tx | — | `calendar.created/updated/archived` + `audit_log` | Service-Muster | `M115B-EVENT-01` | SPECIFIED |
| `M115B-10` UI/A11y (WMEE) | Kalenderauswahl + Admin-Verwaltung a11y | Axe, Tastatur, 375 px, Icon+Text, Touchziele | — | — | `M115B-E2E-01…04`, `M115B-A11Y-01` | SPECIFIED |

## 4. Datenmodell-Skizze (additiv, nummernneutral)

### 4.1 Tabelle `calendar` (NEU; Muster `project`/`project_loss_reason`)

| Spalte | Typ | Semantik / Mapping auf Reonic-`Calendar` |
|---|---|---|
| `id` | uuid PK default gen | `Calendar.id` |
| `workspace_id` | uuid not null | Tenant-Schlüssel (RLS-Anker) |
| `name` | text not null | `Calendar.name` (1–200) |
| `color` | text null | `Calendar.color` (Hex, nullable; `#rrggbb`-Muster CHECK) |
| `category_id` | uuid null | `Calendar.categoryId` → `calendar_category` |
| `calendar_type` | text not null | `Calendar.type` (CHECK `team\|tenancy\|user\|client`) |
| `membership_id` | uuid null | `Calendar.userId` → `membership` (Scope `user`; Owner) |
| `team_id` | uuid null | `Calendar.teamId` → `team` (Scope `team`; **Teams noch nicht gebaut** → `UNKNOWN`/strukturell vorbereitet) |
| `active` | boolean not null default true | `Calendar.active` |
| `revision` | integer not null default 1 | CAS-Anker (Hausmuster; jede Mutation +1) |
| `created_by` | uuid not null | WMEE (API hat keine `createdBy`) |
| `created_at` | timestamptz not null default now | WMEE |
| `updated_at` | timestamptz not null default now | WMEE |

Constraints:

- `unique(workspace_id, id)`; `unique(workspace_id, lower(btrim(name)))` (Namensduplikat je Workspace).
- `foreignKey (workspace_id) → workspace.id`; `foreignKey (workspace_id, category_id) → calendar_category(workspace_id, id) ON DELETE SET NULL`.
- `foreignKey (workspace_id, membership_id) → membership(workspace_id, id) ON DELETE RESTRICT`.
- `check calendar_type in ('team','tenancy','user','client')`; `check name` 1–200, NFKC, kein Steuerzeichen; `check color` null oder `^#[0-9a-fA-F]{6}$`; `check revision between 1 and 2147483647`.
- **Scope-Invarianten (DECIDED):** `calendar_type='user' ⇒ membership_id is not null and team_id is null`; `calendar_type='team' ⇒ team_id is not null and membership_id is null`; `calendar_type='tenancy' ⇒ membership_id is null and team_id is null`; `calendar_type='client' ⇒ membership_id is null and team_id is null` (Client = Nichtziel, strukturell erlaubt).
- RLS `FORCE ROW LEVEL SECURITY` + Scope-Policies (§7).

Indexe:

- `calendar_ws_type_active_idx` auf `(workspace_id, calendar_type, active, name, id)` — Kalenderauswahl.
- `calendar_ws_membership_user_uniq` **partial unique** auf `(workspace_id, membership_id) WHERE calendar_type = 'user'` — 1:1-Idempotenz der Auto-Provisionierung.
- `calendar_ws_membership_idx` auf `(workspace_id, membership_id)` (User-Scope).
- `calendar_ws_team_idx` auf `(workspace_id, team_id)` (Team-Scope, vorbereitet); bei Team-Einführung analoger partial unique `(workspace_id, team_id) WHERE calendar_type = 'team'`.

> **`team_id`-FK:** Es existiert derzeit **keine** `team`-Tabelle (UNK-F1-01:
> M1-09 nutzt ausschließlich direkte Memberships; Teams sind nicht gebaut). Die
> Spalte `team_id` wird als **nullable, strukturell vorbereitet** geführt; der
> FK wird erst gesetzt, wenn der Team-Slice die `team`-Tabelle einführt. Bis
> dahin ist der `Team`-Scope fachlich leer (`UNKNOWN`).

### 4.2 Änderung an `project_appointment` (Präzisierung von M1-15 §4.1)

| Aktion | Detail |
|---|---|
| **NEU** `calendar_id` | uuid **not null**, `foreignKey (workspace_id, calendar_id) → calendar(workspace_id, id) ON DELETE RESTRICT` (Kalender nie Termin-löschend) |
| **ENTFÄLLT** `category_id` | der M1-15-Kollaps (`appointment→category`) wird durch die API-treue Form `calendar→category` ersetzt (DEC-M115B-03); die Kategorie wird am Kalender geführt |

- `project_id` bleibt **not null** (Projektakte-Scope); `calendar_id` kommt
  **additiv not null** hinzu. API-treu: `calendarId` Pflicht + `residential/
  commercialProjectId` optional — unsere Projektbindung bleibt enger (Projekt
  immer gesetzt), die Kalenderbindung wird jetzt ebenfalls Pflicht.
- Index `project_appointment_ws_project_range_idx` (§M1-15) bleibt; zusätzlich
  `project_appointment_ws_calendar_range_idx` auf `(workspace_id, calendar_id,
  start_at, end_at, id)` für die kalenderbasierte Range-Query.
- **Backfill (RESOLVED, DEC-M115B-14 + DEC-M115B-16):** Migration `0049` legt
  zuerst die `calendar`-Tabelle an und provisioniert **genau einen
  persönlichen Kalender je `created_by`-Membership** (`ensure_personal_calendar`
  über alle Bestands-Mitglieder). Bestands-Termine aus M1-15 erhalten dann
  `calendar_id` = persönlicher Kalender ihres `created_by` (sonst
  Unternehmenskalender). **Die Kategorie-Zuordnung der Bestands-Termine
  verwirft sich explizit** (`calendar.category_id` bleibt `NULL`, die alte
  `appointment.category_id` wird gedroppt) — `ACCEPTED_EXCEPTION`, begründet
  durch den nachweislich **leeren** Kategorie-Bestand von `0043` (M1-15 hat
  kein Kategorie-CRUD, Kategorien starten leer).

### 4.3 Minimiertes DTO

- `calendar-item.v1` = `{ id, name, color, type, categoryId, categoryName }`
  (für Kalenderauswahl/Ansicht). **Verboten** im Runtime-Schema:
  `workspace_id`, `membership_id`/`team_id`-Rohwerte, Fremd-PII.
- `project-appointment-item.v1` (M1-15) wird erweitert um `calendarId`,
  `calendarName`, `calendarColor`; `categoryId`/`categoryName` entfallen am
  Termin (wandern an den Kalender).

## 5. Zustände und Übergänge

```text
calendar:  (kein Kalender) --create--> active(active=true)
active --archive--> archived(active=false)   [Portal-Muster „Archiviert“]
archived --reactivate--> active               [DECIDED: Reaktivierung erlaubt]
```

- Kalender werden **archiviert, nicht hart gelöscht** (`active=false`);
  Reaktivierung ist erlaubt (DECIDED; das Portal belegt „Archiviert“-Toggles
  bei Vorlagen/Kategorien, das `active`-Flag ist API-belegt).
- Ein archivierter Kalender ist in der Kalenderauswahl ausgeblendet; bestehende
  Termine bleiben sichtbar (kein Kaskaden-Löschen).
- **Offboarding (DEC-M115B-18):** Membership-Revoke ⇒ der zugehörige
  `user`-Kalender wird `active=false` gesetzt; `membership_id` bleibt
  historisch erhalten (der FK wird erst bei Workspace-Löschung geräumt).
- Termine behalten ihre M1-15-Zustandsachse (create/update/delete), zusätzlich
  kalendergebunden.

## 6. Commands und Actions

Vertrag `lib/integrations/calendar/contract.ts` (Erweiterung des M1-15-Vertrags;
Service `modules/calendar/` — Amendment-Konvention aus M1-15 §6):

- `create_calendar({ name, color?, categoryId?, type })` → Insert; `active=true`;
  `revision=1`; `created_by=actor`; nur Admin (Scope-Invarianten §4.1). Event
  `calendar.created` + `audit_log` in derselben Tx.
- `update_calendar(calendarId, expectedRevision, patch)` → **CAS auf
  `expectedRevision`** (Pflicht); allowlistet `name`/`color`/`categoryId`/
  `active`; `revision = revision + 1`, `updated_at = now`; Event
  `calendar.updated`/`calendar.archived`. `0` Zeilen = `conflict`.
- `list_visible_calendars(actor)` → Kalenderauswahl (Scope-gefärbt, §7) für den
  Termin-Dialog.
- `ensure_personal_calendar(membershipId)` → lazy Auto-Provisionierung des
  User-Standardkalenders. **Namensschema (DEC-M115B-17):** `name = „Persönlich —
  <Membership-Anzeigename>“`; Idempotenz/1:1 über partial unique
  `(workspace_id, membership_id) WHERE calendar_type='user'` (§4.1).
- `create_appointment` (M1-15) erhält zusätzlich Pflicht-Parameter `calendarId`
  (Validierung: `calendar_id` muss für den Actor **sichtbar** und
  **`active=true`** sein; andernfalls `invalid`).

Fehler: `invalid`, `not_found`, `conflict`, `denied`, `unauthenticated`; keine
Existenz-/Scope-Leaks.

## 7. Rollen- und Datenvertrag (RBAC je Scope)

Neue Capabilities `calendar.read` (internalOnly) und `calendar.write`
(internalOnly, Admin). Sichtbarkeit je Scope (**DECIDED WMEE**, Muster
M1-09/ROLE-PERMISSION-MATRIX; exakte Reonic-Regeln `UNKNOWN`):

| Scope (`calendar_type`) | Sichtbar für (read) | Mutierend (write) |
|---|---|---|
| `tenancy` (Unternehmen) | alle internen Rollen (Viewer/Editor/Admin) | Admin |
| `user` (persönlich) | Owner (`membership_id`) + Admin | Owner + Admin |
| `team` | Team-Mitglieder (transitiv) + Admin — **strukturell vorbereitet, Teams fehlen** | Admin (bzw. später Team-Admin) |
| `client` (Kundenportal) | **Nichtziel** (F10) | **Nichtziel** |

- `calendar.write` ist `internalOnly`, mindestens Admin (Verwaltung im
  Einstellungsbereich). Der Termin-Dialog nutzt `appointment.write` (Editor+)
  und darf **nur sichtbare** Kalender als Ziel anbieten.
- Viewer/Editor sehen `tenancy`-Kalender; Editor sieht zusätzlich den eigenen
  `user`-Kalender; Admin sieht alle internen Kalender (decided). External/
  Worker/Fremdtenant/revoked bleiben in RLS, Service und HTML fail-closed.
- `membership_id`-Owner ist im `user`-Scope stets der aktive Actor (bzw. Admin).
- **DSGVO/Beschäftigtendatenschutz (DEC-M115B-19):** Die Admin-Sicht auf
  persönliche Kalender ist eine bewusste, begründete Abweichung (Disposition/
  Vertretung im PV-Betrieb) und bleibt auf Kalender-Metadaten
  (`name`/`color`/`active`/Termin-Zeitfenster) beschränkt; Termin-**Inhalte**
  (`description`/`location`) privater Kalender werden in der Admin-Ansicht
  redigiert. Offboarding folgt §5 (DEC-M115B-18).

## 8. Event-, Audit- und Activity-Vertrag

- Kalender-Änderungen: `domain_events` mit Aggregat `calendar`,
  `aggregate_id = calendar_id`, Eventtypen `calendar.created`,
  `calendar.updated`, `calendar.archived`; `audit_log`
  (`action calendar.create/update/archive`, `resource calendar:<id>`).
- Termin-Events bleiben `project.appointment_*` (Aggregat `project`); der
  Payload bleibt minimal (`appointmentId`, `projectId`, `revision`, optional
  `calendarId` — **kein** Titel/Ort/Zeitfenster).
- `domain_events_project_activity_idx` bleibt unverändert (keine neuen
  `project.*`-Eventtypen durch M1-15b). **DEC-M115B-20:** Ein separater
  `domain_events_calendar_activity_idx` wird in M1-15b **nicht** angelegt
  (Kalender-Aktivität wird nicht in der Projektaktivität gerendert; bei Bedarf
  späterer Reporting-Slice).

## 9. Lock-, Race- und Erasure-Vertrag

- **Lock-Ordnung (eindeutig):** (1) `ensure_personal_calendar` ist ein reines
  Insert unter partial-unique-Schutz (`calendar_ws_membership_user_uniq`) und
  hängt an keinem Project-Lock; Parallelaufrufe serialisiert der Unique-Index
  (`ON CONFLICT DO NOTHING` → bestehenden Kalender lesen). (2)
  Kalender-Mutationen (`create/update/archive`) sperren `calendar FOR UPDATE`
  (bei Create zusätzlich `calendar_category`), dann ggf. `membership`.
  (3) Termin-Mutationen behalten die M1-15-Ordnung
  Project `FOR KEY SHARE` → Calendar `FOR KEY SHARE` →
  Appointment-Insert/Update/Delete.
- **Race:** Kalender-`unique(workspace_id, name)` verhindert Namensduplikate;
  Kalender-`revision`-CAS (paralleles Rename/Archive → genau ein Schreiber
  gewinnt, der andere `conflict`); Termin-`expectedRevision`-CAS bleibt.
  **Archivierungs-Race (DEC-M115B-21):** `create_appointment` auf
  `active=false`-Kalender ist `invalid`; im Race gewinnt die Archivierung —
  ein danach commitender Termin-Create erhält `invalid`, kein Teilstand.
- **Erasure:** `calendar` und `calendar_category` sind **workspace-Stammdaten
  ohne Kontakt-PII** → **außerhalb** des `ErasureGraphIds`. Termine bleiben als
  `appointmentIds` im Graphen (`UNK-M115-02`, Root 2026-09-03: Termine werden
  bei der Kontakt-Erasure entfernt, kein Fenster-Eintrag). Das Löschen der
  Termine kaskadiert **nicht** auf den Kalender. **Die Kontakt-Erasure bleibt
  damit unberührt;** die User-/Membership-Löschung folgt dem Offboarding-Pfad
  (§5, DEC-M115B-18), nicht dem Kontakt-Erasure-Graphen.
- Eine während der Termin-Mutation committende Erasure gewinnt (M1-15 §9).

## 10. UI-Vertrag (WMEE-Design)

- **Termin-Dialog (Projektakte):** neue Pflicht-Kalenderauswahl (Dropdown der
  `list_visible_calendars`), Default = persönlicher Kalender des Actors (bzw.
  Workspace-Default); Kalenderfarbe als kleiner Farbpunkt **plus** Name
  (Icon + Text, kein Farbsignal-Only).
- **Workspaceweite Kalenderroute `/w/[workspaceId]/kalender` (DEC-M115B-13):**
  **Monatsansicht** (FullCalendar `daygrid`) mit **Scope-Filter** („Alle“ +
  einzelne sichtbare Kalender, §7) und **Kalender-Einfärbung**
  (`calendar.color`). **Nichtziel:** Planungsmodus, Wochen-/Tages-/Agenda-
  Ansichten (U3 bleibt UNKNOWN), Drag&Drop-Resize.
- **FullCalendar-Einfärbung:** Event-Farbe aus `calendar.color` (statt
  `appointment_type`); `appointment_type` bleibt als Icon/Text-Label sichtbar.
  `color=null` → neutraler WMEE-Wert.
- **Admin-Verwaltung (Einstellungsbereich „Kalender“):** Listen-Ansicht je Tab
  (persönlich/Unternehmen/Benutzer), „Kalender erstellen“ (Unternehmenskalender),
  Umbenennen/Archivieren; Google-/MS-Sync-Schaltflächen **nicht** gebaut
  (Nichtziel).
- Responsive 320/375/390/768/1024/1440/1920, 400-%-Reflow, Touchziele ≥ 44 px,
  `aria-live="polite"`, voller Tastaturpfad, Axe.

## 11. Testmatrix

| Schicht | Fälle |
|---|---|
| Unit/Contract | `calendar`-Schema (8 Felder + `revision`, `type`-Enum, `color`-Hex, Scope-Invarianten user/team/tenancy/client), `calendar-item.v1`-Minimierung (verbietet `workspace_id`/Fremd-IDs), `project-appointment-item.v1` mit `calendarId`; `update_calendar`-CAS (erwartete Revision) |
| DB | `calendar`-Migration additiv; `unique(workspace_id,name)`; Scope-Invarianten (user⇒membership, team⇒team, tenancy⇒keins); partial unique `(workspace_id, membership_id) WHERE type='user'`; `calendar_id`-FK `RESTRICT`; `category_id`-Migration (Kategorie am Kalender, nicht am Termin); **Legacy-Migrationstest:** Creator mit ≥2 `category_id`-Terminen → Termine verlustfrei, `calendar.category_id = NULL` (ACCEPTED_EXCEPTION) |
| RLS | Tenancy-Kalender für Viewer/Editor/Admin; User-Kalender nur Owner+Admin; **Editor sieht fremden User-Kalender nicht**; **Client-Scope-Zeilen fail-closed (default deny)**; External/Worker/Fremdtenant/revoked fail-closed (auch ohne Event/Audit) |
| Race | Namensduplikat-Konflikt; **Kalender-CAS: paralleles Rename/Archive → einer gewinnt, anderer `conflict`**; **zwei parallele `ensure_personal_calendar` → genau ein Kalender**; Termin-CAS bleibt; **Archivierung vs. paralleler Termin-Create → Archivierung gewinnt, Create danach `invalid`** |
| Erasure | Kontakt-Erasure löscht Termine (`appointmentIds`), lässt `calendar`/`calendar_category` unberührt; Tombstone-Hash stabil |
| Chromium E2E | Editor erstellt Termin mit Kalenderauswahl; Admin legt/archiviert Kalender; Viewer sieht nur Tenancy-Kalender; **`/kalender`-Route: Monatsansicht + Scope-Filter „Alle/einzeln“ rendert**; External abgewiesen; Axe + Tastatur + 375 px |
| A11y | Kalenderauswahl-Dropdown (Tastatur/Screenreader), Scope-Filter der Route (Tastatur/Screenreader), Icon+Text (Farbpunkt+Name), 44-px-Touchziele |

## 12. Abschlussgates

- `npm run check` (Vitest grün), Rollenproben 88/88, PG18 5/5, Fresh- +
  Legacy-Migrationspfad, `db:generate` ohne Drift, TypeScript/ESLint/
  Dependency-Cruiser, `git diff --check`, Secret-Scan, Production-Build.
- FullCalendar-Major-Pin (ADR 0021 E5) weiter gültig.
- Unabhängiger Review (Security/Race/Privacy) ohne offene P0–P2; Visual bleibt
  INCONCLUSIVE bis Mikails Freigabe.

## 13. Nichtziele (Non-Goals)

- **Gmail-/Microsoft-/Google-Workspace-Kalender-Sync** (Portal-belegt, aber
  Sync-/Integrations-Slice).
- **Planungsmodus, Wochen-/Tages-/Agenda-Ansichten** der Kalenderroute
  (U3 bleibt UNKNOWN; M1-15b liefert nur die Monatsansicht mit Scope-Filter).
- **`Client`-Scope / Kundenportal-Kalender / Buchungsseite** (F10).
- **Team-Scope fachlich** (hängt an der noch nicht gebauten `team`-Tabelle;
  strukturell vorbereitet).
- **Terminvorlagen** (`calendar-templates`) und **Kategorie-CRUD**
  (`calendar-categories`: „Kategorie erstellen“) — eigene Vorlagen-/Stammdaten-
  Slices; M1-15b lässt Kategorien read-only (wie M1-15).
- **Erinnerung/Benachrichtigung**, **Serientermine**, **Zeiterfassungs-
  Verknüpfung (F9)**, **Plantafel (F7.5)**.
- Keine öffentliche REST-API; `GET /calendars` ist nur funktionale Referenz.

## 14. DECIDED und UNKNOWN

### DECIDED

| ID | Entscheidung | Ablage |
|---|---|---|
| `DEC-M115B-01` | `calendar`-Objekt als Tabelle (4 Scopes `team\|tenancy\|user\|client`), nicht Enum/JSONB | §4.1 |
| `DEC-M115B-02` | Kalender werden **archiviert** (`active=false`), nicht hart gelöscht | §5 |
| `DEC-M115B-03` | M1-15-Kollaps wird aufgelöst: `appointment.category_id` entfällt, `calendar.category_id` + `appointment.calendar_id` (not null) treten an seine Stelle | §4.2 |
| `DEC-M115B-04` | Einfärbung über `calendar.color` (API-treu); `appointment_type` bleibt Label | §10 |
| `DEC-M115B-05` | Auto-Provisionierung des User-Standardkalenders (1:1 je Membership); Tenancy-Kalender explizit durch Admin | §3/§6 |
| `DEC-M115B-06` | RBAC je Scope: Tenancy=alle intern, User=Owner+Admin, Team=Team (vorbereitet), Client=Nichtziel | §7 |
| `DEC-M115B-07` | `calendar`/`calendar_category` außerhalb des Erasure-Graphen; Termine bleiben im Graphen | §9 |
| `DEC-M115B-08` | `calendar.write` = internalOnly, Admin | §7 |
| `DEC-M115B-09` | Eventtypen `calendar.created/updated/archived`; Termin-Events unverändert | §8 |
| `DEC-M115B-10` | `team_id` strukturell vorbereitet, FK erst mit Team-Slice (UNK-F1-01) | §4.1 |
| `DEC-M115B-11` | Migration **0049** (Root-Arbitrage: 0047 = F4.6, 0048 = v5-Leadquelle), Integrationsreihenfolge nach M3-Welle; M3-02 rückt auf 0050 | Header |
| `DEC-M115B-12` | ADR 0025 supersedes ADR 0021 E2 formell (Root O2) | ADR 0025 |
| `DEC-M115B-13` | Workspaceweite `/calendar`-Route (Monatsansicht + Scope-Filter „Alle/einzeln“) ist **Teil von M1-15b** — kein M1-15c (Root O3); Planungsmodus bleibt Nichtziel | §10 |
| `DEC-M115B-14` | Backfill: Bestands-Termine → persönlicher Kalender des `created_by` (Auto-Provisionierung zuerst), sonst Unternehmenskalender — ESTIMATE bestätigt (Root O4) | §4.2 |
| `DEC-M115B-15` | `calendar` erhält `revision`-CAS (Hausmuster; billig, schützt Rename/Archive vor Lost Updates — Root O5) | §4.1/§6 |
| `DEC-M115B-16` | Backfill: Kategorie-Zuordnung der Bestands-Termine verwirft sich (`calendar.category_id = NULL`) — `ACCEPTED_EXCEPTION` (0043-Kategorie-Bestand leer) | §4.2 |
| `DEC-M115B-17` | Auto-Kalender-Namensschema: „Persönlich — <Membership-Anzeigename>“; globaler Namens-Unique bleibt | §6 |
| `DEC-M115B-18` | Offboarding: Membership-Revoke ⇒ User-Kalender `active=false`, `membership_id` bleibt historisch | §5 |
| `DEC-M115B-19` | Admin-Sicht auf persönliche Kalender bleibt (Disposition/Vertretung), auf Metadaten beschränkt; Inhalte redigiert (Beschäftigtendatenschutz) | §7 |
| `DEC-M115B-20` | `domain_events_calendar_activity_idx` wird in M1-15b **nicht** angelegt | §8 |
| `DEC-M115B-21` | Termin-Create auf `active=false`-Kalender = `invalid`; im Archivierungs-Race gewinnt die Archivierung | §6/§9 |

### UNKNOWN

- U1: exakte Zuordnung der drei Portal-Tabs zu den vier API-Scopes
  (`personal`→`User`, `company`→`Tenancy`, `user`→`User`+`Team`) ist `INFERRED`;
  die Bedeutung des **`Client`**-Scopes ist `UNKNOWN` (vermutlich Kundenportal/
  Buchung, F10).
- U2: exakte Sichtbarkeitsregeln je Scope (sieht ein Admin wirklich alle
  User-/Team-Kalender? sieht ein Editor fremde User-Kalender?) — Portal nur
  partiell beobachtet; §7 ist `DECIDED WMEE`.
- U3: „Planungsmodus“ und Wochen-/Tages-/Agenda-Details der Kalenderansicht —
  nicht auswertbar beobachtet, nicht spezifiziert.
- U4: ~~Kalender-Revision/CAS~~ → RESOLVED (O5): `revision`-CAS (DEC-M115B-15).
- U5: ~~Backfill-Zielkalender~~ → RESOLVED (O4): persönlicher Kalender des
  `created_by`, sonst Unternehmenskalender — ESTIMATE (DEC-M115B-14).

## 15. Offene Fragen an den Root-Integrator — RESOLVED (2026-09-03)

1. **O1 — Migrationsnummer:** RESOLVED → **`0049_m1_15b_calendar_scopes.sql`** (Root-Arbitrage: 0047 = F4.6, 0048 = v5-Leadquelle)
   (nach M3-Welle; M3-02 rückt auf 0048).
2. **O2 — ADR 0021 E2:** RESOLVED → formell superseded durch **ADR 0025**
   (`docs/adr/0025-kalender-scopes.md`).
3. **O3 — Workspaceweite `/calendar`-Route:** RESOLVED → **Teil von M1-15b**
   (Scopes sind ohne die Route nicht bedienbar); kein M1-15c; §13 angepasst.
4. **O4 — Backfill:** RESOLVED → persönlicher Kalender des `created_by`
   (Auto-Provisionierung zuerst), sonst Unternehmenskalender — ESTIMATE.
5. **O5 — Kalender-CAS:** RESOLVED → `revision`-CAS (Hausmuster).
