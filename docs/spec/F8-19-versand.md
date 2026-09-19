# F8-19 — Versand/Sent (Statusübergang + Liefer-Nachweis)

Zweiter F8.6-Folgeslice nach F8-17 (Modulkatalog: „Versand mit separatem
Zahlungs-PDF (EPC-QR)"), F8.3-Sent-Status (`Draft → Issued → Sent → Void`).
Baut auf dem versiegelten PDF-Artefakt (M3-02c), dem privaten Download
(M3-02d) und `markSentDocument` (M3-01) auf: Versand markiert ein
ausgestelltes Dokument als versendet und versiegelt *welche* PDF-Bytes
(Rechnungs-PDF, optional Zahlungs-PDF) versendet wurden — als lesbarer
Liefer-Nachweis, ohne echten E-Mail-Versand.

Schnitt: Dieser Slice liefert Gating, Delivery-Record, Sent-Übergang,
Action, UI-Affordances und Browser-Kette. Rendern (M3-02b/c, F8-17),
Download-Route und Artifact-Reads (M3-02d) bleiben unverändert.

## Umfang

- `markSentWithDelivery(tx, ctx, { documentId, channel })` in neuem
  `modules/invoicing/delivery-service.ts` (Spiegel `requestInvoicePdfInput`/
  `markSentDocument`): `requireAccess(ctx, "invoicing.write", …)`; nur
  `issued` mit `sent_at IS NULL` (sonst `conflict`, kein stilles Re-Senden);
  verlangt mindestens einen `succeeded`-Rechnungs-PDF-Job
  (`invoice-pdf-template.v1`, DECIDED — kein Versand ohne unveraenderliche
  Bytes); referenziert den `succeeded`-Zahlungs-PDF-Job genau dann, wenn
  offener Rest > 0 und Job vorhanden (DECIDED — sonst Rechnung-ohne-Beleg);
  setzt `sent_at` (Status bleibt `issued`, Sent ist boolesche Achse per
  M301-03-DECIDED), schreibt die Delivery-Zeile, emittiert
  `commercial_document.sent` (Payload um `invoiceJobId`/`paymentJobId`/
  SHAs erweitert) + Audit `document.send`.
- Tabelle `commercial_document_delivery` (Migration erwartet, klein):
  `(workspace_id, document_id)` UNIQUE (parallele Versandversuche →
  `conflict`), `channel` CHECK `('manual')` (DECIDED — v1 nur manueller/
  externer Versand, `email`/`post` reserviert), FKs auf beide Render-Jobs,
  SHA256-Spalten (32 Byte, Spiegel Snapshot-Hash), `sent_by`/`sent_at`;
  append-only (kein Update-Pfad).
- `getDocumentDelivery` (Spiegel `getInvoicePdfStatus`):
  `requireAccess(ctx, "invoicing.write", …)` (DECIDED — RLS-SELECT verlangt
  Write-Schranke seit 0193/P1-1); Viewer/External fail-closed, 404 ohne
  Orakel. Bytes bleiben bei `issuing_details.write` (M3-02d unveraendert).
- Server-Action `markSentWithDeliveryAction` (Spiegel
  `requestInvoicePdfAction`): exaktes Form-Parsing
  (workspaceId/documentId/channel, keine Extrafelder), Capability
  `invoicing.write`, Fehlerabbildung
  unauthenticated/denied/invalid/not_found/conflict/unavailable,
  `revalidatePath` auf die Dokument-Detailseite. `sendDocumentAction`
  unveraendert (Nicht-PDF-Typen, Rueckwaertskompat, DECIDED).
- UI-Affordances auf der Dokument-Detailseite (Spiegel `pdf-panel.tsx`):
  Sent-Badge (`issued` + `sent_at`), Versand-Panel (Zeitpunkt, Kanal,
  referenzierte Jobs mit SHA-Kurzform), Download-Links nur bei `succeeded`
  + `issuing_details.write`, Versand-Button nur fuer Editor+
  (`invoicing.write`), nach Versand deaktiviert (conflict statt Re-Send).
- E2E-Kette `F819-E2E-01`: Ausstellen → PDFs `succeeded` → Versenden →
  Sent-Badge + Delivery-Record + Download-Bytes stimmen (Hashabgleich wie
  M302D-E2E-01).

## Nicht-Umfang

- Kein echter E-Mail-/Brief-Versand (kein SMTP/Resend/Post-API, keine
  Templates, kein Bounce-Handling): Katalog F8.6 verlangt nur das separate
  Zahlungs-PDF, kein Mail-Transport (DECIDED).
- Kein Re-Send/Zweitversand (→ `conflict`), kein Un-Send; Storno bleibt
  `issued`/`issued+sent → voided` (M301-04, `markSentDocument`-Semantik).
- Kein Mahnwesen, kein Bankabgleich, keine E-Rechnung (F8.7-Nicht-Features).
- Kein Monats-ZIP, kein DATEV-Export, kein Lexoffice/SevDesk/Bexio-Sync.
- Keine Dateinamen-Aenderung (`<Nummer>.pdf`, F8-18-Eigentum), kein neues
  Rendern, keine Report-Varianten, kein WORM/Retention.

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F819-CT-01 | Gating: nur `issued` + `sent_at NULL` + `succeeded`-Invoice-Job; sonst invalid/conflict | Contract-/DB-Tests |
| F819-CT-02 | Delivery-Record: UNIQUE (ws, doc), Kanal `manual`, Job-FKs + SHA-Nachweis, append-only | DB-/Contract-Tests |
| F819-CT-03 | Zahlungs-Job nur bei offenem Rest > 0 referenziert; sonst Rechnung-ohne-Beleg | Contract-/DB-Tests |
| F819-CT-04 | Action: exaktes Form-Parsing, Capability, Fehlerabbildung, Revalidierung; Event + Audit | Contract-Tests |
| F819-CT-05 | UI: Sent-Badge/Panel, Download nur `succeeded` + Capability, Button nach Versand aus | UI-Contract-Tests |
| F819-E2E-01 | Browser-Kette: Ausstellen → Versenden → Nachweis + Bytes stimmen | E2E-Test |

## Offene Schaetzung (ESTIMATE)

- Kanal-Enum: `email`/`post` erst mit Transport-Slice; v1 `manual` deckt
  externen Versand (Kunde laedt PDFs herunter und versendet selbst).
- E2E-Poll-Budget folgt dem Offer-/M302D-Abschluss (Worker-Renderzeit +
  Puffer); Payment-Job optional im Pfad.
- Storno nach Versand: Nummer bleibt verbrannt (F8.3, M301-04).
