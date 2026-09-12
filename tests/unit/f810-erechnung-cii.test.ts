import { describe, expect, it } from "vitest";

import {
  buildCiiXml,
  CiiExportError,
  type CiiExportInput,
} from "@/lib/integrations/invoicing/cii-export";

function input(overrides: Partial<CiiExportInput> = {}): CiiExportInput {
  return {
    kind: "invoice",
    number: "RE-2026-0042",
    issueDate: "2026-09-12",
    deliveryDate: "2026-09-10",
    currency: "EUR",
    seller: {
      name: "WMEE GmbH",
      line1: "Musterstraße 1",
      postalCode: "80331",
      city: "München",
      country: "DE",
      taxId: "DE123456789",
    },
    buyer: {
      name: "Erika Musterfrau",
      line1: "Beispielweg 2",
      postalCode: "80469",
      city: "München",
      country: "DE",
    },
    lines: [
      {
        position: 1,
        name: "PV-Module 450 Wp",
        quantityMilli: 12000,
        unit: "piece",
        netCents: 600000,
        taxCents: 114000,
        grossCents: 714000,
        taxRateBps: 1900,
      },
      {
        position: 2,
        name: "Montage & Anmeldung",
        quantityMilli: 1000,
        unit: "set",
        netCents: 150050,
        taxCents: 28510,
        grossCents: 178560,
        taxRateBps: 1900,
      },
    ],
    netCents: 750050,
    taxCents: 142510,
    grossCents: 892560,
    paymentIban: "DE89370400440532013000",
    ...overrides,
  };
}

function codeOf(task: () => unknown): string | null {
  try {
    task();
  } catch (error) {
    if (error instanceof CiiExportError) return error.code;
    throw error;
  }
  return null;
}

describe("F8-10 E-Rechnung CII-Export", () => {
  it("F810-U-01: Kernstruktur, Typcode, Summenkranz und Einheiten", () => {
    const xml = buildCiiXml(input());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).toContain("<ram:ID>RE-2026-0042</ram:ID>");
    expect(xml).toContain("<udt:DateTimeString format=\"102\">20260912</udt:DateTimeString>");
    expect(xml).toContain("<ram:GrandTotalAmount>8925.60</ram:GrandTotalAmount>");
    expect(xml).toContain("<ram:DuePayableAmount>8925.60</ram:DuePayableAmount>");
    expect(xml).toContain("<ram:TaxTotalAmount currencyID=\"EUR\">1425.10</ram:TaxTotalAmount>");
    expect(xml).toContain("<ram:BilledQuantity unitCode=\"H87\">12</ram:BilledQuantity>");
    expect(xml).toContain("<ram:BilledQuantity unitCode=\"SET\">1</ram:BilledQuantity>");
    expect(xml).toContain("<ram:ChargeAmount>500</ram:ChargeAmount>");
    expect(xml).toContain("<ram:RateApplicablePercent>19</ram:RateApplicablePercent>");
    expect(xml).toContain("<ram:IBANID>DE89370400440532013000</ram:IBANID>");
    expect(xml).toContain("<ram:ID schemeID=\"VA\">DE123456789</ram:ID>");
  });

  it("F810-U-02: Gutschrift trägt 381, Determinismus ist byte-identisch", () => {
    const xml = buildCiiXml(input({ kind: "credit_note" }));
    expect(xml).toContain("<ram:TypeCode>381</ram:TypeCode>");
    expect(buildCiiXml(input())).toBe(buildCiiXml(input()));
  });

  it("F810-U-03: Freitexte werden XML-escapet", () => {
    const xml = buildCiiXml(input({
      number: "RE&A-\"1\"",
      lines: [{
        position: 1,
        name: "Wechselrichter <3 kVA> & \"Speicher\"",
        quantityMilli: 1000,
        unit: "piece",
        netCents: 100000,
        taxCents: 19000,
        grossCents: 119000,
        taxRateBps: 1900,
      }],
      netCents: 100000,
      taxCents: 19000,
      grossCents: 119000,
    }));
    expect(xml).toContain("<ram:ID>RE&amp;A-&quot;1&quot;</ram:ID>");
    expect(xml).toContain("<ram:Name>Wechselrichter &lt;3 kVA&gt; &amp; &quot;Speicher&quot;</ram:Name>");
    expect(xml).not.toContain("Wechselrichter <3");
  });

  it("F810-U-04: Steuersatz-Gruppierung je Satz", () => {
    const xml = buildCiiXml(input({
      lines: [
        {
          position: 1, name: "A", quantityMilli: 1000, unit: "piece",
          netCents: 100000, taxCents: 19000, grossCents: 119000, taxRateBps: 1900,
        },
        {
          position: 2, name: "B", quantityMilli: 2000, unit: "meter",
          netCents: 200000, taxCents: 14000, grossCents: 214000, taxRateBps: 700,
        },
      ],
      netCents: 300000,
      taxCents: 33000,
      grossCents: 333000,
    }));
    expect(xml).toContain("<ram:BasisAmount>1000.00</ram:BasisAmount>");
    expect(xml).toContain("<ram:RateApplicablePercent>7</ram:RateApplicablePercent>");
    expect(xml).toContain("<ram:BilledQuantity unitCode=\"MTR\">2</ram:BilledQuantity>");
  });

  it("F810-U-05: Reject-Pfade sind trennscharf", () => {
    expect(codeOf(() => buildCiiXml(input({ kind: "quote" as never })))).toBe("kind");
    expect(codeOf(() => buildCiiXml(input({ currency: "USD" as never })))).toBe("currency");
    expect(codeOf(() => buildCiiXml(input({ number: "  " })))).toBe("number");
    expect(codeOf(() => buildCiiXml(input({ issueDate: "12.09.2026" })))).toBe("date");
    expect(codeOf(() => buildCiiXml(input({ lines: [] })))).toBe("lines");
    expect(codeOf(() => buildCiiXml(input({
      lines: [{ ...input().lines[0]!, taxRateBps: 0 }],
    })))).toBe("tax");
    expect(codeOf(() => buildCiiXml(input({ netCents: 1 })))).toBe("sums");
    expect(codeOf(() => buildCiiXml(input({ grossCents: 1 })))).toBe("sums");
    expect(codeOf(() => buildCiiXml(input({
      seller: { ...input().seller, taxId: null },
    })))).toBe("party");
    expect(codeOf(() => buildCiiXml(input({
      buyer: { ...input().buyer, city: " " },
    })))).toBe("party");
  });
});
