import { describe, expect, it } from "vitest";

import {
  buildDatevBatchCsv,
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
      { taxRateBps: 1900, taxTreatment: "standard_19", netCents: 800000, taxCents: 152000, grossCents: 952000 },
      { taxRateBps: 1900, taxTreatment: "standard_19", netCents: 150000, taxCents: 28500, grossCents: 178500 },
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

function dataRows(content: string): string[] {
  return content.split("\r\n").slice(2, -1);
}

describe("F8-22 DATEV-Sonderfaelle", () => {
  it("F822-CT-01: zero_12_3 bucht mit ESTIMATE-BU/Konto je SKR, standard_19 unveraendert", () => {
    const zero = booking({
      number: "RE-2026-000012",
      lines: [{ taxRateBps: 0, taxTreatment: "zero_12_3", netCents: 500000, taxCents: 0, grossCents: 500000 }],
      netCents: 500000,
      taxCents: 0,
      grossCents: 500000,
    });
    const skr03 = dataRows(buildDatevBatchCsv(batch({ bookings: [zero] })));
    expect(skr03).toHaveLength(1);
    expect(skr03[0]).toContain("5000,00;S;1400;8340;43;15112026;RE-2026-000012;");

    const skr04 = dataRows(buildDatevBatchCsv(batch({ skr: "04", bookings: [zero] })));
    expect(skr04[0]).toContain("5000,00;S;1200;4340;43;15112026;RE-2026-000012;");

    // standard_19 unveraendert: Automatikkonto, BU leer (F8-11-kompatibel,
    // auch ohne explizite Behandlung ableitbar).
    const legacy = booking({
      lines: [{ taxRateBps: 1900, netCents: 10000, taxCents: 1900, grossCents: 11900 }],
      netCents: 10000,
      taxCents: 1900,
      grossCents: 11900,
    });
    const rows = dataRows(buildDatevBatchCsv(batch({ bookings: [legacy] })));
    expect(rows[0]).toContain("119,00;S;1400;8400;;15112026;RE-2026-000001;");
  });

  it("F822-CT-02: reverse_13b bucht mit ESTIMATE-BU/Konto + Steuerschuldnerschaft-Hinweis", () => {
    const reverse = booking({
      number: "RE-2026-000013",
      lines: [{ taxRateBps: 0, taxTreatment: "reverse_13b", netCents: 200000, taxCents: 0, grossCents: 200000 }],
      netCents: 200000,
      taxCents: 0,
      grossCents: 200000,
    });
    const skr03 = dataRows(buildDatevBatchCsv(batch({ bookings: [reverse] })));
    expect(skr03).toHaveLength(1);
    expect(skr03[0]).toContain("2000,00;S;1400;8338;40;15112026;RE-2026-000013;");
    expect(skr03[0]).toContain(" - §13b");
    expect(skr03[0]).toContain("Steuerschuldnerschaft des Leistungsempfaengers");

    const skr04 = dataRows(buildDatevBatchCsv(batch({ skr: "04", bookings: [reverse] })));
    expect(skr04[0]).toContain("2000,00;S;1200;4338;40;15112026;RE-2026-000013;");
    expect(skr04[0]).toContain(" - §13b");

    // 60-Zeichen-Kappung greift zuerst: Basistext bleibt F8-11-identisch.
    expect(skr03[0]).toContain("Rechnung RE-2026-000013 - Muster Kundin - §13b");

    // Gutschrift: Haben-Seite mit BU.
    const credit = booking({
      kind: "credit_note",
      number: "GU-2026-000002",
      lines: [{ taxRateBps: 0, taxTreatment: "reverse_13b", netCents: 50000, taxCents: 0, grossCents: 50000 }],
      netCents: 50000,
      taxCents: 0,
      grossCents: 50000,
    });
    const creditRows = dataRows(buildDatevBatchCsv(batch({ bookings: [credit] })));
    expect(creditRows[0]).toContain("500,00;H;1400;8338;40;");
  });

  it("F822-CT-03: Mischbeleg splittet je Gruppe, summengleich, deterministische Reihenfolge", () => {
    // Zeilen absichtlich in falscher Reihenfolge: Emission folgt der
    // Gruppenordnung standard_19, zero_12_3, reverse_13b.
    const mixed = booking({
      number: "RE-2026-000020",
      lines: [
        { taxRateBps: 0, taxTreatment: "reverse_13b", netCents: 100000, taxCents: 0, grossCents: 100000 },
        { taxRateBps: 0, taxTreatment: "zero_12_3", netCents: 200000, taxCents: 0, grossCents: 200000 },
        { taxRateBps: 1900, taxTreatment: "standard_19", netCents: 100000, taxCents: 19000, grossCents: 119000 },
        { taxRateBps: 0, taxTreatment: "zero_12_3", netCents: 50000, taxCents: 0, grossCents: 50000 },
      ],
      netCents: 450000,
      taxCents: 19000,
      grossCents: 469000,
    });
    const rows = dataRows(buildDatevBatchCsv(batch({ bookings: [mixed] })));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("1190,00;S;1400;8400;;15112026;RE-2026-000020;");
    expect(rows[1]).toContain("2500,00;S;1400;8340;43;15112026;RE-2026-000020;");
    expect(rows[2]).toContain("1000,00;S;1400;8338;40;15112026;RE-2026-000020;");
    // Bruto summengleich: 1190 + 2500 + 1000 = 4690,00.
    expect(rows[0]).not.toContain("§13b");
    expect(rows[2]).toContain("§13b");
    const twice = dataRows(buildDatevBatchCsv(batch({ bookings: [mixed] })));
    expect(twice).toEqual(rows);
  });

  it("F822-CT-03b: krumme Gruppen verweigern mit Belegnummer", () => {
    // 0-%-Zeile mit Steuerbetrag.
    expect(() => buildDatevBatchCsv(batch({
      bookings: [booking({
        lines: [{ taxRateBps: 0, taxTreatment: "zero_12_3", netCents: 100, taxCents: 19, grossCents: 119 }],
        netCents: 100,
        taxCents: 19,
        grossCents: 119,
      })],
    }))).toThrowError(/RE-2026-000001/u);
    // Zeilensumme krumm in 0-%-Gruppe.
    expect(() => buildDatevBatchCsv(batch({
      bookings: [booking({
        lines: [{ taxRateBps: 0, taxTreatment: "reverse_13b", netCents: 100, taxCents: 0, grossCents: 101 }],
        netCents: 100,
        taxCents: 0,
        grossCents: 101,
      })],
    }))).toThrowError(DatevExportError);
  });

  it("F822-CT-04: fehlende/inkonsistente Behandlung verweigert mit Belegnummer (kein Teil-Stapel)", () => {
    // 0 % ohne Behandlung: mehrdeutig.
    expect(() => buildDatevBatchCsv(batch({
      bookings: [booking({
        lines: [{ taxRateBps: 0, netCents: 100, taxCents: 0, grossCents: 100 }],
        netCents: 100,
        taxCents: 0,
        grossCents: 100,
      })],
    }))).toThrowError(/RE-2026-000001/u);
    // Inkonsistent: 19 % + zero, 0 % + standard.
    for (const lines of [
      [{ taxRateBps: 1900, taxTreatment: "zero_12_3" as const, netCents: 100, taxCents: 19, grossCents: 119 }],
      [{ taxRateBps: 0, taxTreatment: "standard_19" as const, netCents: 100, taxCents: 0, grossCents: 100 }],
      [{ taxRateBps: 700, taxTreatment: "standard_19" as const, netCents: 100, taxCents: 7, grossCents: 107 }],
      [{ taxRateBps: 0, taxTreatment: "zero_operator_confirmed" as unknown as "zero_12_3", netCents: 100, taxCents: 0, grossCents: 100 }],
    ]) {
      expect(() => buildDatevBatchCsv(batch({
        bookings: [booking({
          lines,
          netCents: 100,
          taxCents: lines[0]?.taxCents ?? 0,
          grossCents: lines[0]?.grossCents ?? 100,
        })],
      }))).toThrowError(DatevExportError);
    }
    // Fremdwaehrung + krummer Kopf nennen den Beleg; der ganze Stapel faellt
    // (kein Teil-Export): gueltiger Zweitbeleg rettet nichts.
    const good = booking({ number: "RE-2026-000099" });
    expect(() => buildDatevBatchCsv(batch({
      bookings: [good, booking({ currency: "USD" })],
    }))).toThrowError(/RE-2026-000001/u);
    expect(() => buildDatevBatchCsv(batch({
      bookings: [good, booking({ grossCents: 1130501 })],
    }))).toThrowError(/RE-2026-000001/u);
  });
});
