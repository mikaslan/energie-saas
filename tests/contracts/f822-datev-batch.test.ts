import { describe, expect, it } from "vitest";

import {
  INVOICING_DATEV_BATCH_VERSION,
  INVOICING_DATEV_COMMAND_VERSION,
  invoicingDatevBatchV1Schema,
  invoicingDatevCommandV1Schema,
} from "@/lib/integrations/invoicing/contract";
import {
  buildDatevBatchCsv,
  buildDatevBatchDocuments,
  datevBatchFileName,
  type DatevBatchInput,
  type DatevBookingInput,
} from "@/lib/integrations/invoicing/datev-export";

function booking(overrides: Partial<DatevBookingInput> = {}): DatevBookingInput {
  return {
    kind: "invoice",
    number: "RE-2026-000020",
    issueDate: "2026-11-15",
    contactName: "Muster Kundin",
    currency: "EUR",
    lines: [
      { taxRateBps: 1900, taxTreatment: "standard_19", netCents: 100000, taxCents: 19000, grossCents: 119000 },
      { taxRateBps: 0, taxTreatment: "zero_12_3", netCents: 250000, taxCents: 0, grossCents: 250000 },
      { taxRateBps: 0, taxTreatment: "reverse_13b", netCents: 100000, taxCents: 0, grossCents: 100000 },
    ],
    netCents: 450000,
    taxCents: 19000,
    grossCents: 469000,
    ...overrides,
  };
}

function batch(overrides: Partial<DatevBatchInput> = {}): DatevBatchInput {
  return { month: "2026-11", skr: "03", bookings: [booking()], ...overrides };
}

describe("F822-CONTRACT: invoicing-datev-batch.v1 + documents[]", () => {
  it("F822-CT-05: documents[] traegt Belegnummer, Typ, Datum, Brutto, Behandlungsgruppen", () => {
    const documents = buildDatevBatchDocuments(batch());
    expect(documents).toHaveLength(1);
    expect(documents[0]).toStrictEqual({
      number: "RE-2026-000020",
      kind: "invoice",
      issueDate: "2026-11-15",
      grossCents: 469000,
      groups: [
        { taxTreatment: "standard_19", netCents: 100000, taxCents: 19000, grossCents: 119000, buKey: "", revenueAccount: "8400" },
        { taxTreatment: "zero_12_3", netCents: 250000, taxCents: 0, grossCents: 250000, buKey: "43", revenueAccount: "8340" },
        { taxTreatment: "reverse_13b", netCents: 100000, taxCents: 0, grossCents: 100000, buKey: "40", revenueAccount: "8338" },
      ],
    });

    const skr04 = buildDatevBatchDocuments(batch({ skr: "04" }));
    expect(skr04[0]?.groups.map((group) => group.revenueAccount)).toEqual(["4400", "4340", "4338"]);

    // Gruppensummen ergeben den Kopf (summengleich).
    for (const document of documents) {
      const gross = document.groups.reduce((sum, group) => sum + group.grossCents, 0);
      expect(gross).toBe(document.grossCents);
    }

    // JSON-rundreisestabil (DTO-Anforderung).
    expect(JSON.parse(JSON.stringify(documents))).toStrictEqual(documents);
  });

  it("F822-CT-05b: documents[] folgt der CSV-Zeilenordnung; leerer Monat liefert []", () => {
    const late = booking({ number: "RE-2026-000021", issueDate: "2026-11-20" });
    const early = booking({ number: "RE-2026-000019", issueDate: "2026-11-02" });
    const documents = buildDatevBatchDocuments(batch({ bookings: [late, early] }));
    expect(documents.map((document) => document.number)).toEqual(["RE-2026-000019", "RE-2026-000021"]);

    const content = buildDatevBatchCsv(batch({ bookings: [late, early] }));
    const rows = content.split("\r\n").slice(2, -1);
    const totalGroups = documents.reduce((sum, document) => sum + document.groups.length, 0);
    expect(rows).toHaveLength(totalGroups);
    // Jede Gruppe ist in genau einer CSV-Zeile wiederzufinden (BU/Konto/Brutto).
    for (const document of documents) {
      for (const group of document.groups) {
        const gross = `${String(Math.floor(group.grossCents / 100))},${String(group.grossCents % 100).padStart(2, "0")}`;
        const matches = rows.filter(
          (row) => row.includes(document.number) && row.includes(group.revenueAccount) && row.startsWith(`${gross};`),
        );
        expect(matches, `${document.number}/${group.taxTreatment}`).toHaveLength(1);
      }
    }

    expect(buildDatevBatchDocuments(batch({ bookings: [] }))).toStrictEqual([]);
  });

  it("F822-CT-05c: Batch-DTO bleibt abwaertskompatibel (Command/Batch-Versionen stabil)", () => {
    const command = invoicingDatevCommandV1Schema.parse({
      schemaVersion: INVOICING_DATEV_COMMAND_VERSION,
      month: "2026-11",
      skr: "03",
    });
    expect(command.month).toBe("2026-11");

    const content = buildDatevBatchCsv(batch());
    const documents = buildDatevBatchDocuments(batch());
    const parsed = invoicingDatevBatchV1Schema.safeParse({
      schemaVersion: INVOICING_DATEV_BATCH_VERSION,
      month: command.month,
      skr: command.skr,
      fileName: datevBatchFileName(command.month, command.skr),
      contentType: "text/csv; charset=utf-8",
      content,
      documents,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.documents).toHaveLength(1);
  });
});
