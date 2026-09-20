# M3-02d — Rechnungs-PDF-Download, UI und Browser-Kette

Folgeslice zu M3-02b (Render-Input) und M3-02c (Worker/Artefakt).
Spiegel des M2-02-Downloads (`M202-ROUTE-01`, `readOfferPdfDraftArtifact`,
`generateOfferPdfDraftAction`): versiegelte Bytes werden nach AuthZ privat
heruntergeladen, nie neu gerendert, nie promoted.

## Umfang

- `readInvoicePdfArtifact(tx, ctx, { workspaceId, documentId, jobId })`
  in `modules/invoicing/pdf-service.ts` (Spiegel `readOfferPdfDraftArtifact`):
  `requireAccess(ctx, "invoicing.issuing_details.write", …)` (DECIDED —
  Download-Auth zieht `issuing_details.write` nach, vgl. 0193-P1-1-Kommentar),
  Join auf `commercial_document` (Nummer), nur `status = 'succeeded'`,
  MIME-/SHA256-/Size-/Buffer-Pruefungen + `timingSafeEqual`-Hashabgleich,
  Dateiname `<Rechnungsnummer>.pdf` (sicheres Muster).
- `getInvoicePdfStatus` / `listInvoicePdfJobs` (Spiegel
  `getOfferPdfDraftStatus`): `requireAccess(ctx, "invoicing.write", …)`
  (DECIDED — RLS-SELECT verlangt Write-Schranke seit 0193/P1-1; `read`
  saehe 0 Zeilen).
- Download-Route
  `app/w/[workspaceId]/rechnungen/[type]/[documentId]/pdf/[jobId]/route.ts`
  (Spiegel `M202-ROUTE-01`): striktes Params-Schema (lowercase-UUIDs),
  `force-dynamic`, private Header
  (`no-store`/`nosniff`/`no-referrer`/`DENY`, CSP `sandbox`),
  `Content-Disposition: attachment` mit ASCII- + RFC-5987-Namen,
  Fehlerabbildung 401/403/404/503 ohne Orakel (404 bei
  Params-/NotFound, 503 bei Integritaetsfehler).
- Server-Action `requestInvoicePdfAction` (Spiegel
  `generateOfferPdfDraftAction`): exaktes Form-Parsing
  (workspaceId/documentId, keine Extrafelder), Capability
  `invoicing.write`, Fehlerabbildung
  unauthenticated/denied/invalid/not_found/conflict/unavailable,
  `revalidatePath` auf die Dokument-Detailseite.
- UI-Panel `pdf-panel.tsx` auf der Dokument-Detailseite: Job-Statusliste
  (Status/Versuche/Fehler), Download-Link nur bei `succeeded`,
  Anforderungs-Button fuer Editor+ (`invoicing.write`), Viewer sieht
  Status ohne Bytes (kein Download-Link ohne `issuing_details.write`).
- E2E-Kette `M302D-E2E-01` (Spiegel m2-02-E2E-Abschluss): Anfordern →
  Status-Poll → Download → Byte-/Hash-Pruefung. Der E2E-Runner startet
  den Worker bereits (`worker.log` in `run.mts`); keine Runner-Aenderung
  erwartet.

## Nicht-Umfang

- Kein neues Rendern, keine Report-Varianten, kein Versand, keine
  Signatur, kein oeffentlicher Link, kein WORM/Retention (GoBD-Gate
  bleibt), keine Migration erwartet (reine Lese-/Aktions-Schicht).
- Kein EPC-QR, kein Monats-ZIP, kein Sync (Folgeslices).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| M302D-CT-01 | Artifact-Read: nur `succeeded`, Hash-/Size-/MIME-Integritaet, `issuing_details.write` noetig | Contract-/Unit-Tests |
| M302D-CT-02 | Status-Read: `invoicing.write` noetig, Viewer/External fail-closed (kein Orakel) | Contract-Tests |
| M302D-CT-03 | Route: Params-UUIDs, private Header, Disposition, 401/403/404/503-Abbildung | Route-/Contract-Tests |
| M302D-CT-04 | Action: exaktes Form-Parsing, Capability, Fehlerabbildung, Revalidierung | Contract-Tests |
| M302D-CT-05 | UI-Panel: Status sichtbar, Download nur bei `succeeded` + Capability | UI-Contract-Tests |
| M302D-E2E-01 | Browser-Kette: Anfordern → Status → Download → Bytes stimmen | E2E-Test |

## Offene Schaetzung (ESTIMATE)

- Dateinamen-Muster folgt der Rechnungsnummer (M3-01-Format); Fallback
  bei unerwarteten Zeichen: 503 ohne Orakel (Spiegel Offer).
- E2E-Poll-Budget folgt dem Offer-Abschluss (Worker-Renderzeit + Puffer).
