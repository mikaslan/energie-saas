# M1-Bereitschaft — was M1 ist und was ihm im Weg steht

Stand: 2026-08-28 · Branch `tooling` · reine Repo-Analyse, kein Produktivcode geändert.

Dieses Dokument beantwortet zwei Fragen, bevor an M1 gebaut wird: Was genau umfasst M1
laut eigener Blaupause, und was steht dem im Weg? Es ist bewusst unfreundlich zu den
eigenen Plänen — Schönfärberei kostet in M1 mehr als sie einbringt.

---

## 1. Verifizierte Ausgangslage

Echte Läufe von heute (2026-08-28), nicht erneut ausgeführt:

- `npm run typecheck` — grün
- `npm run lint` — grün
- `npm run depcruise` — grün, 43 Module / 58 Dependencies, 0 Grenzverletzungen
- `npm test` — 15 Testdateien, 110 Tests, alle grün, gegen echtes Postgres mit angewendeten Migrationen

M0 ist als Commit `120f46c` („Merge M0: Multi-Tenant-Fundament, 13 Tasks +
Codex-Ultra-Review-Härtung") in `main`. Der Branch `tooling` hat seitdem Abhängigkeiten,
ein Monitoring-Gerüst und ein Hetzner-Provisionierungsskript ergänzt — aber keine einzige
Zeile Fachlogik. Der fachliche Ausgangsstand für M1 ist damit exakt der M0-Stand.

Das ist eine gute Ausgangslage: Die Qualität des Vorhandenen ist hoch, die Testkultur ist
streng, und das Fundament trägt. Der Rest dieses Dokuments beschäftigt sich deshalb mit
dem, was fehlt.

---

## 2. Was M0 bereitstellt — und was für M1 fehlt

### Vorhanden und tragfähig

| Bereich | Dateien | Zustand |
|---|---|---|
| Mandantenzugang | `lib/db/tenant.ts` | `withTenant`, `withAuthorizedTenant` + Testvarianten, fertig |
| Rechte | `lib/permissions.ts` | 3 Schichten, 9 Actions, 8 Capabilities, fail-closed |
| Events/Audit | `lib/events.ts`, `lib/audit.ts`, `lib/db/schema/events.ts` | Outbox + Audit-Log, append-only per Trigger |
| Statusmaschine | `lib/state-machine.ts` | generischer Fabrikator, eingefrorene Übergangsmatrix |
| Schema | `lib/db/schema/{core,events,site,auth}.ts` | workspace, membership, user_identity, domain_events, audit_log, site |
| Storage | `lib/storage/*` | S3-Abstraktion mit WORM-Vorbereitung |
| Auth | `lib/auth.ts`, `app/api/auth/[...all]/route.ts` | better-auth passwortlos |
| Worker | `worker/index.ts`, `worker/health.ts` | pg-boss + Heartbeat |
| Fachmodul | `modules/sites/{index,service}.ts` | **genau eines**, als Referenzmuster |
| Invarianten-Suite | `tests/db/tenant-invariants.test.ts` | prüft jede neue Tabelle generisch |

### Fehlt, und ist für M1 zwingend

**a) Es gibt keine Oberfläche.** `app/` enthält `layout.tsx` und `page.tsx` im unveränderten
`create-next-app`-Zustand — Next-Logo, „To get started, edit the page.tsx file",
`<title>Create Next App</title>`, `lang="en"` — plus die Auth-Catch-all-Route. Keine
Anwendungsrouten, kein Layout-Shell, keine Navigation, kein Formular, keine Tabelle, kein
einziges eigenes UI-Bauteil. `shadcn/ui` ist im PLAN und in der Design-Mission als Basis
gesetzt, aber **nicht installiert**: weder Radix, noch `class-variance-authority`,
`tailwind-merge` oder `lucide-react` stehen in der `package.json`; es gibt kein
`components/`-Verzeichnis und kein `docs/design/`. Die Design-Mission
(`docs/prompts/02-design-mission.md`, Branch `design`) ist geschrieben, aber nie gelaufen.

Das ist die größte Einzeldifferenz zwischen „M0 ist fertig" und „M1 ist ein nutzbares CRM".
Die Roadmap sagt für M1 „vollwertiges Handwerks-CRM standalone — erster Realbetrieb". Der
Weg dahin führt zu ungefähr gleichen Teilen über Datenmodell/Services und über eine
Oberfläche, die es zu null Prozent gibt.

**b) Es gibt keinen Server-Action-Wrapper.** `modules/sites/service.ts` beschreibt die
Autorisierungsgrenze in einem langen Kommentar:

> „die AUFRUFGRENZE — ab M1 der Server-Action-Wrapper, der die Transaktion geöffnet hat
> bzw. den Abort sieht — fängt diesen Fehler und schreibt den Denial-Audit in einer EIGENEN,
> NEUEN Transaktion NACH dem Abort"

Dieser Wrapper existiert nur als *simuliertes* Muster in `tests/db/site.test.ts`
(Zeilen 100–141), nicht als produktive Funktion. Solange er fehlt, kann kein einziger
M1-Service von außen aufgerufen werden, ohne das Muster jedes Mal neu von Hand zu
schreiben — und genau dabei geht der Denial-Audit verloren. Das ist die dringlichste
Einzelschuld aus M0.

**c) Es gibt keine Contact-Entität.** `lib/db/schema/site.ts` sagt es selbst: „Contact-FK
kommt in M1 (Contact-Tabelle existiert dort noch nicht) als additive Spalte nach."

**d) Es gibt keine Projekt-/Request-Entität.** Der „Ein-Projekt-Spine, drei Phasen"
(`Request → Offer → Installation`) aus der Kernarchitektur ist nirgends modelliert. Die
Action `phase.convert` steht bereits in `ACTION_REQUIREMENTS`, hat aber kein Objekt, auf das
sie wirken könnte. **Der M1-Roadmaptext nennt `project` nicht als eigene Position** — er
listet F1.1 bis F1.9, und der Spine steckt implizit in F1.2, F1.5 und F1.6. Das ist eine
Lücke im Plan, nicht nur im Code: Ohne `project` gibt es kein Kanban, keinen Outcome und
keinen Lead.

**e) Es gibt keine Zod-Schemata für Domänendaten.** `zod@4` und `drizzle-zod` sind
installiert, aber es existiert kein `lib/validation`, keine Schema-Registry, kein
Versionierungsmuster. Für F16.1 und F1.4 („Zod-typisierte JSONB") ist das die Kernfrage,
nicht eine Nebensache. Zu beachten: `drizzle-zod` leitet nur Schemata aus *Tabellenform* ab
— die typisierten JSONB-Inhalte müssen von Hand geschrieben und versioniert werden.

**f) Es gibt keine Transaktions-Mailfunktion für Kundenmails.** `lib/mail.ts` exportiert
genau eine Funktion, `sendAuthMail`. F1.6 verlangt für „Cannot fulfill" eine Kundenmail.

**g) Zugangsschlüssel für M1-Funktionen sind nicht beschafft.** Laut
`docs/tooling/einkaufsliste.md` sind Geoapify (Geocoding für F1.3 und den CSV-Import,
Position 7, „P1 sofort") und Stadia Maps (Kartenkacheln, Position 10) noch offen. Beides ist
Tier-2 — Registrierung durch Mikail, nicht autonom.

---

## 3. Was M1 laut Blaupause ist

Aus `docs/blaupause/05-roadmap.md`, Abschnitt „M1 — Stammdaten-Kern + CRM/Leads":

> **Module:** F16.1 minimal (eigene Komponenten mit Zod-typisierten JSONB-Daten, EK/VK,
> CSV/Excel-Import; kein Seed-Katalog-Anspruch à la 150k) · F1.1 Kontakte (Consent +
> Policy-Version, DSGVO-Zeitstempel) · F1.2 nur Pfade manuell + CSV-Bulk · F1.3
> Projektadresse/Pin an der Site · F1.4 Gebäude-/Energiedaten (energy_profile) · F1.5
> Kanban-Boards mit Spalten-Typen · F1.6 Outcome-Aktionen · F1.8 Lead Sources · F1.9
> Aufgaben/Notizen/Termine (ohne Google/MS-Sync). Querschnitt: Suche/Filter/Tags, Activity
> Feed (speist sich aus M0-Events), erste KPI-Kacheln (materialisierte Views).
>
> **Danach nutzbar:** vollwertiges Handwerks-CRM standalone — erster Realbetrieb mit
> freundlichem Betrieb möglich.
> **Abhängigkeiten:** komplett auf M0.
> **Nicht gebaut:** Broker-APIs (F1.2-Rest), AI Lead Score (F1.7), Kalender-Sync.

Die zugehörigen F-Nummern aus `docs/blaupause/01-modulkatalog.md` sind in Abschnitt 5
einzeln aufgeschlüsselt.

### Was Vollständigkeitskritik und K3-Gegenprobe zu M1 sagen

`06-vollstaendigkeitskritik.md` behandelt M1 nicht als eigenen Abschnitt, trifft es aber an
sechs Stellen direkt:

1. **Keine Zeit-/Kapazitätsachse** (5.1): „M0–M8 haben keine Wochen-Schätzungen; für einen
   Solo-Gründer mit KI-Unterstützung ist M0+M1+M2+M3 realistisch 6–12 Monate — das steht
   nirgends." Für M1 gibt es damit bis heute keine Aufwandszahl. Abschnitt 8 dieses
   Dokuments liefert die erste.
2. **DSGVO-Löschung vs. Append-only** (4.2): Der Löschzeitstempel am Contact kollidiert
   konzeptionell mit unveränderlichen Events und dem Audit-Log. `docs/konzepte/dsgvo-loeschkonzept.md`
   löst das über Pseudonymisierung — das ist eine **M1-Bauaufgabe** (Regel 2), nicht nur ein
   Konzept.
3. **Such-Skalierung, Rate-Limiting, Mandanten-Fairness** (4.4): „ein Großkunde mit
   CSV-Bulk-Import" — beides ist M1-Funktionalität (Querschnitt Suche, F1.2 CSV-Bulk) und
   beides ist unbehandelt.
4. **Migrations-/Onboarding-Pfad** (4.5): „Import ist als CSV-Lead-Import gedacht, nicht als
   Voll-Migration — für Wechselkunden entscheidend." Der M1-CSV-Import ist damit faktisch
   die einzige Tür für Bestandsdaten, ist aber nicht dafür ausgelegt.
5. **Positionierungswiderspruch** (5.4): Das Marktbild empfiehlt den Wallbox-/Elektriker-Keil,
   die Roadmap baut den PV-Residential-Pfad. Das ist **kein rein strategischer Streit** — er
   entscheidet, welche Felder `energy_profile` (F1.4) und welche Komponententypen F16.1 zuerst
   tragen müssen. Solange er offen ist, wird F1.4 entweder zu breit oder am falschen Kunden
   gebaut.
6. **Haftung für Wirtschaftlichkeits-/Förderaussagen** (3.1) betrifft M1 noch nicht direkt,
   aber die Consent-/Policy-Version-Felder aus F1.1 sind der Ort, an dem die spätere
   Disclaimer-Architektur andockt.

`07-k3-gegenprobe.md` äußert sich zu M1 **gar nicht** — die Konsultation war budgetbedingt auf
wenige hundert Token eingedampft und konzentrierte sich auf M2–M4 (Simulation vor den Piloten
ziehen, Order-Modell, Worker-SPOF). Für M1 gibt es damit **keine unabhängige Zweitmeinung**.
Das ist ehrlich zu benennen: Die M1-Planung ist bislang nur von einer Stimme geprüft. Das
OpenRouter-Guthaben war laut Gegenprobe bei 0,02 $ — ein K3-/Kimi-Gegenblick auf die
M1-Spec ist erst nach Aufladung möglich und sollte vor dem Bau des Schemas erfolgen.

---

## 4. Der Vertrag, den jede neue M1-Tabelle erfüllen muss

Das ist kein Vorschlag, sondern erzwungen von `tests/db/tenant-invariants.test.ts`. Jede neue
Tenant-Tabelle wird die Suite rot machen, bis alle sechs Punkte erfüllt sind:

1. **`workspace_id uuid NOT NULL`** — geprüft über `information_schema`.
2. **`UNIQUE (workspace_id, id)`** zusätzlich zum Primary Key, als Ziel für zusammengesetzte
   FKs (Muster: `site_ws_id_uq`).
3. **Jeder FK auf eine Tenant-Entität ist zusammengesetzt**, nie einspaltig — FK-Prüfungen in
   PostgreSQL nutzen RLS *nicht* als Sichtbarkeitsfilter (`modules/README.md`).
4. **RLS `enable` + `force`** und **genau eine permissive Policy** namens `tenant_isolation`,
   `FOR ALL`, mit exakt diesem Prädikat in `using` **und** `with check`:
   ```sql
   workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
   ```
   Der Vergleich in der Suite ist exakt (whitespace-normalisiert), kein Substring-Match. Jeder
   Zusatzfilter muss `as restrictive` sein.
5. **Eine Fixture-Factory in `tests/setup/tenant-fixtures.ts`** — ohne sie schlägt der Test
   „jede Mandantentabelle hat eine Fixture-Factory registriert" fehl.
6. **Der Cross-Write-Test muss an der RLS scheitern**, nicht an PK/FK/CHECK — die Suite prüft
   die Fehlermeldung auf `row-level security`.

Dazu kommt aus dem Modulmuster (`modules/README.md`, `modules/sites/service.ts`):

- Service-Funktion nimmt `(tx: TenantTx, ctx: ServiceCtx, input)`, prüft `can()` **zuerst**,
  wirft bei Ablehnung `PermissionDeniedError` und schreibt dabei **keinen** Audit.
- `workspaceId` wird beim Insert **zuletzt** gesetzt (`{ ...input, workspaceId: ctx.workspaceId }`),
  damit ein durchgereichtes `input.workspaceId` den verifizierten Wert nicht überschreibt.
- `emitEvent` und der Erfolgs-`writeAudit` laufen in **derselben** Transaktion.
- Event-Payloads enthalten **nur IDs, nie Klartext-Personenbezug**
  (`docs/konzepte/dsgvo-loeschkonzept.md`, Regel 1). Für M1 ist das schärfer als für M0:
  Kontakte, Notizen und Aufgaben sind personenbezogen von Natur aus.
- Jedes Modul hat genau eine öffentliche Datei `index.ts`; `app/` darf nur darauf zugreifen
  (dependency-cruiser, `severity: error`).

**Praktische Konsequenz:** Eine neue Tabelle in M1 kostet nie nur „ein Drizzle-Schema". Sie
kostet Schema + RLS-Migration + Fixture + Service + Modul-Barrel + Tests. Das ist gut so,
aber es muss in jeder Schätzung stehen.

---

## 5. M1-Arbeitsliste je F-Nummer

Notation: **E** = Entitäten, **S** = Services (Modul/Funktion), **R** = Routen/Server-Actions,
**A** = Abnahmekriterien.

### P0 — Vorbedingungen (keine F-Nummer, blockiert alles)

**P0.1 Autorisierungs-Aufrufgrenze** (`lib/server-action.ts`, neu)
- S: `serverAction(schema, action, handler)` — löst die better-auth-Session zur
  `user_identity.id` auf, nimmt die Workspace-ID aus dem Request/Cookie, validiert den Input
  per Zod, ruft `withAuthorizedTenant`, fängt `PermissionDeniedError`, schreibt den
  Denial-Audit in **neuer** Transaktion und gibt ein typisiertes `Result` zurück.
- A: Ein `viewer` löst bei einer schreibenden Action einen Audit-Eintrag mit `allowed: false`
  aus, obwohl die fachliche Transaktion abgebrochen ist (exakt der Testfall aus
  `tests/db/site.test.ts`, jetzt gegen produktiven Code). Ungültiger Input erzeugt keinen
  DB-Zugriff. Fehlende Membership erzeugt `workspace.access`-Denial.

**P0.2 Workspace-Kontext in der App**
- E: keine neue Tabelle; Auswahl in Session/Cookie.
- R: Workspace-Auswahl beim Login (eine Identität kann in n Workspaces sein), Switcher.
- A: Ein Nutzer mit zwei Memberships sieht nach dem Wechsel ausschließlich Daten des
  gewählten Workspace; die Auswahl ist serverseitig verifiziert (nicht aus dem Client
  vertraut).

**P0.3 Design-System + App-Shell** (Design-Mission, eigener Branch)
- shadcn-Installation, WMEE-Token-Set (Light + Dark), Navigation, Topbar, Content-Bereich,
  `docs/design/struktur.md`.
- A: Eine Beispielseite rendert mit den Tokens; `npm run check` bleibt grün.

**P0.4 Zod-Schema-Registry für JSONB** (`lib/validation/`, neu)
- S: Registry `typ → { version, schema, migrate }` für `catalog_component.technical_data` und
  `site.energy_profile`; Lese-Migration beim Auslesen, Schreiben immer in der aktuellen Version.
- A: Ein Datensatz in Version 1 wird beim Lesen verlustfrei nach Version 2 gehoben; ein
  unbekannter Typ oder eine unbekannte Version führt zu einem klaren Fehler, nicht zu stillem
  Datenverlust.

### F1.1 — Kontakte

- **E** `contact`: `id`, `workspace_id`, `salutation`, `first_name`, `last_name`,
  `company_name`, `is_business` (B2B-Flag), `email_primary`, `email_secondary`, `phone`,
  `phone_window` (Erreichbarkeitsfenster), Hauptadresse (`street`, `house_number`,
  `postal_code`, `city`, `country`), `marketing_consent` (bool), `consent_policy_version`
  (text), `consent_at` (timestamptz), `consent_source`, UTM-Felder (`utm_source`,
  `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`), `deleted_at` (DSGVO-Zeitstempel),
  `created_at`.
- **S** `modules/crm`: `createContact`, `updateContact`, `setMarketingConsent`,
  `anonymizeContact` (Pseudonymisierung nach Löschkonzept Regel 2).
- **R** `/kontakte` (Liste), `/kontakte/[id]` (Detail), Anlage-Dialog.
- **A**
  - Consent lässt sich nicht ohne `consent_policy_version` und `consent_at` setzen (DB-CHECK
    oder Service-Invariante, nicht nur UI).
  - Consent-Widerruf erzeugt ein `contact.consent_revoked`-Event **ohne** E-Mail im Payload.
  - `anonymizeContact` überschreibt Name, E-Mails, Telefon und Adresse mit
    `geloescht-<id>`, setzt `deleted_at`, lässt alle Fremdschlüssel intakt; danach ist der
    Kontakt in keiner Suche mehr auffindbar, seine Projekte existieren weiter.
  - `see_purchase_prices`/EK spielt hier keine Rolle, aber der Kontakt darf für einen
    `external_only`-Nutzer nur über zugewiesene Projekte sichtbar sein (restrictive Policy —
    kann in M1 als Platzhalter dokumentiert und später ergänzt werden).

### Projekt-Spine (implizit, aber Voraussetzung für F1.2/F1.5/F1.6)

- **E** `project`: `id`, `workspace_id`, `contact_id` (zusammengesetzter FK), `site_id`
  (zusammengesetzter FK), `name`, `phase` (`request|offer|installation`), `outcome`
  (`open|won|lost|cannot_fulfill`), `kanban_column_id`, `lead_source_id`,
  `key_account_manager_id`, `close_date`, `loss_reason_code`, `loss_reason_text`,
  `archived_at`, `created_at`.
- **S** `modules/projects`: `createProject`, `moveToColumn`, `convertPhase` (nutzt
  `createStateMachine`), `assignKeyAccountManager`.
- **A** Phasenübergänge laufen ausschließlich über die Statusmaschine; ein illegaler Übergang
  wirft `IllegalTransitionError`. `phase.convert` wird per `can()` geprüft. Jeder Übergang
  erzeugt ein Event.

### F1.2 — Intake: manuell + CSV-Bulk

- **E** `import_job`: `id`, `workspace_id`, `kind` (`lead|component`), `filename`,
  `status` (`pending|running|partial|done|failed`), `row_count`, `ok_count`, `error_count`,
  `created_by`, `created_at`, `finished_at`. Dazu `import_row_error`: `import_job_id`,
  `row_number`, `column`, `code`, `message`, `raw_row` (jsonb).
- **S** `modules/intake`: `startCsvImport` (parst per papaparse, validiert je Zeile gegen
  Zod, schreibt zeilenweise), `getImportReport`. Geocoding über Geoapify im Worker-Job, nicht
  im Request.
- **R** `/import` (Upload + Spalten-Mapping + Vorschau + Ergebnisbericht), Worker-Job
  `csv-import`.
- **A**
  - Ein Import mit 100 Zeilen, davon 7 fehlerhaft, endet in `status: partial` mit 93
    angelegten Datensätzen und 7 Zeilenfehlern **mit Zeilennummer und Spaltenname**.
  - Ein erneuter Import derselben Datei erzeugt keine Dubletten (Idempotenzschlüssel je Zeile).
  - Der Abbruch mitten im Lauf hinterlässt keinen halben Datensatz (Zeile = Transaktion).
  - Ein Import blockiert weder die Oberfläche noch andere Mandanten (Worker, Begrenzung der
    Zeilenzahl pro Job).

### F1.3 — Projektadresse und Pin an der Site

- **E** Ergänzungen an `site`: `contact_id` (der in `site.ts` angekündigte additive FK,
  zusammengesetzt), `geocoded_at`, `geocode_source`, `geocode_confidence`.
- **S** `modules/sites`: `geocodeSite`, `confirmPin`.
- **R** Site-Panel im Projekt-Detail mit MapLibre-Karte, verschiebbarem Pin, Bestätigungsknopf.
- **A** `pin_confirmed` wird ausschließlich durch eine bewusste Nutzerhandlung `true`; ein
  Geocoding-Treffer allein setzt es nicht. Ein Projekt ohne bestätigten Pin lässt sich anlegen,
  wird aber sichtbar als „Pin fehlt" markiert (Voraussetzung für M6-Planung).

### F1.4 — Gebäude-/Energiedaten (`energy_profile`)

- **E** `site.energy_profile` (jsonb, Zod-typisiert je `input_mode`) +
  `site.energy_profile_schema_version` (int, NOT NULL). Inhalt: `input_mode`
  (`consumption|property|roomwise|manual`), Bestandsanlagen (PV/Speicher/Wallbox/EV mit je
  Leistung/Baujahr), Verbrauch (kWh/a), Strompreis, Preissteigerung, Lastprofil-Kennung.
- **S** `modules/sites`: `setEnergyProfile` (validiert gegen das Schema des jeweiligen
  `input_mode`), `readEnergyProfile` (hebt Altversionen beim Lesen).
- **A** Ein Profil mit unbekanntem `input_mode` wird abgelehnt. Ein Profil in Schemaversion 1
  wird beim Lesen nach Version 2 gehoben, ohne die gespeicherte Zeile zu verändern. Der
  Wechsel des `input_mode` verwirft keine Daten stillschweigend, sondern verlangt eine
  Bestätigung.
- **Offene Modellfrage (siehe Risiko 6.5):** Die *Zielpakete* aus F1.4 (Solar/Speicher/
  Wallbox/Heizung, je Purchase/Lease/Financing) beschreiben die Kaufabsicht, nicht das Gebäude.
  Sie gehören ans `project`, nicht an die `site` — sonst teilen sich zwei Projekte am selben
  Haus eine Kaufabsicht, die nur einem von beiden gehört.

### F1.5 — Kanban-Boards mit Spalten-Typen

- **E** `kanban_board`: `id`, `workspace_id`, `name`, `scope` (`residential|commercial`),
  `is_default`, `archived_at`.
  `kanban_column`: `id`, `workspace_id`, `board_id` (zusammengesetzter FK), `name`,
  `column_type` (`lead|offer|won|lost`), `position` (int), `conversion_ratio`
  (numeric, nullable), `color`, `archived_at`.
- **S** `modules/boards`: `createBoard`, `createColumn`, `reorderColumns`, `archiveColumn`.
- **R** `/anfragen` (Board mit pragmatic-drag-and-drop), `/einstellungen/boards`.
- **A**
  - `position` ist innerhalb eines Boards eindeutig; Umsortieren ist transaktional
    (kein Zwischenzustand mit doppelter Position).
  - Eine Spalte mit Karten lässt sich nicht löschen, nur archivieren.
  - Das Verschieben einer Karte in eine Spalte vom Typ `won` löst **nicht** automatisch den
    Outcome `won` aus — siehe Risiko 6.3. Der Spalten-Typ steuert Automatiken (in M2 die
    Angebotsnummern-Vergabe), er *ist* nicht der Outcome.
  - Gewichtete Pipeline: Summe über `deal_value × conversion_ratio` je Spalte; Spalten ohne
    Ratio zählen mit 0, nicht mit 1.

### F1.6 — Outcome-Aktionen

- **E** Felder am `project` (siehe oben) + `loss_reason` als Workspace-konfigurierbare Liste
  (`loss_reason` Tabelle: `code`, `label`, `position`, `archived_at`).
- **S** `modules/projects`: `markWon`, `markLost`, `markCannotFulfill`, `reopen` — alle über
  eine eigene Outcome-Statusmaschine:
  ```
  open           → won, lost, cannot_fulfill
  won            → open   (reopen)
  lost           → open   (reopen)
  cannot_fulfill → ∅      (Einweg)
  ```
- **A**
  - `markLost` ohne `loss_reason_code` wird abgelehnt.
  - `reopen` löscht `loss_reason_code`, `loss_reason_text` und `close_date` und erzeugt ein
    Event; es löst **keine** CRM-Syncs aus (relevant erst ab M7, aber die Semantik gehört
    jetzt in die Statusmaschine).
  - `markCannotFulfill` versendet eine Kundenmail (setzt die fehlende generische
    Mailfunktion voraus, siehe 2f) und sperrt die spätere Signatur — in M1 als Flag am
    Projekt, das M2 auswertet.
  - Ein zweiter `markCannotFulfill` auf demselben Projekt wirft `IllegalTransitionError`.

### F1.8 — Lead Sources

- **E** `lead_source`: `id`, `workspace_id`, `name`, `color`, `archived_at`, `created_at`.
- **S** `modules/crm`: `createLeadSource`, `archiveLeadSource`.
- **A** Quellen werden archiviert, nie gelöscht; eine archivierte Quelle bleibt an
  bestehenden Projekten sichtbar, erscheint aber nicht mehr in der Auswahl. Auto-Zuweisung
  (per Broker/Funnel-Variante) ist in M1 **nicht** gebaut, das Feld dafür existiert aber.

### F1.9 — Aufgaben, Notizen, Termine

Der mit Abstand größte Block. Drei getrennte Entitäten:

- **E** `task`: `id`, `workspace_id`, `project_id` (nullable, zusammengesetzt), `title`,
  `body` (jsonb, Tiptap-Dokument), `due_at` (timestamptz, absolut), `status`
  (`open|done`), `completed_at`, `created_by`, `created_at`.
  `task_assignee`: `task_id`, `user_id` (n Nutzer).
  `task_label` + `task_label_link`.
  `task_subitem`: `task_id`, `position`, `text`, `done` (Sub-Checkliste).
  `task_template`: `title`, `body`, `due_offset_days` (relativ), `subitems` (jsonb).
- **E** `note`: `id`, `workspace_id`, `project_id`, `body` (jsonb, Tiptap mit
  `extension-mention`), `created_by`, `created_at`, `edited_at`. Mentions zusätzlich
  relational in `note_mention` (für Benachrichtigungen und Suche).
- **E** `appointment`: `id`, `workspace_id`, `project_id` (nullable), `title`,
  `starts_at`, `ends_at`, `all_day`, `location`, `scope`, `created_by`.
  `appointment_attendee`: `appointment_id`, `user_id`.
- **S** `modules/tasks`: `createTask`, `completeTask`, `assignTask`, `applyTaskTemplate`;
  `modules/notes`: `createNote`, `updateNote`; `modules/appointments`: `createAppointment`,
  `moveAppointment`.
- **R** Projekt-Detail-Tabs „Aufgaben", „Notizen"; `/kalender` (FullCalendar Core v7).
- **A**
  - `due_at` ist immer absolut gespeichert; Templates rechnen `due_offset_days` beim
    Anwenden einmalig in ein Datum um (keine Recurrence, keine Dependencies — bewusst).
  - Eine `@`-Mention in einer Notiz erzeugt eine `note_mention`-Zeile und ein Event mit
    **User-ID, nicht Name**.
  - Ein Termin über Mitternacht wird korrekt in der Wochenansicht dargestellt (Zeitzone:
    alles `timestamptz`, Anzeige in Workspace-Zeitzone).
  - **Offen:** Der Modulkatalog nennt „n User + n Teams" und „Kalender (4 Scopes)". *Teams
    gibt es in M0 nicht* („Nicht gebaut: Teams/Bereichs-Toggles, additive Spalten
    reserviert"), und die vier Scopes sind nirgends aufgezählt. Beides muss vor dem Bau
    entschieden werden — Vorschlag: M1 baut nur `n User`, `scope` bleibt ein Textfeld mit
    zunächst zwei Werten (`personal`, `project`).

### F16.1 — Komponentenkatalog (minimal)

- **E** `catalog_component`: `id`, `workspace_id`, `name`, `brand`, `component_type`
  (`module|inverter|battery|wallbox|heat_pump|mounting|other`), `sku`,
  `purchase_price_cents` (EK), `sales_price_cents` (VK), `unit`, `technical_data` (jsonb),
  `technical_data_schema_version` (int NOT NULL), `image_key`, `datasheet_key`,
  `key_points` (jsonb-Array), `archived_at`, `created_at`.
- **S** `modules/catalog`: `createComponent`, `updateComponent`, `archiveComponent`,
  `importComponentsCsv` (nutzt `import_job` aus F1.2).
- **R** `/katalog`, `/katalog/[id]`, Import-Dialog.
- **A**
  - `purchase_price_cents` verlässt den Server **nie** für Nutzer ohne
    `see_purchase_prices` — serverseitige Feldfilterung, kein Ausblenden im Client
    (Architektur §5, ausdrücklich).
  - `technical_data` wird gegen das Schema des jeweiligen `component_type` validiert;
    ein unbekannter Typ wird abgelehnt.
  - Preise sind Ganzzahlen in Cent, keine Fließkommazahlen.
  - `component_type` ist nach Anlage unveränderlich (der Katalog sagt „Typ nach Anlage fix").
  - Kein Seed-Katalog: die Tabelle startet leer, der Import ist der einzige Massenweg.

### Querschnitt

**Suche/Filter/Tags**
- **E** `tag` (`workspace_id`, `name`, `color`, `archived_at`) + `tag_link`
  (`tag_id`, `entity_type`, `entity_id`) — Tags sind laut Katalog rein visuell, ohne
  Automationen und ohne Rechtewirkung.
- **A** Freitextsuche über Kontaktname, Projektname und Adresse; kombinierbare Filter
  (Phase, Outcome, Datum, Zuständiger, Quelle, Tag, archiviert). Umsetzung in M1 über
  Postgres-Trigram-Index (`pg_trgm`), nicht über eine externe Suchmaschine. **Achtung:** ein
  GIN-Index über Kontaktdaten macht die Suche nicht RLS-blind — RLS gilt weiterhin, aber die
  Antwortzeit bei einem Großmandanten ist zu messen, nicht zu vermuten
  (Vollständigkeitskritik 4.4).

**Activity Feed**
- Read-only Projektion aus `domain_events`, gefiltert auf `aggregate_id = project.id` sowie
  auf verknüpfte Aggregate.
- **A** Der Feed zeigt keine Wertdetails (der Katalog sagt „Events ohne Wertdetails"), und er
  zeigt keine personenbezogenen Klartexte — er kann sie gar nicht zeigen, weil sie laut
  Löschkonzept Regel 1 nicht im Payload stehen. Anzeigenamen werden zur Laufzeit über die IDs
  nachgeschlagen.

**Erste KPI-Kacheln**
- Der Roadmaptext sagt „materialisierte Views". **Das ist so nicht baubar**, siehe Risiko 6.6.

---

## 6. Risiken speziell für M1

### 6.1 Zod-typisierte JSONB-Komponentendaten: Schema-Evolution (hoch)

Das Muster „JSONB + Zod-Schema je Typ" löst das Validierungsproblem und schafft ein neues:
Sobald der erste Kunde 300 Wechselrichter erfasst hat, ist jede Schemaänderung eine
Datenmigration ohne Migrationswerkzeug — Drizzle migriert Spalten, nicht JSONB-Inhalte.

Konkrete Fallen:
- **Feld umbenennen** — alte Zeilen validieren nicht mehr, das Modul wirft beim Lesen.
- **Pflichtfeld hinzufügen** — alle Altzeilen sind sofort ungültig.
- **Typ ändern** (String → Zahl) — stiller Fehler, wenn das Schema per `coerce` arbeitet.

Gegenmaßnahme, verbindlich ab der ersten Zeile: `technical_data_schema_version` als eigene
Spalte (NOT NULL, nicht im JSONB), eine Registry pro Typ mit expliziten
`migrate_v1_to_v2`-Funktionen, Lesen migriert immer nach oben, Schreiben immer in der
aktuellsten Version, und ein Test, der für **jede** registrierte Version ein Golden-Fixture
durch alle Migrationsschritte schickt. Ohne diese Spalte ist die Version im JSONB selbst
versteckt und lässt sich nicht indizieren oder per SQL zählen — dann weiß niemand, wie viele
Altzeilen es überhaupt noch gibt.

Zusatzrisiko: Ein Wechsel zurück auf feste Spalten ist teuer. Die Entscheidung „JSONB statt
Spalten" sollte deshalb nicht für *alle* technischen Daten gelten — Felder, nach denen
gefiltert oder sortiert wird (Leistung in kWp, Speicherkapazität), gehören als echte Spalten
ins Schema, nicht ins JSONB. Der Katalog verlangt das nicht, aber die Filterbarkeit im
Angebotseditor (M2) wird es verlangen.

### 6.2 CSV-/Excel-Import: Fehlerbehandlung und Teilerfolge (hoch)

Der Import ist die einzige Massentür in M1 und laut Vollständigkeitskritik (4.5) faktisch auch
der Migrationspfad für Wechselkunden — obwohl er dafür nicht ausgelegt ist.

- **Teilerfolg ist der Normalfall, nicht der Ausnahmefall.** Ein Alles-oder-nichts-Import ist
  bei 400 Zeilen aus einer gewachsenen Excel-Datei praktisch immer „nichts". Zeile =
  Transaktion, Job = Bericht.
- **Fehler müssen zurückverfolgbar sein.** Zeilennummer, Spaltenname, Rohwert und ein
  stabiler Fehlercode — nicht „Import fehlgeschlagen".
- **Wiederholbarkeit.** Ein zweiter Lauf derselben Datei darf keine Dubletten erzeugen.
  Vorschlag: Idempotenzschlüssel je Zeile aus `import_job_id + row_number`, plus fachliches
  Dedupe (E-Mail bei Kontakten, SKU bei Komponenten).
- **Encoding und Trennzeichen.** Deutsche Excel-Exporte sind CP1252 mit Semikolon und
  Komma-Dezimaltrennzeichen. Das ist kein Randfall, das ist der Standardfall. Zahlen wie
  `1.234,56` müssen erkannt werden, sonst entstehen Preise um den Faktor 1000 daneben.
- **Excel (xlsx) ist noch nicht entschieden.** `docs/tooling/entscheidungen.md` Punkt 5 sagt
  ausdrücklich: „Excel-(xlsx)-Import erst in der M1-Spec entscheiden." Da die Roadmap
  „CSV/Excel-Import" schreibt, der Beschaffungsstand aber nur papaparse (CSV) umfasst, ist das
  eine offene Entscheidung, keine Implementierungsfrage.
- **Mandanten-Fairness.** Ein Import mit 50.000 Zeilen darf keine anderen Mandanten
  ausbremsen (Vollständigkeitskritik 4.4). In M1 mindestens: harte Zeilenobergrenze pro Job,
  ein Job pro Workspace gleichzeitig, Ausführung im Worker.
- **Geocoding im Import.** Geoapify Free hat 3.000 Credits/Tag. Ein 5.000-Zeilen-Import
  sprengt das Tageskontingent. Der Import braucht Rate-Limiting und einen Zustand
  „Geocoding ausstehend", statt am Limit zu scheitern.

### 6.3 Kanban-Spalten-Typ getrennt vom Outcome (mittel, aber teuer bei Fehlentscheidung)

Die Kernarchitektur ist eindeutig: „Zwei Achsen pro Karte: Kanban-Spalte
(workspace-konfigurierbar) getrennt vom Outcome (`Open/Won/Lost/Cannot fulfill`)." Der
Spalten-**Typ** (`Lead/Offer/Won/Lost`) steuert Automatiken, er ist aber nicht der Outcome.

Die Verlockung, beides zu koppeln („Karte in Won-Spalte ⇒ Outcome = won"), ist groß, weil es
in der Oberfläche natürlicher wirkt. Sie ist falsch, und zwar aus drei Gründen:

1. Ein Workspace darf mehrere Spalten vom Typ `won` haben (z. B. „Gewonnen — Montage
   geplant" und „Gewonnen — wartet auf Termin"). Eine Kopplung macht den Outcome von der
   Spaltenkonfiguration abhängig.
2. `Cannot fulfill` hat gar keinen Spalten-Typ — es ist ein reiner Outcome. Bei Kopplung
   fällt es aus dem Modell.
3. `Reopen` müsste die Karte zurückschieben, obwohl der Nutzer die Karte vielleicht bewusst
   dort liegen lassen will.

**Empfehlung:** Beide Achsen strikt getrennt speichern und getrennt setzen. Der Spalten-Typ
darf einen Outcome *vorschlagen* (Dialog: „Karte in eine Won-Spalte verschoben — als
gewonnen markieren?"), nie automatisch setzen. Die Automatik, die der Katalog dem Spalten-Typ
zuschreibt, ist die Angebotsnummern-Vergabe in M2 — nicht der Outcome.

Ein Test, der das festhält, gehört in M1: „Verschieben in eine `won`-Spalte ändert
`project.outcome` nicht."

### 6.4 DSGVO-Consent am Kontakt mit Policy-Version (mittel, rechtlich scharf)

Consent ohne Nachweis ist wertlos. Drei Fehler sind leicht zu machen:

1. **Consent als einzelnes Bool.** Ein `marketing_consent = true` ohne Version, Zeitpunkt und
   Quelle lässt sich im Streitfall nicht belegen. Die drei Felder gehören zusammen und
   sollten gemeinsam erzwungen werden (DB-CHECK: `marketing_consent = false OR
   (consent_policy_version IS NOT NULL AND consent_at IS NOT NULL)`).
2. **Consent-Historie überschreiben.** Wenn ein Kunde zustimmt, widerruft und erneut
   zustimmt, braucht es drei Einträge, nicht ein Feld. Der saubere Weg in diesem Repo ist der
   vorhandene: `domain_events` ist append-only und trägt die Historie ohnehin — die
   `contact`-Spalten sind dann nur der aktuelle Stand. Voraussetzung: Die Events tragen
   Version und Zeitpunkt, aber **keine E-Mail-Adresse** (Löschkonzept Regel 1).
3. **Kollision mit dem Löschanspruch.** Genau hier trifft Vollständigkeitskritik 4.2 zu:
   `anonymizeContact` überschreibt die Kontaktzeile, aber die Consent-Events bleiben. Das ist
   nach dem Löschkonzept korrekt (nur IDs im Payload), muss aber in M1 auch so gebaut sein —
   sonst steht die E-Mail-Adresse für immer in einer append-only-Tabelle.

Zusätzlich fehlt bislang: Wo werden die Policy-Versionen selbst verwaltet? Ein
`consent_policy`-Eintrag pro Workspace (Version, Text, gültig ab) ist nicht in der Roadmap,
aber ohne ihn ist die Versionsnummer ein Freitextfeld ohne Bedeutung. Kleiner Aufwand, sollte
in M1 mit.

### 6.5 Site vs. Projekt: wo die Zielpakete leben (mittel)

`energy_profile` gehört laut Architektur an die Site — richtig für Gebäudedaten, Bestandsanlagen
und Verbrauch. Die *Zielpakete* aus F1.4 (Solar/Speicher/Wallbox/Heizung, je
Purchase/Lease/Financing) sind aber Kaufabsicht und gehören ans Projekt. Der Katalogtext wirft
beides in einen Satz. Wenn das ungeprüft ins Schema wandert, teilen sich „PV heute" und „WP
nächstes Jahr" am selben Haus eine Zielpaket-Struktur — genau der Fall, für den die Site-Entität
überhaupt eingeführt wurde.

### 6.6 KPI-Kacheln als materialisierte Views sind aktuell **verboten** (hoch, konkreter Blocker)

Die Roadmap schreibt für M1: „erste KPI-Kacheln (materialisierte Views)". Die eigene
Invarianten-Suite verbietet das:

> „Eine Matview speichert Cross-Tenant-Ergebnisse PHYSISCH und erbt die RLS ihrer
> Basistabellen NICHT. … solange keine ein explizit tenantgeschütztes Cache-Muster mitbringt
> (eigener Schutznachweis + Eintrag hier), ist jede Matview in `public` ein Suite-Fehler."
> (`tests/setup/tenant-fixtures.ts`, `MATVIEW_ALLOWLIST` — derzeit leer)

Das ist kein Versehen, sondern Codex-Review-Befund #5 aus M0. Wer in M1 eine Matview anlegt,
macht `npm test` rot und umgeht die Mandantengrenze.

Drei gangbare Wege, in dieser Reihenfolge:
1. **Erst gar keine Matview.** Sechs KPI-Kacheln über einige tausend Projekte sind gewöhnliche
   Aggregat-Queries unter RLS. Für M1 mit einem freundlichen Pilotbetrieb reicht das mit
   Sicherheit. Diese Option kostet nichts und ist die Empfehlung.
2. **Vorberechnete Tabelle statt Matview** — eine normale Tenant-Tabelle `kpi_snapshot` mit
   `workspace_id`, RLS und Fixture, gefüllt vom Worker. Erfüllt alle Invarianten ohne Ausnahme.
3. **Matview mit Schutznachweis** — nur wenn 1 und 2 messbar nicht reichen, und dann mit
   `workspace_id` in der View, eigener Zugriffsfunktion und Eintrag in `MATVIEW_ALLOWLIST`.

**Der Roadmaptext sollte entsprechend korrigiert werden.** Er widerspricht der eigenen
Testsuite.

### 6.7 Die Oberfläche ist der eigentliche M1-Aufwand (hoch)

M1 ist im Kern kein Datenmodell-Meilenstein, sondern der erste UI-Meilenstein — und die UI
startet bei null. Kanban mit Drag & Drop, virtualisierte Tabellen, Rich-Text-Editor,
Kalender, Karte mit Pin, Import-Assistent mit Spalten-Mapping und Fehlerbericht: das sind
sechs eigenständige Interaktionsflächen, jede mit eigenen Randfällen. Die Bibliotheken sind
beschafft, aber keine Zeile davon ist integriert, und das Design-System, auf dem sie sitzen
sollen, existiert nicht.

Wer M1 nach Datenmodell schätzt, unterschätzt es um mindestens die Hälfte.

### 6.8 Teams sind in F1.9 verlangt, in M0 aber ausdrücklich nicht gebaut (mittel)

F1.9 sagt „n User + n Teams"; M0 sagt „Nicht gebaut: Teams/Bereichs-Toggles (additive Spalten
reserviert)". Beides kann stimmen — dann baut M1 nur Nutzer-Zuweisung. Es muss aber
entschieden und aufgeschrieben werden, sonst wird es beim Bauen implizit entschieden.
Dasselbe gilt für die „4 Scopes" des Kalenders, die nirgends aufgezählt sind.

### 6.9 Keine unabhängige Zweitmeinung zu M1 (mittel)

`07-k3-gegenprobe.md` prüft M2–M4, nicht M1, und war budgetbedingt stark eingeschränkt
(Restguthaben 0,02 $). Die M1-Planung ist damit einstimmig — was in diesem Projekt sonst
bewusst vermieden wird. Vor dem Bau des Schemas sollte ein Kimi-/Codex-Gegenblick auf die
Schema-Skizze aus Abschnitt 7 laufen.

### 6.10 Externe Abhängigkeiten sind noch nicht beschafft (niedrig, aber blockierend zum falschen Zeitpunkt)

Geoapify (F1.3, CSV-Geocoding) und Stadia Maps (Kartenkacheln) sind laut Einkaufsliste „P1
sofort" bzw. „P1", aber offen. Für Entwicklung reicht OpenFreeMap ohne Schlüssel; sobald F1.3
über die Kartenanzeige hinausgeht, braucht es die Keys. Beides ist Tier-2 (Registrierung durch
Mikail) und sollte vor dem F1.3-Sprint erledigt sein, nicht während.

---

## 7. Schema-Skizze für M1 (Vorschlag, kein Produktivcode)

Stil bewusst identisch zu `lib/db/schema/site.ts`: expliziter `foreignKey` auf `workspace`,
`uniqueIndex` auf `(workspaceId, id)` als Ziel künftiger zusammengesetzter FKs, alle FKs auf
Tenant-Entitäten zweispaltig. Zu **jeder** dieser Tabellen gehört eine RLS-Migration nach dem
Muster `drizzle/0008_site_rls.sql` und ein Eintrag in `tests/setup/tenant-fixtures.ts` — sonst
wird die Invarianten-Suite rot.

Diese Skizze ist ein Diskussionsstand für die M1-Spec, nicht der fertige Code. Sie gehört vor
dem Bau durch einen Codex-Review und (siehe 6.9) durch eine unabhängige Zweitmeinung.

### 7.1 Kontakt (F1.1)

```ts
// lib/db/schema/contact.ts  — VORSCHLAG
export const contact = pgTable("contact", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),

  salutation: text("salutation"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  companyName: text("company_name"),
  isBusiness: boolean("is_business").notNull().default(false),

  emailPrimary: text("email_primary"),
  emailSecondary: text("email_secondary"),
  phone: text("phone"),
  phoneWindow: text("phone_window"),          // Erreichbarkeitsfenster (Freitext)

  street: text("street"),
  houseNumber: text("house_number"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country").notNull().default("DE"),

  // DSGVO: Consent NUR gemeinsam mit Version + Zeitpunkt (CHECK in der Migration).
  marketingConsent: boolean("marketing_consent").notNull().default(false),
  consentPolicyVersion: text("consent_policy_version"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  consentSource: text("consent_source"),      // "manual" | "csv" | "funnel" | ...

  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),

  // Löschkonzept Regel 2: Pseudonymisierung + Zeitstempel, Zeile bleibt bestehen.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("contact_ws_idx").on(t.workspaceId),
  uniqueIndex("contact_ws_id_uq").on(t.workspaceId, t.id),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "contact_workspace_id_fk" }),
]);
```

Begleitende Migration (Auszug, das Wesentliche):

```sql
alter table contact add constraint contact_consent_complete_chk
  check (marketing_consent = false
         or (consent_policy_version is not null and consent_at is not null));

alter table contact enable row level security;
alter table contact force row level security;
create policy tenant_isolation on contact
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
```

### 7.2 Projekt-Spine (Voraussetzung für F1.2/F1.5/F1.6)

```ts
// lib/db/schema/project.ts — VORSCHLAG
export const projectPhases = ["request", "offer", "installation"] as const;
export const projectOutcomes = ["open", "won", "lost", "cannot_fulfill"] as const;

export const project = pgTable("project", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  siteId: uuid("site_id"),                     // erst mit bestätigtem Pin Pflicht (M6)

  name: text("name").notNull(),
  phase: text("phase").$type<(typeof projectPhases)[number]>().notNull().default("request"),
  outcome: text("outcome").$type<(typeof projectOutcomes)[number]>().notNull().default("open"),

  kanbanColumnId: uuid("kanban_column_id"),
  leadSourceId: uuid("lead_source_id"),
  keyAccountManagerId: uuid("key_account_manager_id"),   // genau 1 (Katalog M1)

  dealValueCents: integer("deal_value_cents"),           // Forecast ≠ Kundenpreis
  closeDate: timestamp("close_date", { withTimezone: true }),
  lossReasonCode: text("loss_reason_code"),
  lossReasonText: text("loss_reason_text"),

  archivedAt: timestamp("archived_at", { withTimezone: true }),  // Archivieren ≠ Schließen
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("project_ws_idx").on(t.workspaceId),
  index("project_ws_column_idx").on(t.workspaceId, t.kanbanColumnId),
  uniqueIndex("project_ws_id_uq").on(t.workspaceId, t.id),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "project_workspace_id_fk" }),
  // ZUSAMMENGESETZT — modules/README.md, sonst Cross-Tenant-Referenz möglich
  foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contact.workspaceId, contact.id], name: "project_contact_fk" }),
  foreignKey({ columns: [t.workspaceId, t.siteId], foreignColumns: [site.workspaceId, site.id], name: "project_site_fk" }),
  foreignKey({ columns: [t.workspaceId, t.kanbanColumnId], foreignColumns: [kanbanColumn.workspaceId, kanbanColumn.id], name: "project_column_fk" }),
  foreignKey({ columns: [t.workspaceId, t.leadSourceId], foreignColumns: [leadSource.workspaceId, leadSource.id], name: "project_lead_source_fk" }),
]);
```

Dazu zwei Statusmaschinen in `modules/projects/state.ts`:

```ts
export const phaseMachine = createStateMachine<Phase>({
  request:      ["offer"],
  offer:        ["installation"],
  installation: [],
});

export const outcomeMachine = createStateMachine<Outcome>({
  open:           ["won", "lost", "cannot_fulfill"],
  won:            ["open"],   // Reopen
  lost:           ["open"],   // Reopen
  cannot_fulfill: [],         // Einweg (Katalog F1.6)
});
```

### 7.3 Kanban (F1.5)

```ts
export const kanbanBoard = pgTable("kanban_board", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  scope: text("scope").$type<"residential" | "commercial">().notNull().default("residential"),
  isDefault: boolean("is_default").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("kanban_board_ws_id_uq").on(t.workspaceId, t.id),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "kanban_board_workspace_id_fk" }),
]);

export const columnTypes = ["lead", "offer", "won", "lost"] as const;

export const kanbanColumn = pgTable("kanban_column", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  boardId: uuid("board_id").notNull(),
  name: text("name").notNull(),
  // steuert AUTOMATIKEN (ab M2 Angebotsnummern-Vergabe) — ist NICHT der Outcome
  columnType: text("column_type").$type<(typeof columnTypes)[number]>().notNull(),
  position: integer("position").notNull(),
  conversionRatio: numeric("conversion_ratio", { precision: 5, scale: 4 }), // null = zählt 0
  color: text("color"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("kanban_column_ws_id_uq").on(t.workspaceId, t.id),
  uniqueIndex("kanban_column_board_pos_uq").on(t.workspaceId, t.boardId, t.position),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "kanban_column_workspace_id_fk" }),
  foreignKey({ columns: [t.workspaceId, t.boardId], foreignColumns: [kanbanBoard.workspaceId, kanbanBoard.id], name: "kanban_column_board_fk" }),
]);
```

Hinweis zum `position`-Unique: Umsortieren braucht dann ein `deferrable initially deferred`
oder eine Zwei-Phasen-Umnummerierung in einer Transaktion. Alternativ `position` als
`numeric` mit Lückenvergabe (1024, 2048, …) und ohne Unique — das ist der pragmatischere Weg
und sollte in der Spec entschieden werden.

### 7.4 Komponentenkatalog (F16.1)

```ts
export const componentTypes = [
  "module", "inverter", "battery", "wallbox", "heat_pump", "mounting", "other",
] as const;

export const catalogComponent = pgTable("catalog_component", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),

  name: text("name").notNull(),
  brand: text("brand"),
  sku: text("sku"),
  componentType: text("component_type").$type<(typeof componentTypes)[number]>().notNull(),

  // Cent-Ganzzahlen, keine Fließkommazahlen. EK verlässt den Server nur mit
  // Capability see_purchase_prices (Architektur §5, serverseitige Filterung).
  purchasePriceCents: integer("purchase_price_cents"),
  salesPriceCents: integer("sales_price_cents"),
  unit: text("unit").notNull().default("Stk"),

  // Zod-typisiert je componentType. Version als EIGENE SPALTE (indizierbar,
  // zählbar) — nicht im JSONB versteckt. Siehe Risiko 6.1.
  technicalData: jsonb("technical_data").$type<Record<string, unknown>>().notNull().default({}),
  technicalDataSchemaVersion: integer("technical_data_schema_version").notNull().default(1),

  imageKey: text("image_key"),
  datasheetKey: text("datasheet_key"),
  keyPoints: jsonb("key_points").$type<string[]>().notNull().default([]),

  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("catalog_component_ws_id_uq").on(t.workspaceId, t.id),
  index("catalog_component_ws_type_idx").on(t.workspaceId, t.componentType),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "catalog_component_workspace_id_fk" }),
]);
```

### 7.5 Lead Sources (F1.8)

```ts
export const leadSource = pgTable("lead_source", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  color: text("color"),
  // Katalog F1.8: archivierbar statt löschbar
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("lead_source_ws_id_uq").on(t.workspaceId, t.id),
  uniqueIndex("lead_source_ws_name_uq").on(t.workspaceId, t.name),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "lead_source_workspace_id_fk" }),
]);
```

### 7.6 Aufgaben, Notizen, Termine (F1.9)

```ts
export const task = pgTable("task", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id"),                 // nullable: freistehende Aufgaben erlaubt
  title: text("title").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>(),   // Tiptap-Dokument
  dueAt: timestamp("due_at", { withTimezone: true }),     // ABSOLUT (Katalog F1.9)
  status: text("status").$type<"open" | "done">().notNull().default("open"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("task_ws_id_uq").on(t.workspaceId, t.id),
  index("task_ws_due_idx").on(t.workspaceId, t.dueAt),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "task_workspace_id_fk" }),
  foreignKey({ columns: [t.workspaceId, t.projectId], foreignColumns: [project.workspaceId, project.id], name: "task_project_fk" }),
]);

// n:m Zuweisung — Teams bewusst NICHT (M0 hat keine Teams, siehe Risiko 6.8)
export const taskAssignee = pgTable("task_assignee", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  taskId: uuid("task_id").notNull(),
  userId: uuid("user_id").notNull(),
}, (t) => [
  uniqueIndex("task_assignee_ws_id_uq").on(t.workspaceId, t.id),
  uniqueIndex("task_assignee_uq").on(t.workspaceId, t.taskId, t.userId),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "task_assignee_workspace_id_fk" }),
  foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [task.workspaceId, task.id], name: "task_assignee_task_fk" }),
]);

export const note = pgTable("note", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),  // Tiptap + Mentions
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("note_ws_id_uq").on(t.workspaceId, t.id),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "note_workspace_id_fk" }),
  foreignKey({ columns: [t.workspaceId, t.projectId], foreignColumns: [project.workspaceId, project.id], name: "note_project_fk" }),
]);

export const appointment = pgTable("appointment", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id"),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  scope: text("scope").notNull().default("project"),   // 4 Scopes im Katalog nicht aufgezählt
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("appointment_ws_id_uq").on(t.workspaceId, t.id),
  index("appointment_ws_start_idx").on(t.workspaceId, t.startsAt),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "appointment_workspace_id_fk" }),
]);
```

Ergänzend, ohne ausformulierte Skizze: `task_label`, `task_label_link`, `task_subitem`,
`task_template`, `note_mention`, `appointment_attendee`, `tag`, `tag_link`, `loss_reason`,
`consent_policy`, `import_job`, `import_row_error`. Alle nach demselben Muster.

**Tabellenzahl gesamt: rund 20 neue Tenant-Tabellen.** Jede mit RLS-Migration, Fixture und
Tests. Das ist die realistische Größenordnung von M1 auf der Datenseite — und der Grund,
warum die Reihenfolge in Abschnitt 8 wichtiger ist als die Vollständigkeit.

---

## 8. Reihenfolge, Abhängigkeiten und Aufwand

### 8.1 Abhängigkeitskette

```
P0.1 Server-Action-Wrapper ──┬─→ ALLE Services (keine Ausnahme)
P0.2 Workspace-Kontext ──────┘
P0.3 Design-System/Shell ────→ ALLE Seiten   (unabhängig, parallel baubar)
P0.4 Zod-Registry ───────────→ F16.1, F1.4

F1.1 contact ────────────────→ project ──┬─→ F1.5 Kanban ──→ F1.6 Outcome
F1.8 lead_source ────────────→ project ──┤
F1.3 site+contact_id ────────→ project ──┘
                                         └─→ F1.9 Tasks/Notes/Appointments
                                         └─→ Activity Feed
                                         └─→ Suche/Filter/Tags
                                         └─→ KPI-Kacheln
F16.1 catalog_component (unabhängig von project) ──→ F1.2 CSV-Import (teilt import_job)
F1.4 energy_profile (hängt an site + P0.4)
```

Drei Dinge fallen auf:

1. **`project` ist der Flaschenhals.** Fünf F-Nummern hängen daran, und es steht nicht als
   eigene Position in der Roadmap. Es gehört als erste Entität nach `contact` gebaut.
2. **F16.1 ist unabhängig** vom gesamten CRM-Strang. Es kann parallel laufen und ist der
   natürliche Übungsplatz für die Zod-Registry (P0.4) — ohne den Kanban-Strang zu blockieren.
3. **Das Design-System ist von allem entkoppelt** und blockiert alles. Es sollte als erstes
   parallel gestartet werden, weil es die längste Vorlaufzeit hat und niemand darauf warten
   will.

### 8.2 Erster kundensichtbarer Nutzen

Der früheste Punkt, an dem ein Installateur etwas Nützliches sieht, ist:

**Kontakt anlegen → Projekt anlegen → Karte auf dem Kanban verschieben → gewonnen/verloren
markieren.**

Das sind: P0.1, P0.2, P0.3, F1.1, `project`, F1.5, F1.6, F1.8. In dieser Reihenfolge, und
nichts dazwischen. Aufgaben (F1.9), Katalog (F16.1), Import (F1.2) und Gebäudedaten (F1.4)
sind wertvoll, aber keiner davon macht die Anwendung von „nichts" zu „etwas".

Das ist zugleich der ehrlichste Zuschnitt für einen ersten freundlichen Betrieb: Ein
Handwerksbetrieb, der Leads auf einer Tafel verschiebt und Gewonnen/Verloren markiert, hat
bereits mehr als eine WhatsApp-Gruppe. Er hat noch kein CRM — dafür fehlen Aufgaben und
Notizen. Aber er hat einen Grund, das Programm ein zweites Mal zu öffnen.

### 8.3 Aufwandsschätzung

Grobe Schätzung in Personentagen für Solo-Arbeit mit KI-Unterstützung, **inklusive** RLS-Migration,
Fixture, Service, Tests und Oberfläche. Sie ist die erste Zahl, die es für M1 überhaupt gibt —
`06-vollstaendigkeitskritik.md` (5.1) rügt zu Recht, dass die Roadmap keine Zeitachse hat.
Entsprechend ist sie mit Vorsicht zu lesen: eine Schätzung ohne Vergleichsdaten aus diesem
Projekt, nicht eine Planung.

| Position | Aufwand (PT) | Anmerkung |
|---|---|---|
| P0.1 Server-Action-Wrapper | 1–2 | reiner Backend-Schritt, hoch testbar |
| P0.2 Workspace-Kontext/Switcher | 1–2 | |
| P0.3 Design-System + App-Shell | 3–5 | eigene Mission, parallel |
| P0.4 Zod-Registry + Versionierung | 1–2 | zahlt auf F16.1 und F1.4 ein |
| F1.1 Kontakte | 2–3 | inkl. Consent-CHECK und Pseudonymisierung |
| Projekt-Spine (implizit) | 2–3 | inkl. beider Statusmaschinen |
| F1.8 Lead Sources | 0,5–1 | kleinste Position |
| F1.5 Kanban + Board-Konfiguration | 3–5 | Drag & Drop, Umsortier-Transaktionen |
| F1.6 Outcome-Aktionen | 1–2 | +0,5 für die fehlende Kundenmail-Funktion |
| F1.3 Site/Pin/Geocoding | 2–3 | setzt Geoapify-Key voraus |
| F1.4 energy_profile | 2–3 | hängt an P0.4 |
| F16.1 Komponenten (ohne Import) | 2–3 | inkl. EK-Serialisierungsfilter |
| F1.2 CSV-Import (Leads + Komponenten) | 4–6 | Teilerfolge, Encoding, Worker, Bericht |
| F1.9 Aufgaben/Notizen/Termine | 5–8 | größter Einzelblock, 8 Tabellen, 3 UI-Flächen |
| Querschnitt Suche/Filter/Tags | 3–4 | pg_trgm, kombinierbare Filter |
| Activity Feed | 1–2 | Projektion, keine neue Tabelle |
| KPI-Kacheln (ohne Matview) | 2–3 | siehe Risiko 6.6 |
| **Summe** | **36–57 PT** | ≈ 7–11 Arbeitswochen solo |

Das deckt sich grob mit der Einschätzung aus der Vollständigkeitskritik („M0+M1+M2+M3
realistisch 6–12 Monate"). Wer M1 in zwei Wochen erwartet, plant an der Realität vorbei.

### 8.4 Was in einer Sitzung schaffbar ist

**Empfehlung: P0.1, der Server-Action-Wrapper — gegen das bereits existierende sites-Modul.**

Zuschnitt:
- `lib/server-action.ts` mit `serverAction(inputSchema, action, handler)`.
- Eine echte Server Action `app/(app)/sites/actions.ts`, die `createSite` darüber aufruft.
- Tests: Erfolgspfad (Insert + Event + Audit committen gemeinsam), Denial-Pfad (Transaktion
  bricht ab, Denial-Audit steht trotzdem in einer neuen Transaktion), Validierungspfad
  (ungültiger Input erreicht die DB nie), Membership-Pfad (`workspace.access`-Denial).
- `npm run check` bleibt grün.

Warum genau das:
- Es ist **keine neue Tabelle** — der Vertrag aus Abschnitt 4 muss nicht bedient werden, die
  Sitzung geht nicht in RLS-Migrationen auf.
- Es löst die **dringlichste Schuld aus M0**: das Boundary-Pattern existiert nur als Test.
- Es ist **exakt vermessen**: `tests/db/site.test.ts` Zeilen 100–141 beschreibt das
  Sollverhalten bereits Zeile für Zeile. Der Test schreibt sich fast von selbst.
- **Jede** weitere M1-Position hängt daran. Ohne den Wrapper wird das Muster in jedem Modul
  neu erfunden und irgendwo falsch.

Zweite Sitzung, falls die erste schnell fertig ist: `contact` (F1.1) komplett — Schema,
RLS-Migration, Consent-CHECK, Fixture, `createContact`/`anonymizeContact`, Tests. Das ist der
erste vollständige Durchlauf des Tabellen-Vertrags aus Abschnitt 4 und kalibriert alle
weiteren Schätzungen.

Parallel, unabhängig und ohne Konflikt: die Design-Mission auf Branch `design` starten. Sie
berührt keine Datei, die P0.1 anfasst.

---

## 9. M1-Startempfehlung

Ohne weitere Recherche umsetzbar:

1. **Vor dem ersten Commit vier Entscheidungen treffen und aufschreiben** (je 1–2 Sätze in
   `docs/adr/`, das Verfahren dafür steht schon):
   - **`project` gehört zu M1.** Die Roadmap ergänzen — ohne den Spine gibt es kein F1.5 und
     kein F1.6.
   - **KPI-Kacheln ohne materialisierte View.** Der Roadmapsatz „erste KPI-Kacheln
     (materialisierte Views)" widerspricht der eigenen Testsuite und wird zu „Aggregat-Queries
     unter RLS, Vorberechnung als `kpi_snapshot`-Tabelle erst bei gemessenem Bedarf".
   - **Keine Teams in M1.** F1.9 wird auf `n User` zugeschnitten; Kalender-`scope` startet mit
     `personal` und `project`.
   - **xlsx ja oder nein.** Die Tooling-Entscheidung hat das ausdrücklich in die M1-Spec
     vertagt. Vorschlag: CSV in M1, xlsx erst wenn ein echter Kunde eine .xlsx schickt.
2. **P0.1 als erste Sitzung bauen** (Zuschnitt siehe 8.4).
3. **Design-Mission parallel starten** — sie hat die längste Vorlaufzeit und blockiert später
   jede Seite.
4. **Geoapify- und Stadia-Konten registrieren lassen** (Tier-2, Mikail) — bevor F1.3 ansteht,
   nicht während.
5. **Danach in dieser Reihenfolge:** F1.1 → `project` → F1.8 → F1.5 → F1.6. An diesem Punkt
   existiert die kleinste Anwendung, die ein Handwerksbetrieb zweimal öffnet.
6. **Erst danach** F16.1 + P0.4 (unabhängiger Strang), dann F1.3/F1.4, dann F1.2, dann F1.9,
   zuletzt der Querschnitt.
7. **Vor dem Bau des Schemas** die Skizze aus Abschnitt 7 durch `/codex-review` und — sobald
   OpenRouter-Guthaben da ist — durch einen Kimi-Gegenblick schicken. M1 ist bisher die
   einzige Planungsstufe ohne unabhängige Zweitmeinung.

**Der eine Satz:** M1 ist kein Datenmodell-Meilenstein, sondern der erste UI-Meilenstein mit
rund 20 neuen Tenant-Tabellen dahinter, er ist mit 36–57 Personentagen etwa dreimal so groß
wie er in der Roadmap aussieht, und der einzig sinnvolle erste Schritt ist der
Server-Action-Wrapper, den M0 in seinen eigenen Kommentaren bereits als „ab M1" angekündigt hat.

---

## 10. Offene Fragen, die niemand im Repo beantwortet

1. **Positionierung:** Wallbox-/Elektriker-Keil (Marktbild) oder PV-Residential (Roadmap)? Die
   Antwort bestimmt, welche Felder `energy_profile` und welche `component_type`-Schemata zuerst
   gebaut werden. Solange sie offen ist, wird F1.4 zu breit gebaut.
2. **Die vier Kalender-Scopes** aus F1.9 sind nirgends aufgezählt.
3. **Die Default-Kanban-Spalten** eines neuen Workspace sind unbekannt — der Modulkatalog
   führt sie ausdrücklich unter „nur per Demo-Zugang klärbar". Vorschlag: eine eigene,
   plausible Vorgabe setzen (Neu / Kontaktiert / Termin / Angebot / Gewonnen / Verloren) und
   sie als Workspace-Vorlage konfigurierbar machen.
4. **Die Loss-Reason-Werteliste** ebenso — gleicher Vorschlag: eigene Vorgabe, konfigurierbar.
5. **Das CSV-Spaltenschema für den Lead-Import** („Excel-Import-Spaltenschema" steht ebenfalls
   auf der „nur per Demo klärbar"-Liste). Für M1 heißt das: eigenes Schema definieren, plus
   ein Spalten-Mapping-Schritt in der Oberfläche, damit fremde Dateien trotzdem passen.
6. **Wer betreibt die Consent-Policy-Versionen** — Workspace-eigen oder plattformweit?
7. **`external_only`** ist als Capability und als geplante restrictive Policy vorgesehen, aber
   es gibt keine Zuweisungstabelle (welcher Nutzer sieht welches Projekt). In M1 nur
   dokumentieren oder gleich bauen?
