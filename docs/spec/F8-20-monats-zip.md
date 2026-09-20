# F8-20 — Monats-ZIP (summary.csv + Rechnungs-PDFs für DATEV/Steuerberater)

Folgeslice zu F8-11 (DATEV-EXTF-Stapel) und M3-02d (PDF-Download-Kette).
Modulkatalog F8.6 („DATEV/Steuerberater"): Ein Download pro Monat bündelt
alle ausgestellten Geldbelege als `summary.csv` plus die versiegelten
Rechnungs-PDFs — der Steuerberater bekommt Buchungsübersicht und Belege
in einem Paket, ohne Einzel-Downloads.

Schnitt: Dieser Slice liefert Builder, Read-Service, Route und
Berichte-Link. Kein neues Rendern (nur `succeeded`-Artefakte der
M3-02c-Pipeline), kein EXTF im ZIP (F8-11 bleibt eigener Download).

## Ziel

- Durchgängiger Monatspfad: Builder (rein, deterministisch) → Service
  (Read-Pfad) → Route (Attachment wie DATEV-Route) → Link auf der
  Berichte-Seite (Muster: DATEV-/CSV-Links in `berichte/page.tsx`).
- ZIP-Layout (DECIDED): `summary.csv` im Root + `pdfs/<Nummer>.pdf`
  je Beleg mit vorhandenem, integerem PDF-Artefakt.

## Umfang

- `buildMonthSummaryCsv(rows)` + `buildMonatsZip({ month, summary,
  pdfs })` in `lib/integrations/invoicing/monats-zip.ts` (reine
  Funktionen, Muster `datev-export.ts`): `summary.csv` mit einer Zeile
  je Beleg (`typ;nummer;ausstellungsdatum;kontakt;netto;steuer;brutto;
  pdf_datei;pdf_sha256`), CRLF, `;`-getrennt, Formula-Injection-Guard
  und Quoting wie EXTF-`cell()`; Sortierung Ausstellungsdatum
  aufsteigend, dann Beleg-ID (deterministisch, Muster F8-11).
- ZIP via `fflate@0.8.x` (DECIDED: zero-dep, sync-API, deterministisch
  pinnbar mit fester mtime; gegen `jszip` (Ballast) und `archiver`
  (Stream-API, Non-Determinismus) evaluiert). Dateiname
  `monatsunterlagen-<monat>.zip`, `application/zip`.
- `exportMonatsZip(tx, ctx, { month })` in neuem
  `modules/invoicing/month-zip-service.ts` (Muster `exportDatevBatch`):
  Monats-Scope wie F8-11 (`status = 'issued'`,
  `type IN (invoice, credit_note)`, `issued_at` im Monat, Berlin).
  PDF-Quelle: jüngster `succeeded`-Job je Dokument, nur Template-Spur
  `invoice-pdf-template.v1` (DECIDED: keine Payment-PDFs im ZIP);
  Integritätsprüfungen als Spiegel `readInvoicePdfArtifact`
  (MIME/SHA256/Size + `timingSafeEqual`-Hashabgleich).
- Fehlende/korrupte PDFs brechen den ZIP nie ab (DECIDED — der
  Steuerberater bekommt trotzdem die Buchungsdaten): betroffene Zeile
  bleibt in `summary.csv` mit leeren `pdf_datei`/`pdf_sha256`-Spalten
  (ehrlich partiell, kein stiller Vollständigkeitsanspruch).
- Capability: `invoicing.issuing_details.write` für den Gesamt-ZIP
  (DECIDED — PDF-Bytes verlassen das System, M3-02d zieht diese
  Schranke nach; schärfer als DATEV-/CSV-`read`).
- Download-Route
  `app/w/[workspaceId]/rechnungen/berichte/monats-zip/route.ts`
  (Muster DATEV-Route): striktes `monat`-Schema (`400` bei ungültig),
  `force-dynamic`, private Header (`no-store`/`nosniff`/`no-referrer`,
  CSP `sandbox`), `Content-Disposition: attachment`,
  Fehlerabbildung 401/403/404/400 ohne Orakel.
- UI-Link auf `berichte/page.tsx` (Muster DATEV-Links):
  „Monats-ZIP (PDFs + Übersicht)", `data-testid="monats-zip-download"`,
  plus ehrlicher Hinweis-Text (nur `issued`-Belege, fehlende PDFs per
  Zeile sichtbar). Link immer sichtbar (DECIDED: kein Orakel), die
  Route erzwingt die Capability (403 fail-closed).

## Nicht-Umfang

- Kein EXTF/BUCHUNG-Stapel im ZIP (F8-11 bleibt separat), kein
  Payment-PDF (F8-17), kein Versand an den Steuerberater (E-Mail/Brief),
  kein DATEV-Datenservice/OAuth, keine 0-%-/§13b-Sonderlogik (der ZIP
  stellt nur aus, was `issued` ist — keine Steuer-Validierung wie F8-11).
- Kein neues Rendern, kein WORM/Retention, keine Migration, keine neue
  Permission (reine Lese-/Bündel-Schicht).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F820-CT-01 | Summary-Builder: Spalten, CRLF/`;`, Escaping/Guard, Sortierung, Determinismus | Unit-Tests |
| F820-CT-02 | ZIP-Layout: `summary.csv` + `pdfs/<Nummer>.pdf`, Dateiname, MIME, Roundtrip-Parse | Unit-Tests |
| F820-CT-03 | Service: Monats-Scope Berlin, nur `succeeded` + Invoice-Template, Hash-Integrität, fehlende/korrupte PDFs → leere Spalten statt Abbruch | DB-/Contract-Tests |
| F820-CT-04 | Route: `monat`-Schema, private Header, Disposition, 401/403/404/400-Abbildung, `issuing_details.write` nötig | Route-/Contract-Tests |
| F820-CT-05 | UI-Link: `data-testid`, Hinweis-Text, kein Orakel | UI-Contract-Tests |
| F820-E2E-01 | Browser-Kette: Berichte-Seite → Monats-ZIP → `PK`-Magic + `summary.csv` mit Belegnummer | E2E-Test |

## Contract-IDs / Module

- Neu: `INVOICING_MONATS_ZIP_COMMAND_VERSION`
  (`invoicing-monats-zip-command.v1`),
  `INVOICING_MONATS_ZIP_BATCH_VERSION`
  (`invoicing-monats-zip-batch.v1`) in
  `lib/integrations/invoicing/contract.ts` (Muster DATEV-Schemas).
- Neu: `lib/integrations/invoicing/monats-zip.ts` (Builder),
  `modules/invoicing/month-zip-service.ts` (Read-Service),
  `berichte/monats-zip/route.ts` (Route).
- Angefasst: `berichte/page.tsx` (Link + Hinweis), `modules/invoicing/index.ts`
  (Exporte). Keine Migration, keine neue Permission, ein neuer Provider
  (`fflate`).

## Tests

- Unit `tests/unit/f820-monats-zip.test.ts` (Muster `f811-datev-extf.test.ts`):
  Header/Spalten, Komma-/Punkt-Beträge, Escaping, leere `pdf_*`-Spalten
  bei fehlendem PDF, Ordnung, Determinismus (Byte-identität), ZIP-Parse-Back.
- DB `tests/db/f820-monats-zip.test.ts` (Muster F8-11-DB): echte
  `issued`-Belege + `succeeded`-Jobs → ZIP enthält Summary + PDFs mit
  Hash-Abgleich; Beleg ohne Job → Zeile mit leeren PDF-Spalten.
- Route-Tests (Muster `m302d-invoice-pdf-download-route.test.ts`):
  Params/Monat-Gating, Header, Statusabbildung, Capability-403.
- UI-Contract (Muster `m302d-invoice-pdf-ui-contract.test.ts`):
  Link-Selektor + Hinweis-Text auf der Berichte-Seite.
- E2E `tests/e2e/f8-20-monats-zip.spec.ts` (Muster `f8-11-datev-extf.spec.ts`):
  Berichte → ZIP-Download → Magic Bytes + Belegnummer in Summary;
  Axe sauber, keine Konsolenfehler.
- Gates: tsc/eslint/depcruise grün.

## Offene Schätzung (ESTIMATE)

- `summary.csv`-Spalten und Beträge mit Punkt-Dezimal (2 Stellen,
  maschinenlesbar wie Berichte-CSV; kein Komma wie EXTF).
- PDF-Dateiname `<Nummer>.pdf` nach M3-02d-Safe-Pattern; Belege mit
  unsanitärer/fehlender Nummer erhalten leere `pdf_*`-Spalten.
- Größen-Schranke: 500 Belege / 64 MB unkomprimiert pro ZIP (darüber
  400 mit ehrlicher Meldung); leeren Monat → gültiger ZIP mit
  Summary-Header allein (kein Fehler, ehrlich leer).
- `fflate`-Pin auf 0.8.x zur Implementierungszeit; ZIP-mtime fix
  (Monatserster, UTC) für Byte-Determinismus.
