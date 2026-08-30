import {
  type OfferPdfDraftInputV1,
  validateOfferPdfDraftInput,
} from "./pdf-contract";

const DRAFT_STATUS = "Interner Angebotsentwurf · nicht versendet · nicht verbindlich";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeFlowText(value: string): string {
  return escapeHtml(value.replace(/\s+/gu, " "));
}

function groupGermanInteger(value: number | bigint): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ".");
}

function formatMoney(cents: number | bigint): string {
  const exactCents = typeof cents === "bigint" ? cents : BigInt(cents);
  const euros = exactCents / BigInt(100);
  const remainder = String(exactCents % BigInt(100)).padStart(2, "0");
  return `${groupGermanInteger(euros)},${remainder}&nbsp;€`;
}

function formatQuantity(quantityMilli: number, unit: "piece" | "set" | "meter"): string {
  const whole = Math.floor(quantityMilli / 1_000);
  const fractional = String(quantityMilli % 1_000).padStart(3, "0").replace(/0+$/u, "");
  const number = fractional.length === 0
    ? groupGermanInteger(whole)
    : `${groupGermanInteger(whole)},${fractional}`;
  const unitLabel = unit === "piece" ? "Stk." : unit === "set" ? "Set" : "m";
  return `${number}&nbsp;${unitLabel}`;
}

function formatDiscount(basisPoints: number): string {
  const percent = Math.floor(basisPoints / 100);
  const hundredths = String(basisPoints % 100).padStart(2, "0");
  return `${groupGermanInteger(percent)},${hundredths}&nbsp;%`;
}

function formatTax(basisPoints: 0 | 1_900): string {
  return `${basisPoints === 0 ? "0" : "19"}&nbsp;%`;
}

function formatPreparedAt(value: string): string {
  const date = new Date(value);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = String(date.getUTCFullYear());
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day}.${month}.${year}, ${hour}:${minute} UTC`;
}

function positionTypeLabel(type: "required" | "additional" | "optional"): string {
  if (type === "required") return "Erforderlich";
  if (type === "additional") return "Zusätzlich";
  return "Optional";
}

type PdfLine = OfferPdfDraftInputV1["sections"][number]["lines"][number];
type PdfSection = OfferPdfDraftInputV1["sections"][number];

function renderLine(
  section: PdfSection,
  line: PdfLine,
  renderedLineNumber: number,
): string {
  const description = line.description === null
    ? ""
    : `<p class="line-description">${escapeFlowText(line.description)}</p>`;
  const hiddenNotice = line.isHidden
    ? `<span class="internal-hidden">Intern ausgeblendet · nicht für späteres Kundendokument freigegeben</span>`
    : "";
  return `<tr data-offer-line="${renderedLineNumber}"${line.isHidden ? ' class="hidden-line"' : ""}>
  <td class="position-cell">${section.position}.${line.position}</td>
  <td><strong>${escapeHtml(line.title)}</strong>${description}${hiddenNotice}</td>
  <td>${positionTypeLabel(line.positionType)}</td>
  <td class="number-cell">${formatQuantity(line.quantityMilli, line.unit)}</td>
  <td class="number-cell">${formatMoney(line.salesUnitNetCents)}</td>
  <td class="number-cell">${formatDiscount(line.lineDiscountBps)}</td>
  <td class="number-cell">${formatTax(line.taxRateBps)}</td>
  <td class="number-cell"><strong>${formatMoney(line.finalNetCents)}</strong><span class="gross-line">brutto ${formatMoney(line.grossCents)}</span></td>
</tr>`;
}

function renderSectionTables(
  input: OfferPdfDraftInputV1,
  optional: boolean,
): string {
  let renderedLineNumber = 0;
  for (const section of input.sections) {
    for (const line of section.lines) {
      const belongsToBlock = (line.positionType === "optional") === optional;
      if (belongsToBlock) renderedLineNumber += 1;
    }
  }
  if (renderedLineNumber === 0) {
    return `<p class="empty-block">Keine ${optional ? "optionalen Positionen" : "Positionen im Basisumfang"}.</p>`;
  }

  let ordinal = 0;
  return input.sections.map((section) => {
    const lines = section.lines.filter((line) =>
      (line.positionType === "optional") === optional);
    if (lines.length === 0) return "";
    const rows = lines.map((line) => {
      ordinal += 1;
      return renderLine(section, line, ordinal);
    }).join("\n");
    return `<section class="offer-section" aria-label="${escapeHtml(section.title)}">
  <div class="section-heading">
    <h3>${section.position}. ${escapeHtml(section.title)}</h3>
    ${section.discountBps > 0
      ? `<p>Sektionsrabatt ${formatDiscount(section.discountBps)}</p>`
      : ""}
  </div>
  <table>
    <thead>
      <tr>
        <th scope="col" class="position-cell">Pos.</th>
        <th scope="col">Leistung</th>
        <th scope="col">Typ</th>
        <th scope="col" class="number-cell">Menge</th>
        <th scope="col" class="number-cell">VK netto</th>
        <th scope="col" class="number-cell">Rabatt</th>
        <th scope="col" class="number-cell">Steuer</th>
        <th scope="col" class="number-cell">Endwert netto</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
  }).join("\n");
}

function renderCommercialTerms(input: OfferPdfDraftInputV1): string {
  const customDeal = input.commercialTerms.customDealNetCents === null
    ? "Kein individueller Zielpreis hinterlegt"
    : `${formatMoney(input.commercialTerms.customDealNetCents)} netto`;
  return `<dl class="commercial-terms">
  <div><dt>Globaler Rabatt</dt><dd>${formatDiscount(input.commercialTerms.globalDiscountBps)}</dd></div>
  <div><dt>Individueller Zielpreis</dt><dd>${customDeal}</dd></div>
</dl>`;
}

function renderTaxBreakdown(input: OfferPdfDraftInputV1, optional: boolean): string {
  return ([0, 1_900] as const).map((rate) => {
    const matchingLines = input.sections.flatMap((section) => section.lines).filter((line) =>
      (line.positionType === "optional") === optional && line.taxRateBps === rate);
    if (matchingLines.length === 0) return "";
    const taxCents = matchingLines.reduce(
      (sum, line) => sum + BigInt(line.taxCents),
      BigInt(0),
    );
    return `<div class="tax-breakdown"><dt>Steueranteil ${formatTax(rate)}</dt><dd>${formatMoney(taxCents)}</dd></div>`;
  }).join("");
}

function renderSummary(
  title: string,
  netCents: number,
  taxCents: number,
  grossCents: number,
  prefix: "Basis" | "Optionen",
  taxBreakdown: string,
): string {
  return `<section class="summary" aria-label="${escapeHtml(title)}">
  <h3>${escapeHtml(title)}</h3>
  <dl>
    <div><dt>${prefix} netto</dt><dd>${formatMoney(netCents)}</dd></div>
    <div><dt>${prefix} Steuer</dt><dd>${formatMoney(taxCents)}</dd></div>
    ${taxBreakdown}
    <div class="summary-total"><dt>${prefix} brutto</dt><dd>${formatMoney(grossCents)}</dd></div>
  </dl>
</section>`;
}

/** Pure deterministic HTML renderer. All dynamic values are text-escaped. */
export function renderOfferPdfDraftHtml(value: OfferPdfDraftInputV1): string {
  const validated = validateOfferPdfDraftInput(value);
  if (!validated.ok) {
    throw new TypeError(`Ungueltiger PDF-Dokumentinput: ${validated.paths.join(", ")}`);
  }
  const input = validated.value;
  const status = escapeHtml(DRAFT_STATUS);
  const pageFooterText = `${input.offerNumber} · Revision ${input.variant.revision} · ${DRAFT_STATUS}`;

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">
  <meta name="color-scheme" content="light">
  <title>Angebotsentwurf ${escapeHtml(input.offerNumber)}</title>
  <style>
    @page { size: A4; margin: 27mm 12mm 22mm;
      @top-center { content: "${DRAFT_STATUS}"; box-sizing: border-box; width: 100%; border: 0.4mm solid #8c1d1d; background: #fff0f0; color: #8c1d1d; font: 700 8.5pt Arial, Helvetica, sans-serif; }
      @bottom-left { content: "${pageFooterText}"; border-top: 0.25mm solid #6e7f77; color: #47564f; font: 7.5pt Arial, Helvetica, sans-serif; }
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
    .document-status { margin: 2mm 0 0; color: #8c1d1d; font-weight: 700; }
    .offer-number { text-align: right; }
    .offer-number span { display: block; color: #47564f; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; }
    .offer-number strong { display: block; margin-top: 1mm; font-size: 13pt; overflow-wrap: anywhere; }
    .context-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-bottom: 7mm; }
    .context-card { border: 0.25mm solid #d3ddd8; border-radius: 2mm; padding: 4mm; background: #f7faf8; break-inside: avoid; page-break-inside: avoid; }
    .context-card h2 { margin-bottom: 2mm; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; }
    .context-card p:last-child { margin-bottom: 0; }
    .billing-note { color: #47564f; font-size: 8pt; }
    .variant-card { border-left: 1.2mm solid #0f7550; padding: 2mm 0 2mm 4mm; margin-bottom: 8mm; break-inside: avoid; page-break-inside: avoid; }
    .variant-meta { color: #47564f; }
    .block { margin-top: 8mm; }
    .block-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 5mm; border-bottom: 0.5mm solid #0f7550; padding-bottom: 2mm; margin-bottom: 4mm; }
    .block-heading p { margin: 0; color: #47564f; }
    .offer-section { margin: 0 0 6mm; }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; padding: 2.5mm 3mm; background: #eef3f0; break-after: avoid; page-break-after: avoid; }
    .section-heading p { margin: 0; color: #47564f; font-size: 8pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    th, td { border-bottom: 0.2mm solid #d3ddd8; padding: 2.2mm 1.4mm; vertical-align: top; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
    th { background: #f7faf8; color: #0a4a33; font-size: 7.2pt; line-height: 1.25; }
    td { font-size: 7.7pt; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th:nth-child(1), td:nth-child(1) { width: 6%; }
    th:nth-child(2), td:nth-child(2) { width: 28%; }
    th:nth-child(3), td:nth-child(3) { width: 10%; }
    th:nth-child(4), td:nth-child(4) { width: 9%; }
    th:nth-child(5), td:nth-child(5) { width: 12%; }
    th:nth-child(6), td:nth-child(6) { width: 10%; }
    th:nth-child(7), td:nth-child(7) { width: 8%; }
    th:nth-child(8), td:nth-child(8) { width: 17%; }
    .position-cell { font-variant-numeric: tabular-nums; }
    .number-cell { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .line-description { margin: 1mm 0 0; color: #47564f; white-space: normal; }
    .gross-line { display: block; margin-top: 0.5mm; color: #47564f; font-size: 7pt; font-weight: 400; }
    .hidden-line { background: #fff8e5; }
    .internal-hidden { display: block; margin-top: 1mm; color: #6b4708; font-weight: 700; }
    .commercial-terms { display: flex; flex-wrap: wrap; gap: 4mm 8mm; border: 0.25mm solid #d3ddd8; padding: 3mm; margin: 0 0 5mm; break-inside: avoid; page-break-inside: avoid; }
    .commercial-terms div { display: flex; gap: 2mm; }
    .commercial-terms dt { color: #47564f; }
    .commercial-terms dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin-top: 5mm; }
    .summary { border: 0.35mm solid #6e7f77; border-radius: 2mm; padding: 4mm; break-inside: avoid; page-break-inside: avoid; }
    .summary h3 { margin-bottom: 2mm; }
    .summary dl { margin: 0; }
    .summary dl div { display: flex; justify-content: space-between; gap: 4mm; padding: 1mm 0; }
    .summary dd { margin: 0; font-variant-numeric: tabular-nums; }
    .summary-total { border-top: 0.25mm solid #6e7f77; margin-top: 1mm; padding-top: 2mm !important; font-weight: 800; }
    .optional-block { border-top: 1mm solid #6b4708; padding-top: 5mm; }
    .optional-note { color: #6b4708; font-weight: 700; }
    .empty-block { color: #47564f; font-style: italic; }
    .disclosure { margin-top: 9mm; padding: 4mm; border: 0.35mm solid #6e7f77; background: #f4f7f5; break-inside: avoid; page-break-inside: avoid; }
    .disclosure h2 { margin-bottom: 2mm; font-size: 11pt; }
    .disclosure p:last-child { margin-bottom: 0; }
    .document-footer { margin-top: 7mm; border-top: 0.25mm solid #6e7f77; padding-top: 2mm; color: #47564f; font-size: 8pt; break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <header class="document-header">
    <div>
      <div class="wordmark">WMEE</div>
      <div class="document-kind">Angebotsentwurf zur internen Prüfung</div>
      <p class="document-status" role="status">${status}</p>
    </div>
    <div class="offer-number"><span>Angebotsnummer</span><strong>${escapeHtml(input.offerNumber)}</strong></div>
  </header>
  <main>
    <h1>Angebotsentwurf</h1>
    <div class="context-grid">
      <section class="context-card" aria-labelledby="recipient-heading">
        <h2 id="recipient-heading">Empfänger</h2>
        <p><strong>${escapeHtml(input.recipient.displayName)}</strong></p>
        <p class="billing-note">Eine Rechnungsadresse ist nicht Bestandteil dieses Entwurfs.</p>
      </section>
      <section class="context-card" aria-labelledby="site-heading">
        <h2 id="site-heading">Anlagenstandort</h2>
        <p>${escapeHtml(input.installationSite.formattedAddress)}</p>
      </section>
    </div>
    <section class="variant-card" aria-labelledby="variant-heading">
      <h2 id="variant-heading">${escapeHtml(input.variant.name)}</h2>
      <p class="variant-meta">Revision ${input.variant.revision} · vorbereitet am ${formatPreparedAt(input.preparedAt)}</p>
    </section>
    <section class="block" aria-labelledby="base-heading">
      <div class="block-heading">
        <h2 id="base-heading">Im Entwurf enthaltener Basisumfang</h2>
        <p>Erforderliche und zusätzliche Positionen</p>
      </div>
      ${renderCommercialTerms(input)}
      ${renderSectionTables(input, false)}
      <div class="summary-grid">
        ${renderSummary(
          "Basissumme",
          input.totals.basisNetCents,
          input.totals.basisTaxCents,
          input.totals.basisGrossCents,
          "Basis",
          renderTaxBreakdown(input, false),
        )}
      </div>
    </section>
    <section class="block optional-block" aria-labelledby="optional-heading">
      <div class="block-heading">
        <h2 id="optional-heading">Optionale Positionen</h2>
        <p class="optional-note">Optionale Leistungen sind nicht in der Basissumme enthalten.</p>
      </div>
      ${renderSectionTables(input, true)}
      <div class="summary-grid">
        ${renderSummary(
          "Optionale Summe",
          input.totals.optionalNetCents,
          input.totals.optionalTaxCents,
          input.totals.optionalGrossCents,
          "Optionen",
          renderTaxBreakdown(input, true),
        )}
      </div>
    </section>
    <aside class="disclosure" aria-labelledby="review-heading">
      <h2 id="review-heading">Interner Prüfhinweis</h2>
      <p>Dieser Entwurf enthält noch keine Firmen- und Rechtsangaben, keine Rechnungsadresse, keine AGB, keine Widerrufsinformation und keine Gültigkeitsfrist. Steuerbehandlung, Leistungsumfang und Rechtstexte müssen vor einer späteren Ausgabe menschlich geprüft und freigegeben werden.</p>
    </aside>
  </main>
  <footer class="document-footer" aria-label="Dokumentstatus">${escapeHtml(pageFooterText)}</footer>
</body>
</html>`;
}
