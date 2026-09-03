import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  DOCUMENT_LIST_MAX_LIMIT,
  INVOICING_REPORT_COMMAND_VERSION,
  INVOICING_REPORT_CSV_VERSION,
  INVOICING_REPORT_VERSION,
  MAX_DOCUMENT_LINE_POSITION,
  MAX_DOCUMENT_MONEY_CENTS,
  MAX_DOCUMENT_QUANTITY_MILLI,
  commercialDocumentCommandV1Schema,
  commercialDocumentGroupCommandV1Schema,
  commercialDocumentLineCommandV1Schema,
  commercialDocumentListCommandV1Schema,
  commercialDocumentTypes,
  invoicingReportCommandV1Schema,
  invoicingReportCsvV1Schema,
  invoicingReportV1Schema,
} from "@/lib/integrations/invoicing/contract";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

describe("M3-01 commercial document command contracts", () => {
  it("Gruppen-Befehl: Name 1..120, leer/überlang abgelehnt", () => {
    const base = {
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
      name: "Rechnungen 2026",
    };
    expect(commercialDocumentGroupCommandV1Schema.safeParse(base).success).toBe(true);
    expect(commercialDocumentGroupCommandV1Schema.safeParse({
      ...base, name: "   ",
    }).success).toBe(false);
    expect(commercialDocumentGroupCommandV1Schema.safeParse({
      ...base, name: "x".repeat(121),
    }).success).toBe(false);
    expect(commercialDocumentGroupCommandV1Schema.safeParse({
      ...base, schemaVersion: "fremd.v1",
    }).success).toBe(false);
  });

  it("Dokument-Befehl akzeptiert genau die 6 Typen", () => {
    const draft = {
      schemaVersion: COMMERCIAL_DOCUMENT_COMMAND_VERSION,
      input: {
        type: "invoice",
        name: "Entwurf",
        groupId: null,
        projectId: null,
        contactId: null,
        dueDate: "2026-12-31",
        deliveryDate: null,
        validityDate: null,
        plannedDeliveryDate: null,
        plannedServiceDate: null,
        creditNoteType: null,
      },
    };
    expect(commercialDocumentTypes).toEqual([
      "invoice", "credit_note", "order_confirmation", "purchase_order",
      "delivery_note", "letter",
    ]);
    expect(commercialDocumentCommandV1Schema.safeParse(draft).success).toBe(true);
    expect(commercialDocumentCommandV1Schema.safeParse({
      ...draft, input: { ...draft.input, type: "quote" },
    }).success).toBe(false);
    expect(commercialDocumentCommandV1Schema.safeParse({
      ...draft, input: { ...draft.input, name: " " },
    }).success).toBe(false);
  });

  it("Zeilen-Befehl: Positions-/Mengen-/Geldgrenzen", () => {
    const line = {
      schemaVersion: COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
      documentId: WORKSPACE,
      input: {
        position: 1,
        name: "Position",
        quantityMilli: 1000,
        unit: "piece",
        netCents: 100,
        taxRateBps: 1900,
      },
    };
    expect(commercialDocumentLineCommandV1Schema.safeParse(line).success).toBe(true);
    expect(commercialDocumentLineCommandV1Schema.safeParse({
      ...line, input: { ...line.input, position: 0 },
    }).success).toBe(false);
    expect(commercialDocumentLineCommandV1Schema.safeParse({
      ...line, input: { ...line.input, position: MAX_DOCUMENT_LINE_POSITION + 1 },
    }).success).toBe(false);
    expect(commercialDocumentLineCommandV1Schema.safeParse({
      ...line, input: { ...line.input, quantityMilli: MAX_DOCUMENT_QUANTITY_MILLI + 1 },
    }).success).toBe(false);
    expect(commercialDocumentLineCommandV1Schema.safeParse({
      ...line, input: { ...line.input, netCents: MAX_DOCUMENT_MONEY_CENTS + 1 },
    }).success).toBe(false);
    expect(commercialDocumentLineCommandV1Schema.safeParse({
      ...line, input: { ...line.input, unit: "hours" },
    }).success).toBe(false);
  });
});

describe("M3-01 A4 — Liste/Filter + Bericht (M301-06/M301-07)", () => {
  const listBase = {
    schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
    type: "invoice" as const,
  };

  it("M301-CON-01: Listen-Befehl minimal gültig; limit/cursor gebunden", () => {
    expect(commercialDocumentListCommandV1Schema.safeParse(listBase).success).toBe(true);
    expect(commercialDocumentListCommandV1Schema.safeParse({
      ...listBase, limit: 0,
    }).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse({
      ...listBase, limit: DOCUMENT_LIST_MAX_LIMIT + 1,
    }).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse({
      ...listBase, cursor: "",
    }).success).toBe(false);
  });

  it("M301-CON-01: typ-gebundene Filter werden abgelehnt", () => {
    const withFilters = (type: string, filters: Record<string, unknown>) => ({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type,
      filters,
    });
    expect(commercialDocumentListCommandV1Schema.safeParse(
      withFilters("letter", { paymentStatus: "unpaid" }),
    ).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(
      withFilters("invoice", { creditNoteType: "minderleistung" }),
    ).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(
      withFilters("order_confirmation", { typeDateFrom: "2026-01-01" }),
    ).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(
      withFilters("credit_note", { creditNoteType: "minderleistung", typeDateFrom: "2026-01-01" }),
    ).success).toBe(true);
    expect(commercialDocumentListCommandV1Schema.safeParse(
      withFilters("invoice", { paymentStatus: "paid", typeDateTo: "2026-12-31" }),
    ).success).toBe(true);
  });

  it("M301-CON-01: Datumsbereichslogik from <= to; Suche 1..160", () => {
    const withFilters = (filters: Record<string, unknown>) => ({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice" as const,
      filters,
    });
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      issuedFrom: "2026-02-01", issuedTo: "2026-01-01",
    })).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      typeDateFrom: "2026-02-01", typeDateTo: "2026-01-01",
    })).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      search: "a".repeat(161),
    })).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      search: "Solar",
    })).success).toBe(true);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      archived: "all",
    })).success).toBe(true);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      archived: "unbekannt",
    })).success).toBe(false);
  });

  it("M301-CON-01: nur echte Kalenderdaten (Kimi-P2-1)", () => {
    const withFilters = (filters: Record<string, unknown>) => ({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice" as const,
      filters,
    });
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      issuedFrom: "2026-02-30",
    })).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      issuedTo: "2026-13-01",
    })).success).toBe(false);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      issuedFrom: "2026-02-28",
    })).success).toBe(true);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      typeDateFrom: "2024-02-29",
    })).success).toBe(true);
    expect(commercialDocumentListCommandV1Schema.safeParse(withFilters({
      typeDateFrom: "2025-02-29",
    })).success).toBe(false);
  });

  it("M301-CON-02: Berichts-Monat streng YYYY-MM im Bereich 2000..2099", () => {
    const base = { schemaVersion: INVOICING_REPORT_COMMAND_VERSION };
    expect(invoicingReportCommandV1Schema.safeParse({ ...base, month: "2026-09" }).success).toBe(true);
    for (const bad of ["2026-13", "2026-9", "26-09", "1999-12", "2100-01", "2026/09", ""]) {
      expect(invoicingReportCommandV1Schema.safeParse({ ...base, month: bad }).success).toBe(false);
    }
  });

  it("M301-CON-02: Berichts-DTO validiert (KPI-Grenzen, Bucket-Felder, CSV)", () => {
    const report = {
      schemaVersion: INVOICING_REPORT_VERSION,
      month: "2026-09",
      monthStart: "2026-09-01",
      monthEnd: "2026-10-01",
      revenueThisMonthCents: 11900,
      cashflowThisMonthCents: 11900,
      outstandingCents: 0,
      overdueCents: 0,
      previousMonth: {
        month: "2026-08",
        revenueCents: 0,
        cashflowCents: 0,
        outstandingCents: null,
        overdueCents: null,
      },
      latestDocuments: [],
      revenueByStatus: {
        draftCents: 0, sentCents: 0, paidCents: 0, overdueCents: 0, voidedCents: 0,
        draftCount: 0, sentCount: 0, paidCount: 0, overdueCount: 0, voidedCount: 0,
      },
      overdueBuckets: {
        days0To30Cents: 0, days31To60Cents: 0, days61To90Cents: 0,
        over90Cents: 0, totalOutstandingCents: 0,
      },
      permissions: { canWrite: false },
    };
    expect(invoicingReportV1Schema.safeParse(report).success).toBe(true);
    expect(invoicingReportV1Schema.safeParse({
      ...report, revenueThisMonthCents: MAX_DOCUMENT_MONEY_CENTS + 1,
    }).success).toBe(false);
    // Kimi-P2-2: Vormonat von 2000-01 ist 1999-12 und bleibt parsebar.
    expect(invoicingReportV1Schema.safeParse({
      ...report, month: "2000-01",
      previousMonth: { ...report.previousMonth, month: "1999-12" },
    }).success).toBe(true);
    const csv = {
      schemaVersion: INVOICING_REPORT_CSV_VERSION,
      month: "2026-09",
      fileName: "invoicing-report-2026-09.csv",
      contentType: "text/csv; charset=utf-8",
      content: "Typ;Nummer\r\ninvoice;Rechnung-1\r\n",
    };
    expect(invoicingReportCsvV1Schema.safeParse(csv).success).toBe(true);
    expect(invoicingReportCsvV1Schema.safeParse({
      ...csv, contentType: "application/json",
    }).success).toBe(false);
  });
});
