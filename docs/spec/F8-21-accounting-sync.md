# F8-21 — Accounting-Sync Lexoffice/SevDesk/Bexio (Katalog F8.6)

Folgeslice nach F8-11 (DATEV-EXTF-Builder als Payload-Muster) und M3-02d
(Read-/Gating-Muster). Katalog F8.6 („Lexoffice/SevDesk/Bexio") bekommt
einen ersten ehrlichen Sync-Pfad: vendor-neutrale Export-Payload +
Sync-Satz mit State-Machine + Provider-Interface mit
Per-Vendor-Payload-Mapping. Keine Live-Vendor-API-Calls mit echten
Credentials in diesem Slice — der Transport bleibt eine injizierbare
Schnittstelle mit Fake-Transport für Tests.

## Ziel

- Aus jedem ausgestellten Geldbeleg (`invoice`/`credit_note`,
  `status = 'issued'`, EUR) eine deterministische, vendor-neutrale
  `AccountingExportPayload` bauen (Muster `buildDatevBatchCsv`:
  reine Funktion, fail-closed, Summenkranz).
- Pro Vendor (lexoffice, sevdesk, bexio) ein reines Mapping
  Neutral → Vendor-Payload, ohne Netzwerk, ohne Secrets.
- Sync-Satz je (Beleg, Vendor) mit State-Machine
  `queued → exported → acknowledged | failed`, idempotent
  wiederholbar, Replay erkennt Drift.
- Service-Schicht zum Anstoßen/Lesen des Sync-Status unter
  Capability-Gating; Secrets verlassen nie den Aufrufer.

## Umfang (Scope)

- `buildAccountingExportPayload(doc)` in
  `lib/integrations/invoicing/accounting-contract.ts` (reine Funktion):
  neutrales Format v1 (Belegart, Nummer, Ausstelldatum, Kontakt,
  Währung, Zeilen mit `taxRateBps`/Netto/Steuer/Brutto, Kopf-Summen).
  Validierung fail-closed: nur `issued`, nur `invoice`/`credit_note`,
  nur EUR, Nummer gesetzt, Summenkranz Σ Zeilen == Kopf wie F8-11/CII.
  Kopf-only-Belege wie F8-11 (exakt-19-%-Kopf → eine Zeile, sonst
  Fehler mit Belegnummer). 0-%-Zeilen sind hier ERLAUBT
  (DECIDED — Vendor-APIs kennen 0-%-Steuersätze; kein BU-Schlüssel-
  Problem wie bei EXTF), werden aber explizit mit `taxRateBps: 0`
  markiert.
- Per-Vendor-Mapper (reine Funktionen, selber Modul):
  `toLexofficeVoucher`, `toSevDeskVoucher`, `toBexioEntry`
  (ESTIMATE-Feldprofile, s. unten). Unbekannte Vendor-Keys →
  Fehler fail-closed.
- Provider-Interface `AccountingProvider` (DECIDED — minimal):
  `{ vendor, exportVoucher(payload): Promise<{ externalId, rawStatus }> }`.
  Kein SDK, kein OAuth, kein HTTP in diesem Slice; einziger
  mitgelieferter Transport ist `FakeAccountingProvider`
  (In-Memory, deterministisch, für Tests/E2E).
- Sync-Satz `accounting_sync_record` (neue Tabelle, Migration):
  `(workspace_id, document_id, vendor)` UNIQUE; Felder
  `state`, `payload_sha256` (JCS+SHA wie M3-02b, Replay-/Drift-Check),
  `external_id`, `attempts`, `last_error`, Zeitstempel.
  State-Machine: `queued → exported → acknowledged`, jeder
  Fehler → `failed` (mit Retry über Re-Queue, `attempts+1`).
  Nur Vorwärts-Übergänge; `acknowledged` ist terminal
  (DECIDED — kein Re-Export nach Ack ohne neuen Beleg-Stand).
- Service in `modules/invoicing/accounting-sync-service.ts`:
  `queueAccountingSync` (Capability `invoicing.write`, nur `issued`;
  Idempotenz-Key umfasst Vendor + Payload-Hash — gleicher Stand →
  gleicher Satz, neuer Stand → Re-Queue aus `failed`/`exported`),
  `getAccountingSyncStatus`/`listAccountingSyncs`
  (Capability `invoicing.write`, Spiegel M3-02d-Status-Reads),
  `runAccountingSync` (führt queued/exported Sätze über den
  injizierten Provider aus; schreibt `external_id`/Fehler).
- Keine Secrets in DB (DECIDED): Der Sync-Satz speichert nur
  Provider-Name + `external_id`; Tokens/Keys werden — wenn der
  echte Transport folgt — zur Laufzeit vom Aufrufer injiziert
  und nie persistiert/geloggt.

## Nicht-Umfang

- Keine echten Vendor-API-Calls, kein OAuth, kein SDK, keine
  Credential-Verwaltung, kein Webhook-Empfang (Folgeslice mit
  echtem Transport je Vendor).
- Kein Bankabgleich, kein Mahnwesen, keine E-Rechnung (F8.7).
- Kein DATEV-Datenservice, kein Monats-ZIP, kein Versand.
- Keine UI-Affordances, keine Browser-Kette in diesem Slice
  (Status-Reads sind UI-ready; UI folgt als F8-23, Folgeslice ausserhalb EPIC-Scope).

## Contract-IDs (Akzeptanzmatrix)

| ID | Anspruch | Beleg |
|---|---|---|
| F821-CT-01 | Neutral-Payload: exaktes v1-Format, Scope-/Summen-Validierung fail-closed, 0-%-Zeilen markiert erlaubt | Contract-/Unit-Tests |
| F821-CT-02 | Vendor-Mapper: lexoffice/sevdesk/bexio deterministisch, unbekannter Vendor fail-closed | Unit-Tests |
| F821-CT-03 | Sync-Satz: UNIQUE (workspace, document, vendor), State-Machine nur vorwärts, `acknowledged` terminal | DB-/Contract-Tests |
| F821-CT-04 | Idempotenz: gleicher Stand → kein Doppelsatz; neuer Stand → Re-Queue; Replay erkennt Payload-Drift | DB-/Unit-Tests |
| F821-CT-05 | Service-Gating: `invoicing.write` nötig, nur `issued`, Viewer/External fail-closed ohne Orakel | Contract-Tests |
| F821-CT-06 | Fake-Transport: queued → exported → acknowledged mit `external_id`; Fehler → `failed` mit Retry | Contract-/DB-Tests |
| F821-CT-07 | Keine Secrets in DB/Logs (nur Vendor + `external_id`) | Unit-/Review-Test |

## Module

- `lib/integrations/invoicing/accounting-contract.ts` — neutrale
  Payload v1 + JCS/SHA-Seal + drei Vendor-Mapper (rein, ohne IO).
- `lib/integrations/invoicing/accounting-provider.ts` —
  `AccountingProvider`-Interface + `FakeAccountingProvider`.
- `modules/invoicing/accounting-sync-service.ts` — Queue/Status/
  Run-Service mit Capability-Gating.
- Migration `accounting_sync_record` (+ RLS wie
  `commercial_document`-Familie, workspace-scoped).
- Tests: `tests/unit/f821-accounting-sync.test.ts`,
  `tests/db/f821-accounting-sync.test.ts`,
  `tests/contracts/f821-accounting-sync.test.ts`.

## Tests

- Unit: Neutral-Builder (gültig, Scope-Rejects, krumme Summen,
  0-%-Markierung, Determinismus), Mapper je Vendor
  (Pflichtfelder, Steuerabbildung, Unbekannt-Reject), Seal/Drift.
- DB: Queue/Idempotenz/Re-Queue, State-Übergänge (gültig +
  illegale abgelehnt), UNIQUE-Verletzung, terminaler Ack.
- Contract: Capability-Gating (Editor ok, Viewer/External denied),
  Fake-Transport-Run (Erfolg + Fehler + Retry), kein Orakel
  (404/denied ohne Beleg-Existenz-Leak).

## DECIDED

- Kein Live-Vendor-Verkehr in diesem Slice; Provider-Interface +
  Fake-Transport. Echte Transporte sind Folgeslices.
- 0-%-Zeilen erlaubt und explizit markiert (Abweichung von
  F8-11 begründet: Vendor-APIs kennen 0-%-Sätze).
- `acknowledged` terminal; Re-Export nur über neuen Beleg-Stand.
- Keine Secrets in DB oder Logs; Auth des echten Transports
  bleibt Laufzeit-Injektion des Aufrufers.
- Capability `invoicing.write` für Queue/Status/Run (Spiegel
  M3-02d-Status-Reads; kein neues Permission-Flag).

## Offene Schätzung (ESTIMATE)

- Vendor-Feldprofile (reversible Näherung aus öffentlicher
  API-Dokumentation, kein Live-Vertrag geprüft): lexoffice
  Voucher (type, voucherNumber, voucherDate, contact, lineItems
  mit taxRate 0/19); sevDesk Invoice (objectName, invoiceNumber,
  invoiceDate, contact, positions mit taxRate); bexio Entry
  (contact, title, mwst-gesteuerte Positionen). Profile werden
  mit erstem echtem Transportaufruf verifiziert und dann
  versioniert (`vendorApiVersion` am Sync-Satz).
- Beträge an Vendoren in Dezimal-Euro mit 2 Stellen + parallel
  Cent-Integer (Toleranz gegen Rundungsprofile).
- Kontaktlose Belege: Vendor-Kontaktfeld leer lassen, Belegnummer
  bleibt eindeutige Referenz (Muster F8-11-Buchungstext).
