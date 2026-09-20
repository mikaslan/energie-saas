import {
  validateInvoicePdfInput,
  type InvoicePdfInputV1,
} from "./pdf-contract";

const EURO_FORMAT = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const QUANTITY_FORMAT = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

function formatMoney(cents: number | bigint): string {
  const value = typeof cents === "bigint" && cents <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(cents)
    : cents;
  if (typeof value === "bigint") {
    throw new RangeError("Geldbetrag ausserhalb des darstellbaren Bereichs.");
  }
  return `${EURO_FORMAT.format(value / 100)}&nbsp;€`;
}

function formatQuantity(quantityMilli: number, unit: "piece" | "set" | "meter"): string {
  const suffix = unit === "piece" ? "Stk." : unit === "set" ? "Set" : "m";
  return `${QUANTITY_FORMAT.format(quantityMilli / 1000)} ${suffix}`;
}

function formatTax(basisPoints: 0 | 1_900): string {
  return basisPoints === 0 ? "0 %" : "19 %";
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function formatSkonto(percentBps: number | null, days: number | null): string {
  if (percentBps === null || days === null) return "Kein Skonto vereinbart";
  return `${EURO_FORMAT.format(percentBps / 100)} % Skonto bei Zahlung binnen ${days} Tagen`;
}

type PdfLine = InvoicePdfInputV1["lines"][number];

function renderLine(line: PdfLine): string {
  return `<tr>
  <td class="position-cell">${line.position}</td>
  <td><strong>${escapeHtml(line.title)}</strong></td>
  <td class="number-cell">${formatQuantity(line.quantityMilli, line.unit)}</td>
  <td class="number-cell">${formatMoney(line.netCents)}</td>
  <td class="number-cell">${formatTax(line.taxRateBps)}</td>
  <td class="number-cell"><strong>${formatMoney(line.grossCents)}</strong><span class="gross-line">inkl. ${formatMoney(line.taxCents)} Steuer</span></td>
</tr>`;
}

function documentKindLabel(input: InvoicePdfInputV1): string {
  if (input.document.type === "credit_note") return "Gutschrift";
  switch (input.document.invoiceKind) {
    case "anzahlung": return "Anzahlungsrechnung";
    case "abschlag": return "Abschlagsrechnung";
    case "teilrechnung": return "Teilrechnung";
    case "schlussrechnung": return "Rechnung";
    default: return "Rechnung";
  }
}

function renderSenderAddress(input: InvoicePdfInputV1): string {
  const sender = input.sender;
  const lines = [
    sender.companyName,
    sender.companyAddressLine1,
    sender.companyAddressLine2,
    `${sender.companyPostalCode} ${sender.companyCity}`,
    sender.companyCountry,
  ].filter((line): line is string => line !== null);
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n        ");
}

function renderRecipientAddress(input: InvoicePdfInputV1): string {
  const recipient = input.recipient;
  const street = recipient.street === null
    ? null
    : `${recipient.street}${recipient.houseNumber === null ? "" : ` ${recipient.houseNumber}`}`;
  const lines = [
    recipient.displayName,
    street,
    `${recipient.postalCode} ${recipient.city}`,
    recipient.country,
  ].filter((line): line is string => line !== null);
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n        ");
}

function renderTaxBreakdown(input: InvoicePdfInputV1): string {
  return ([0, 1_900] as const).map((rate) => {
    const matchingLines = input.lines.filter((line) => line.taxRateBps === rate);
    if (matchingLines.length === 0) return "";
    const taxCents = matchingLines.reduce(
      (sum, line) => sum + BigInt(line.taxCents),
      BigInt(0),
    );
    return `<div class="tax-breakdown"><dt>Steueranteil ${formatTax(rate)}</dt><dd>${formatMoney(taxCents)}</dd></div>`;
  }).join("");
}

/** Pure deterministic HTML renderer. All dynamic values are text-escaped. */
export function renderInvoicePdfHtml(value: InvoicePdfInputV1): string {
  const validated = validateInvoicePdfInput(value);
  if (!validated.ok) {
    throw new TypeError("Ungueltiger Rechnungs-PDF-Input.");
  }
  const input = validated.value;
  const kind = documentKindLabel(input);
  const pageFooterText = `${input.document.number} · ausgestellt ${formatDate(input.document.issuedAt.slice(0, 10))}`;

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(kind)} ${escapeHtml(input.document.number)}</title>
  <style>
    @page { size: A4; margin: 27mm 12mm 22mm;
      @bottom-left { content: "${escapeHtml(pageFooterText)}"; border-top: 0.25mm solid #6e7f77; color: #47564f; font: 7.5pt Arial, Helvetica, sans-serif; }
      @bottom-right { content: "Seite " counter(page) " von " counter(pages); border-top: 0.25mm solid #6e7f77; color: #47564f; font: 7.5pt Arial, Helvetica, sans-serif; }
    }
    :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #0b1b15; background: #ffffff; }
    * { box-sizing: border-box; }
    body { margin: 0; font-size: 9.5pt; line-height: 1.4; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 3mm; font-size: 22pt; line-height: 1.1; color: #0a4a33; }
    h2 { margin: 0 0 4mm; font-size: 15pt; color: #0a4a33; }
    h3 { margin: 0; font-size: 11pt; color: #0b1b15; }
    .document-header { display: grid; grid-template-columns: 1fr auto; gap: 8mm; border-bottom: 1mm solid #0f7550; padding-bottom: 5mm; margin-bottom: 7mm; }
    .wordmark { font-size: 18pt; line-height: 1; font-weight: 800; letter-spacing: 0.12em; color: #0f7550; }
    .document-kind { margin-top: 2mm; color: #47564f; font-weight: 700; }
    .document-number { text-align: right; }
    .document-number span { display: block; color: #47564f; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; }
    .document-number strong { display: block; margin-top: 1mm; font-size: 13pt; overflow-wrap: anywhere; }
    .context-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-bottom: 7mm; }
    .context-card { border: 0.25mm solid #d3ddd8; border-radius: 2mm; padding: 4mm; background: #f7faf8; break-inside: avoid; page-break-inside: avoid; }
    .context-card h2 { margin-bottom: 2mm; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; }
    .context-card p { margin: 0 0 1mm; }
    .context-card p:last-child { margin-bottom: 0; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4mm; margin-bottom: 7mm; }
    .meta-grid div { border-left: 1.2mm solid #0f7550; padding-left: 3mm; }
    .meta-grid dt { color: #47564f; font-size: 8pt; }
    .meta-grid dd { margin: 0; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    th, td { border-bottom: 0.2mm solid #d3ddd8; padding: 2.2mm 1.4mm; vertical-align: top; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
    th { background: #f7faf8; color: #0a4a33; font-size: 7.2pt; line-height: 1.25; }
    td { font-size: 7.7pt; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th:nth-child(1), td:nth-child(1) { width: 7%; }
    th:nth-child(2), td:nth-child(2) { width: 37%; }
    th:nth-child(3), td:nth-child(3) { width: 13%; }
    th:nth-child(4), td:nth-child(4) { width: 13%; }
    th:nth-child(5), td:nth-child(5) { width: 9%; }
    th:nth-child(6), td:nth-child(6) { width: 21%; }
    .position-cell { font-variant-numeric: tabular-nums; }
    .number-cell { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .gross-line { display: block; margin-top: 0.5mm; color: #47564f; font-size: 7pt; font-weight: 400; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 5mm; }
    .summary { border: 0.35mm solid #6e7f77; border-radius: 2mm; padding: 4mm; break-inside: avoid; page-break-inside: avoid; }
    .summary h3 { margin-bottom: 2mm; }
    .summary dl { margin: 0; }
    .summary dl div { display: flex; justify-content: space-between; gap: 4mm; padding: 1mm 0; }
    .summary dd { margin: 0; font-variant-numeric: tabular-nums; }
    .summary-total { border-top: 0.25mm solid #6e7f77; margin-top: 1mm; padding-top: 2mm !important; font-weight: 800; }
    .payment-box { margin-top: 7mm; padding: 4mm; border: 0.35mm solid #6e7f77; background: #f4f7f5; break-inside: avoid; page-break-inside: avoid; }
    .payment-box h2 { margin-bottom: 2mm; font-size: 11pt; }
    .payment-box p:last-child { margin-bottom: 0; }
    .document-footer { margin-top: 7mm; border-top: 0.25mm solid #6e7f77; padding-top: 2mm; color: #47564f; font-size: 8pt; break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <header class="document-header">
    <div>
      <div class="wordmark">${escapeHtml(input.sender.companyName)}</div>
      <div class="document-kind">${escapeHtml(kind)}</div>
    </div>
    <div class="document-number"><span>Belegnummer</span><strong>${escapeHtml(input.document.number)}</strong></div>
  </header>
  <main>
    <h1>${escapeHtml(kind)}</h1>
    <div class="context-grid">
      <section class="context-card" aria-labelledby="sender-heading">
        <h2 id="sender-heading">Aussteller</h2>
        ${renderSenderAddress(input)}
      </section>
      <section class="context-card" aria-labelledby="recipient-heading">
        <h2 id="recipient-heading">Empfänger</h2>
        ${renderRecipientAddress(input)}
      </section>
    </div>
    <dl class="meta-grid">
      <div><dt>Ausgestellt</dt><dd>${escapeHtml(formatDate(input.document.issuedAt.slice(0, 10)))}</dd></div>
      <div><dt>Fällig</dt><dd>${input.document.dueDate === null ? "—" : escapeHtml(formatDate(input.document.dueDate))}</dd></div>
      <div><dt>Leistung</dt><dd>${input.document.serviceDate === null ? "—" : escapeHtml(formatDate(input.document.serviceDate))}</dd></div>
    </dl>
    <table>
      <thead>
        <tr>
          <th scope="col" class="position-cell">Pos.</th>
          <th scope="col">Leistung</th>
          <th scope="col" class="number-cell">Menge</th>
          <th scope="col" class="number-cell">Netto</th>
          <th scope="col" class="number-cell">Steuer</th>
          <th scope="col" class="number-cell">Brutto</th>
        </tr>
      </thead>
      <tbody>
${input.lines.map(renderLine).join("\n")}
      </tbody>
    </table>
    <div class="summary-grid">
      <section class="summary" aria-label="Summen">
        <h3>Summen</h3>
        <dl>
          <div><dt>Netto</dt><dd>${formatMoney(input.totals.netCents)}</dd></div>
          <div><dt>Steuer</dt><dd>${formatMoney(input.totals.taxCents)}</dd></div>
          ${renderTaxBreakdown(input)}
          <div class="summary-total"><dt>Brutto</dt><dd>${formatMoney(input.totals.grossCents)}</dd></div>
        </dl>
      </section>
    </div>
    <aside class="payment-box" aria-labelledby="payment-heading">
      <h2 id="payment-heading">Zahlung</h2>
      <p>${escapeHtml(formatSkonto(input.document.skontoPercentBps, input.document.skontoDays))}</p>
      ${input.sender.paymentIban === null
        ? ""
        : `<p>Kontoinhaber ${escapeHtml(input.sender.paymentAccountHolder ?? "")} · IBAN ${escapeHtml(input.sender.paymentIban)}${input.sender.paymentBic === null ? "" : ` · BIC ${escapeHtml(input.sender.paymentBic)}`}</p>`}
    </aside>
  </main>
  <footer class="document-footer" aria-label="Dokumentstatus">${escapeHtml(pageFooterText)}</footer>
</body>
</html>`;
}
