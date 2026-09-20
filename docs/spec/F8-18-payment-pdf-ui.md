# F8-18 — Zahlungsbeleg-PDF (EPC-QR): UI, Download und Browser-Kette

Folgeslice zu F8-17 (EPC-Payload, Payment-Template, Worker-Paar) als
Spiegel von M3-02d (Route, Server-Action, Panel, Page, E2E): Die
F8-17-Reads sind template-agnostisch, daher braucht der Payment-Track
keine neue Download-Pipeline — nur zahlungsspezifische Affordances
(Anfordern, Status, Download-Link, Gating) plus Browser-Kette.
Erfuellt zugleich den F817-E2E-01-Platzhalter („Browser-Kette erst mit
Payment-UI").

## Ziel

Ausgestellte Rechnungen mit offenem Rest erhalten auf der
Beleg-Detailseite ein eigenes Zahlungsbeleg-Panel (EPC-QR): Editor+
fordert den F8-17-Job an, sieht Status/Versuche/Fehler und laedt das
versiegelte Zahlungs-PDF privat herunter; Viewer sieht Status ohne
Bytes; vollbezahlte/stornierte Belege und Gutschriften erhalten kein
Angebot. Abnahme per F818-E2E-01/02.

## Umfang (Scope)

- Status-Diskriminator (DECIDED — reine Lese-Projektion, keine
  Migration): `listInvoicePdfs`/`getInvoicePdfStatus` liefern zusaetzlich
  `templateVersion` (`invoice-pdf-template.v1` vs.
  `invoice-payment-template.v1`); Capabilities unveraendert
  (`invoicing.write`, fail-closed wie M302D-CT-02).
- Download ueber die bestehende M3-02d-Route
  `.../rechnungen/[type]/[documentId]/pdf/[jobId]/route.ts` (DECIDED —
  kein neuer Pfad: jobId-schluesselig, template-agnostisch, gleiche
  private Header + 401/403/404/503-Abbildung). Dateiname je Track:
  `<nummer>.pdf` (Invoice) bzw. `<nummer>-zahlung.pdf` (Payment,
  DECIDED — aus gespeicherter `template_version` abgeleitet, das
  route-seitige Safe-Pattern deckt das Suffix ab).
  `readInvoicePdfArtifact`-Integritaet (nur `succeeded`, MIME/SHA/Size +
  `timingSafeEqual`, `issuing_details.write`) gilt unveraendert.
- Server-Action `requestInvoicePaymentAction` (Spiegel
  `requestInvoicePdfAction`) in `pdf-actions.ts`: exaktes Form-Parsing
  (`workspaceId`/`type`/`documentId`, keine Extrafelder; `type` strikt
  `invoice`, DECIDED — Gutschriften schulden dem Kunden, nie QR an
  uns), Capability `invoicing.write`, ruft `requestInvoicePaymentInput`
  mit `COMMERCIAL_DOCUMENT_PAYMENT_RENDER_COMMAND_VERSION`,
  Fehlerabbildung unauthenticated/denied/invalid/not_found/unavailable
  (`invalid` u.a. bei Rest <= 0, storniert, fehlender/ungueltiger IBAN),
  `revalidatePath` auf die Detailseite. Eigener State-Typ
  `RequestInvoicePaymentActionState` (Spiegel
  `RequestInvoicePdfActionState`).
- UI-Panel `invoice-payment-panel.tsx` (Spiegel `invoice-pdf-panel.tsx`,
  `id="invoice-payment"`): Job-Statusliste nur des Payment-Tracks,
  Download-Link nur bei `succeeded` + `canDownload`,
  Anforderungs-Button nur fuer Editor+ bei `canGenerate`;
  Viewer-Hinweis ohne Bytes; Gating-Hinweise („Kein offener Betrag —
  kein Zahlungsbeleg noetig." / „Keine Bankverbindung hinterlegt — ..."
  als Copy-ESTIMATE, im UI-Test pinnbar).
- Page-Verdrahtung in `[type]/[documentId]/page.tsx`: Panel nur fuer
  `type === "invoice"` + `status === "issued"`; partitioniert die
  `listInvoicePdfs`-Jobs per `templateVersion` (Invoice-Panel erhaelt
  nur Invoice-Jobs — behebt Fehl-Labeling von Payment-Jobs als
  „Rechnungs-PDF ist bereit"); `canGenerate` zusaetzlich an
  `openCents > 0` gebunden (reine Anzeige, Service bleibt letzte
  Instanz).
- E2E-Ketten (Spiegel `M302D-E2E-01`, gleicher Runner ohne Umbau,
  synthetischer `claim`/`finalize`-Abschluss): `F818-E2E-01` Anfordern
  → Status → Download → Byte-/Hash-/Header-Pruefung inkl.
  `-zahlung.pdf`-Disposition; `F818-E2E-02` Gating — vollbezahlter
  Beleg zeigt Hinweis statt Button.

## Nicht-Umfang

- Keine Migration, kein Schemawechsel (reine Lese-/Aktions-/UI-Schicht).
- Keine EPC-/Template-/Renderer-Aenderung (F8-17 unveraendert).
- Kein Versand, Mahnwesen, Bankabgleich; kein Monats-ZIP, DATEV-Export,
  Lexoffice/SevDesk/Bexio-Sync; keine E-Rechnung.
- Kein Zahlungsbeleg fuer Gutschriften/Entwuerfe/stornierte Belege.

## Contract-IDs

| ID | Anspruch | Beleg |
|---|---|---|
| F818-CT-01 | Status-Diskriminator: Track-Trennung, Capabilities wie M3-02d | Contract-/Unit-Tests |
| F818-CT-02 | Download: bestehende Route dient Payment-Track, `-zahlung.pdf`, private Header, 401/403/404/503 | Route-/Contract-Tests |
| F818-CT-03 | Action: exaktes Parsing (`type=invoice`), Capability, Fehlerabbildung, Revalidierung | Contract-Tests |
| F818-CT-04 | Panel: Payment-Jobs only, Download nur `succeeded`+Capability, Gating-Hinweise | UI-Contract-Tests |
| F818-CT-05 | Page: Panel nur invoice+issued, Partition Invoice/Payment, `canGenerate` an Rest > 0 | UI-Contract-Tests |
| F818-E2E-01 | Browser-Kette: Anfordern → Status → Download → Bytes stimmen | E2E-Test |
| F818-E2E-02 | Gating-Kette: vollbezahlt → Hinweis statt Button | E2E-Test |

## Module

- `app/w/[workspaceId]/rechnungen/[type]/[documentId]/pdf/[jobId]/route.ts` — unveraendert ausser Payment-Dateiname (Track-Suffix).
- `app/w/[workspaceId]/rechnungen/pdf-actions.ts` + `pdf-action-state.ts` — `requestInvoicePaymentAction` + State (Spiegel).
- `app/w/[workspaceId]/rechnungen/[type]/[documentId]/invoice-payment-panel.tsx` — neu (Spiegel `invoice-pdf-panel.tsx`).
- `app/w/[workspaceId]/rechnungen/[type]/[documentId]/page.tsx` — Partition + Gating.
- `modules/invoicing/pdf-service.ts` — nur Projektion (`templateVersion`) + Track-Dateiname (kein Schema).
- `tests/e2e/f8-18-invoice-payment.spec.ts` — F818-E2E-01/02 (Spiegel `m3-02d-invoice-pdf.spec.ts`).
- Contract-/Unit-Tests als Spiegel der M302D-Suite (Actions, Panel, Route).

## Tests

- `F818-CT-01..05` als Spiegel der M302D-CT-Suite: gleiche
  Orakel-Freiheit (Viewer/External fail-closed), gleiche
  Header-/Parsing-Striktheit.
- `F818-E2E-01/02` im bestehenden E2E-Runner (Worker laeuft bereits;
  synthetischer Abschluss wie M3-02d, kein Produktions-Render-Beleg).
- Negativfaelle: vollbezahlt/storniert/Gutschrift → `invalid`, kein
  Button; fehlende IBAN → `invalid` + Hinweis.

## DECIDED

- Kein neuer Download-Pfad; bestehende Route dient beiden Tracks.
- Payment-Dateiname `<nummer>-zahlung.pdf` (Track-Suffix statt Kollision
  mit `<nummer>.pdf`).
- `templateVersion`-Diskriminator in Status-Reads (Projektion, keine
  Migration); Page partitioniert Invoice/Payment.
- Action-`type` strikt `invoice` (fail-closed an der Kante).
- Download-Capability `issuing_details.write`, Status-Capability
  `invoicing.write` (wie M3-02d).
- `canGenerate` an `openCents > 0` gebunden (Anzeige-Gating; Service
  bleibt letzte Instanz).

## Offene Schaetzung (ESTIMATE)

- Panel-Copy (Gating-/Fehler-Hinweise) final im UI-Test pinnbar.
- E2E-Poll-Budget folgt dem M3-02d-Abschluss (Worker-Renderzeit + Puffer).
- QR-Vorschau im Panel (Inline-SVG) ist Folgeslice, nicht F8-18.
