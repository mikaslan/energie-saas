# F8-17 — EPC-QR-Zahlungsbeleg (Payload, Template, Worker-Paar)

Erster F8.6-Folgeslice nach M3-02d (Modulkatalog: „Versand mit separatem
Zahlungs-PDF (EPC-QR)"). Baut auf dem versiegelten Render-Input
(M3-02b) und der Worker-Pipeline (M3-02c) auf: Neben dem Rechnungs-PDF
entsteht ein zweites, eigenstaendiges Zahlungs-PDF mit EPC-QR-Code
(GiroCode), das den offenen Betrag per Banking-App zahlbar macht.

Schnitt: Dieser Slice liefert Payload, Template, Request-Gating und
die Worker-Erweiterung. Download/Status/UI funktionieren ohne
Aenderung (M3-02d-Reads sind template-agnostisch); zahlungsspezifische
UI-Affordances + Browser-Kette folgen als F8-18.

## Umfang

- `buildEpcPayload(input)` in `lib/integrations/invoicing/epc-contract.ts`
  (reine Funktion): EPC069-12-Payload
  (`BCD/002/1/SCT/BIC/Kontoinhaber/IBAN/Betrag/Verwendungszweck/Referenz`)
  aus versiegeltem Input — Kreditor aus Workspace-Settings
  (Name/IBAN/BIC), Betrag aus offenem Rest
  (`grossCents - paidCents`, nur > 0), Referenz = Dokumentnummer.
  Strikte Validierung (IBAN-Pruefziffern, BIC-Format, Betrag
  `EUR` + 2 Dezimalstellen, Zeichensatz-Latin-Subset); Fehler
  fail-closed (kein Zahlungsbeleg statt falscher Daten).
- Zweite Template-Spur `invoice-payment-template.v1` + Rezept-Pin
  (Muster `invoice-pdf-template.v1`): Zahlungs-PDF enthaelt NUR
  Zahlungsdaten (Empfaenger, IBAN/BIC, Betrag, Referenz, QR-SVG) —
  keine Rechnungspositionen, keine PII ueber das Noetige hinaus.
  QR via `qrcode-generator@2.0.4` (DECIDED: zero-dep, MIT, SVG,
  deterministisch pinnbar; gegen `qrcode` (yargs/pngjs-Ballast) und
  `uqr` (0.x, unbewaehrt) evaluiert).
- Payment-Input-Builder `buildInvoicePaymentInput` + Schema
  `invoice-payment-input.v1` (versiegelt wie M3-02b: JCS + SHA).
- `requestInvoicePaymentInput` (Spiegel `requestInvoicePdfInput`):
  nur `issued` mit offenem Rest > 0; vollbezahlte/stornierte Docs
  abgewiesen; Idempotenz-Key umfasst Template/Rezept (eigener Job
  neben dem Rechnungs-PDF).
- Worker-Paar: Claim/Handler akzeptieren das zweite
  (Input/Template/Rezept)-Tripel, Renderer dispatcht per
  `schemaVersion` (Invoice- vs. Payment-HTML); unbekannte Versionen
  bleiben `invalid_input` fail-closed. Keine Migration (reine
  Daten-/Code-Schicht, M3-02d-Reads unveraendert).

## Nicht-Umfang

- Kein Versand (E-Mail/Brief), kein Mahnwesen, kein Bankabgleich
  (bleibt Nicht-Feature per F8.7); `markSentDocument` unveraendert.
- Keine UI-Affordances, keine E2E-Kette (F8-18).
- Kein Monats-ZIP, kein DATEV-Export, kein Lexoffice/SevDesk/Bexio-Sync
  (eigene Folgeslices).
- Keine E-Rechnung (XRechnung/Factur-X, F8.7-Nicht-Feature).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F817-CT-01 | EPC-Payload: exaktes Format, IBAN/BIC/Betrag-Validierung, fail-closed | Contract-/Unit-Tests |
| F817-CT-02 | Nur offener Rest > 0 erzeugt Beleg; vollbezahlt/storniert abgewiesen | Contract-/DB-Tests |
| F817-CT-03 | Template enthaelt nur Zahlungsdaten + QR-SVG (keine Positionen/Leak-Felder) | Unit-Tests |
| F817-CT-04 | Worker versiegelt Payment-Tripel; Replay erkennt Drift; Invoice-Pfad unberuehrt | DB-/Unit-Tests |
| F817-E2E-01 | (F8-18) Browser-Kette erst mit Payment-UI | — |

## Offene Schaetzung (ESTIMATE)

- EPC-Zeichensatz: deutsches Latin-Subset; Umlaute per EPC-Regel.
- Betrag: genau 2 Dezimalstellen, `EUR` fix (Modulkatalog: EUR).
- QR-Fehlerkorrektur: M (EPC-Empfehlung), Version auto.
