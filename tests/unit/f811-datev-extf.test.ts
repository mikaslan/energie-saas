import { describe, expect, it } from "vitest";

import {
  buildDatevBatchCsv,
  datevBatchFileName,
  DatevExportError,
  type DatevBatchInput,
  type DatevBookingInput,
} from "@/lib/integrations/invoicing/datev-export";

function booking(overrides: Partial<DatevBookingInput> = {}): DatevBookingInput {
  return {
    kind: "invoice",
    number: "RE-2026-000001",
    issueDate: "2026-11-15",
    contactName: "Muster Kundin",
    currency: "EUR",
    lines: [
      { taxRateBps: 1900, netCents: 800000, taxCents: 152000, grossCents: 952000 },
      { taxRateBps: 1900, netCents: 150000, taxCents: 28500, grossCents: 178500 },
    ],
    netCents: 950000,
    taxCents: 180500,
    grossCents: 1130500,
    ...overrides,
  };
}

function batch(overrides: Partial<DatevBatchInput> = {}): DatevBatchInput {
  return { month: "2026-11", skr: "03", bookings: [booking()], ...overrides };
}

describe("F8-11 DATEV-EXTF Buchungsstapel", () => {
  it("F811-U-01: Vorspann, SKR03-Konten, Soll-Seite, Komma-Betrag", () => {
    const content = buildDatevBatchCsv(batch());
    const lines = content.split("\r\n");
    expect(lines[0]).toMatch(/^EXTF;700;21;Buchungsstapel;/u);
    expect(lines[1]).toContain("Soll/Haben-Kennzeichen");
    expect(lines[1]).toContain("Belegnummer");
    expect(lines[2]).toContain("11305,00;S;1400;8400;;15112026;RE-2026-000001;");
    expect(lines[2]).toContain("Rechnung RE-2026-000001 - Muster Kundin");
    expect(content.endsWith("\r\n")).toBe(true);
  });

  it("F811-U-02: SKR04-Konten und Gutschrift auf Haben-Seite", () => {
    const content = buildDatevBatchCsv(batch({
      skr: "04",
      bookings: [booking({ kind: "credit_note", number: "CRN-1", grossCents: 11900, netCents: 10000, taxCents: 1900, lines: [{ taxRateBps: 1900, netCents: 10000, taxCents: 1900, grossCents: 11900 }] })],
    }));
    expect(content.split("\r\n")[2]).toContain("119,00;H;1200;4400;;15112026;CRN-1;");
    expect(datevBatchFileName("2026-11", "04")).toBe("datev-buchungsstapel-2026-11-skr04.csv");
    expect(datevBatchFileName("2026-11", "03")).toBe("datev-buchungsstapel-2026-11-skr03.csv");
  });

  it("F811-U-03: Escaping (Trennzeichen, Quotes, Formel-Guard)", () => {
    const content = buildDatevBatchCsv(batch({
      bookings: [booking({ contactName: 'A"B;C & Sohn', number: "=RE-1" })],
    }));
    const row = content.split("\r\n")[2];
    // Zell-Guard greift nur bei führendem Formelzeichen; mitten im Text
    // genügen Quoting/Verdopplung.
    expect(row).toContain('"Rechnung =RE-1 - A""B;C & Sohn"');
  });

  it("F811-U-04: Reject-Pfade nennen den Beleg (0-%, Summen, Währung, Monat, SKR)", () => {
    expect(() => buildDatevBatchCsv(batch({
      bookings: [booking({ lines: [{ taxRateBps: 0, netCents: 100, taxCents: 0, grossCents: 100 }], netCents: 100, taxCents: 0, grossCents: 100 })],
    }))).toThrowError(DatevExportError);
    expect(() => buildDatevBatchCsv(batch({
      bookings: [booking({ grossCents: 1130501 })],
    }))).toThrowError(/RE-2026-000001/u);
    expect(() => buildDatevBatchCsv(batch({
      bookings: [booking({ currency: "USD" })],
    }))).toThrowError(DatevExportError);
    expect(() => buildDatevBatchCsv(batch({ month: "11-2026" }))).toThrowError(DatevExportError);
    expect(() => buildDatevBatchCsv(batch({ skr: "05" as "03" }))).toThrowError(DatevExportError);
  });

  it("F811-U-05: leerer Monat ist gültig und deterministisch", () => {
    const first = buildDatevBatchCsv(batch({ bookings: [] }));
    const second = buildDatevBatchCsv(batch({ bookings: [] }));
    expect(first).toBe(second);
    expect(first.split("\r\n")).toHaveLength(3);
    expect(buildDatevBatchCsv(batch())).toBe(buildDatevBatchCsv(batch()));
  });
});
