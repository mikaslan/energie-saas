import {
  validateInvoicePaymentInput,
  type InvoicePaymentInputV1,
} from "./pdf-contract";

const EURO_FORMAT = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
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

function formatMoney(cents: number): string {
  return `${EURO_FORMAT.format(cents / 100)}&nbsp;EUR`;
}

// Fail-closed QR-Huelle: exakt die Tag-Form von qrcode-generator@2.0.4
// (gepinnt), danach nur Rechteck/Pfad-Geometrie — keine Skripte, keine
// externen Referenzen, keine Events.
const SEALED_QR_HEAD_PATTERN = /^<svg version="1\.1" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[0-9]+px" height="[0-9]+px" viewBox="0 0 [0-9]+ [0-9]+" {1,2}preserveAspectRatio="xMinYMin meet">/u;

function assertSealedQrSvg(qrSvg: string): void {
  const head = qrSvg.match(SEALED_QR_HEAD_PATTERN)?.[0];
  if (!head || !qrSvg.trimEnd().endsWith("</svg>")) {
    throw new TypeError("QR-SVG entspricht nicht der versiegelten Form.");
  }
  const body = qrSvg.slice(head.length);
  const sealed = !/<script[\s>]/iu.test(body)
    && !/\son[a-z]+\s*=/iu.test(body)
    && !/href\s*=/iu.test(body)
    && !/https?:\/\//iu.test(body)
    && !/url\(/iu.test(body)
    && !/<(foreignObject|image|use|animate)[\s>]/iu.test(body);
  if (!sealed) {
    throw new TypeError("QR-SVG entspricht nicht der versiegelten Form.");
  }
}

export function renderInvoicePaymentHtml(
  value: InvoicePaymentInputV1,
  qrSvg: string,
): string {
  const validated = validateInvoicePaymentInput(value);
  if (!validated.ok) {
    throw new TypeError("Ungueltiger Zahlungsbeleg-Input.");
  }
  assertSealedQrSvg(qrSvg);
  const input = validated.value;
  const pageFooterText = `Zahlungsbeleg ${input.documentNumber} · Referenz ${input.reference}`;

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">
  <meta name="color-scheme" content="light">
  <title>Zahlungsbeleg ${escapeHtml(input.documentNumber)}</title>
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
    .amount { font-size: 18pt; font-weight: bold; color: #0a4a33; }
    .qr { width: 52mm; height: 52mm; margin: 6mm 0; border: 0.4mm solid #0b1b15; padding: 2mm; }
    .qr svg { display: block; width: 100%; height: 100%; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 2mm 2mm; text-align: left; vertical-align: top; border-bottom: 0.25mm solid #d7dedb; }
    th { width: 34mm; color: #47564f; font-weight: normal; }
  </style>
</head>
<body>
  <main>
    <p class="kicker">Zahlungsbeleg zur Rechnung ${escapeHtml(input.documentNumber)}</p>
    <h1>Zahlungsbeleg</h1>
    <p class="amount">${formatMoney(input.amountCents)}</p>
    <div class="qr" role="img" aria-label="EPC-QR-Code zur Zahlung">${qrSvg}</div>
    <table>
      <tbody>
        <tr><th>Empfänger</th><td>${escapeHtml(input.creditor.name)}</td></tr>
        <tr><th>IBAN</th><td>${escapeHtml(input.creditor.iban)}</td></tr>
        ${input.creditor.bic === "" ? "" : `<tr><th>BIC</th><td>${escapeHtml(input.creditor.bic)}</td></tr>`}
        <tr><th>Betrag</th><td>${formatMoney(input.amountCents)}</td></tr>
        <tr><th>Referenz</th><td>${escapeHtml(input.reference)}</td></tr>
        <tr><th>Rechnung</th><td>${escapeHtml(input.documentNumber)}</td></tr>
      </tbody>
    </table>
    <p>Bitte scannen Sie den Code mit Ihrer Banking-App. Massgeblich sind Betrag und Referenz dieses Belegs.</p>
  </main>
</body>
</html>`;
}
