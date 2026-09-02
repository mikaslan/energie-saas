# M1-14 — Kontakt-Datensatz (F1.1)

- Status: DISCOVERED → SPECIFIED
- Datum: 2026-09-02
- F-Bezug: F1.1 Kontaktverwaltung (Contact als zentrale Datenachse) — PARTIAL
- Architektur: ADR 0020
- Basis: `01b52e9` (M1-12a) [L01:44]
- Geplante Migration: `0042_m1_14_contact_dataset.sql` (Root-Fix: 0040 = M1-11b, 0041 = M1-13, 0042 = M1-14;
  Basis `01b52e9` endet bei `0039`;
  Integration in der Reihenfolge 0040 → 0041 → 0042.)
  
  

> **Scope-Disziplin.** Dieses Dokument spezifiziert den vollständigen
> Kontakt-Datensatz **in der eigenen Projektakte**. Es baut keine öffentliche
> REST-API; die Reonic-OpenAPI ist ausschließlich funktionale Referenz für
> Datenmodell und Semantik. Die bestehende `site`-Logik (Projekt-/Planungs-
> adresse, Pin, Geocoding) bleibt unangetastet [ADR 0020].

## Quellenlegende

- `SRC-API-SPEC` — Reonic OpenAPI v3.11.0, `https://api.reonic.de/rest/v3/openapi`,
  DOCUMENTED (öffentliche Spec, **kein** API-Call mit Key), kartiert in
  `docs/parity/REONIC-API-CAPABILITY-MAP.md`
- `API-MAP:N` — `docs/parity/REONIC-API-CAPABILITY-MAP.md`, Zeile N
- `MODKAT:F1.1` — `docs/blaupause/01-modulkatalog.md`, Zeile 13 (F1.1)
- `GOAL:F1` — `REONIC-PARITY-GOAL-PROMPT.md`, §8 F1 („Contact als zentrale
  Datenachse …“)
- `CRM` — `lib/db/schema/crm.ts` (Ist-`contact`-Tabelle)
- `INTAKE` — `lib/db/schema/intake.ts` (UTM im `inbound_receipt.acquisition`)
- `ERASURE` — `drizzle/0027_m1_07_gdpr_erasure.sql` (`erase_inactive_lead`)
- `M111A/0039` — `drizzle/0039_m1_11a_project_outcome.sql` (Revision/CAS-Muster)
- `M111B` — Spec `M1-11b-cannot-fulfil.md` (quellgepinnte Funktionsersetzung)
- `ADR0020` — `docs/adr/0020-kontakt-datenmodell.md`

## 1. Nutzerergebnis

Ein interner Editor/Admin sieht in der Projektakte einen vollständigen,
editierbaren Kontakt-Datensatz: Vor-/Nachname, Anrede, B2B-Markierung, bis zu
zwei E-Mail-Adressen, Mobil- und Festnetznummer, Erreichbarkeitsfenster, eine
vom Planungsstandort getrennte Kontaktadresse, Marketing-Consent mit
Policy-Version und Datenschutzlink sowie UTM-/Kampagnenfelder. Jede Änderung
läuft revisionsgebunden (CAS), erzeugt ein Activity-Event und einen
Audit-Eintrag und ist für Viewer/External/Fremdmandant vollständig
fail-closed. Der DSGVO-Löschmarker (`deleted_at`) und die bestehende
Erasure-Grenze bleiben bindend; neue PII-Spalten werden bei einer Erasure
mitgelöscht.

## 2. Clean-Room-Evidenz (API) und Gap-Analyse

### 2.1 API-Operationen (DOCUMENTED)

| Methode + Pfad | Mut. | Schema | Hinweise (API) |
|---|---|---|---|
| `GET /contacts` | — | `Contact[]` (gepaginated) | Filter: `email`, `phoneNumber` (E.164), `createdAt.gt/.lt`, `updatedAt.gt/.lt`, `page`, `itemsPerPage` (1–200, default 50), `sort` (Felder `fullName`, `createdAt`; default `-createdAt`) |
| `GET /contacts/{contactId}` | — | `ContactDetail` | — |
| `POST /contacts/create` | create | `ContactCreate` → `ContactDetail` | „Allowed API keys: Read and Write, Lead creation only“ |
| `POST /contacts/{contactId}/update` | update | `object` → `ContactDetail` | „Allowed API keys: Read and Write“; 404 → `{message}` |

- **Kein Delete-Endpunkt** vorhanden. Der DSGVO-Löschmarker ist das Feld
  `deletedAt` (soft-delete-Zeitstempel) im `Contact`-Schema; der Mechanismus,
  der es setzt, ist in der öffentlichen Spec **nicht** exponiert → `UNKNOWN`
  (UNK-M114-01).
- **Keine BETA-Markierung** an den Contacts-Endpunkten (im Gegensatz zu Time
  Tracking/Checklists/Wiki/Photogrammetry).

### 2.2 API-Schemas (DOCUMENTED)

`Contact` (14 Pflichtfelder): `id`*, `fullName`* (aus Vor+Nachname kombiniert),
`firstName`*, `lastName`*, `salutation`* (Enum `Female|Male|Diverse|Family|
Business|null`), `primaryEmail`*, `secondaryEmail`*, `mobile`*, `phone`*,
`phoneReachability`* (Enum `Morning|Afternoon|Evening|Fulltime|WeekendOnly|
EmailOnly|null`), `address`* (Objekt `street/houseNumber/city/postcode/
country`), `createdAt`*, `updatedAt`*, `deletedAt`*.

`ContactDetail` = `Contact` + `commercialProjectIds[]`, `residentialProjectIds[]`,
`marketingConsent`* (bool), `marketingConsentText`, `marketingConsentDataProtectionLink`,
`utm` (Objekt `campaign/content/medium/source/term`), `integrations` (Objekt
`bitrixId/hubspotId/pdsId/photovateId/pipedriveId/weclappId`).

`ContactCreate` (Pflicht: `firstName`*, `lastName`*, `marketingConsent`*; Rest
optional). `update`-Body enthält nur `firstName, lastName, salutation,
primaryEmail, secondaryEmail, mobile, phone, phoneReachability, address,
integrations` — **nicht** `marketingConsent*`, `utm` (create-only in der API).

Beobachtungen, die die Spec treiben:

- **Anrede/B2B:** Die API kennt kein separates B2B-Flag; `Business` im
  Anrede-Enum ist der einzige beobachtbare Träger. Der Modulkatalog verlangt
  ein explizites „B2B-Flag“ [MODKAT:F1.1] → DECIDED M114-02 (ADR 0020).
- **Policy-Version:** Die API hat `marketingConsent` nur als Boolean + Text +
  Link, **keine** Version. Goal-Prompt F1 verlangt „Policy-Version“ [GOAL:F1]
  → WMEE-Erweiterung DECIDED M114-06.
- **Erreichbarkeitsfenster:** API-belegt über `phoneReachability`-Enum → wird
  übernommen (kein UNKNOWN).

### 2.3 Gap-Analyse Ist-Repo ↔ API-Felder

| Feld | API (Status) | Ist-Repo | Aktion |
|---|---|---|---|
| `id` | DOCUMENTED (uuid) | `contact.id` [CRM:18] | vorhanden |
| `fullName` | DOCUMENTED (kombiniert) | `displayName` (gespeichert, nicht kombiniert) [CRM:20] | `displayName` = `btrim(first || ' ' || last)` serverseitig halten [ADR 0020] |
| `firstName` | DOCUMENTED (Pflicht bei Create) | — | NEU `first_name` (not null) |
| `lastName` | DOCUMENTED (Pflicht bei Create) | — | NEU `last_name` (not null) |
| `salutation` | DOCUMENTED (Enum) | — | NEU `salutation` (Enum + null) |
| `primaryEmail` | DOCUMENTED | `emailPrimary`/`emailNormalized` [CRM:21-22] | vorhanden |
| `secondaryEmail` | DOCUMENTED | — | NEU `email_secondary` |
| `mobile` | DOCUMENTED | — | NEU `phone_mobile` |
| `phone` | DOCUMENTED | `phoneRaw`/`phoneE164` [CRM:23-24] | vorhanden |
| `phoneReachability` | DOCUMENTED (Enum) | — | NEU `phone_reachability` (Enum) |
| `address` (street/houseNumber/city/postcode/country) | DOCUMENTED | — (nur `site`, andere Semantik) | NEU 5 flache Spalten am `contact`; `site` unangetastet [ADR 0020] |
| `marketingConsent` | DOCUMENTED (bool) | `marketingConsent` [CRM:25] | vorhanden |
| `marketingConsentText` | DOCUMENTED | — | NEU `marketing_consent_text` |
| `marketingConsentDataProtectionLink` | DOCUMENTED | — | NEU `marketing_consent_data_protection_link` |
| Consent Policy-Version | NICHT in API | — (nur `marketingConsentAt`/`Source` [CRM:26-27]) | NEU `marketing_consent_policy_version` (WMEE) [ADR 0020] |
| `utm` (campaign/content/medium/source/term) | DOCUMENTED | nur `inbound_receipt.acquisition.utm` (Intake, nicht am Contact) [INTAKE:26] | NEU 5 UTM-Spalten am Contact; aus Intake befüllen |
| `integrations` (6 CRM-IDs) | DOCUMENTED | — | NON-GOAL (M1-14); späteres Integrations-Slice |
| `deletedAt` (DSGVO-Löschmarker) | DOCUMENTED | `deletedAt` [CRM:29] | vorhanden; Edit auf gelöschtem Contact fail-closed |
| `createdAt`/`updatedAt` | DOCUMENTED | vorhanden [CRM:30-31] | vorhanden |
| B2B-Markierung | implizit via `salutation=Business` | — | NEU `is_business` + Invariante [ADR 0020] |
| Revision/CAS | nicht in API | — (Muster: `site.address_revision`, `project.outcome_revision`) | NEU `revision` [ADR 0020] |
| `commercialProjectIds`/`residentialProjectIds` | DOCUMENTED | ableitbar über `project.contactId` | DERIVED (Lesemodell), keine Spalte |

## 3. Capability-Sheet (Goal-Prompt §7)

### 3.1 Gemeinsamer Liefervertrag

- **Modul:** CRM (F1). **Tenant-/Owner-Scope:** Workspace + Contact
  (`workspace_id`-Composite-Schlüssel, FORCE-RLS wie Bestand).
- **Akteur/Rolle:** interner Viewer read-only; interner Editor/Admin
  editierend (Capability `contact.write`, `internalOnly`); `external_only`,
  Worker, Auth, System und Fremdmandant fail-closed.
- **Route/Oberfläche:** Projektakte `/w/[workspaceId]/anfragen/[projectId]`,
  Sektion „Identität und Kontakt“ (liest heute nur `displayName`/`email`/
  `phone`); Edit als Server-Action, keine öffentliche REST-API.
- **Notifications:** nur lokale `aria-live`-Ergebnisse; keine externe Mail.
- **Loading/Empty/Error/Success/Disabled/Permission-Denied:** echte getrennte
  Zustände; fehlende Optionale rendern als „Nicht hinterlegt“, nie als
  Existenz-Orakel; Denied/NotFound ohne Contact-Leak.
- **Desktop/Tablet/Mobile:** responsive 320/375/390/768/1024/1440/1920,
  400-%-Reflow, kein Seiten-Overflow, Touchziele ≥ 44 px.
- **Keyboard:** vollständiger Formularpfad ohne Maus.
- **Offline:** kein Offline-Schreibversprechen; sicherer Online-Fehlerzustand.
- **Paritätsstatus:** FUNCTIONAL (eigenständige Ausgestaltung, API als
  Referenz); kein Anspruch auf private Reonic-Interna.
- **Confidence:** API-Felder hoch (DOCUMENTED); interne Ausgestaltung
  (Revision, Policy-Version, B2B-Flag) DECIDED WMEE.
- **Owner:** Root; UI-/Test-Lanes mit unabhängigen Abschlussprüfungen.
- **Letzte Prüfung:** 2026-09-02 (Discovery/Spec; noch nicht implementiert).

### 3.2 Feingranulare Capabilities

| ID / F-Nr. | Job, Trigger, Happy Path | Eingaben / Validierungen | Zustand / Nebenwirkung | Recht / Daten / Event | Tests | Status |
|---|---|---|---|---|---|---|
| `M114-01` / F1.1 | Projektakte liest vollständigen Contact-Datensatz | autorisierte Workspace-/Project-ID | read-only DTO; Denied/NotFound ohne Orakel | `contact.read`; Contact-DTO ohne EK-/Fremd-PII | `M114-DB-01`, `M114-RBAC-01`, `M114-E2E-01` | SPECIFIED |
| `M114-02` / F1.1 | Editor ändert Stammdaten revisionsgebunden | allowlistete Felder, `expectedRevision`; Name 1–200, E-Mail-Format/≤254, E.164 | `revision+1`, `updatedAt`; CAS null Zeilen = Conflict | `contact.write`; Contact; `contact.updated` | `M114-SVC-01`, `M114-DB-02`, `M114-ACTION-01`, `M114-RACE-01` | SPECIFIED |
| `M114-03` / F1.1 | Anrede + B2B-Flag setzen | `salutation` ∈ Enum(+null); `is_business` bool; Invariante `business ⇒ is_business` | persistente Spalten; CHECK-Constraint | `contact.write`; Contact | `M114-CONTRACT-01`, `M114-DB-01` | SPECIFIED |
| `M114-04` / F1.1 | mehrere Kontaktwege (2× E-Mail, Mobil, Festnetz) | Normalisierung E-Mail/E.164; Sekundär-/Mobil nullable | flache Spalten [ADR 0020] | `contact.write`; Contact | `M114-CONTRACT-02`, `M114-DB-01` | SPECIFIED |
| `M114-05` / F1.1 | Kontaktadresse getrennt von Projektadresse | 5 nullable Spalten, PLZ-Muster, Längen; `site` unverändert | nur `contact`-Spalten; kein Site-Touch | `contact.write`; Contact | `M114-CONTRACT-03`, `M114-DB-01` | SPECIFIED |
| `M114-06` / F1.1 | Marketing-Consent mit Policy-Version | bool + Version + Text + Link + At + Source; Consent-CHECK | Consent-Spalten; Event/Audit (Historie) | `contact.write`; `contact.marketing_consent_changed` | `M114-CONTRACT-04`, `M114-DB-03` | SPECIFIED |
| `M114-07` / F1.1 | DSGVO-Löschmarker + Erasure | `deleted_at` vorhanden; Edit auf gelöschtem Contact fail-closed; Scrub-Erweiterung | Erasure scrubbt neue PII-Spalten | `contact.write`/Erasure; `erase_inactive_lead` erweitert | `M114-ERASURE-01/02` | SPECIFIED |
| `M114-08` / F1.1 | UTM-/Kampagnenfelder | 5 nullable Spalten; aus `inbound_receipt.acquisition.utm` befüllt | Contact-Spalten; bei Erasure genullt | `contact.write`; Contact | `M114-CONTRACT-05`, `M114-ERASURE-01` | SPECIFIED |
| `M114-09` / F1.1 | Erreichbarkeitsfenster | `phone_reachability` Enum (6 Werte + null), API-belegt | persistente Spalte | `contact.write`; Contact | `M114-CONTRACT-06` | SPECIFIED |
| `M114-10` / F1.1 | Activity-Event + Audit | — | `domain_events` (`contact.updated`) + `audit_log`; Payload ohne PII-Werte | Trigger/Service wie Muster | `M114-EVENT-01` | SPECIFIED |
| `M114-11` / F1.1 | RLS/RBAC fail-closed | — | Viewer/External/Fremdmandant/Worker lesen/mutieren nicht | RLS/FORCE-RLS + Actions | `M114-RBAC-01/02` | SPECIFIED |
| `M114-12` / F1.1 | Race/CAS | paralleler Edit | genau ein Schreiber gewinnt; anderer Conflict ohne Teilstand | Project→Contact-Lockreihenfolge | `M114-RACE-01/02` | SPECIFIED |
| `M114-13` / F1.1 | Migration + Rollenvertrag | — | additive Migration, `db:generate` ohne Drift, Rollenprobe | Migrator/Runtime/Worker | `M114-MIG-01`, Rollenprobe | SPECIFIED |
| `M114-14` / F1.1 | UI/A11y | — | Editor-/Viewer-Zustände, Axe, Tastatur, 375 px | — | `M114-E2E-01…04`, `M114-A11Y-01` | SPECIFIED |

## 4. Datenmodell und Datenbankvertrag (Migration 0042)

Additiv am `contact` [CRM] (Details ADR 0020):

| Spalte | Typ | Hinweis |
|---|---|---|
| `first_name` | text not null | 1–200, CHECK |
| `last_name` | text not null | 1–200, CHECK |
| `salutation` | text | CHECK `in ('female','male','diverse','family','business') or null` |
| `is_business` | boolean not null default false | CHECK `salutation='business' ⇒ is_business` |
| `email_secondary` | text | nullable, ≤254, E-Mail-Format |
| `phone_mobile` | text | nullable, E.164-Muster (wie `phone_e164`) |
| `phone_reachability` | text | CHECK `in ('morning','afternoon','evening','fulltime','weekend_only','email_only') or null` |
| `address_street` / `address_house_number` / `address_postal_code` / `address_city` / `address_country` | text (je nullable) | Längen; PLZ-Muster `^[0-9]{5}$` für DE |
| `marketing_consent_policy_version` | text | nullable, 1–100 |
| `marketing_consent_text` | text | nullable |
| `marketing_consent_data_protection_link` | text | nullable, `https://` |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` | text (je nullable) | je ≤1000 |
| `revision` | integer not null default 1 | CHECK `between 1 and 2147483647` |

- `display_name` bleibt NOT NULL und wird serverseitig auf
  `btrim(first_name || ' ' || last_name)` gehalten; bestehende
  `contact_active_identity_ck`-Semantik bleibt (Name oder E-Mail oder Telefon).
- **Backfill:** bestehende Zeilen erhalten `first_name`/`last_name` per
  Split-on-first-space aus `display_name` (Eintoken-Fall: beide = Token;
  exakte Regel ESTIMATE/Implementierungsdetail, vom Intake künftig durch echte
  Vor-/Nachnamen ersetzt). `is_business = false`, `revision = 1`.
- **UTM-Backfill:** beim Intake werden die UTM-Spalten des Contacts aus
  `inbound_receipt.acquisition.utm` [INTAKE:26] befüllt (nur wenn leer bzw.
  beim Create); kein Rückwärts-Reprocessing alter Receipts in M1-14
  (DECIDED M114-08).
- **Erasure (quellgepinnt):** `erase_inactive_lead()` [ERASURE] wird um die
  neuen PII-Spalten in seiner UPDATE-Spaltenliste erweitert (SHA-256-Ist-Prüfung
  + Anker, Muster ADR 0018 [M111B]). Keine neue Tabelle → kein neuer
  Graphen-Knoten.

## 5. Commands und Actions

Server-Action `updateContact` (Muster: bestehende `authorizedAction`-Actions,
Allowlist, Re-Authentifizierung):

- `updateContact({ workspaceId, projectId, expectedRevision, patch })` mit
  `patch` strikt allowlistet auf die M1-14-Felder (Name, Anrede, B2B,
  E-Mail-Sekundär, Mobil, Erreichbarkeit, Kontaktadresse, Consent-Felder,
  UTM-Felder). Kein `site`-Feld im Patch.
- Ablauf: Project laden → Contact-Lock (Reihenfolge Project → Contact, wie
  Muster) → CAS `revision = expectedRevision` → Spalten-Update →
  `revision+1`, `updatedAt` → Event + Audit in derselben Transaktion.
- Fehlerklassen: `invalid`, `not_found`, `conflict` (Revisionskonflikt),
  `deleted_contact`, `unauthenticated`, `denied`. Unbekannte Fehler nicht roh
  nach außen.
- Gelöschter Contact (`deleted_at` not null): Edit abgewiesen (`deleted_contact`).

## 6. Rollen- und Datenvertrag

`contact.write` ist `internalOnly`, mindestens Editor.

| Actor | Contact lesen | Contact editieren |
|---|---|---|
| interner Viewer | ja (read-only DTO) | nein |
| interner Editor | ja | ja |
| interner Admin | ja | ja |
| `external_only` | nein (bzw. nur zugewiesene Request-Sicht) | nein |
| revoked/fremder Actor | nein | nein |
| Worker/Auth/System | nein | nein |

SQL-Ebene (RLS/FORCE-RLS, bestehendes Tenant-Muster) und Action-Ebene bleiben
doppelt fail-closed. Kein Contact-Leak über Fehlermeldungen.

## 7. Event-, Audit- und Activity-Vertrag

- `domain_events`: `contact.updated` (Aggregat `contact`), Payload **minimal**:
  `contactId` + geänderte Feldnamen (keine Feldwerte, keine PII/Freitext).
- `audit_log`: `action = contact.update`, `resource = contact:<id>`,
  `allowed = true`, Details ohne PII-Werte.
- Projektaktivität (redigiert): festes deutsches Label „Kontaktdaten geändert“,
  keine Roh-Payload-/Werteanzeige.
- `contact.marketing_consent_changed` als eigenes Event bei Consent-Änderung
  (trägt Policy-Version, kein Kontakt-PII).

## 8. Lock- und Race-Vertrag

- Lock-Reihenfolge fest: Project → Contact (erster Lock wie Erasure-Pfad).
- CAS über `revision`; null Zeilen = Conflict; kein Teilstand.
- Event, Audit und Spalten-Update committen in derselben Transaktion.
- Kreuzung mit Erasure: Erasure sperrt Contact zuerst (`FOR UPDATE` auf die
  Contact-Zeile) und gewinnt; ein paralleler Edit auf einer gerade gelöschten
  Zeile erhält `deleted_contact`.

## 9. UI-Vertrag

- Sektion „Identität und Kontakt“ wird von read-only `<dl>` [page.tsx:393-408]
  zu Editor mit Lese-/Edit-Modus; Viewer sieht nur Lesezustand.
- Feldgruppen: Name+Anrede, B2B, Kontaktwege (primär/sekundär E-Mail, Mobil,
  Festnetz), Erreichbarkeit, Kontaktadresse, Consent (Checkbox + Version/Text/
  Link, read-only bei fehlender `contact.write`), UTM-/Kampagnenfelder.
- Konflikt-/Fehlerzustand bewahrt Entwurf und Fokus (Muster M1-10).
- Kein Farbsignal ohne Text/Icon; Touchziele ≥ 44 px; kein horizontaler
  Overflow bei 320/375 px; `aria-live` für Ergebnis.

## 10. Testmatrix

### 10.1 Unit/Contract

- `M114-CONTRACT-01`: Anrede-Enum + B2B-Invariante (gültig/ungültig).
- `M114-CONTRACT-02`: E-Mail-Normalisierung (primär/sekundär), E.164
  (Mobil/Festnetz), Längen.
- `M114-CONTRACT-03`: Kontaktadresse (PLZ-Muster, Längen, nullable).
- `M114-CONTRACT-04`: Consent-CHECK (true ⇒ Version/At/Source gesetzt).
- `M114-CONTRACT-05`: UTM-Spalten (Längen, nullable).
- `M114-CONTRACT-06`: `phone_reachability`-Enum.
- `M114-SVC-01`: `updateContact`-Allowlist + Fehlerklassen (invalid/not_found/
  conflict/deleted_contact/denied).

### 10.2 DB (echtes PostgreSQL)

- `M114-DB-01`: Migration frisch + idempotent; neue CHECKs greifen.
- `M114-DB-02`: Revision-CAS (null Zeilen = Conflict; Revision inkrementiert).
- `M114-DB-03`: Consent-Event/Audit genau einmal.

### 10.3 RLS/RBAC (negativ)

- `M114-RBAC-01`: Viewer/External/Fremdmandant/Worker lesen/mutieren nicht
  (SQL- und Action-Ebene), ohne Event-/Audit-Zeile.
- `M114-RBAC-02`: `external_only` ohne Assignment vollständig fail-closed.

### 10.4 Race

- `M114-RACE-01`: zwei parallele Edits — genau einer gewinnt.
- `M114-RACE-02`: Edit gegen Erasure — Erasure gewinnt, Edit `deleted_contact`.

### 10.5 Erasure

- `M114-ERASURE-01`: vollständiger Erasure-Lauf nullt alle neuen PII-Spalten
  (inkl. UTM, Consent-Version/-Text/-Link, Adresse, Anrede).
- `M114-ERASURE-02`: quellgepinnte Erweiterung bricht bei Drift ab; Tombstone/
  Replay bleibt gültig.

### 10.6 Chromium-E2E / A11y

- `M114-E2E-01`: Editor ändert Kontakt (Happy Path) + Revision-Konflikt.
- `M114-E2E-02`: Viewer read-only (keine Controls).
- `M114-E2E-03`: External abgewiesen.
- `M114-E2E-04`: Consent + UTM + Kontaktadresse sichtbar/editierbar.
- `M114-A11Y-01`: Axe, Tastatur, 375 px, Touchziele, `aria-live`.

## 11. Abschlussgates

- `npm run check` (Vitest, alle Dateien grün) inkl. M1-14-Fälle.
- Rollenprobe 88/88 + PG18-Proben 5/5 (nach Lane-Integration ggf. neue Zählung).
- `db:generate` ohne Drift; Fresh- + Legacy-Migrationspfad.
- Production-Build, TypeScript, ESLint, Dependency-Cruiser, `git diff --check`,
  Secret-Scan.
- Unabhängiger Security-/Race-/Privacy-Review ohne offene P0–P2.
- Chromium-E2E inkl. Axe; Visual bleibt bis Mikails Freigabe `INCONCLUSIVE`
  (`M114-VISUAL-01`).

## 12. Nichtziele (NON-GOALS)

- Deduplizierung / Duplikat-Triage (bestehendes `dedupeReviewRequired` bleibt,
  aber keine neue Dedupe-Logik).
- AI-Lead-Score (F1.7).
- Gmail-/Microsoft-Projektmail (F1.9).
- Kanban-Board-Konfiguration (F1.5).
- CSV-Import (existiert als Muster M1-08b).
- Globale Kontaktsuche (späterer Slice; `GET /contacts`-Filter nur Referenz).
- `integrations` (Bitrix/Hubspot/PDS/Photovate/Pipedrive/Weclapp) — späteres
  Integrations-Slice.
- Keine öffentliche REST-API, kein `POST /contacts/create`-Äquivalent in diesem
  Slice (Intake-Pfad M1-04 bleibt unverändert).
- Keine Reonic-Texte, UI, Assets, Taxonomie oder private Implementierungsdetails.

## 13. DECIDED

| ID | Entscheidung | Ablage |
|---|---|---|
| `DEC-M114-01` | Kontaktwege flach (4 benannte Spalten), keine Kanal-Tabelle/JSONB | ADR 0020 |
| `DEC-M114-02` | B2B als `is_business` + Invariante `salutation='business'` | ADR 0020 |
| `DEC-M114-03` | Kontaktadresse flach am `contact`, `site` unangetastet | ADR 0020 |
| `DEC-M114-04` | Consent flach + Policy-Version; Historie über Events/Audit | ADR 0020 |
| `DEC-M114-05` | Edit mit `revision`-CAS (Muster site/project) | ADR 0020 |
| `DEC-M114-06` | Erasure quellgepinnter Spaltenlisten-Scrub erweitert | ADR 0020 |
| `DEC-M114-07` | UTM flach am Contact, aus Intake befüllt | ADR 0020 |
| `DEC-M114-08` | `displayName` = `btrim(first || ' ' || last)` serverseitig | ADR 0020 |
| `DEC-M114-09` | Keine öffentliche REST-API in M1-14; API = Datenmodell-Referenz | §2 |

## 14. Verbleibende UNKNOWN (zur Root-Integrator-/Owner-Klärung)

1. `UNK-M114-01`: Mechanismus, mit dem Reonic `deletedAt` setzt (kein
   Delete-Endpunkt in der Spec) — wir implementieren den eigenen Löschmarker
   + bestehende Erasure.
2. `UNK-M114-02`: Ob `marketingConsent`/`utm` runtime-seitig wirklich
   create-only sind (Spec lässt sie im Update-Body weg; Laufzeit nicht beobachtet).
3. `UNK-M114-03`: Quelle/Inhalt der Policy-Version — `marketing_consent_policy_version`
   ist WMEE-Erweiterung; der zu referenzierende Policy-Text/-Stand ist
   Owner-Input (Startwert `v1`/leer ist ESTIMATE).
4. `UNK-M114-04` (GELÖST): Migrationsnummer fixiert: M1-11b = `0040`, M1-13 = `0041`, M1-14 = `0042`
   (Root-Entscheidung 2026-09-02; Integration in dieser Reihenfolge).
5. `UNK-M114-05`: Ob `integrations` (Drittsystem-IDs) je gespeichert werden
   sollen — bewusst NON-GOAL, Entscheidung für späteres Integrations-Slice.
