# ADR 0021 — Termine & Kalender: Kategorien als Tabelle, Appointment ohne Kalender-Objekt, Typ-Enum, Hard-Delete, FullCalendar-Major-Pin/CSR, Zeitzone

- Status: VORGESCHLAGEN (im Rahmen der M1-15-Spec DISCOVERED→SPECIFIED)
- Datum: 2026-09-02
- Betroffene Slice-Spec: `docs/spec/M1-15-termine-kalender.md`
- Basis: `01b52e9` (M1-12a)
- Referenz: `docs/parity/REONIC-API-CAPABILITY-MAP.md` (Appointments/Calendars/Calendar Categories), OpenAPI v3.11.0 (DOCUMENTED)

## Kontext

M1-15 (Termine & Kalender, F1.9) führt Termine an der Projektakte ein. Die
öffentliche Reonic-OpenAPI `3.11.0` dokumentiert sieben Operationen
(`GET/POST /appointments…`, `GET /calendars`, `GET /calendarCategories`) und
modelliert alle drei Ressourcen als **inline** Objekte (keine benannten
`components.schemas`). Fünf Modellierungsfragen sind durch die Spec **nicht**
vorentschieden und müssen bewusst getroffen werden, weil sie den
Datenbankvertrag und die UI prägen:

1. **Kategorien**: `CalendarCategory` = `{id, name, order}` — **ohne** Farbe.
   Die Farbe (`color`, Hex) liegt am `Calendar`, nicht an der Kategorie.
2. **Kalender-Hierarchie**: `Appointment` verlangt `calendarId` (required),
   `Calendar` trägt `type ∈ {Team, Tenancy, User, Client}` plus `userId`/
   `teamId`/`categoryId` — die vollen „4 Scopes“ inkl. Google/MS-Sync. M1-15
   ist bewusst nur auf Termine **an Projekten** begrenzt.
3. **Termin-Typ**: Das `Appointment`-Objekt hat **kein** Typ-Feld und **kein**
   Erinnerungsfeld. Der einzige `type`-Enum der Domäne ist der Kalender-Scope.
4. **Delete**: `POST /appointments/{id}/delete` ist ein echtes Löschen
   (Response `{data:{id}}`); das `Appointment`-Schema hat **kein** `deletedAt`.
5. **FullCalendar**: `package.json` installiert `@fullcalendar/react@7.0.2`
   neben `@fullcalendar/core`/`daygrid`/`timegrid`/`list`/`interaction@6.1.21` —
   ein **harter Major-Konflikt** (`@fullcalendar/react@7` deklariert
   `@fullcalendar/core@7.0.2` als Abhängigkeit; die Plugins verlangen
   `@fullcalendar/core@~6.1.21`).

Dieses ADR legt die Entscheidungen fest, damit M1-15 einen Implementierer ohne
Rückfragen starten kann. Es wiederholt keine verifizierten Muster
(Tenant-Schlüssel, RLS/FORCE-RLS, additive Migration, Outbox), sondern verweist
darauf.

## Entscheidung 1 — Kalender-Kategorien: eigene Tabelle (leer), kein Enum

**Gewählt:** `calendar_category` als eigene, workspace-gebundene Tabelle mit
`id`, `workspace_id`, `name` (1–200), `order` (int ≥ 0), `created_at`. **Kein**
`color` (die API führt an der Kategorie keine Farbe). M1-15 liefert nur die
Tabelle + Read-Projektion, **keine** Kategorie-CRUD (die API exponiert nur
`GET /calendarCategories`, keine create/update/delete). Startbestand **leer**
(„Katalog-startet-leer“-Prinzip: keine erfundenen Kategorienamen).

**Verworfen:**

1. **Enum statt Tabelle.** Ein Enum kann keine workspace-individuelle Ordnung
   (`order`, „lower values come first“) und keine künftige create/update-Pflege
   tragen; die API modelliert Kategorien als eigene, geordnete Ressource, nicht
   als geschlossene Werteliste.
2. **Kategorie mit `color`-Spalte.** Die API trennt Kategorie (Name+Ordnung)
   strikt von Farbe (liegt am Kalender). Ein `color` an der Kategorie wäre eine
   erfundene Feld-Semantik. Die Termin-Einfärbung trägt stattdessen der
   `appointment_type` (Entscheidung 3).

**Begründung:** 1:1-Parität ist bei einer geordneten, erweiterbaren Tabelle
sauber nachweisbar; das Fehlen von API-create hält sie in M1-15 read-only und
leer, ohne inventierte Stammdaten.

## Entscheidung 2 — Kein `calendar`-Objekt in M1-15; Appointment hängt am Project

**Gewählt:** `project_appointment` hängt direkt am `project`
(`workspace_id`-Composite-FK) und trägt optional `category_id`
(→ `calendar_category`). Es gibt **keine** `calendar`-Tabelle und **keinen**
`calendarId`. Die 4-Scope-Kalenderhierarchie (`Team/Tenancy/User/Client`,
`userId`/`teamId`, Google/MS-Sync) ist Nichtziel (F7-/Integrations-Slices).

**Verworfen:**

1. **Volle `calendar`-Tabelle** (id/name/color/categoryId/userId/teamId/type/
   active). Zöge Team-/User-/Mandanten-Kalender, `1:1-Teamkalender` und
   Sync-Scope in einen Slice, der laut Auftrag nur „Termine an Projekten“
   liefern soll.
2. **`calendarId` als Pflicht-FK ohne Objekt.** Ein Pflicht-Fremdschlüssel auf
   eine nicht existierende Ressource ist sinnlos; die API-Pflicht
   `calendarId` wird deshalb als `ACCEPTED_EXCEPTION` (Nichtreplikation)
   geführt, nicht als leerer Platzhalter.

**Begründung:** Der Auftrag begrenzt M1-15 auf die Projektakte. Die
Projektverknüpfung (`residentialProjectId`/`commercialProjectId`, nullable,
mutually exclusive) ist API-belegt und wird auf unser
`project_id` abgebildet. Der Kategorie-Sprung `calendar → category` wird zu
`appointment → category` **kollabiert** (DECIDED WMEE), weil das Kalender-Objekt
selbst entfällt; das hält die Kategorie für die Ansicht nutzbar, ohne einen
leeren Kalender-Knoten einzuführen.

## Entscheidung 3 — Termin-Typ als DECIDED-WMEE-Enum (API hat keinen)

**Gewählt:** `appointment_type` (not null) mit WMEE-Werteliste
`on_site | phone | installation | maintenance | consultation | other`
(interne snake_case, Muster M1-14 `salutation`). Der Typ trägt die
Termin-Einfärbung in FullCalendar (feste WMEE-Farbzuordnung, Muster
`project_task_label`). Erinnerung bleibt **Nichtziel** und ist zusätzlich
API-seitig nicht vorhanden.

**Verworfen:** Auf einen Typ verzichten und nur `title` anzeigen. Der Auftrag
verlangt explizit einen „Typ (DECIDED-Werte falls API-Enum unbelegt)“; ein
Typ erleichtert Monats-/Wochen-Übersicht und Filterung. Die Werteliste ist
eine **Produktentscheidung** (kein erfundenes Preisdatum); die exakte Liste
bleibt bis Root-Bestätigung `ESTIMATE` (offene Frage O3).

**Begründung:** Die API belegt weder Typ noch Erinnerung; der Typ wird daher
ehrlich als `DECIDED WMEE` geführt und nicht als Reonic-Parität behauptet.

## Entscheidung 4 — Delete = Hard-Delete (API-treu), Historie über Event/Audit

**Gewählt:** `delete_appointment` löscht die Zeile (`DELETE`, keine
`deleted_at`-Spalte); `project_appointment_attendee` löscht über
`ON DELETE CASCADE` mit. `domain_events` (`project.appointment_deleted`) und
`audit_log` (in derselben Transaktion) konservieren die Historie
(ID-only-Payload, keine PII).

**Verworfen:** Soft-Delete (`deleted_at`), wie es die Notes-Spec (M1-13) wählt.
Dort war Soft-Delete nötig, weil die API **keinen** Delete-Endpunkt kennt;
Termine haben dagegen einen echten Delete-Endpunkt und **kein** `deletedAt`
im Schema. Ein erfundener `deleted_at` würde die Paritäts-Form verwässern und
die Erasure-Logik verdoppeln.

**Begründung:** API-treu, einfach, und die WORM-Outbox (`domain_events`) plus
`audit_log` sind bereits der belastbare Historien-Mechanismus.

## Entscheidung 5 — FullCalendar: konsistenter Major-Pin + Client-Side-Rendering

**Gewählt:**

- **Version pin** (vor RED verpflichtend): alle `@fullcalendar/*` auf
  **eine** konsistente Major-Linie. Empfohlen `6.1.x` durchgängig
  (`@fullcalendar/react@^6.1.21` + `core`/`daygrid`/`timegrid`/`list`/
  `interaction@^6.1.21`), da vier der fünf Pakete bereits `6.1.21` sind und
  kein `temporal-polyfill` nötig wird. (Alternative `7.0.2` vollständig —
  dann zusätzlich `temporal-polyfill` und alle Plugins auf `7.0.2`.) Der
  Ist-Zustand (`react@7` + `core/plugins@6`) wird **nicht** als lauffähig
  angenommen.
- **CSR:** FullCalendar wird als schmales Client-Wrapper-Modul
  (`appointment-calendar.tsx`) gerendert; die Daten (minimierte
  `project-appointment-range.v1`-DTOs) werden **serverseitig** (RSC,
  autorisiert, RLS-gefiltert, Zeitzonen-Normalisierung) geladen und als
  Props übergeben. **Kein** Server-Side-Rendering der Grid (FullCalendar
  braucht Browser-Layout; SSR brächte keinen Wert und Hydration-Risiken).

**Verworfen:** Vollständiges SSR/Hydration der Kalender-Grid oder ein
selbstgebauter Kalender. SSR der Grid ist bei FullCalendar nicht sinnvoll;
ein Eigenbau verletzt die Vorgabe, das bereits installierte FullCalendar zu
nutzen.

**Begründung:** Der installierte Versions-Mix ist ein realer, blockierender
Befund der Repo-Realität; die Entscheidung macht den Implementierer auf den
Pflicht-Pin aufmerksam und legt CSR als Normalfall fest.

## Entscheidung 6 — Zeitzone Europe/Berlin an der Service-Grenze, Speicherung UTC

**Gewählt:** `start_at`/`end_at` sind `timestamptz` (PostgreSQL intern UTC).
Alle Ein-/Ausgaben werden an **einer** Service-Grenze nach
`Europe/Berlin` normalisiert (serverseitig, **nie** Client-Lokalzeit).
`all_day = true` terminiert als reines Datum (Tag in `Europe/Berlin`), das
Zeit-Komponenten ignoriert; Invariante `end ≥ start + 1 Tag` bei `all_day`.

**Verworfen:** Zeitzone als `text`-Spalte ohne Offset oder Client-seitige
Konvertierung. Beides führt zu Sommerzeit-/DST-Fehlern und nicht
reproduzierbaren Zeitfenstern.

**Begründung:** Die API liefert `date-time` (ISO 8601) ohne Zeitzonen-Semantik;
`Europe/Berlin` ist die im Auftrag genannte Zielzeitzone. Ein fester
Zeitzonen-Grenzpunkt macht die Semantik deterministisch und testbar.

## Konsequenzen

- Migration `0043_m1_15_appointments_calendar.sql` (additiv; Nummer nach den
  parallelen Lanes 0040=M1-11b, 0041=M1-13, 0042=M1-14).
- Drei neue Tabellen (`project_appointment`, `project_appointment_attendee`,
  `calendar_category`); `calendar_category` startet leer, keine erfundenen
  Stammdaten.
- Neuer Graphen-Knoten in der Erasure: `ErasureGraphIds.appointmentIds?` +
  quellgepinnte `erase_inactive_lead`-Erweiterung löscht Termine (und kaskadierend
  Teilnehmer) des Contact-Graphen; `calendar_category` bleibt außerhalb des
  Graphen (workspace-Stammdaten ohne Kontakt-PII).
- `domain_events_project_activity_idx` muss in `0043` additiv um
  `project.appointment_created/updated/deleted` erweitert werden.
- Keine öffentliche REST-API in M1-15; die API-Operationen sind funktionale
  Referenz für Datenmodell und Semantik, nicht ein zu bauender Endpunkt.
- FullCalendar-Major-Pin ist eine **Vor-RED-Pflicht** (sonst läuft der
  Kalender nicht oder bundlet zwei `core`-Versionen).
