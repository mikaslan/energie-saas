# M3-00 — Workspace-Stammdaten „Ausstellungsdetails“ & Rechnungsstellung (F8.2)

- Status: **DISCOVERED → SPECIFIED** · noch nicht CONTRACTED/RED/IMPLEMENTED
- Datum: 2026-09-03
- F-Bezug: **F8.2** (Modulkatalog „Gates: Länder (DE/AT/CH/FR/UK/Jersey für
  Geld-Dokumente), Rolle Editor + Invoicing-Recht, Issuing Details Pflicht“)
- Architektur: **ADR 0024** (`docs/adr/0024-workspace-stammdaten.md`)
- Basis: `tooling` HEAD `1287488` (Spec-/ADR-Ablage; M3-00 ist reine Spezifikation)
- Geplante Migration: **`0045_m3_00_workspace_master_data.sql`** (Root-reserviert;
  M3-01 folgt mit `0046_m3_01_invoicing_core.sql`)
- Ziel: keine — dieser Slice ist reine Spezifikation (nur Doku, kein Code/Commit).

> **Einordnung:** Root-Entscheid O4 aus `docs/spec/M3-01-rechnungen-kern.md`
> §16. M3-00 ist ein kleines vertikales Slice **direkt vor** M3-01 und liefert
> die Workspace-Defaults + das Precondition-Gate, die M3-01 bei der Ausstellung
> (Issue) benötigt. Es baut **keine** Rechnungs-Listen, **keine** Dokumente und
> **kein** PDF.

---

## 0. Quellenlegende

| Kürzel | Quelle | Rolle |
|---|---|---|
| `PDEEP` | `artifacts/browser-recon-20260902/deep/PORTAL-DEEP.txt` (§7 Einstellungen) | Portal-Einstellungs-Baum; Route `invoicing&tab=issuing-details` |
| `ACSV` | `docs/parity/reonic-portal-audit/reonic_funktionskatalog.csv` + `reonic_portal_audit_gesamt.csv` | „Rechnungs-Firmendaten, Steuer-/Zahlungsdetails, Textvorlagen und Nummerierung; Formularfelder, Speichern“ |
| `AMAP` | `docs/parity/REONIC-PORTAL-AUDIT-MAP.md` (Einstellungen – Organisation) | Bereichs-/F-Mapping, „Einstellungen – Rechnungsstellung → F8.2, F8.3“ |
| `MODKAT` | `docs/blaupause/01-modulkatalog.md` (M8, Zeile 107) | F8.2 als primäre Abnahmequelle |
| `M301` | `docs/spec/M3-01-rechnungen-kern.md` (committet `1287488`) | §10 Rechte (Issuing-Details-Berechtigung), §4 Datenmodell, O4/O5-Entscheide |
| `M201` | `lib/db/schema/offers.ts` (`offer_number_series`) | Nummernserien-Muster (prefix/padding/seriesYear) |
| `M114`/`M115` | `docs/spec/M1-14-kontaktdatensatz.md`, `docs/spec/M1-15-termine-kalender.md` | Struktur-/Stil-Vorlage |
| `ADR 0024` | `docs/adr/0024-workspace-stammdaten.md` | Singleton-Settings vs. JSONB |

> **Evidenz-Klassifikation (Goal-Prompt §7):** `OBSERVED`, `DOCUMENTED`,
> `INFERRED`, `DECIDED`, `UNKNOWN`, `CONFLICTING`. Keine Reonic-Texte, Assets,
> Kundendaten oder Preise übernommen. `ESTIMATE` markiert Schätzwerte.

---

## 1. Nutzerergebnis (JTBD)

Ein interner **Admin oder Editor mit Invoicing-Recht** pflegt workspaceweit die
**Ausstellungsdetails**: Firmendaten des Ausstellers (Name, Adresse, Land),
Steuer-/Zahlungsdetails und — als Defaults für M3-01 — die **Nummernserien-Formate
je Dokumenttyp** (Präfix/Padding) sowie die **GoBD-Aufbewahrungsfrist**
(`goebd_retention_until`-Default). Viewer lesen read-only; External/Worker/
Fremdtenant bleiben fail-closed. Jede Änderung erzeugt in **derselben
Transaktion** ein Domain-Event und eine Audit-Zeile und erhöht die
Settings-`revision` (CAS).

M3-00 liefert zugleich das **Precondition-Gate** für M3-01: Fehlen oder
unvollständige Pflicht-Stammdaten (Firmenname, Adresse, Land, Zahlungsdaten für
Geld-Dokumente) lassen die Ausstellung in M3-01 **fail-closed** scheitern
(Permission-Denied-/Precondition-Zustand), statt ein Dokument ohne rechtlich
gültige Ausstellerdaten zu erzeugen.

---

## 2. Clean-Room-Evidenz und Gap-Analyse

**Belegt (OBSERVED/DOCUMENTED):**
- **Route/Tab:** `/portal-settings?settings=invoicing&tab=issuing-details`
  (`ACSV`, `PDEEP` §7) — „Rechnungs-Firmendaten, Steuer-/Zahlungsdetails,
  Textvorlagen und Nummerierung; Formularfelder, Speichern“.
- **F8.2 (MODKAT, DOCUMENTED):** Länder **DE/AT/CH/FR/UK/Jersey** für
  Geld-Dokumente; Rolle **Editor + Invoicing-Recht**; **Issuing Details Pflicht**.
- **Field-Gruppen (OBSERVED, nur Labels):** Firmendaten · Steuer-/Zahlungsdetails ·
  Textvorlagen · Nummerierung.

**Gap / Grenzen:**
- Feldnamen und Pflichtfelder sind inzwischen **OBSERVED**
  (`M3-UNKNOWN-RECON.md` §1a–1d: Name*/Email*/Land*, USt-IdNr, Behörde,
  Registernummer, Adresse, Buchhaltungsmethode, Bankkonto, Textvorlagen,
  Nummern-Templates) — nur die exakten **Validierungsregeln** bleiben
  UNKNOWN → eigene Regeln sind ESTIMATE.
- „Textvorlagen“ ist beobachtet, aber **Nichtziel** dieses Slices (Templates →
  Folgeslice, analog Brief-Templates in M3-01 §13).
- Nummernformate sind **RESOLVED** (OBSERVED-Templates, DECIDED 4); die exakte
  Aufbewahrungsfrist bleibt **UNKNOWN** (Default 3650 = ESTIMATE).

---

## 3. Capability-Sheet (Goal-Prompt §7)

**Gemeinsamer Liefervertrag (alle M300-xx):** Workspace-Tenant-Grenzen; jeder
Schreibpfad validiert Actor/Membership server-seitig, prüft `invoicing.write`
(+ Issuing-Details-Berechtigung) und schreibt Domain-Event + Audit-Zeile in
derselben Transaktion; Settings-`revision` CAS-inkrementiert; Externe
Nebenwirkungen = keine; Notifications = keine; Pflichtzustände Loading/Empty/
Error/Success/Disabled/Permission-Denied (§7).

### M300-01 — Issuing-Details pflegen (Firmendaten, Steuer-/Zahlungsdetails, Land)

- **F-Nr:** F8.2 · **Modul:** `modules/invoicing/` (Settings-Dienst) ·
  **Route:** `/w/{workspaceId}/einstellungen/rechnungsstellung` (WMEE-Design)
- **Akteur/Rolle:** Admin/Editor+ mit `invoicing.write` +
  `invoicing.issuing_details.write`
- **JTBD:** rechtlich gültige Ausstellerdaten workspaceweit hinterlegen und pflegen
- **Trigger:** Einstellungsseite öffnen; „Speichern“
- **Vorbedingungen:** Workspace-Membership aktiv
- **Happy Path:** Stammdaten (Firmenname, Adresse, Land, Zahlungsdaten) setzen → gespeichert, `revision+1`
- **Varianten:** Erst-Anlage (Singleton-Insert) vs. Update (CAS); Land-Enum 6 Werte
- **Eingabefelder:** Firmenname (Pflicht), E-Mail (Pflicht, OBSERVED),
  Behörde (optional, OBSERVED „Behörde“ — nicht „Rechtsform“),
  Registernummer (optional), USt-IdNr. (optional, `companyTaxId`), Adresse
  (Zeile1/PLZ/Ort Pflicht, Zeile2 optional), Land (Pflicht, Enum),
  Buchhaltungsmethode (periodengerecht|zahlungsbasiert),
  Kontoinhaber/IBAN/BIC (Pflicht für Geld-Dokumente)
- **Validierungen:** Firmenname 1–160 non-empty; E-Mail 3–254 mit Format-CHECK;
  Land ∈ {DE,AT,CH,FR,UK,JE}; IBAN MOD-97-Prüfung + Länge 15–34 (DECIDED,
  ESTIMATE); BIC 8 **oder** 11 Zeichen (SEPA: BIC optional, sofern gesetzt
  gültig); Textlängen-Obergrenzen
- **Zustände:** — (Einstellungswerte; `revision` monoton steigend)
- **Erlaubte Übergänge:** — (Update erzeugt neue Revision)
- **Persistente Nebenwirkungen:** `workspace_invoicing_settings` (Upsert, CAS)
- **Berechtigung:** `invoicing.write` + `invoicing.issuing_details.write`
  (in M3-00 selbst definiert, von M3-01 §10 importiert — Kimi-P1-4)
- **Tenant-Scope:** `workspaceId` (Singleton je Workspace)
- **API-Operationen:** `getInvoicingSettings`, `upsertInvoicingSettings`
- **Datenentitäten:** `workspace_invoicing_settings`
- **Audit Events:** `workspace_invoicing_settings.created/updated`
- **Evidence:** `ACSV` Feldgruppen; `MODKAT` F8.2 · **Confidence:** OBSERVED
  (Gruppen), DECIDED/ESTIMATE (konkrete Felder)

### M300-02 — Nummernserien-Defaults je Dokumenttyp

- **F-Nr:** F8.3 (Nummernkreise-Default) · **Akteur:** wie M300-01
- **Route:** gleiche Einstellungsseite (Unter-Tab „Zahlenkreise“,
  `tab=number-circles` — OBSERVED via `M3-UNKNOWN-RECON.md` §1d)
- **JTBD:** je Dokumenttyp ein **Format-Template** als Workspace-Default
  festlegen (Seed für M3-01-Serien) + Nummer-Zähler einsehen
- **Trigger:** Nummerierungsgruppe bearbeiten; „Speichern“
- **Vorbedingungen:** Workspace aktiv
- **Happy Path:** je Typ Template setzen → M3-01 rendert neue Belegnummern daraus
- **Varianten:** OBSERVED-Defaults (Reonic, `M3-UNKNOWN-RECON.md` §1d):
  Rechnung `Rechnung-{YEAR}-{MONTH}-{NUMBER}`; Gutschrift
  `CRN-{YEAR}-{MONTH}-{DAY}-{NUMBER}`; Auftragsbestätigung
  `OFC-{YEAR}-{MONTH}-{DAY}-{NUMBER}`; Bestellung
  `PO-{YEAR}-{MONTH}-{DAY}-{NUMBER}`; Lieferschein
  `DN-{YEAR}-{MONTH}-{DAY}-{NUMBER}`; Brief
  `LE-{YEAR}-{MONTH}-{DAY}-{NUMBER}`. Teilrechnungs-Format
  `Abschlagsrechnung-{YEAR}-{MONTH}-{NUMBER}` wird für den Teilrechnungs-
  Folgeslice (M3-01 Non-Goal) mitgeführt.
- **Eingabefelder:** Format-Template (1–120) je Typ; **Validierungen:**
  Template non-empty; erlaubte Platzhalter ausschließlich
  `{YEAR}`/`{MONTH}`/`{DAY}`/`{NUMBER}` (je mind. einmal `{NUMBER}`,
  höchstens je einmal die Datums-Platzhalter); keine unbekannten Platzhalter
- **Zustände:** — · **Übergänge:** — (Update)
- **Persistente Nebenwirkungen:** `workspace_document_number_format` (Upsert je Typ)
- **Berechtigung:** `invoicing.write` · **API-Operationen:** `getNumberFormats`, `upsertNumberFormat(workspaceId, type, formatTemplate)`
- **Datenentitäten:** `workspace_document_number_format`
- **Audit Events:** `workspace_document_number_format.updated`
- **Evidence:** `M3-UNKNOWN-RECON.md` §1d (OBSERVED Formate + Platzhalter) ·
  **Confidence:** OBSERVED (Formate/Labels), DECIDED (Template-Validierung)

### M300-03 — GoBD-Retention-Default

- **F-Nr:** F8.7 (Aufbewahrungs-Default; Durchsetzung = Folgeslice) ·
  **Akteur:** wie M300-01
- **Route:** gleiche Einstellungsseite
- **JTBD:** workspaceweite Aufbewahrungsfrist als Default für `goebd_retention_until` hinterlegen
- **Trigger:** Feld bearbeiten; „Speichern“
- **Vorbedingungen:** —
- **Happy Path:** Default-Tage setzen → M3-01 setzt `goebd_retention_until = issuedAt + default` bei Ausstellung
- **Varianten:** Default ESTIMATE 3650 Tage (10 Jahre); Bereich 1…36500
- **Eingabefelder:** Aufbewahrungsfrist in Tagen
- **Validierungen:** 1…36500 Tage
- **Zustände:** — · **Übergänge:** — (Update)
- **Persistente Nebenwirkungen:** `goebd_retention_default_days`
- **Berechtigung:** `invoicing.write` · **API-Operationen:** Teil von `upsertInvoicingSettings`
- **Datenentitäten:** `workspace_invoicing_settings`
- **Audit Events:** (in `workspace_invoicing_settings.updated`)
- **Evidence:** `MODKAT` F8.7; `M301` §10 O5-Entscheid · **Confidence:** DECIDED
  (Default-Wert ESTIMATE), UNKNOWN (exakte Reonic-Frist)

### M300-04 — Precondition-Gate für M3-01-Ausstellung

- **F-Nr:** F8.2 („Issuing Details Pflicht“) · **Akteur:** M3-01 Issue-Service
- **Route:** — (server-seitige Prüfung in `issueDocument`)
- **JTBD:** Ausstellung nur bei vollständigen Ausstellerdaten zulassen
- **Trigger:** `issueDocument` in M3-01
- **Vorbedingungen:** Dokument `draft`
- **Happy Path:** Stammdaten vollständig → Ausstellung läuft; unvollständig → fail-closed `PreconditionConflict`
- **Varianten:** Geld-Dokumente zusätzlich Zahlungsdaten-Pflicht; Brief (kein Betrag) braucht kein IBAN
- **Eingabefelder:** — (liest Settings)
- **Validierungen:** `companyName`, `companyEmail`, `companyAddressLine1`,
  `companyPostalCode`, `companyCity`, `companyCountry` Pflicht; IBAN Pflicht
  für Geld-Dokumente; **Land-Gate (DECIDED 11):** `companyCountry` ≠ `DE`
  → `PreconditionConflict` für Geld-Dokumente (Brief bleibt möglich)
- **Zustände:** — · **Übergänge:** — (Guard, kein Zustandswechsel)
- **Persistente Nebenwirkungen:** keine (reine Prüfung)
- **Berechtigung:** `invoicing.issuing_details.write` (Kimi-P1-4: M3-00
  definiert den Key; M3-01 §10 importiert ihn)
- **API-Operationen:** intern `assertIssuingDetailsComplete(workspaceId, documentType)`
- **Datenentitäten:** `workspace_invoicing_settings` (Read)
- **Audit Events:** (Ablehnung als `audit_log` allowed=false, Muster `auditLog`)
- **Evidence:** `MODKAT` F8.2 „Issuing Details Pflicht“; `M301` §10 · **Confidence:**
  DOCUMENTED (Pflicht), DECIDED (fail-closed als PreconditionConflict)

### M300-05 — RBAC/RLS für Workspace-Stammdaten

- **F-Nr:** F8.2 · **Akteur:** alle Rollen · **Route:** — (DB-/Service-Ebene)
- **JTBD:** Schreib-/Leserecht und Tenant-Grenzen für Stammdaten durchsetzen
- **Happy Path:** `invoicing.read` (Viewer+) read-only; `invoicing.write`
  (Editor+/Admin mit Invoicing-Recht) schreibend; External/Worker/Fremdtenant fail-closed
- **Validierungen:** RLS tenant-gebunden; Singleton je Workspace
- **Berechtigung:** `invoicing.read`/`invoicing.write`
- **Datenentitäten:** `workspace_invoicing_settings`, `workspace_document_number_format`
- **Evidence:** `MODKAT` F8.2; `M301` §10 · **Confidence:** DECIDED (Muster M1-00…M1-03)

---

## 4. Datenmodell-Skizze (Migration `0045`, additiv)

Alle Tabellen workspace-tenantgebunden (FK `workspace.id`, tenant-gebundenes
Unique wie bestehende Muster).

1. **`workspace_invoicing_settings`** (Singleton je Workspace):
   - `workspaceId` uuid **PK** → `workspace.id`
   - `companyName` text not null (1–160) — OBSERVED Pflicht „Name des Unternehmens“
   - `companyEmail` text not null (3–254, E-Mail-CHECK) — OBSERVED Pflicht „Email“
   - `companyAuthority` text nullable (1–80) — OBSERVED „Behörde“ (Bezeichnung
     der zuständigen Behörde; Kimi-P1-6: Spaltenname final, kein
     „companyLegalForm“-Rest)
   - `companyRegisterNumber` text nullable (1–64) — OBSERVED „Registernummer“
   - `companyTaxId` text nullable (1–64) — OBSERVED „USt-IdNr.“, sensitive
   - `companyAddressLine1` text not null (1–160)
   - `companyAddressLine2` text nullable (1–160)
   - `companyPostalCode` text not null (1–20)
   - `companyCity` text not null (1–120)
   - `companyCountry` text not null, CHECK `in ('DE','AT','CH','FR','UK','JE')`
     — OBSERVED Pflicht „Land“ (Select)
   - `accountingMethod` text not null default `'accrual'`, CHECK
     `in ('accrual','cash')` — OBSERVED „Buchhaltungsmethode“
     („Periodengerecht“/„Zahlungsbasiert“; bei `cash` ergänzt M3-01 die
     Notiz „Umsatzsteuer nach vereinnahmten Entgelten“ in
     Rechnungen/Teilrechnungen/Gutschriften — DE/FR/CH/UK)
   - `paymentAccountHolder` text nullable (1–160) — OBSERVED „Name des Kontoinhabers“
   - `paymentIban` text nullable (1–34)
   - `paymentBic` text nullable (8–11) — OBSERVED „BIC / SWIFT“
   - `goebdRetentionDefaultDays` integer not null default 3650, CHECK `1…36500`
   - `revision` integer not null default 1, CHECK `>= 1`
   - `createdBy`/`updatedBy` uuid → membership; `createdAt`/`updatedAt` timestamptz
   - CHECK: `length(btrim(companyName)) between 1 and 160` u. a. Längengrenzen;
     `paymentAccountHolder`/`paymentIban`/`paymentBic` gemeinsam null oder vollständig

2. **`workspace_document_number_format`** (Kind, 6 Zeilen je Workspace):
   - `workspaceId` uuid not null → `workspace.id`
   - `type` text not null, CHECK `in ('invoice','credit_note','order_confirmation',
     'purchase_order','delivery_note','letter')`
   - `formatTemplate` text not null (1–120) — OBSERVED-Platzhalter
     `{YEAR}`/`{MONTH}`/`{DAY}`/`{NUMBER}`, validiert im Service (CHECK nur:
     enthält `{NUMBER}`, keine unbekannten `{…}`-Token via Regex)
   - `counter` bigint not null default 0, CHECK `>= 0` — Nummer-Zähler,
     **nur M3-01 inkrementiert** (M3-00 setzt/liest, kein manueller Reset)
   - `updatedAt` timestamptz; **PK** `(workspaceId, type)`
   - Defaults (OBSERVED, `M3-UNKNOWN-RECON.md` §1d):
     `Rechnung-{YEAR}-{MONTH}-{NUMBER}` /
     `CRN-{YEAR}-{MONTH}-{DAY}-{NUMBER}` /
     `OFC-{YEAR}-{MONTH}-{DAY}-{NUMBER}` /
     `PO-{YEAR}-{MONTH}-{DAY}-{NUMBER}` /
     `DN-{YEAR}-{MONTH}-{DAY}-{NUMBER}` /
     `LE-{YEAR}-{MONTH}-{DAY}-{NUMBER}`

**Counter-/Seeding-Vertrag (Kimi-P1-3, DECIDED):**
- `counter` ist **global monoton pro `(workspaceId, type)`** und wird **nie
  zurückgesetzt** (GoBD-Eindeutigkeit); M3-01 inkrementiert atomar per
  `UPDATE … RETURNING` in der Issue-Transaktion.
- **Seeding:** die 6 Default-Zeilen werden beim ersten `getNumberFormats`
  bzw. ersten Settings-Öffnen **idempotent** angelegt
  (`INSERT … ON CONFLICT DO NOTHING` mit den OBSERVED-Defaults); kein
  Migrations-Backfill für Bestands-Workspaces nötig — M3-01 fällt bei
  fehlender Zeile auf den OBSERVED-Default zurück.
- **Platzhalter-Rendering (ESTIMATE gepinnt):** `{YEAR}` vierstellig,
  `{MONTH}`/`{DAY}` zweistellig zero-padded (09), `{NUMBER}` ungepaddete
  Ganzzahl; das „Abschlagsrechnung“-Template wird nur als Doku-Notiz für den
  Teilrechnungs-Folgeslice mitgeführt (kein 7. `type`-Wert, kein CHECK).
- `workspace_document_number_format` ohne `revision`: **Last-Write-Wins**
  ist explizit DECIDED (Stammdaten niedriger Frequenz; CAS entfällt bewusst).

> **Hinweis Typanzahl:** M3-01 sprach von „7 Dokumenttypen“ = 6 Dokumenttypen +
> Dokumentgruppen-Übersicht. Dokumentgruppen besitzen **keine** eigene
> Nummernserie; daher 6 `type`-Werte. Skizze, kein Schema-Contract — exakter
> Drizzle-/CHECK-Vertrag bei CONTRACTED (schema-hash-gepinnt).

**Seeding-Vertrag M3-01:** `commercial_document_number_series` rendert die
Belegnummer beim Ausstellen aus `workspace_document_number_format.formatTemplate`
(`{YEAR}`/`{MONTH}`/`{DAY}` = Ausstellungsdatum Europe/Berlin, `{NUMBER}` =
fortlaufender `counter`; M3-01 §6); das M3-00-Default ist die Quelle.

---

## 5. Commands und Actions

- `getInvoicingSettings(workspaceId)` → Settings-DTO (ohne `companyTaxId`/`paymentIban`
  im Minimierten DTO, nur bei Issuing-Details-Berechtigung vollständig).
- `upsertInvoicingSettings(workspaceId, input, baseRevision)` → Insert bei
  fehlender Zeile, sonst CAS-Update (`revision = baseRevision`); Konflikt → `Conflict`.
- `getNumberFormats(workspaceId)` / `upsertNumberFormat(workspaceId, type, formatTemplate)`.
  *(Kimi-P1-2: Signatur auf das Template-Modell umgestellt; das frühere
  Präfix/Padding-Design ist superseded — `M201`/`offer_number_series` ist
  kein Muster mehr für diese Tabelle.)*
- intern `assertIssuingDetailsComplete(workspaceId, documentType)` → bool/`PreconditionConflict`.

---

## 6. Rollen-, RLS- und Erasure-Vertrag

- **Rechte:** `invoicing.read` (Viewer+), `invoicing.write` (Editor+/Admin mit
  Invoicing-Recht). Ausstellung in M3-01 zusätzlich an Issuing-Details-
  Berechtigung gebunden (M3-01 §10).
- **RLS:** beide Tabellen tenant-gebunden; Policies nach Muster der verifizierten
  RLS-Kern-Rollen; Rollenprobe erweitert (88/88 + neue Blöcke).
- **Erasure (DSGVO):** Workspace-Stammdaten sind **Tenant-/Firmendaten, keine
  Kontakt-PII** → **kein** Eintrag im Kontakt-`ErasureGraphIds`. `companyTaxId`
  und `paymentIban` sind sensitive Geschäftsdaten, werden aber nur bei
  Issuing-Details-Berechtigung ausgeliefert (§5 DTO-Minimierung) und fallen
  nicht unter den Kontakt-Erasure-Pfad. Workspace-Löschung = separates
  Workspace-Lifecycle-Thema (Non-Goal).

---

## 7. Event-, Audit- und Activity-Vertrag

- Domain-Events (`domain_events`, Outbox in derselben Transaktion):
  `workspace_invoicing_settings.created/updated`,
  `workspace_document_number_format.updated`.
- Audit (`audit_log`): erlaubte Schreibzugriffe **und** abgelehnte
  Precondition-Prüfungen (M300-04 `allowed=false`) mit `resource =
  'workspace_invoicing_settings'` bzw. `'document.issue'`.
- Keine projektgebundene Activity (kein `project`-Bezug in M3-00).

---

## 8. Lock- und Race-Vertrag

- **Singleton-Insert:** einzigartiger `workspaceId`-PK verhindert Duplikate;
  konkurrierendes Erst-Insert → `Conflict`/`unique_violation` → idempotenter Retry.
- **CAS-Update:** `revision`-Vergleich (`baseRevision`) schützt vor Lost-Update
  (Muster M1-13 Revision-CAS); `updatedBy`/`updatedAt` gesetzt.
- **Gleichzeitiges Upsert Settings ↔ Number-Format:** getrennte Zeilen, kein
  gemeinsamer Lock nötig; beide in eigener Transaktion.
- **M3-01-Issue liest Settings:** nur read-only; Issue-Transaktion liest den
  aktuellen Settings-Stand innerhalb der Issue-Transaktion (konsistenter Snapshot).

---

## 9. UI-Vertrag (WMEE-Design)

- **Route:** `/w/{workspaceId}/einstellungen/rechnungsstellung` (Parallele zu
  `/portal-settings?settings=invoicing&tab=issuing-details`; keine
  Reonic-Layout-/Text-Übernahme).
- **Gruppen:** Firmendaten · Steuer-/Zahlungsdetails · Nummerierung ·
  (Textvorlagen = Platzhalter, deaktiviert/Non-Goal). „Speichern“.
- **Pflichtzustände:** Loading, Empty (noch keine Stammdaten → Hinweis „Für die
  Rechnungsausstellung erforderlich“), Error, Success („Gespeichert“), Disabled
  (ohne `invoicing.write`), Permission-Denied (External/Viewer-ohne-Recht).
- **A11y:** Screenreader-Zusammenfassung (Vollständigkeitsstatus), Fokusreihenfolge,
  Tastatur, Fehlermeldungen am Feld, keine farbalone Codierung.
- **Responsive:** Desktop (2-Spalten-Formular), Tablet/375-px-Mobile (einspaltig).
- **Visuelles Baseline-Gate:** bis Eigentümer-Freigabe `INCONCLUSIVE`.

---

## 10. Testmatrix

| Kürzel | Capability | Art | Prüfung | Gate |
|---|---|---|---|---|
| `M300-01` | Issuing-Details pflegen | Unit/Contract/DB | Insert+Update; Land-Enum; Längengrenzen; Zahlungsdaten gemeinsam-null | `M300-DB-01` |
| `M300-02` | Nummernserien-Defaults | DB/Contract | 6 Typen; Template-Validierung (`{NUMBER}` Pflicht, unbekannte/doppelte Datums-Platzhalter, Länge 1–120); OBSERVED-Defaults | `M300-DB-02` |
| `M300-03` | GoBD-Retention-Default | Unit/DB | Bereich 1…36500; Default 3650 | `M300-UNIT-01` |
| `M300-04` | Precondition-Gate | Unit/DB | vollständig → ok; fehlende Pflichtfelder → `PreconditionConflict`; Geld vs. Brief (IBAN) | `M300-DB-03` |
| `M300-05` | RLS/Rechte | RLS | Viewer read-only; External/Worker/Fremdtenant fail-closed; `invoicing.write`-Gate | Rollenprobe |
| — | Race | Race | Singleton-Doppel-Insert; CAS-Lost-Update; Upsert Settings↔Format | `M300-RACE-01` |
| — | DTO-Minimierung | Contract | `companyTaxId`/`paymentIban` nur bei Berechtigung im Readmodell | `M300-CON-01` |
| — | Chromium-E2E | E2E | Anlegen→Speichern→Reload; Vollständigkeits-Hinweis; Permission-Denied | `M300-E2E-*` |
| — | A11y | A11y | SR-Zusammenfassung, Fokus, Tastatur, Feldfehler | `M300-A11Y-*` |

**DB-Matrix:** frisch + idempotent + Legacy-Upgrade-Pfad; Verletzungsfälle
(ungültiges Land, IBAN ohne Kontoinhaber, Prefix mit Sonderzeichen). **Rollenprobe:**
88/88 + neue Blöcke; **PG18-Probe:** 5/5.

**Abschlussgates (Gate 2):** `npm run check` grün, `db:generate` ohne Drift,
`db:roles:verify` 88/88 + PG18 5/5, Production-Build, ESLint, TypeScript,
Dependency-Cruiser, `git diff --check`, Secret-Scan, Chromium-E2E (inkl. A11y),
unabhängiger Review ohne offene P0–P2. **Visual-Gate** `INCONCLUSIVE`.

---

## 11. Nichtziele (NON-GOALS)

- **Textvorlagen** (beobachtet in `ACSV`, aber Templates → Folgeslice).
- **Branding**, **Pflichtfelder-Konfiguration**, **Lizenzen & Rechnungen**
  (weitere Firmeneinstellungs-Gruppen).
- **Mehrstaatliche Steuersatzlogik** (Land-Enum wird erfasst, aber AT/CH/FR/UK/JE-
  Steuersätze = UNKNOWN/Non-Goal; M3-01 nutzt M2-01-Steuervertrag 0 %/19 %).
- **GoBD-Durchsetzung** (Aufbewahrungs-**Default** wird modelliert; Erzwingung/
  Archiv = Folgeslice; M3-01 §13).
- **Workspace-Löschung/-Lifecycle** (kein Erasure-Pfad für Mandanten-Stammdaten).
- **Rechnungs-Listen/Dokumente/PDF** (M3-01 bzw. M3-02).

---

## 12. DECIDED

1. **Singleton `workspace_invoicing_settings`** + Kind-Tabelle
   `workspace_document_number_format` (ADR 0024), nicht JSONB-in-`workspace`.
2. **Land-Enum `DE|AT|CH|FR|UK|JE`** (F8.2 DOCUMENTED).
3. **Precondition-Gate fail-closed** als `PreconditionConflict` in M3-01, nicht
   als stiller Default („Issuing Details Pflicht“).
4. **Nummernserien-Defaults = OBSERVED-Formate** (Reonic,
   `M3-UNKNOWN-RECON.md` §1d): `Rechnung-{YEAR}-{MONTH}-{NUMBER}`,
   `CRN-{YEAR}-{MONTH}-{DAY}-{NUMBER}`, `OFC-…`, `PO-…`, `DN-…`, `LE-…` —
   ersetzt die früheren DECIDED-Präfixe `RE/GU/AB/BE/LS/BR`/Padding 6;
   konfigurierbar (Template + Platzhalter-Validierung, M300-02).
5. **`goebd_retention_default_days` = 3650** (10 Jahre, ESTIMATE), Bereich 1…36500.
6. **DTO-Minimierung:** `companyTaxId`/`paymentIban` nur bei
   Issuing-Details-Berechtigung im Readmodell.
7. **Kein Kontakt-Erasure-Eintrag** für Workspace-Stammdaten (Firmendaten,
   keine Kontakt-PII).
8. **Settings-Gruppen getrennt** (Root O1): jede künftige Settings-Gruppe
   (Branding, Textvorlagen) erhält eine eigene Tabelle mit eigenem
   RLS-/Formvertrag — kein gemeinsamer Gruppen-Diskriminator (YAGNI).
9. **Retention-Default 3650 Tage bestätigt** (Root O2): 10 Jahre, übliche
   GoBD-/AO-§147-Aufbewahrung; bleibt ESTIMATE bezüglich des Reonic-Defaults.
10. **Kein Field-Level-Encryption in M3-00** (Root O3): RLS +
    DTO-Minimierung tragen M3-00; at-rest-/Field-Level-Encryption als
    SECURITY-Folgeslice dokumentiert.
11. **Nicht-DE-Land blockt Geld-Ausstellung** (Root O4): fail-closed mit
    klarem Hinweis bis Steuer-Folgeslice; `letter` (ohne Betrag) bleibt möglich.
12. **OBSERVED-Formate statt eigener Prefixe** (Root O5 superseded):
   `offer_number_series` (ANG) bleibt unangetastet; die kaufmännische
   Nummernwelt nutzt ab sofort die OBSERVED-Templates (§4.2/M300-02) —
   getrennte Nummernwelten Angebot vs. kaufmännische Dokumente.

## 13. Verbleibende UNKNOWN (zur Root-/Owner-Klärung)

1. Exakte Feld-**Validierungen** (Längen, Formate) der Reonic-Unterseite
   `issuing-details` — Feldnamen/Pflichtfelder sind OBSERVED
   (`M3-UNKNOWN-RECON.md` §1a–1c: Name*/Email*/Land*, USt-IdNr, Behörde,
   Registernummer, Adresse, Buchhaltungsmethode, Bankkonto, Textvorlagen);
   nur die Validierungsregeln selbst bleiben UNKNOWN → eigene = ESTIMATE.
2. ~~Exakte Nummernformate/Präfixe je Typ~~ → RESOLVED: OBSERVED
   (`M3-UNKNOWN-RECON.md` §1d, DECIDED 4).
3. Exakte GoBD-Aufbewahrungsfrist (Default 3650 = ESTIMATE).
4. Mehrstaatliche Steuer-/Zahlungs-Anforderungen (Land-Enum belegt, aber
   AT/CH/FR/UK/JE-Detailregeln UNKNOWN).
5. Field-Level-Encryption/Masking für `companyTaxId`/`paymentIban` —
   Root O3: bewusst NICHT in M3-00, als SECURITY-Folgeslice eingeplant.

---

## 14. Offene Fragen an den Root-Integrator — RESOLVED (2026-09-03)

1. **O1 — Singleton vs. gemeinsame Settings-Tabelle:** RESOLVED → eigene
   Tabellen je Settings-Gruppe (kein gemeinsamer Diskriminator, YAGNI).
2. **O2 — Retention-Default:** RESOLVED → 3650 Tage (10 Jahre) bestätigt;
   bleibt ESTIMATE für den Reonic-Default.
3. **O3 — TaxId/IBAN-Schutz:** RESOLVED → RLS + DTO-Minimierung trägt M3-00;
   Field-Level-Encryption = SECURITY-Folgeslice.
4. **O4 — Land-Gate-Wirkung:** RESOLVED → Nicht-DE blockt Geld-Dokument-
   Ausstellung fail-closed bis Steuer-Folgeslice; Brief bleibt möglich.
5. **O5 — Nummernserien-Default:** RESOLVED, dann **SUPERSEDED**
   (Kimi-P1-1): die frühere Entscheidung „dokumenttyp-eigene Prefixe
   `RE/GU/AB/BE/LS/BR`“ ist durch die OBSERVED-Templates ersetzt
   (DECIDED 4/12); `offer_number_series` (ANG) bleibt unangetastet.
