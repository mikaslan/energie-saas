# M3-01 — Rechnungen & kaufmännische Dokumente: Kern (F8)

- Status: **DISCOVERED → SPECIFIED** · noch nicht CONTRACTED/RED/IMPLEMENTED
- Datum: 2026-09-03
- F-Bezug: **F8** (Modulkatalog `M8 — Rechnungsstellung` F8.1/F8.3/F8.6-Filter &
  Berichte; Goal-Prompt §8 F8 „Rechnungen und kaufmännische Dokumente“) —
  **DOKUMENT-KERN**, bewusst begrenzt (Non-Goals §13).
- Architektur: **ADR 0023** (`docs/adr/0023-rechnungs-dokumentmodell.md`)
- Basis: **`codex/m2-integration`** (HEAD `12c863f`) — Begründung §0.1
- Geplante Migration: **`0046_m3_01_invoicing_core.sql`** (Root-Arbitrage vom
  2026-09-03: M2-04 behält `0044`, M3-00 nimmt `0045`; Kette
  `0042→0043→0044→0045(M3-00)→0046(M3-01)`, §0.1)
- Ziel: keine — dieser Slice ist reine Spezifikation (nur Doku, kein Code/Commit).

> **Vorgänger-Dokument:** Diese Fassung ersetzt die Root-Skizze „M3-01 …
> Kern (F8)“ (Status DISCOVERED→SPECIFIED, Basis `12c863f`) und erweitert sie
> zur vollständigen Slice-Spec. Capability-IDs M301-01…10 und Tabellenname
> `commercial_document` bleiben die vom Root gesetzten kanonischen Labels.

---

## 0. Quellenlegende

| Kürzel | Quelle | Rolle |
|---|---|---|
| `PDEEP` | `artifacts/browser-recon-20260902/deep/PORTAL-DEEP.txt` (2026-09-03) | DOM-verifizierte Tiefgang-Datei: Invoicing-Tabs/Routen/Spalten/Enums/Berichte |
| `PDEEP-IMG` | `artifacts/browser-recon-20260902/deep/*.png` (Screenshots) | visuelle Strukturbelege (nur Referenznamen, keine Pixel/PII übernommen) |
| `AMAP` | `docs/parity/REONIC-PORTAL-AUDIT-MAP.md` | Bereichsliste + F-Mapping (F8.1/F8.3, Berichte) |
| `ACSV` | `docs/parity/reonic-portal-audit/reonic_funktionskatalog.csv` + `reonic_portal_audit_gesamt.csv` | 118-Zeilen-Katalog, Invoicing-Routen/Funktionen/Grenzen |
| `MODKAT` | `docs/blaupause/01-modulkatalog.md` (M8, Zeilen 102–112) | F8.1–F8.7 als primäre Abnahmequelle |
| `GOAL` | `REONIC-PARITY-GOAL-PROMPT.md` §7/§8 | Evidence-Klassifikation + F8-Funktionsliste |
| `M201` | `docs/spec/M2-01-angebotsvarianten-snapshot-bom.md` + `lib/integrations/offers/money.ts` + `lib/db/schema/offers.ts` | Geldlogik-Muster (Cent, Half-up, Basispoints, Snapshot-SHA, Nummernserie) |
| `M114`/`M115` | `docs/spec/M1-14-kontaktdatensatz.md`, `docs/spec/M1-15-termine-kalender.md` | Struktur-/Stil-Vorlage (Quellenlegende, Capability-Sheet, Testmatrix, DECIDED/UNKNOWN) |
| `ERASURE` | `lib/db/schema/erasure.ts` + `drizzle/0027_m1_07_gdpr_erasure.sql` | `ErasureGraphIds`, Legal-Hold-/Erase-Gate-Muster |
| `ADR 0023` | `docs/adr/0023-rechnungs-dokumentmodell.md` | Architekturentscheidung: generisches Document-Modell |

> **Evidenz-Klassifikation (Goal-Prompt §7):** `OBSERVED` (rechtmäßig beobachtet),
> `DOCUMENTED` (öffentliche Doku/Spec), `INFERRED`, `DECIDED` (bewusste
> Eigenentscheidung), `UNKNOWN`, `CONFLICTING`. Es wurden **keine** Reonic-Texte,
> Assets, Kundendaten, Preise oder IDs als Produktinhalt übernommen; alle
> Personendaten sind maskiert. `ESTIMATE`-Werte sind als solche markiert.

### Referenz-Screenshots (PDEEP-IMG, nur Dateinamen)

`invoicing.png` (Landing/Weiterleitung), `invoicing-document-groups.png`,
`invoicing-all-invoices.png`, `invoicing-credit-notes.png`,
`invoicing-offer-confirmations.png`, `invoicing-purchase-orders.png`,
`invoicing-deliver-notes.png`, `invoicing-letters.png`, `invoicing-reports.png`.

### 0.1 Basis- und Migrations-Kette

**Basis-Entscheidung (DECIDED): `codex/m2-integration`, HEAD `12c863f`.**

Geprüft (2026-09-03): `codex/m2-integration` (`12c863f`) enthält die M1-Welle
(`0040`=M1-11b, `0041`=M1-13, inkl. Reparatur-Commit „repair 0041 snapshot
chain“) **und** die M2-Angebotslinie (`1904eaa` M2-01 → `fc08949` M2-02 →
`62b75bd` M2-03a → `a06f961` M2-03b1). `codex/m1-wave-01` steht einen Commit
zurück auf `e5a9c5d` (identisch minus 0041-Reparatur).

**Warum `m2-integration`:** M3-01 (Rechnungen) ist der fachliche Nachfolger der
M2-Angebotslinie. Der Slice übernimmt die Geldlogik (Cent/Half-up/Basispoints),
die Snapshot-/SHA-Immutable-Semantik und den Nummernkreis-Vertrag aus M2-01.
`m2-integration` trägt die semantisch korrekte Herkunft und den aktuelleren
Stand (0041-Fix). Eine spätere Divergenz (M1-Welle-02 vs. M2/M3-Welle) würde
bei falscher Basiswahl teuer; hier ist die Wahl risikoarm und eindeutig.

**Migrationsnummer (Root-Arbitrage 2026-09-03, O1 RESOLVED):** M3-01 erhält
**`0046_m3_01_invoicing_core.sql`**. M2-04 ist bereits mit `0044` in
Implementierung (`0044_m2_04_e_signature.sql`); es wird nicht umnummeriert.
M3-00 (Workspace-Stammdaten, O4) ist Vorbedingung und nimmt als zuerst
integrierter M3-Slice `0045`. Reservierte Kette: `0042`=M1-14 (Kontakt) →
`0043`=M1-15 (Termine) → `0044`=M2-04 (E-Signatur) → `0045`=M3-00
(Stammdaten) → `0046`=M3-01 (Invoicing-Kern).

### 0.2 F-Nummern-Hinweis (nicht konfliktär)

Der Modulkatalog führt Rechnungen als **M8** (F8.1–F8.7), der Goal-Prompt als
**F8**; `M3` ist der Delivery-Meilenstein (§11 Goal-Prompt). M3-01 deckt einen
**Teil** von F8.1/F8.3/F8.6 ab (Dokument-Kern) — nicht F8 als Ganzes. Die
Canonical-F-Nummern bleiben unverändert.

---

## 1. Nutzerergebnis (JTBD)

Ein interner **Editor/Admin mit Invoicing-Recht** verwaltet workspaceweit
kaufmännische Dokumente über sieben typgetrennte Tabs plus eine
Dokumentgruppen-Übersicht und eine Berichtsseite. Er kann Dokumente anlegen
(7 Typen), als Entwurf pflegen, **ausstellen** (dann Nummer + unveränderlicher
Snapshot), **versenden** (Versand-Achse) und **stornieren** (Void mit Grund).
Parallel pflegt er die **Zahlungsachse** (Unbezahlt/Teilweise/Bezahlt/Überfällig/
Uneinbringlich). Die Berichtsseite zeigt Einnahmen/Cashflow/Ausstehend/Überfällig
mit Überfälligkeits-Buckets (0–30/31–60/61–90/90+) und Daten-Export. Viewer
sehen read-only; External/Worker/Fremdtenant bleiben fail-closed. Jede
Mutation erzeugt Domain-Event **und** Audit-Zeile in derselben Transaktion.

M3-01 erzeugt **kein** PDF-Rendering (eigener Folgeslice M3-02, analog M2-02),
**keine** Teilrechnungsketten, **kein** EPC-QR, **keine** Steuerberater-Syncs
und **keine** E-Rechnung/GoBD.

---

## 2. Clean-Room-Evidenz (OBSERVED — PORTAL-DEEP)

Top-8-Erkenntnisse aus `PDEEP` (paraphrasiert, keine Texte/PII):

1. **Invoicing-Navigation:** `/invoicing` leitet auf `/invoicing/document-groups`
   („Übersicht“) weiter; linke Tabs je Typ mit Zähler-Badges.
2. **Routen:** Übersicht `document-groups`, `all-invoices`, `credit-notes`,
   `offer-confirmations` (Auftragsbestätigungen), `purchase-orders`,
   `deliver-notes`, `letters`; Berichte eigenständig unter `/backoffice/reports`.
3. **Rechnungs-Spalten:** Name | Betrag | Status | Zahlungsstatus |
   Ausstellungsdatum | Fälligkeitsdatum; Filter Status/Zahlungsstatus/
   Ausstellungsdatum/Fälligkeitsdatum/Archiviert; Suche „Rechnungen oder
   Projekte suchen“; „Neu“-Dropdown Rechnung/Teilrechnung.
4. **Typ-spezifische Spalten/Filter:** Gutschrift (Lieferdatum, Typ-Filter),
   Auftragsbestätigung (geplantes Liefer-/Leistungsdatum), Bestellung
   (Gültigkeitsdatum), Lieferschein (Lieferdatum), Brief (Gültigkeitsdatum,
   **ohne Betrag**).
5. **Status-Enums (Filter-Dropdowns):** Dokument-Status `Entwurf | Ausgestellt |
   Storniert`; Zahlungsstatus `Teilweise bezahlt | Bezahlt | Unbezahlt |
   Überfällig | Uneinbringlich`.
6. **Berichte-Gruppierung „Nach Status“ (Lebenszyklus):** `Versendet | Bezahlt |
   Überfällig | Entwurf | Storniert` — belegt Versand-/Zahlungszustände als
   von der Dokument-Status-Achse getrennte, im Reporting zusammengeführte Achsen.
7. **Berichte-Seite:** KPIs Einnahmen diesen Monat | Cashflow diesen Monat |
   Ausstehend | Überfällig (je Vormonats-Vergleich); Tabelle „Neueste Dokumente“
   (Name|Betrag|Status|Zahlung); Diagramm „Einnahmen Nach Status“;
   Überfälligkeitsbericht `0-30 | 31-60 | 61-90 | Über 90 | Insgesamt ausstehend`;
   Aktion „Daten herunterladen“.
8. **Anfragen-/Angebote-/Komponenten-/Einstellungs-Enums** (Rahmenkontext, nicht
   M3-01-Scope): Anfragen-Filter (Status-Pipeline, Vertriebsstatus, Lead-Score,
   Quellen), Angebote-Kanban (Vertriebsphasen, Unterschrift-Status), Komponenten-
   Typen (13), Einstellungs-Baum inkl. „Rechnungsstellung“-Unterseite
   (`/portal-settings?settings=invoicing&tab=issuing-details` — Nummerierung/
   Textvorlagen; **Nichtziel** M3-01, siehe §13).

`ACSV` bestätigt die Routen/Funktionen/Grenzen („Keine Dokumente erstellt“,
Schreibfunktionen nur beobachtet, nicht betätigt).

---

## 3. Capability-Sheet (Goal-Prompt §7)

**Gemeinsamer Liefervertrag (alle M301-xx):** Workspace-Tenant-Grenzen; jeder
Schreibpfad validiert Actor/Membership server-seitig, prüft Invoicing-Recht
und schreibt Domain-Event + Audit-Zeile in **derselben** Transaktion; Beträge
immer Cent-Integer (`bigint`); Externe Nebenwirkungen = keine (kein E-Mail-/PDF-
Versand in M3-01); Notifications = keine (Folgeslice); Pflichtzustände
Loading/Empty/Error/Success/Disabled/Permission-Denied gemäß §11.

### M301-01 — Dokument anlegen (7 Typen + Dokumentgruppen)

- **F-Nr:** F8.1 · **Modul:** `modules/invoicing/` · **Route:** je Typ-Tab
  `/w/{workspaceId}/rechnungen/{typ}` + Übersicht `…/rechnungen` (Gruppen)
- **Akteur/Rolle:** Editor+ mit `invoicing.write`
- **JTBD:** Dokument eines der 7 Typen anlegen (frei oder gruppengebunden);
  Dokumentgruppen als Projekt-Behälter anlegen/archivieren
- **Trigger:** „Neu“ (bei Rechnungen Dropdown Rechnung/Teilrechnung — Teilrechnung = Non-Goal)
- **Vorbedingungen:** Workspace aktiv; Issuing-Details vorhanden (F8.2) für Geld-Dokumente
- **Happy Path:** Typ wählen → Name/Positionen/typ-Datumfelder → Entwurf gespeichert; Gruppe anlegen → in Übersicht mit Artikelzähler
- **Varianten:** Brief ohne Betrag; freie vs. gruppengebundene Anlage; leerer Zustand „0 Artikel“
- **Eingabefelder:** Name, Positionen (Menge/Einheit/Netto/Steuer), typ-spezifische Daten (Fälligkeit/Lieferung/Gültigkeit/geplante Daten); Gruppe: Name
- **Validierungen:** Typ-Enum; typ-abhängige Pflichtfelder (CHECK+Service); Beträge cent-ganz ≥ 0; Gruppenname 1–120 non-empty, workspaceweit eindeutig
- **Zustände:** Dokument `draft` (initial); Gruppe `aktiv | archiviert`
- **Erlaubte Übergänge:** Gruppe `aktiv ↔ archiviert`; Dokument-Übergänge → M301-02/04
- **Persistente Nebenwirkungen:** `commercial_document`(+`_line`), `commercial_document_group`
- **Berechtigung:** `invoicing.write` · **Tenant-Scope:** `workspaceId` (+ optional `projectId`/`groupId`)
- **API-Operationen:** `createDocument(type, input)`, `listDocumentGroups`, `createDocumentGroup`, `archiveDocumentGroup`
- **Datenentitäten:** `commercial_document`, `commercial_document_line`, `commercial_document_group`
- **Audit Events:** `commercial_document.created`, `commercial_document_group.created/archived/unarchived`
- **Evidence:** `PDEEP` §1a–1g; `ACSV` Routen · **Confidence:** OBSERVED (Typen/Routen), DECIDED (freie Anlage; Angebot-zu-Rechnung = Non-Goal)

### M301-02 — Dokument ausstellen (Nummernkreis + Snapshot, immutable)

- **F-Nr:** F8.3 · **Akteur:** Editor+ mit `invoicing.write` (+ Issuing-Details)
- **Route:** Dokument-Detail · **Trigger:** „Ausstellen“
- **Vorbedingungen:** `draft`; Beträge cent-ganz; Issuing-Details vorhanden
- **Happy Path:** `draft → issued`; Nummer aus `commercial_document_number_series`
  zuweisen; `issued_snapshot` + `snapshot_sha256` (32 byte) speichern; Content einfrieren
- **Varianten:** Jahreswechsel (neue Serie); verbrannte Nummern bleiben verbrannt
- **Eingabefelder:** keine (Nummer systemseitig) · **Validierungen:** Nummer
  eindeutig je `(workspaceId, type, number_year, number_sequence)`; SHA=32 byte
- **Zustände:** `draft → issued` · **Übergänge:** `draft→issued`
- **Persistente Nebenwirkungen:** `issued_at`, `document_number`+Teile, `issued_snapshot`, `snapshot_sha256`, `issued_by`
- **Berechtigung:** nur Issue-Service · **API-Operationen:** `issueDocument` (intern `reserveDocumentNumber`)
- **Datenentitäten:** `commercial_document`, `commercial_document_number_series`
- **Audit Events:** `commercial_document.issued`
- **Evidence:** `PDEEP` Status-Enums; `MODKAT` F8.3; `M201` `offer_number_series` · **Confidence:** OBSERVED (Enum), DECIDED (JSON-Snapshot + SHA analog M2; WORM/GoBD = Non-Goal)

### M301-03 — Versenden (Versand-Achse)

- **F-Nr:** F8.3 · **Akteur:** Editor+ mit `invoicing.write`
- **Route:** Dokument-Detail · **Trigger:** „Als versendet markieren“
- **Vorbedingungen:** `issued` · **Happy Path:** `sentAt` setzen (einmalig)
- **Varianten:** Transport vorbereitet, kein echter Versand (Non-Goal)
- **Eingabefelder:** keine · **Validierungen:** `sentAt` nur ab `issued`; nicht rücknehmbar
- **Zustände:** Versand-Achse `not_sent → sent` · **Übergänge:** einmalig, terminal
- **Persistente Nebenwirkungen:** `sent_at`
- **Berechtigung:** `invoicing.write` · **API-Operationen:** `markSentDocument`
- **Audit Events:** `commercial_document.sent`
- **Evidence:** `PDEEP` Berichte-Gruppierung „Versendet“; `MODKAT` F8.3 · **Confidence:** OBSERVED (Gruppierung), DECIDED (boolesche Achse, kein 4. Status)

### M301-04 — Stornieren (Void)

- **F-Nr:** F8.3/F8.6 · **Akteur:** Editor+ mit `invoicing.write`
- **Route:** Dokument-Detail · **Trigger:** „Stornieren“
- **Vorbedingungen:** `issued` oder `sent` (auch `draft → void` als Verwerfen)
- **Happy Path:** `→ voided`; `void_reason` (Festliste) Pflicht; Content unverändert
- **Varianten:** Gutschrift ist getrennt (nicht Teil von Void); Nummer wird nicht freigegeben
- **Eingabefelder:** Void-Grund (Enum) · **Validierungen:** Grund Pflicht; `voided` terminal
- **Zustände:** `issued/sent/draft → voided` · **Übergänge:** `draft→voided`, `issued→voided`, `sent→voided`
- **Persistente Nebenwirkungen:** `voided_at`, `void_reason`
- **Berechtigung:** `invoicing.write` · **API-Operationen:** `voidDocument`
- **Audit Events:** `commercial_document.voided`
- **Evidence:** `PDEEP` Status-Enum „Storniert“; `MODKAT` F8.6 · **Confidence:** OBSERVED (Enum), DECIDED (Grund-Festliste eigene Werte)

### M301-05 — Zahlungsachse

- **F-Nr:** F8.3 · **Akteur:** Editor+ mit `invoicing.write`
- **Route:** Dokument-Detail + Listenfilter · **Trigger:** Zahlungsstatus setzen / Fälligkeit überschritten
- **Vorbedingungen:** `issued`-Geld-Dokument; Brief hat keine Zahlungsachse
- **Happy Path:** `unpaid → partially_paid → paid`; `unpaid → overdue` (auto bei Fälligkeit)
- **Varianten:** `uncollectable` terminal; `paid` nur wenn `paid_cents ≥ gross_cents`
- **Eingabefelder:** Zahlungsstatus, optional `paid_cents` (Cent)
- **Validierungen:** `partially_paid ⇔ 0 < paid_cents < gross_cents`; `paid ⇒ paid_cents ≥ gross_cents`
- **Zustände:** `unpaid | partially_paid | paid | overdue | uncollectable`
- **Übergänge:** `unpaid↔partially_paid→paid`, `unpaid/partially_paid→overdue→paid`, `→uncollectable`; `paid`/`uncollectable` terminal
- **Persistente Nebenwirkungen:** `payment_status`, `paid_cents`, `payment_updated_at`
- **Berechtigung:** `invoicing.write` · **API-Operationen:** `setPaymentStatus`, `recordPayment`
- **Audit Events:** `commercial_document.payment_updated`
- **Evidence:** `PDEEP` Zahlungsstatus-Enum; `MODKAT` F8.3 „Overdue(auto)“ · **Confidence:** OBSERVED (Enum), DECIDED (auto-overdue-Mechanik; exakter Takt UNKNOWN)

### M301-06 — Liste + Filter (typ-spezifische Spalten)

- **F-Nr:** F8.3 · **Akteur:** Editor+/Viewer (`invoicing.read`)
- **Route:** je Typ-Tab · **Trigger:** Tab öffnen; Filter/Suche/Archiv-Toggle
- **Happy Path:** Liste mit typ-spezifischen Spalten + Filter + Suche + Archiv-Toggle (§7)
- **Eingabefelder:** Status, Zahlungsstatus (nur Geld), Datumsbereiche, Archiviert, Suche
- **Validierungen:** Filter-Enums gebunden; Datumsbereichslogik
- **Zustände:** — (Listen-/Filterzustand) · **API-Operationen:** `listDocuments(type, filters, cursor)`
- **Datenentitäten:** `commercial_document` (Readmodell) · **Audit Events:** —
- **Evidence:** `PDEEP` §1b–1g; `ACSV` · **Confidence:** OBSERVED (Spalten/Filter)

### M301-07 — Berichte

- **F-Nr:** F8.x (Querschnitt Reporting) · **Akteur:** Editor+/Viewer (`invoicing.read`)
- **Route:** `/backoffice/reports` (Tabs Übersicht | Forderungen) · **Trigger:** Seite öffnen; „Daten herunterladen“
- **Happy Path:** KPIs + Vormonatsvergleich + Neueste-Dokumente + Einnahmen-nach-Status + Überfälligkeits-Buckets; CSV-Export
- **Varianten:** leerer Zustand (0 €, keine Dokumente)
- **Eingabefelder:** Zeitraum (Kalendermonat Europe/Berlin) · **Validierungen:** Buckets disjunkt; Cent→Dezimal korrekt
- **Zustände:** — (Readonly-Aggregate) · **API-Operationen:** `getInvoicingReport(month)`, `exportInvoicingReport(month)`
- **Datenentitäten:** `commercial_document` (Aggregation) · **Audit Events:** —
- **Evidence:** `PDEEP` §1h; `ACSV` Berichte · **Confidence:** OBSERVED (Labels/Buckets/Aktionen), DECIDED (KPI-Definitionen §8, ESTIMATE)

### M301-08 — Beträge (Cent + Rundungsausgleich)

- **F-Nr:** F8.3/F8.5 · **Akteur:** Service (serverautoritativ)
- **Route:** — (Berechnung bei Save/Issue) · **Trigger:** Positionsänderung/Ausstellung
- **Vorbedingungen:** Netto-Basis EUR (wie M2-01) · **Happy Path:** Zeile netto → Steuer half-up → brutto = netto+steuer; Summen = Σ Zeilen
- **Varianten:** Brief ohne Betrag; Steuer 0 %/19 %
- **Eingabefelder:** Menge/Einheit/Netto/Steuer je Position
- **Validierungen:** Beträge 0…9e15 Cent (`moneyCheck`); `gross = net + tax` je Zeile und Summe
- **Zustände:** — (Berechnung) · **API-Operationen:** intern `calculateDocumentPricing` (Wiederverwendung `money.ts`)
- **Datenentitäten:** `commercial_document_line` · **Audit Events:** —
- **Evidence:** `M201` `lib/integrations/offers/money.ts` · **Confidence:** DECIDED (Übernahme M2-01-Geldvertrag; exakte Reonic-Rundung UNKNOWN)

### M301-09 — RBAC/RLS

- **F-Nr:** F8.2 · **Akteur:** alle Rollen · **Route:** — (DB-/Service-Ebene)
- **JTBD:** Invoicing-Recht + RLS strikt durchsetzen
- **Happy Path:** Viewer read-only, External/Worker/Fremdtenant fail-closed, Cross-Tenant negativ
- **Validierungen:** `invoicing.read`/`invoicing.write`; RLS-Policies tenant-gebunden
- **Berechtigung:** `invoicing.read`/`invoicing.write` · **Datenentitäten:** alle `commercial_document*`
- **Evidence:** `ERASURE`; `MODKAT` F8.2 · **Confidence:** DECIDED (RLS-Grenzen nach Muster M1-00…M1-03)

### M301-10 — Erasure

- **F-Nr:** DSGVO-Querschnitt · **Akteur:** System (Erasure-Graph)
- **Route:** — · **Trigger:** Kontakt-/Projekt-Erasure
- **Happy Path:** `ErasureGraphIds` um `commercialDocumentIds`/`commercialDocumentGroupIds` erweitern; issued+offene Forderung blockt; draft/void/paid scrubben Empfänger-PII
- **Varianten:** Geldkern (Beträge/Nummern/Status) bleibt; nur `recipient_snapshot`-PII gescrubbt
- **Validierungen:** Legal-Hold-/Vertrags-Gate (Muster `contact_legal_hold`)
- **Datenentitäten:** `commercial_document`, `commercial_document_group`
- **Evidence:** `ERASURE`; `MODKAT` F8.7 · **Confidence:** DECIDED (Minimal-Grenze; GoBD-Aufbewahrung = Non-Goal)

---

## 4. Datenmodell-Skizze (Migration `0046`, additiv)

Reihenfolge der Tabellen in der Migration (alle workspace-tenantgebunden,
FK auf `workspace.id`, tenant-gebundenes Unique `(workspaceId, id)` wie M2-01):

1. **`commercial_document_group`** — `id`, `workspaceId`, `projectId` (nullable),
   `name` (1–120), `archivedAt` (nullable), `createdBy`→membership,
   `createdAt`/`updatedAt`. Unique `(workspaceId, id)`, `(workspaceId, name)`.
2. **`commercial_document_number_series`** — Muster `offer_number_series`: `id`,
   `workspaceId`, `type` (7-Enum), `seriesYear`, `prefix`, `padding`,
   `lastSequence` (0…999999). Unique `(workspaceId, type, seriesYear)`.
3. **`commercial_document`** (Kern, ADR 0023) — `id`, `workspaceId`, `type`,
   `groupId` (nullable), `projectId` (nullable), `contactId` (nullable,
   Empfänger), `status` (`draft|issued|voided`), `sentAt` (nullable),
   `voidedAt`/`voidReason` (nullable), `name` (1–160), `number`/`numberYear`/
   `numberSequence` (nullable bis `issued`), `issuedAt` (nullable),
   `currency` (`'EUR'`), `netCents`/`taxCents`/`grossCents` (bigint,
   `moneyCheck`; bei `letter` 0/0/0), `paymentStatus` (nullable für `letter`,
   sonst `unpaid|partially_paid|paid|overdue|uncollectable`), `paidCents`
   (bigint, default 0), `dueDate`/`deliveryDate`/`validityDate`/
   `plannedDeliveryDate`/`plannedServiceDate` (nullable, typ-bedingt),
   `recipientSnapshot` (JSONB, PII-arm: Anrede/Name/Adresse als Snapshot),
   `issuedSnapshot` (JSONB, nullable bis `issued`), `snapshotSha256`
   (bytea, nullable bis `issued`), `issuedBy`→membership, `createdBy`,
   `createdAt`/`updatedAt`. CHECKs: Typ-Enum; je Typ Pflicht-Datumfelder;
   `status='issued' ⇒ number/snapshot/hash/issuedAt not null`; Geld-/Zahlungs-
   Konsistenz; `letter ⇒ grossCents=0 ∧ paymentStatus is null`.
4. **`commercial_document_line`** — Muster `offer_bom_line` (vereinfacht, ohne
   Katalog-FK): `id`, `workspaceId`, `documentId`, `position`, `name`,
   `quantityMilli`, `unit` (`piece|set|meter`), `netCents`/`taxCents`/`grossCents`
   (bigint), `taxRateBps` (0|1900), `lineSnapshot` (JSONB). CHECKs:
   `grossCents = netCents + taxCents`; Position 1…500.

**Kanonisierung:** `issued_snapshot` trägt `schemaVersion =
'document-snapshot.v1'` und `canonicalizationVersion = 'document-jcs.v1'`,
analog `offer_variant_revision` (`offer-variant-snapshot.v1`/`offer-jcs.v1`).

**Index:** `(workspaceId, type, status, updatedAt, id)` für Listen;
`(workspaceId, type, numberYear, numberSequence)` für Nummernkreis; partielle
Indizes für Berichte (Beträge je Zeitraum).

> Dies ist eine **Skizze**, kein Schema-Contract. Exakter Drizzle-/CHECK-Vertrag
> entsteht bei CONTRACTED (schema-hash-gepinnt), analog M1-14/M1-15.

---

## 5. Zustandsmaschinen

### 5.1 Dokument-Status (`commercial_document.status`)

```
draft ──issue──▶ issued ──void──▶ voided
  │                │
  └──void(verwerfen)└──mark_sent──▶ (issued bleibt issued; sentAt gesetzt)
```

- `draft`: editierbar (Content).
- `issued`: Nummer + `issuedSnapshot` + `snapshotSha256` gesetzt; Content
  **unveränderlich** (nur Versand-/Zahlungsachse/Void erlaubt).
- `voided`: terminal; Content unverändert, `voidReason` Pflicht.
- Übergänge: `draft→issued`, `draft→voided`, `issued→voided`; `sent` ist keine
  eigene Statusstufe, sondern die **Versand-Achse** (§5.2).

### 5.2 Versand-Achse (`commercial_document.sentAt`)

- `not_sent` (null) → `sent` (`sentAt` nicht-null). Einmalig, nicht rücknehmbar.
- Gilt ab `issued`; ein `draft` ist nie `sent`.

### 5.3 Zahlungsachse (`commercial_document.paymentStatus`, nur Geld-Dokumente)

```
unpaid ─▶ partially_paid ─▶ paid
  │            │
  └─(fällig)──▶ overdue ─▶ paid
  └─▶ uncollectable (terminal)
```

- `unpaid` initial; `overdue` **auto** aus `unpaid`/`partially_paid` sobald
  `dueDate < heute` (DECIDED: periodischer Check bzw. on-read Derivation;
  exakter Takt UNKNOWN).
- `paid`/`uncollectable` terminal.
- `partially_paid` ⇔ `0 < paidCents < grossCents`; `paid` ⇒ `paidCents ≥ grossCents`.

---

## 6. Nummernkreise

- Workspaceweit, **je Typ** (7 Serien), jahresbasiert (`seriesYear`).
- Format DECIDED (Standard, konfigurierbar über Workspace-Stammdaten, F8.2):
  `<PREFIX>-<JJJJ>-<NNNNNN>`, Padding 6. Vorschlags-Präfixe (DECIDED):
  `RE` (Rechnung), `GU` (Gutschrift), `AB` (Auftragsbestätigung), `BE`
  (Bestellung), `LS` (Lieferschein), `BR` (Brief). Exakte Reonic-Präfixe
  UNKNOWN.
- **Verbrannte Nummern bleiben verbrannt:** `void` gibt die Nummer nicht frei;
  `lastSequence` ist monoton. Race-sichere Vergabe innerhalb der
  Issue-Transaktion (Row-Lock auf `commercial_document_number_series`,
  CAS/`FOR UPDATE`), analog `offer_number_series`.

---

## 7. Spalten-/Filter-Sets je Typ (aus PDEEP §1, OBSERVED)

| Typ | Spalten | Filter | Suche | Neu-Aktion |
|---|---|---|---|---|
| Übersicht (Gruppen) | Name | — | — | „Neu“ (Gruppe) |
| Rechnung | Name · Betrag · Status · Zahlungsstatus · Ausstellungsdatum · Fälligkeitsdatum | Status, Zahlungsstatus, Ausstellungsdatum, Fälligkeitsdatum, Archiviert | „Rechnungen oder Projekte suchen“ | Dropdown: Rechnung / Teilrechnung (Teilrechnung = Non-Goal) |
| Gutschrift | Name · Betrag · Status · Zahlungsstatus · Ausstellungsdatum · Lieferdatum | Status, Typ, Ausstellungsdatum, Lieferdatum, Archiviert | wie Typ | „Neu“ |
| Auftragsbestätigung | Name · Betrag · Status · Ausstellungsdatum · Geplantes Lieferdatum · Geplantes Leistungsdatum | Status, Ausstellungsdatum, Archiviert | wie Typ | „Neu“ |
| Bestellung | Name · Betrag · Status · Ausstellungsdatum · Gültigkeitsdatum | Status, Ausstellungsdatum, Archiviert | wie Typ | „Neu“ |
| Lieferschein | Name · Betrag · Status · Ausstellungsdatum · Lieferdatum | Status, Ausstellungsdatum, Archiviert | wie Typ | „Neu“ |
| Brief | Name · Status · Ausstellungsdatum · Gültigkeitsdatum | Status, Ausstellungsdatum, Archiviert | wie Typ | „Neu“ |

Zusätzlich je Liste: Ergebniszähler, Paginierung, Archiv-Toggle, Zeilenmenü.
Filter-/Spalten-Enums sind genau die Portal-Enums (§2).

---

## 8. Berichte (`/backoffice/reports`, M301-07)

- **Tabs:** Übersicht, Forderungen.
- **KPIs (DECIDED-Definitionen):**
  - *Einnahmen diesen Monat:* Σ `grossCents` aller `issued`-Geld-Dokumente mit
    `issuedAt` im aktuellen Kalendermonat (Europe/Berlin).
  - *Cashflow diesen Monat:* Σ `paidCents` mit `payment_updated_at` im Monat
    (ESTIMATE: Zahlungseingang als Cashflow-Proxi; exakte Reonic-Definition
    UNKNOWN).
  - *Ausstehend:* Σ `grossCents − paidCents` über `issued`-Dokumente mit
    `paymentStatus ∈ {unpaid, partially_paid, overdue}`.
  - *Überfällig:* Σ `grossCents − paidCents` mit `paymentStatus = overdue`.
  - Je KPI „Kein Vormonat“-Vergleich (Delta zum Vormonat).
- **Neueste Dokumente:** Name · Betrag · Status · Zahlung (letzte N, DECIDED 10).
- **Einnahmen nach Status:** Verteilung über Lebenszyklus-Gruppierung
  `Versendet | Bezahlt | Überfällig | Entwurf | Storniert`.
- **Überfälligkeitsbericht:** Buckets `0–30 | 31–60 | 61–90 | Über 90 |
  Insgesamt ausstehend` (Tage seit `dueDate`, disjunkt, kumulierte Beträge).
- **Export:** „Daten herunterladen“ = CSV (DECIDED: UTF-8, `;`-getrennt,
  Datum ISO-8601, Beträge in Euro-Dezimal mit 2 Nachkommastellen aus Cent).
  Monats-ZIP/DATEV = Non-Goal.

---

## 9. Geldvertrag (Cent, Rundungsausgleich)

Wiederverwendung des M2-01-Geldvertrags (`lib/integrations/offers/money.ts`),
ohne neue Rundungsentscheidungen:

- Alle Beträge **integer Cent** (DB `bigint` mode `number`), Bereich
  `0 … 9_000_000_000_000_000` (`moneyCheck`).
- **Netto-Basis** EUR, Half-up-Rundung, Basispoints (`taxRateBps` 0|1900).
- Zeile: `tax = round_half_up(net × taxRateBps / 10000)`, `gross = net + tax`;
  Dokument-Summen = Σ Zeilen → `net + tax = gross` strukturell erfüllt.
- **Rundungsausgleich:** Die Largest-Remainder-Allokation aus `money.ts`
  (`allocateTarget`) wird beibehalten und steht für Folgeslices
  (Teilrechnungs-Splits, Rabatte) bereit. In M3-01 gibt es noch keinen
  prozentualen Split → kein separater Ausgleich nötig, die Invariante
  `Σ gross = Σ net + Σ tax` gilt konstruktionsbedingt.
- `letter` trägt `net/tax/gross = 0` und keine Zahlungsachse.
- **Länder-Gates (F8.2):** als Workspace-Metadatum modelliert; mehrstaatliche
  Steuersatzlogik (AT/CH/FR/UK/Jersey) = UNKNOWN/Non-Goal; M3-01 nutzt den
  bestehenden M2-01-Steuervertrag (0 %/19 %).

---

## 10. Rollen-, RLS- und Erasure-Vertrag

- **Rechte (F8.2, DECIDED):** `invoicing.read` (Viewer+), `invoicing.write`
  (Editor+ mit Invoicing-Recht), Ausstellung/Versand/Void zusätzlich an
  Issuing-Details-Berechtigung gebunden. `external_only`-Mitglieder und
  Worker/Fremdtenant bleiben fail-closed (kein Readmodell-Eintrag).
- **RLS:** alle `commercial_document*`-Tabellen tenant-gebunden; Policies nach
  Muster der verifizierten RLS-Kern-Rollen (Runtime/Worker/Owner/Migrator),
  Rollenprobe erweitert (88/88 + neue Blöcke).
- **Erasure (DSGVO):** `ErasureGraphIds` wird um `commercialDocumentIds` und
  `commercialDocumentGroupIds` erweitert (additiv, analog `profileIds`/
  `snapshotIds`). Verhalten:
  - `issued`-Geld-Dokument mit offener Forderung → Erasure **blockt**
    (Legal-Hold-/Vertrags-Gate, Muster `contact_legal_hold`).
  - `draft`/`voided` oder bereits `paid`/`uncollectable` → PII im
    `recipientSnapshot` (Anrede/Name/Adresse) wird gescrubbt; Beträge, Nummern
    und Status bleiben erhalten (Geldkern ohne PII).
  - GoBD-Vollarchivierung/-Aufbewahrungs-Durchsetzung = Non-Goal (M3-01);
    das Aufbewahrungsdatum wird aber bereits als `goebd_retention_until`
    (nullable `date`, bei Ausstellung aus Workspace-Default gesetzt) modelliert
    — Durchsetzung im GoBD-Folgeslice (Root-Entscheid O5).

---

## 11. Oberfläche und Pflichtzustände

- **Informationsarchitektur:** Bereich „Rechnungen“ mit linken Tabs (Übersicht,
  6 Typen) + Top-Nav „Berichte“. Routen-Parallelität zu WMEE-Design, keine
  Reonic-Layout-Übernahme (Clean-Room/WMEE = visuelle Referenz).
- **Pflichtzustände je Liste/Detail:** Loading, Empty („0 Artikel“/„Keine
  Einträge“), Error, Success, Disabled, Permission-Denied.
- **Responsive:** Desktop (Tabellen), Tablet (kompaktere Spalten), 375-px-Mobile
  (kartenartige Zeilen; Berichts-KPIs stapeln). Offline: read-only nicht
  verpflichtend; Mutationen online-only.
- **A11y:** Screenreader-Zusammenfassung (Anzahl Treffer, Filter aktiv),
  Fokusreihenfolge, Tastaturbedienung für Filter/Tabs/Aktionen; keine
  farbalone Statuscodierung.
- **Visuelles Baseline-Gate:** bleibt bis Eigentümer-Freigabe `INCONCLUSIVE`
  (analog M2-01); Screenshot-Kandidaten nur als Strukturreferenz, keine
  Reonic-Assets/Texte.

---

## 12. Lock-/Race-/Immutable-Vertrag

- **Nummernvergabe:** atomar in der Issue-Transaktion; `FOR UPDATE`-Lock auf
  `commercial_document_number_series`-Zeile `(workspaceId, type, seriesYear)`;
  kein Nummern-Skip bei Rollback.
- **Immutable `issued`:** Content-Mutationen nach `issued` werden durch
  Service-Guard **und** DB-Guard (Trigger-Muster `0040`/M2-03b) abgelehnt;
  nur `sentAt`/`paymentStatus`/`paidCents`/`voided*` dürfen sich ändern.
- **Concurrent Save vs. Issue:** Issue liest denselben Revisions-/Digest-Stand
  (CAS); konkurrierendes Edit → `Conflict` (Muster M1-13 Revision-CAS).
- **Save vs. Erasure:** Erasure während aktiver Issue/Edit → Lock-Konflikt;
  Reihenfolge `project → workspace → document` (feste Lock-Ordnung).

---

## 13. Nichtziele (Non-Goals) — Folgeslices

- **Teilrechnungsketten** (F8.5: Percentage/Scheme/Remaining, Vererbung,
  >100 %-Ablehnung, Eltern-Zahlungsstatus).
- **PDF-Rendering** (Live-PDF-Preview, Zahlungs-PDF, EPC-QR) → M3-02.
- **EPC-QR**, **Monats-ZIP**, **DATEV/Lexware/sevDesk/Bexio-Sync** (F8.6).
- **E-Rechnung/EN 16931/ZUGFeRD/XRechnung** (F8.7) und **GoBD-Archivierung**.
- **Angebot-zu-Rechnung-Konvertierung** (Varianten-Import, „Duplicate into type“).
- **Brief-Templates** und Textvorlagen-/Nummerierungs-Einstellungs-UI
  (`/portal-settings?settings=invoicing`).
- **Mahnwesen**, **Bankabgleich**, **wiederkehrende Rechnungen** (F8.7).
- **Workspace-Stammdaten** (Issuing Details) als eigenständige Konfiguration —
  M3-01 setzt nur deren Existenz voraus (F8.2-Gate), baut die UI nicht.

---

## 14. Testmatrix

| Kürzel | Capability | Art | Prüfung | Gate |
|---|---|---|---|---|
| `M301-01` | Document Groups + Anlage | Unit/Contract/DB | Gruppe Create/Archive/Reopen; Typ-Enum; typ-Pflichtfelder; Brief ohne Betrag | `M301-DB-01` |
| `M301-02` | Ausstellen/Snapshot | DB | `issued`-Guard; SHA 32 byte; Snapshot-Konsistenz | `M301-DB-02` |
| `M301-03` | Versenden | Unit/DB | `sentAt` nur ab `issued`; nicht rücknehmbar | `M301-DB-03` |
| `M301-04` | Stornieren | Unit/DB | alle Void-Übergänge; Grund-Pflicht; `voided` terminal | `M301-DB-04` |
| `M301-05` | Zahlungsachse | Unit/DB | Enum-Übergänge; auto-overdue; `paid`-Bedingung | `M301-DB-05` |
| `M301-05` | Nummernkreise | DB/Race | Monotonie; Jahreswechsel; Void gibt Nummer nicht frei; Race (2 parallele Issues) | `M301-RACE-01` |
| `M301-06` | Filter-Sets | Contract | je Typ Spalten/Filter-Enums; Suche; Archiv | `M301-CON-01` |
| `M301-07` | Berichte | Unit/Contract | KPI-Werte; Buckets disjunkt; Vormonats-Delta; CSV-Format | `M301-CON-02` |
| `M301-08` | Geld/Rundung | Unit | Cent-Genauigkeit; `gross=net+tax`; Half-up-Kanten; Bereichsgrenzen | `M301-UNIT-01` |
| `M301-09` | RLS/Rechte | RLS | Viewer read-only; External/Worker/Fremdtenant fail-closed; Cross-Tenant negativ | Rollenprobe |
| `M301-10` | Erasure | Erasure | issued+offen blockt; draft/void/paid scrubbed; Graph-Erweiterung | `M301-ERASE-01` |
| — | Race-Kreuzung | Race | Save↔Issue↔Void↔Erasure; feste Lock-Ordnung | `M301-RACE-02` |
| — | Chromium-E2E | E2E | Create→Issue→Send→Void; Filter je Typ; Berichte; Export; A11y | `M301-E2E-*` |
| — | A11y | A11y | Screenreader-Zusammenfassung, Fokus, Tastatur, keine farbalone Codierung | `M301-A11Y-*` |

**DB-Matrix:** frisch + idempotent + Legacy-Upgrade-Pfad; je Typ ein
Verletzungsfall (falsches Datumsfeld, Brief mit Betrag, Geld ohne
Zahlungsstatus); 20+ Fälle analog M1-11b. **Rollenprobe:** 88/88 + neue
Invoicing-Blöcke; **PG18-Probe:** 5/5.

**Abschlussgates (Gate 2):** `npm run check` (alle Vitest-Dateien grün),
`npm run db:generate` ohne Drift, `npm run db:roles:verify` 88/88 + PG18 5/5,
Production-Build, ESLint, TypeScript, Dependency-Cruiser, `git diff --check`,
Secret-Scan, Chromium-E2E (inkl. A11y), unabhängiger Review (keine offenen
P0–P2). **Visual-Gate** bleibt `INCONCLUSIVE` bis Eigentümer-Freigabe.

---

## 15. DECIDED und UNKNOWN

### DECIDED

1. **Generisches `commercial_document`-Modell** mit Typ-Diskriminator +
   typisierten nullable Spalten + CHECKs (ADR 0023).
2. **Basis `codex/m2-integration`** (`12c863f`); Migration **`0046`**
   (Root-Arbitrage 2026-09-03: `0044` gehört M2-04, `0045` gehört M3-00
   Stammdaten). Implementierungs-Basis ist der Integrationsstand nach
   `0042`/`0043`/`0044`/`0045` zum RED-Zeitpunkt.
3. **Versand als boolesche Achse** (`sentAt`), nicht als vierter Dokument-Status;
   die Portal-Gruppierung „Versendet|Bezahlt|Überfällig“ ist eine Reporting-Zusammenführung.
4. **Geldvertrag = M2-01-Verbatim** (Cent, Netto-Basis EUR, Half-up,
   Basispoints 0|1900, Largest-Remainder-Allokation als Reserve); `letter` ohne Betrag.
5. **`overdue` auto** aus `unpaid`/`partially_paid` bei überschrittener Fälligkeit;
   exakter Job-Takt bleibt UNKNOWN.
6. **Immutable `issued`** via JSON-Snapshot + SHA-256 (Muster
   `offer_variant_revision`); WORM/Object-Lock (GoBD) = Folgeslice.
7. **Nummernkreis-Präfixe** `RE/GU/AB/BE/LS/BR`, Padding 6, Jahres-Serien —
   Standard, konfigurierbar; exakte Reonic-Präfixe UNKNOWN.
8. **Berichts-KPIs** wie §8 definiert (Kalendermonat Europe/Berlin);
   „Cashflow“ = Zahlungseingang als Proxi (ESTIMATE).
9. **CSV-Export** UTF-8, `;`-getrennt, ISO-Datum, Euro-Dezimal aus Cent.
10. **Erasure**: issued+offene Forderung blockt; draft/void/paid scrubben PII;
    Geldkern bleibt. `goebd_retention_until` wird bereits modelliert
    (O5), Durchsetzung/Export/WORM = GoBD-Folgeslice.

### UNKNOWN

1. Exakte Reonic-Definitionen der Berichts-KPIs (Cashflow vs. Einnahmen,
   Vormonatsfenster) — eigene Definitionen sind DECIDED/ESTIMATE.
2. Exaktes Nummernformat/Präfixe je Typ in Reonic (Einstellungen
   „Rechnungsstellung“ nicht ausgewertet).
3. Auto-`overdue`-Mechanik (Job-Takt, on-read vs. periodisch) und
   exakter Übergangszeitpunkt.
4. Gutschrift-„Typ“-Enum (Filter „Typ“ in `credit-notes`) — Werte nicht
   vollständig beobachtet (leerer Datenbestand).
5. Dokument-Gruppen-Detailfelder (nur Spalte „Name“ + „0 Artikel“ beobachtet;
   Detail-Ansicht nicht geöffnet).
6. Teilrechnungs-„Neu“-Dropdown-Semantik (Rechnung/Teilrechnung) — als
   Folgeslice markiert, aber die exakte Reonic-Ausprägung bleibt UNKNOWN.

---

## 16. Offene Fragen an den Root-Integrator — RESOLVED (2026-09-03)

1. **O1 — Migrationsnummer:** RESOLVED → M3-01 = **`0046`**; M2-04 behält
   `0044` (bereits in Implementierung, keine Umnummerierung); M3-00
   (Stammdaten, O4) nimmt `0045`. Kette
   `0042 (M1-14) → 0043 (M1-15) → 0044 (M2-04) → 0045 (M3-00) → 0046 (M3-01)`.
2. **O2 — Basis-Review:** RESOLVED → Spec-Basis `12c863f` bestätigt.
   Implementierung zweigt zum RED-Zeitpunkt vom Integrationsstand nach
   `0042`/`0043`/`0044`/`0045` ab; kein Warten, Spec geht in CONTRACTED.
3. **O3 — PDF-Grenze:** RESOLVED → bestätigt. „Ausstellen“ in M3-01 =
   Nummer + Snapshot (kein PDF); PDF-Rendering = M3-02 (analog M2-02).
4. **O4 — Issuing-Details-Gate:** RESOLVED → F8.2 wird eigenes kleines
   vertikales Slice **M3-00 (Workspace-Stammdaten „Ausstellungsdetails“)**,
   direkt vor M3-01. M3-01 modelliert die Vorbedingung, baut keine UI und
   fail-closed (Permission-Denied-Zustand) bei fehlenden Stammdaten.
5. **O5 — Erasure vs. GoBD:** RESOLVED → Minimal-Grenze tragfähig;
   zusätzlich `goebd_retention_until` jetzt modellieren (bei Ausstellung aus
   Workspace-Default gesetzt), Durchsetzung/Export/WORM im GoBD-Folgeslice.
