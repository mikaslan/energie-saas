# M3-01 — Rechnungen & kaufmännische Dokumente: Kern (F8)

- Status: DISCOVERED→SPECIFIED (Root-Version; Agenten-Erweiterung optional)
- Datum: 2026-09-03 · F-Bezug: F8 · Architektur: ADR 0023
- Basis: `codex/m2-integration` (`12c863f`) · Geplante Migration: **0044**
  (Kollisionsvermerk: M1-14=0042, M1-15=0043 parallel; Integration 0042→0043→0044)

## Quellenlegende

- `DEEP` — `artifacts/browser-recon-20260902/deep/PORTAL-DEEP.txt` (DOM-verifiziert,
  eingeloggte Sitzung 2026-09-02/03) + 8 invoicing-Screenshots im selben Ordner
- `AUDIT` — `docs/parity/reonic-portal-audit/reonic_funktionskatalog.csv`
- `MODKAT:F8` — `docs/blaupause/01-modulkatalog.md` Abschnitt F8
- `M2-01` — Spec/ADR Angebots-Geldlogik (Cent, Snapshot, Rundung) als Muster

## 1. Nutzerergebnis

Ein interner Nutzer erstellt aus der Projektakte kaufmännische Dokumente
(Rechnung, Gutschrift, Auftragsbestätigung, Bestellung, Lieferschein, Brief)
mit workspaceweiten Nummernkreisen, versendet sie aus einem
Draft→Issued→Sent→Void-Lebenszyklus und verfolgt die unabhängige
Zahlungsachse; die Berichte-Seite zeigt Einnahmen, Ausstehend und Überfällige
in Alters-Buckets.

## 2. OBSERVED-Referenz (Portal, DEEP)

- **Dokumenttypen (7):** Rechnungen, Gutschriften, Auftragsbestätigungen,
  Bestellungen, Lieferscheine, Briefe + Dokumentgruppen-Übersicht; dazu
  eigener Top-Nav-Bereich „Berichte".
- **Routen:** `/invoicing/document-groups`, `/all-invoices`, `/credit-notes`,
  `/offer-confirmations`, `/purchase-orders`, `/deliver-notes`, `/letters`,
  `/backoffice/reports`.
- **Spalten je Typ:** Rechnung = Name | Betrag | Status | Zahlungsstatus |
  Ausstellungsdatum | Fälligkeitsdatum; Gutschrift/Lieferschein zusätzlich
  Lieferdatum; Auftragsbestätigung zusätzlich geplantes Liefer-/Leistungsdatum;
  Bestellung/Brief mit Gültigkeitsdatum. Filter je Typ: Status + Datum +
  Archiviert (Gutschrift zusätzlich Typ).
- **Enums:** Dokument-Status `Entwurf|Ausgestellt|Storniert`; Zahlungsstatus
  `Unbezahlt|Teilweise bezahlt|Bezahlt|Überfällig|Uneinbringlich`; Berichte
  „Nach Status" `Versendet|Bezahlt|Überfällig|Entwurf|Storniert`.
- **Berichte:** Tabs Übersicht/Forderungen; KPIs Einnahmen/Cashflow (Monat),
  Ausstehend, Überfällig; Neueste-Dokumente-Tabelle; Überfälligkeits-Buckets
  `0–30|31–60|61–90|über 90 Tage`; „Daten herunterladen".

## 3. Scope (Kern) und Non-Goals

**In M3-01:** generisches `commercial_document`-Modell (7 Typen als
Diskriminator), Statusmaschine Draft→Issued→Sent→Void (Portal-Enums +
Versand-Achse aus MODKAT:F8), unabhängige Zahlungsachse (5 Werte),
Nummernkreise (workspaceweit, je Typ, dauerhaft), typ-spezifische Spalten/
Filter gemäß DEEP, Berichte-Seite mit KPIs + Alters-Buckets + Export,
immutable ausgestellte Dokumente (Snapshot wie M2-01), centgenaue Beträge +
Rundungsausgleich, RLS/RBAC (Viewer read-only, External fail-closed),
Erasure-Graph (Dokumente hängen am Contact-Graphen; Scrub quellgepinnt nur
echte PII).

**Non-Goals (Folgeslices):** Teilrechnungsketten, EPC-QR, ZUGFeRD/XRechnung/
EN 16931, GoBD-Archivierung, DATEV/Lexware/sevDesk, Angebot→Rechnung-
Konvertierung, Brief-Templates, Zahlungsimporte.

## 4. Kern-Capabilities (kompakt)

| ID | Capability | Kern-Verhalten |
|---|---|---|
| M301-01 | Dokument anlegen | typ-spezifische Pflichtfelder, Nummernkreis, Draft |
| M301-02 | Dokument ausstellen | → issued, Snapshot + Content-Hash, immutable |
| M301-03 | Versenden | → sent (Resend-Transport vorbereitet, kein echter Versand) |
| M301-04 | Stornieren | issued/sent → void (Gutschrift getrennt) |
| M301-05 | Zahlungsachse | unbezahlt→teilweise→bezahlt; überfällig/uneinbringlich abgeleitet+setzbar |
| M301-06 | Liste + Filter | je Typ: Status/Datum/Archiviert (DEEP-Spalten) |
| M301-07 | Berichte | KPIs + Buckets + Export (CSV) |
| M301-08 | Beträge | Cent, Rundungsausgleich, keine Floats (M2-01-Muster) |
| M301-09 | RBAC/RLS | Viewer read-only, External fail-closed, Cross-Tenant negativ |
| M301-10 | Erasure | Dokument-Metadaten im Erasure-Graphen; PII-Scrub |

## 5. Zustandsmaschinen

- Dokument: `draft → issued → sent → void`; `draft → void`; issued/sent sind
  immutable (nur void als Ausgang).
- Zahlung: `unpaid → partially_paid → paid`; `overdue`/`uncollectible` sind
  Flag-/Ableitungszustände (Datum + setzbar), keine unabhängige Kette.

## 6. Testmatrix (Kern)

- Unit: Nummernkreis (Monotonie, je Typ), Rundungsausgleich, Betragsgrenzen.
- Contract: JSON-Vertrag Dokument+DTO, Enums, Schema-Hash gepinnt.
- DB: Status-Übergänge komplett (alle erlaubt/verboten), Immutability nach
  issued, Zahlungsachse, RLS negativ je Rolle (inkl. revoked/cross-tenant),
  Erasure, Race (Doppel-Issue, Issue↔Void), ein tx.execute je Service-Aufruf.
- Chromium (später zentral): Liste je Typ, Anlegen→Ausstellen→Stornieren,
  Berichte-Seite, Axe/Keyboard/375px.

## 7. Abschlussgates

Standardkette: targeted ESLint · typecheck · fokussierte Vitest ·
`npm run check` exit 0 · `db:generate` ohne Drift · `db:roles:verify`
88/88+5/5 · Build · `git diff --check` · Secret-Scan · Kimi-Code-Review ·
Chromium-Nachholung · Register-Update.

## 8. DECIDED / UNKNOWN

- DECIDED: generisches Modell mit Diskriminator (ADR 0023); Portal-Enums
  übernommen; Nummernkreis-Format `MM-YYYY-<n>` je Typ (ESTIMATE, Owner-
  Freigabe); Export = CSV im Kern.
- UNKNOWN: exakte Nummernkreis-Formate Reonics; Versandtext-/PDF-Layout
  (Folgeslice); Steuersatz-Handhabung je Land (Kern: DE 0 % PV gemäß
  bestehender Geldlogik).
