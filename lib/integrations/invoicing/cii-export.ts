// F8-10 E-Rechnung CII-Export (Katalog F8, „E-Rechnung" offen).
// Reiner, deterministischer Builder: Belegdaten -> CII-XML (EN16931-Syntax,
// BASIC-naher Subset). Keine Migration, keine IO. Alle Summen cent-exakt
// aus den Eingabewerten abgeglichen (fail-closed statt krummem XML).
// Konformität gegen amtliche Validatoren steht aus und wird NICHT behauptet.

export const CII_GUIDELINE_ID = "urn:factur-x.eu:1p0:basicwl";
export const CII_XMLNS_RSM = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";
export const CII_XMLNS_RAM =
  "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100";
export const CII_XMLNS_UDT = "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100";

const CII_TYPE_CODES = { invoice: "380", credit_note: "381" } as const;
export type CiiExportKind = keyof typeof CII_TYPE_CODES;

const CII_UNIT_CODES = { piece: "H87", set: "SET", meter: "MTR" } as const;
export type CiiExportUnit = keyof typeof CII_UNIT_CODES;

export type CiiExportParty = {
  name: string;
  line1: string;
  line2?: string | null;
  postalCode: string;
  city: string;
  country: string;
  taxId?: string | null;
};

export type CiiExportLine = {
  position: number;
  name: string;
  quantityMilli: number;
  unit: CiiExportUnit;
  netCents: number;
  taxCents: number;
  grossCents: number;
  taxRateBps: number;
};

export type CiiExportInput = {
  kind: CiiExportKind;
  number: string;
  issueDate: string;
  deliveryDate: string;
  currency: "EUR";
  seller: CiiExportParty;
  buyer: CiiExportParty;
  lines: CiiExportLine[];
  netCents: number;
  taxCents: number;
  grossCents: number;
  paymentIban?: string | null;
};

export type CiiExportErrorCode =
  | "kind"
  | "currency"
  | "number"
  | "date"
  | "party"
  | "lines"
  | "line"
  | "tax"
  | "sums";

export class CiiExportError extends Error {
  readonly code: CiiExportErrorCode;
  constructor(code: CiiExportErrorCode, detail: string) {
    super(`cii-export:${code}: ${detail}`);
    this.name = "CiiExportError";
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function requiredText(value: string, field: string): string {
  if (value.trim() === "") throw new CiiExportError("party", `${field} fehlt`);
  return value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function amount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function ratePercent(taxRateBps: number): string {
  const raw = (taxRateBps / 100).toFixed(2);
  return raw.replace(/\.?0+$/u, "");
}

function quantity(quantityMilli: number): string {
  const raw = (quantityMilli / 1000).toFixed(3);
  return raw.replace(/\.?0+$/u, "");
}

function unitPrice(netCents: number, quantityMilli: number): string {
  // Stückpreis in Euro mit bis zu 4 Dezimalen (CII-genau); Zeilensumme
  // bleibt cent-exakt aus netCents (kein Rückrechnen).
  const raw = (netCents / 100 / (quantityMilli / 1000)).toFixed(4);
  return raw.replace(/\.?0+$/u, "");
}

function compactDate(isoDate: string, field: string): string {
  if (!ISO_DATE.test(isoDate)) throw new CiiExportError("date", `${field} ist kein ISO-Datum`);
  return isoDate.replace(/-/gu, "");
}

function partyXml(tag: "SellerTradeParty" | "BuyerTradeParty", party: CiiExportParty): string {
  const name = requiredText(party.name, `${tag}.name`);
  const line1 = requiredText(party.line1, `${tag}.line1`);
  const postal = requiredText(party.postalCode, `${tag}.postalCode`);
  const city = requiredText(party.city, `${tag}.city`);
  const country = requiredText(party.country, `${tag}.country`);
  const tax = tag === "SellerTradeParty" ? requiredText(party.taxId ?? "", `${tag}.taxId`) : null;
  return [
    `      <ram:${tag}>`,
    `        <ram:Name>${escapeXml(name)}</ram:Name>`,
    tax !== null
      ? [
        "        <ram:SpecifiedTaxRegistration>",
        `          <ram:ID schemeID="VA">${escapeXml(tax)}</ram:ID>`,
        "        </ram:SpecifiedTaxRegistration>",
      ].join("\n")
      : null,
    "        <ram:PostalTradeAddress>",
    `          <ram:PostcodeCode>${escapeXml(postal)}</ram:PostcodeCode>`,
    `          <ram:LineOne>${escapeXml(line1)}</ram:LineOne>`,
    party.line2 !== null && party.line2 !== undefined && party.line2.trim() !== ""
      ? `          <ram:LineTwo>${escapeXml(party.line2)}</ram:LineTwo>`
      : null,
    `          <ram:CityName>${escapeXml(city)}</ram:CityName>`,
    `          <ram:CountryID>${escapeXml(country)}</ram:CountryID>`,
    "        </ram:PostalTradeAddress>",
    `      </ram:${tag}>`,
  ].filter((part) => part !== null).join("\n");
}

export function buildCiiXml(input: CiiExportInput): string {
  if (input.kind !== "invoice" && input.kind !== "credit_note") {
    throw new CiiExportError("kind", "nur invoice/credit_note werden exportiert");
  }
  if (input.currency !== "EUR") {
    throw new CiiExportError("currency", "nur EUR wird exportiert");
  }
  if (input.number.trim() === "") throw new CiiExportError("number", "Belegnummer fehlt");
  if (input.lines.length === 0) throw new CiiExportError("lines", "Beleg hat keine Positionen");

  for (const [index, line] of input.lines.entries()) {
    if (!Number.isInteger(line.position) || line.position < 1) {
      throw new CiiExportError("line", `Position ${index} ist ungültig`);
    }
    if (line.name.trim() === "") throw new CiiExportError("line", `Position ${line.position} ohne Text`);
    if (!Number.isInteger(line.quantityMilli) || line.quantityMilli <= 0) {
      throw new CiiExportError("line", `Position ${line.position} ohne Menge`);
    }
    if (!(line.unit in CII_UNIT_CODES)) throw new CiiExportError("line", `Position ${line.position} ohne Einheit`);
    for (const [field, value] of [["net", line.netCents], ["tax", line.taxCents], ["gross", line.grossCents]] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new CiiExportError("line", `Position ${line.position}: ${field} ungültig`);
      }
    }
    if (!Number.isInteger(line.taxRateBps) || line.taxRateBps <= 0) {
      throw new CiiExportError("tax", `Position ${line.position}: nur Steuersatz > 0 (Kategorie S)`);
    }
    if (line.grossCents !== line.netCents + line.taxCents) {
      throw new CiiExportError("sums", `Position ${line.position}: brutto != netto + Steuer`);
    }
  }

  const lineNet = input.lines.reduce((sum, line) => sum + line.netCents, 0);
  const lineTax = input.lines.reduce((sum, line) => sum + line.taxCents, 0);
  if (lineNet !== input.netCents || lineTax !== input.taxCents) {
    throw new CiiExportError("sums", "Kopf Netto/Steuer weicht von der Positionssumme ab");
  }
  if (input.grossCents !== input.netCents + input.taxCents) {
    throw new CiiExportError("sums", "Kopf brutto != netto + Steuer");
  }

  const issueCompact = compactDate(input.issueDate, "issueDate");
  const deliveryCompact = compactDate(input.deliveryDate, "deliveryDate");

  const taxGroups = new Map<number, { basis: number; tax: number }>();
  for (const line of input.lines) {
    const group = taxGroups.get(line.taxRateBps) ?? { basis: 0, tax: 0 };
    group.basis += line.netCents;
    group.tax += line.taxCents;
    taxGroups.set(line.taxRateBps, group);
  }

  const lineItems = input.lines.map((line, index) => [
    "    <ram:IncludedSupplyChainTradeLineItem>",
    "      <ram:AssociatedDocumentLineDocument>",
    `        <ram:LineID>${index + 1}</ram:LineID>`,
    "      </ram:AssociatedDocumentLineDocument>",
    "      <ram:SpecifiedTradeProduct>",
    `        <ram:Name>${escapeXml(line.name)}</ram:Name>`,
    "      </ram:SpecifiedTradeProduct>",
    "      <ram:SpecifiedLineTradeAgreement>",
    "        <ram:NetPriceProductTradePrice>",
    `          <ram:ChargeAmount>${unitPrice(line.netCents, line.quantityMilli)}</ram:ChargeAmount>`,
    "        </ram:NetPriceProductTradePrice>",
    "      </ram:SpecifiedLineTradeAgreement>",
    "      <ram:SpecifiedLineTradeDelivery>",
    `        <ram:BilledQuantity unitCode="${CII_UNIT_CODES[line.unit]}">${quantity(line.quantityMilli)}</ram:BilledQuantity>`,
    "      </ram:SpecifiedLineTradeDelivery>",
    "      <ram:SpecifiedLineTradeSettlement>",
    "        <ram:ApplicableTradeTax>",
    "          <ram:TypeCode>VAT</ram:TypeCode>",
    "          <ram:CategoryCode>S</ram:CategoryCode>",
    `          <ram:RateApplicablePercent>${ratePercent(line.taxRateBps)}</ram:RateApplicablePercent>`,
    "        </ram:ApplicableTradeTax>",
    "        <ram:SpecifiedTradeSettlementLineMonetarySummation>",
    `          <ram:LineTotalAmount>${amount(line.netCents)}</ram:LineTotalAmount>`,
    "        </ram:SpecifiedTradeSettlementLineMonetarySummation>",
    "      </ram:SpecifiedLineTradeSettlement>",
    "    </ram:IncludedSupplyChainTradeLineItem>",
  ].join("\n")).join("\n");

  const taxBreakdown = [...taxGroups.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([rate, group]) => [
      "      <ram:ApplicableTradeTax>",
      `        <ram:CalculatedAmount>${amount(group.tax)}</ram:CalculatedAmount>`,
      "        <ram:TypeCode>VAT</ram:TypeCode>",
      `        <ram:BasisAmount>${amount(group.basis)}</ram:BasisAmount>`,
      "        <ram:CategoryCode>S</ram:CategoryCode>",
      `        <ram:RateApplicablePercent>${ratePercent(rate)}</ram:RateApplicablePercent>`,
      "      </ram:ApplicableTradeTax>",
    ].join("\n")).join("\n");

  const iban = input.paymentIban !== null && input.paymentIban !== undefined
    && input.paymentIban.trim() !== ""
    ? input.paymentIban.trim()
    : null;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rsm:CrossIndustryInvoice xmlns:rsm="${CII_XMLNS_RSM}" xmlns:ram="${CII_XMLNS_RAM}" xmlns:udt="${CII_XMLNS_UDT}">`,
    "  <rsm:ExchangedDocumentContext>",
    "    <ram:GuidelineSpecifiedDocumentContextParameters>",
    `      <ram:ID>${CII_GUIDELINE_ID}</ram:ID>`,
    "    </ram:GuidelineSpecifiedDocumentContextParameters>",
    "  </rsm:ExchangedDocumentContext>",
    "  <rsm:ExchangedDocument>",
    `    <ram:ID>${escapeXml(input.number)}</ram:ID>`,
    `    <ram:TypeCode>${CII_TYPE_CODES[input.kind]}</ram:TypeCode>`,
    "    <ram:IssueDateTime>",
    `      <udt:DateTimeString format="102">${issueCompact}</udt:DateTimeString>`,
    "    </ram:IssueDateTime>",
    "  </rsm:ExchangedDocument>",
    "  <rsm:SupplyChainTradeTransaction>",
    lineItems,
    "    <ram:ApplicableHeaderTradeAgreement>",
    partyXml("SellerTradeParty", input.seller),
    partyXml("BuyerTradeParty", input.buyer),
    "    </ram:ApplicableHeaderTradeAgreement>",
    "    <ram:ApplicableHeaderTradeDelivery>",
    "      <ram:ActualDeliverySupplyChainEvent>",
    "        <ram:OccurrenceDateTime>",
    `          <udt:DateTimeString format="102">${deliveryCompact}</udt:DateTimeString>`,
    "        </ram:OccurrenceDateTime>",
    "      </ram:ActualDeliverySupplyChainEvent>",
    "    </ram:ApplicableHeaderTradeDelivery>",
    "    <ram:ApplicableHeaderTradeSettlement>",
    `      <ram:InvoiceCurrencyCode>${input.currency}</ram:InvoiceCurrencyCode>`,
    iban !== null
      ? [
        "      <ram:SpecifiedTradeSettlementPaymentMeans>",
        "        <ram:TypeCode>58</ram:TypeCode>",
        "        <ram:PayeePartyCreditorFinancialAccount>",
        `          <ram:IBANID>${escapeXml(iban)}</ram:IBANID>`,
        "        </ram:PayeePartyCreditorFinancialAccount>",
        "      </ram:SpecifiedTradeSettlementPaymentMeans>",
      ].join("\n")
      : null,
    taxBreakdown,
    "      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    `        <ram:LineTotalAmount>${amount(input.netCents)}</ram:LineTotalAmount>`,
    `        <ram:TaxBasisTotalAmount>${amount(input.netCents)}</ram:TaxBasisTotalAmount>`,
    `        <ram:TaxTotalAmount currencyID="${input.currency}">${amount(input.taxCents)}</ram:TaxTotalAmount>`,
    `        <ram:GrandTotalAmount>${amount(input.grossCents)}</ram:GrandTotalAmount>`,
    `        <ram:DuePayableAmount>${amount(input.grossCents)}</ram:DuePayableAmount>`,
    "      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    "    </ram:ApplicableHeaderTradeSettlement>",
    "  </rsm:SupplyChainTradeTransaction>",
    "</rsm:CrossIndustryInvoice>",
    "",
  ].filter((part) => part !== null).join("\n");
}
