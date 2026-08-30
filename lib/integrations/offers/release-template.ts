import {
  type OfferReleaseCandidateInputV1,
  validateOfferReleaseCandidateInput,
} from "./release-contract";

const RELEASE_CANDIDATE_STATUS =
  "Freigabekandidat · nicht ausgestellt · nicht versendet";

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

function escapeMultilineText(value: string): string {
  const boundedWhitespace = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n");
  return escapeHtml(boundedWhitespace);
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

function formatQuantity(
  quantityMilli: number,
  unit: "piece" | "set" | "meter",
): string {
  const whole = Math.floor(quantityMilli / 1_000);
  const fractional = String(quantityMilli % 1_000).padStart(3, "0").replace(/0+$/u, "");
  const quantity = fractional.length === 0
    ? groupGermanInteger(whole)
    : `${groupGermanInteger(whole)},${fractional}`;
  const unitLabel = unit === "piece" ? "Stk." : unit === "set" ? "Set" : "m";
  return `${quantity}&nbsp;${unitLabel}`;
}

function formatDiscount(basisPoints: number): string {
  const percent = Math.floor(basisPoints / 100);
  const hundredths = String(basisPoints % 100).padStart(2, "0");
  return `${groupGermanInteger(percent)},${hundredths}&nbsp;%`;
}

function formatTax(basisPoints: 0 | 1_900): string {
  return `${basisPoints === 0 ? "0" : "19"}&nbsp;%`;
}

function formatCalendarDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function positionTypeLabel(type: "required" | "additional" | "optional"): string {
  if (type === "required") return "Erforderlich";
  if (type === "additional") return "Zusätzlich";
  return "Optional";
}

function renderAddress(
  address: OfferReleaseCandidateInputV1["sender"]["address"],
): string {
  return `<span>${escapeHtml(address.street)} ${escapeHtml(address.houseNumber)}</span>
<span>${escapeHtml(address.postalCode)} ${escapeHtml(address.city)}</span>
<span>Deutschland</span>`;
}

function renderWebsite(value: string | null): string {
  if (value === null) return "";
  const url = new URL(value);
  const visibleValue = `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  return `<span><strong>Web:</strong> ${escapeHtml(visibleValue)}</span>`;
}

function renderSender(input: OfferReleaseCandidateInputV1): string {
  const sender = input.sender;
  const tradingName = sender.tradingName === null
    ? ""
    : `<span>${escapeHtml(sender.tradingName)}</span>`;
  const phone = sender.contactPhone === null
    ? ""
    : `<span><strong>Telefon:</strong> ${escapeHtml(sender.contactPhone)}</span>`;
  const register = sender.registerCourt === null || sender.registerNumber === null
    ? ""
    : `<span>${escapeHtml(sender.registerCourt)} · ${escapeHtml(sender.registerNumber)}</span>`;
  const vatId = sender.vatId === null
    ? ""
    : `<span>USt-IdNr. ${escapeHtml(sender.vatId)}</span>`;

  return `<section class="party-card party-card--sender" aria-labelledby="sender-heading">
  <h2 id="sender-heading">Aussteller</h2>
  <address>
    <strong>${escapeHtml(sender.legalName)}</strong>
    ${tradingName}
    ${renderAddress(sender.address)}
  </address>
  <div class="party-details">
    <span>Vertreten durch ${escapeHtml(sender.representedBy)}</span>
    <span><strong>E-Mail:</strong> ${escapeHtml(sender.contactEmail)}</span>
    ${phone}
    ${renderWebsite(sender.website)}
    ${register}
    ${vatId}
  </div>
</section>`;
}

function renderRecipient(input: OfferReleaseCandidateInputV1): string {
  const recipient = input.recipient;
  const company = recipient.company === null
    ? ""
    : `<span>${escapeHtml(recipient.company)}</span>`;
  return `<section class="party-card" aria-labelledby="recipient-heading">
  <h2 id="recipient-heading">Empfänger und Rechnungsadresse</h2>
  <address>
    <strong>${escapeHtml(recipient.displayName)}</strong>
    ${company}
    <span>${escapeHtml(recipient.billingAddress.formattedAddress)}</span>
    <span>Deutschland</span>
  </address>
</section>`;
}

type CandidateLine = OfferReleaseCandidateInputV1["sections"][number]["lines"][number];
type CandidateSection = OfferReleaseCandidateInputV1["sections"][number];

function renderLine(
  section: CandidateSection,
  line: CandidateLine,
  renderedLineNumber: number,
): string {
  const description = line.description === null
    ? ""
    : `<p class="line-description">${escapeFlowText(line.description)}</p>`;
  return `<tr data-offer-line="${renderedLineNumber}">
  <td class="position-cell">${section.position}.${line.position}</td>
  <td><strong>${escapeHtml(line.title)}</strong>${description}</td>
  <td>${positionTypeLabel(line.positionType)}</td>
  <td class="number-cell">${formatQuantity(line.quantityMilli, line.unit)}</td>
  <td class="number-cell">${formatMoney(line.salesUnitNetCents)}</td>
  <td class="number-cell">${formatDiscount(line.lineDiscountBps)}</td>
  <td class="number-cell">${formatTax(line.taxRateBps)}</td>
  <td class="number-cell"><strong>${formatMoney(line.finalNetCents)}</strong><span class="gross-line">brutto ${formatMoney(line.grossCents)}</span></td>
</tr>`;
}

function renderSectionTables(
  input: OfferReleaseCandidateInputV1,
  optional: boolean,
): string {
  let ordinal = 0;
  const sections = input.sections.map((section) => {
    const lines = section.lines.filter((line) =>
      (line.positionType === "optional") === optional);
    if (lines.length === 0) return "";
    const rows = lines.map((line) => {
      ordinal += 1;
      return renderLine(section, line, ordinal);
    }).join("\n");
    const discount = section.discountBps === 0
      ? ""
      : `<p>Sektionsrabatt ${formatDiscount(section.discountBps)}</p>`;

    return `<section class="offer-section" aria-label="${escapeHtml(section.title)}">
  <div class="section-heading">
    <h3>${section.position}. ${escapeHtml(section.title)}</h3>
    ${discount}
  </div>
  <table>
    <thead>
      <tr>
        <th scope="col" class="position-cell">Pos.</th>
        <th scope="col">Leistung</th>
        <th scope="col">Art</th>
        <th scope="col" class="number-cell">Menge</th>
        <th scope="col" class="number-cell">Einzel netto</th>
        <th scope="col" class="number-cell">Rabatt</th>
        <th scope="col" class="number-cell">Steuer</th>
        <th scope="col" class="number-cell">Summe netto</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
  }).join("\n");

  return ordinal === 0
    ? `<p class="empty-block">Keine ${optional ? "optionalen Leistungen" : "Basisleistungen"} enthalten.</p>`
    : sections;
}

function renderCommercialTerms(input: OfferReleaseCandidateInputV1): string {
  const customDeal = input.commercialTerms.customDealNetCents === null
    ? "Nicht vereinbart"
    : `${formatMoney(input.commercialTerms.customDealNetCents)} netto`;
  return `<dl class="commercial-terms">
  <div><dt>Globaler Rabatt</dt><dd>${formatDiscount(input.commercialTerms.globalDiscountBps)}</dd></div>
  <div><dt>Individueller Zielpreis</dt><dd>${customDeal}</dd></div>
</dl>`;
}

function renderTaxBreakdown(
  input: OfferReleaseCandidateInputV1,
  optional: boolean,
): string {
  return ([0, 1_900] as const).map((rate) => {
    const matchingLines = input.sections.flatMap((section) => section.lines).filter((line) =>
      (line.positionType === "optional") === optional && line.taxRateBps === rate);
    if (matchingLines.length === 0) return "";
    const taxCents = matchingLines.reduce(
      (sum, line) => sum + BigInt(line.taxCents),
      BigInt(0),
    );
    return `<div><dt>Steueranteil ${formatTax(rate)}</dt><dd>${formatMoney(taxCents)}</dd></div>`;
  }).join("");
}

function renderSummary(
  input: OfferReleaseCandidateInputV1,
  optional: boolean,
): string {
  const prefix = optional ? "Optionen" : "Basis";
  const totals = input.totals;
  const net = optional ? totals.optionalNetCents : totals.basisNetCents;
  const tax = optional ? totals.optionalTaxCents : totals.basisTaxCents;
  const gross = optional ? totals.optionalGrossCents : totals.basisGrossCents;
  return `<section class="summary" aria-label="${prefix}summe">
  <h3>${prefix}summe</h3>
  <dl>
    <div><dt>${prefix} netto</dt><dd>${formatMoney(net)}</dd></div>
    <div><dt>${prefix} Steuer</dt><dd>${formatMoney(tax)}</dd></div>
    ${renderTaxBreakdown(input, optional)}
    <div class="summary-total"><dt>${prefix} brutto</dt><dd>${formatMoney(gross)}</dd></div>
  </dl>
</section>`;
}

function renderLegalDocuments(input: OfferReleaseCandidateInputV1): string {
  const documents = [
    input.legalDocuments.terms,
    input.legalDocuments.withdrawalInformation,
    input.legalDocuments.privacyNotice,
  ];
  return documents.map((document, index) => `<section class="legal-document" aria-labelledby="legal-${index + 1}">
  <h3 id="legal-${index + 1}">${escapeHtml(document.title)}</h3>
  <p>${escapeMultilineText(document.plainText)}</p>
</section>`).join("\n");
}

/** Pure deterministic renderer. Every dynamic value is validated and text-escaped. */
export function renderOfferReleaseCandidateHtml(
  value: OfferReleaseCandidateInputV1,
): string {
  const validated = validateOfferReleaseCandidateInput(value);
  if (!validated.ok) {
    throw new TypeError(
      `Ungueltiger Freigabekandidaten-Dokumentinput: ${validated.paths.join(", ")}`,
    );
  }
  const input = validated.value;
  const status = escapeHtml(RELEASE_CANDIDATE_STATUS);

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-ancestors &#39;none&#39;">
  <meta name="color-scheme" content="light">
  <title>Freigabekandidat ${escapeHtml(input.offerNumber)}</title>
  <style>
    @page { size: A4; margin: 23mm 12mm 20mm; }
    :root {
      color-scheme: light;
      --offer-brand-600: #0f7550;
      --offer-brand-ink: #0a4a33;
      --offer-fg: #0b1b15;
      --offer-fg-muted: #47564f;
      --offer-surface-1: #ffffff;
      --offer-surface-2: #f7faf8;
      --offer-surface-3: #eef3f0;
      --offer-border: #d3ddd8;
      --offer-border-strong: #6e7f77;
      --offer-warning: #6b4708;
      --offer-warning-bg: #fff4d6;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--offer-fg);
      background: var(--offer-surface-1);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-size: 9.3pt; line-height: 1.42; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 3mm; color: var(--offer-brand-ink); font-size: 22pt; line-height: 1.1; }
    h2 { margin: 0 0 3mm; color: var(--offer-brand-ink); font-size: 12pt; }
    h3 { margin: 0; color: var(--offer-fg); font-size: 10.5pt; }
    address { display: flex; flex-direction: column; gap: 0.6mm; font-style: normal; }
    .page-status { position: fixed; z-index: 10; top: -16mm; left: 0; right: 0; min-height: 9mm; border: 0.35mm solid var(--offer-warning); background: var(--offer-warning-bg); color: var(--offer-warning); padding: 2.1mm 4mm; text-align: center; font-size: 8.5pt; font-weight: 800; letter-spacing: 0.015em; }
    .page-footer { position: fixed; z-index: 10; bottom: -13mm; left: 0; right: 0; display: flex; justify-content: space-between; gap: 5mm; border-top: 0.25mm solid var(--offer-border-strong); padding-top: 2mm; color: var(--offer-fg-muted); font-size: 7pt; }
    .page-footer span:last-child { text-align: right; }
    .document-header { display: grid; grid-template-columns: 1fr auto; gap: 8mm; border-bottom: 1mm solid var(--offer-brand-600); padding: 1mm 0 5mm; margin-bottom: 7mm; }
    .wordmark { color: var(--offer-brand-600); font-size: 18pt; line-height: 1; font-weight: 800; letter-spacing: 0.12em; }
    .document-kind { margin-top: 2mm; color: var(--offer-fg-muted); font-weight: 700; }
    .status-badge { margin: 2.5mm 0 0; color: var(--offer-warning); font-weight: 800; }
    .offer-number { text-align: right; }
    .offer-number span { display: block; color: var(--offer-fg-muted); font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.06em; }
    .offer-number strong { display: block; margin-top: 1mm; font-size: 13pt; overflow-wrap: anywhere; }
    .status-notice { border-left: 1.2mm solid var(--offer-warning); background: var(--offer-warning-bg); padding: 3.5mm 4mm; margin-bottom: 7mm; color: var(--offer-warning); break-inside: avoid; page-break-inside: avoid; }
    .status-notice strong { display: block; margin-bottom: 1mm; }
    .status-notice p { margin-bottom: 0; }
    .party-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 5mm; margin-bottom: 5mm; }
    .party-card { border: 0.25mm solid var(--offer-border); background: var(--offer-surface-2); padding: 4mm; break-inside: avoid; page-break-inside: avoid; }
    .party-card--sender { grid-column: 1 / -1; }
    .party-card h2, .site-card h2 { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em; }
    .party-details { display: flex; flex-wrap: wrap; gap: 1.2mm 5mm; margin-top: 3mm; color: var(--offer-fg-muted); font-size: 8pt; }
    .site-card { border-left: 1.1mm solid var(--offer-brand-600); padding: 3mm 0 3mm 4mm; margin-bottom: 6mm; break-inside: avoid; page-break-inside: avoid; }
    .site-card p { margin-bottom: 0; }
    .metadata { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border: 0.25mm solid var(--offer-border); margin: 0 0 8mm; break-inside: avoid; page-break-inside: avoid; }
    .metadata div { min-width: 0; padding: 3mm; border-right: 0.25mm solid var(--offer-border); }
    .metadata div:last-child { border-right: 0; }
    .metadata dt { color: var(--offer-fg-muted); font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
    .metadata dd { margin: 1mm 0 0; font-weight: 700; overflow-wrap: anywhere; }
    .block { margin-top: 8mm; }
    .block-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 5mm; border-bottom: 0.5mm solid var(--offer-brand-600); padding-bottom: 2mm; margin-bottom: 4mm; break-after: avoid; page-break-after: avoid; }
    .block-heading p { margin: 0; color: var(--offer-fg-muted); }
    .offer-section { margin: 0 0 6mm; }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; padding: 2.5mm 3mm; background: var(--offer-surface-3); break-after: avoid; page-break-after: avoid; }
    .section-heading p { margin: 0; color: var(--offer-fg-muted); font-size: 8pt; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    th, td { border-bottom: 0.2mm solid var(--offer-border); padding: 2.2mm 1.3mm; vertical-align: top; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
    th { background: var(--offer-surface-2); color: var(--offer-brand-ink); font-size: 7pt; line-height: 1.25; }
    td { font-size: 7.6pt; }
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
    .line-description { margin: 1mm 0 0; color: var(--offer-fg-muted); white-space: normal; }
    .gross-line { display: block; margin-top: 0.5mm; color: var(--offer-fg-muted); font-size: 7pt; font-weight: 400; }
    .commercial-terms { display: flex; flex-wrap: wrap; gap: 4mm 8mm; border: 0.25mm solid var(--offer-border); padding: 3mm; margin: 0 0 5mm; break-inside: avoid; page-break-inside: avoid; }
    .commercial-terms div { display: flex; gap: 2mm; }
    .commercial-terms dt { color: var(--offer-fg-muted); }
    .commercial-terms dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
    .summary-grid { display: grid; grid-template-columns: minmax(68mm, 1fr); justify-content: end; margin-top: 5mm; }
    .summary { width: 82mm; justify-self: end; border: 0.35mm solid var(--offer-border-strong); padding: 4mm; break-inside: avoid; page-break-inside: avoid; }
    .summary h3 { margin-bottom: 2mm; }
    .summary dl { margin: 0; }
    .summary dl div { display: flex; justify-content: space-between; gap: 4mm; padding: 1mm 0; }
    .summary dd { margin: 0; font-variant-numeric: tabular-nums; }
    .summary-total { border-top: 0.25mm solid var(--offer-border-strong); margin-top: 1mm; padding-top: 2mm !important; font-weight: 800; }
    .optional-block { border-top: 1mm solid var(--offer-warning); padding-top: 5mm; }
    .optional-note { color: var(--offer-warning) !important; font-weight: 700; }
    .empty-block { color: var(--offer-fg-muted); font-style: italic; }
    .legal-block { break-before: page; page-break-before: always; margin-top: 6mm; }
    .legal-intro { color: var(--offer-fg-muted); }
    .legal-document { border-top: 0.35mm solid var(--offer-border); padding-top: 4mm; margin-top: 6mm; overflow-wrap: anywhere; }
    .legal-document h3 { color: var(--offer-brand-ink); break-after: avoid; page-break-after: avoid; }
    .legal-document p { margin: 2mm 0 0; white-space: pre-line; orphans: 3; widows: 3; }
    .document-meta { margin-top: 8mm; border-top: 0.25mm solid var(--offer-border-strong); padding-top: 3mm; color: var(--offer-fg-muted); font-size: 7.5pt; break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <div class="page-status" aria-hidden="true">${status}</div>
  <div class="page-footer" aria-hidden="true"><span>${status}</span><span>${escapeHtml(input.offerNumber)} · Variante Revision ${input.variant.revision}</span></div>
  <header class="document-header">
    <div>
      <div class="wordmark">WMEE</div>
      <div class="document-kind">Angebot zur abschließenden internen Freigabe</div>
      <p class="status-badge" role="status">${status}</p>
    </div>
    <div class="offer-number"><span>Angebotsnummer</span><strong>${escapeHtml(input.offerNumber)}</strong></div>
  </header>
  <main>
    <h1>Angebot</h1>
    <aside class="status-notice" aria-label="Dokumentstatus">
      <strong>Noch nicht ausgestellt oder versendet</strong>
      <p>Dieser Freigabekandidat dient der abschließenden Prüfung. Für eine spätere Ausgabe wird ein gesondertes ausgestelltes Dokument erzeugt.</p>
    </aside>
    <div class="party-grid">
      ${renderSender(input)}
      ${renderRecipient(input)}
      <section class="site-card" aria-labelledby="site-heading">
        <h2 id="site-heading">Anlagenstandort</h2>
        <p>${escapeHtml(input.installationSite.formattedAddress)}</p>
      </section>
    </div>
    <dl class="metadata">
      <div><dt>Dokumentdatum</dt><dd>${formatCalendarDate(input.documentDate)}</dd></div>
      <div><dt>Gültig bis</dt><dd>${formatCalendarDate(input.validThrough)}</dd></div>
      <div><dt>Variante</dt><dd>${escapeHtml(input.variant.name)}</dd></div>
      <div><dt>Stand</dt><dd>Revision ${input.variant.revision}</dd></div>
    </dl>
    <section class="block" aria-labelledby="base-heading">
      <div class="block-heading">
        <h2 id="base-heading">Basisleistungen</h2>
        <p>Erforderliche und zusätzliche Leistungen</p>
      </div>
      ${renderCommercialTerms(input)}
      ${renderSectionTables(input, false)}
      <div class="summary-grid">${renderSummary(input, false)}</div>
    </section>
    <section class="block optional-block" aria-labelledby="optional-heading">
      <div class="block-heading">
        <h2 id="optional-heading">Optionale Leistungen</h2>
        <p class="optional-note">Optionale Leistungen sind nicht in der Basissumme enthalten.</p>
      </div>
      ${renderSectionTables(input, true)}
      <div class="summary-grid">${renderSummary(input, true)}</div>
    </section>
    <section class="legal-block" aria-labelledby="legal-heading">
      <div class="block-heading"><h2 id="legal-heading">Rechtliche Dokumente</h2></div>
      <p class="legal-intro">Die folgenden Texte stammen aus dem intern aktivierten Ausstellerprofil und sind Bestandteil dieses Freigabekandidaten.</p>
      ${renderLegalDocuments(input)}
    </section>
  </main>
  <footer class="document-meta">
    Dokumentprofil ${escapeHtml(input.profile.name)} · Profilrevision ${input.profile.revision} · Dokumentstatus: ${status}
  </footer>
</body>
</html>`;
}
