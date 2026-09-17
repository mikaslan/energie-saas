import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_VERSION,
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  commercialDocumentDetailV1Schema,
  commercialDocumentDraftInputV1Schema,
  commercialDocumentListCommandV1Schema,
  commercialDocumentV1Schema,
} from "@/lib/integrations/invoicing/contract";

const invoiceDraft = {
  type: "invoice",
  name: "F816-Vertrag",
  groupId: null,
  projectId: null,
  contactId: null,
  dueDate: "2026-11-30",
  skontoPercentBps: null,
  skontoDays: null,
  deliveryDate: null,
  validityDate: null,
  plannedDeliveryDate: null,
  plannedServiceDate: null,
  creditNoteType: null,
} as const;

describe("F816-CONTRACT-01: Teilrechnungstypen-Kennung (Zod)", () => {
  it("nimmt invoiceKind an Rechnungen an (alle vier Werte)", () => {
    for (const invoiceKind of ["anzahlung", "abschlag", "teilrechnung", "schlussrechnung"]) {
      const parsed = commercialDocumentDraftInputV1Schema.safeParse({ ...invoiceDraft, invoiceKind });
      expect(parsed.success, `invoiceKind=${invoiceKind}`).toBe(true);
    }
  });

  it("verweigert die Kennung an Nicht-Rechnungen per invoice-only-Refine", () => {
    const parsed = commercialDocumentDraftInputV1Schema.safeParse({
      ...invoiceDraft,
      type: "credit_note",
      dueDate: null,
      deliveryDate: "2026-11-20",
      creditNoteType: "minderleistung",
      invoiceKind: "anzahlung",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // Praezise RED-Signatur: custom-Refine auf Feld invoiceKind (kein
    // blossser strict-unknown-key — der waere code unrecognized_keys).
    expect(parsed.error.issues.some(
      (issue) => issue.code === "custom" && issue.path.includes("invoiceKind"),
    )).toBe(true);
  });

  it("verweigert freie Kennungswerte", () => {
    const parsed = commercialDocumentDraftInputV1Schema.safeParse({
      ...invoiceDraft,
      invoiceKind: "ratezahlung",
    });
    expect(parsed.success).toBe(false);
  });

  it("filtert die Liste nach Kennung (Scope nur Typ invoice)", () => {
    const ok = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: { invoiceKind: "anzahlung" },
    });
    expect(ok.success).toBe(true);

    const scoped = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "credit_note",
      filters: { invoiceKind: "anzahlung" },
    });
    expect(scoped.success).toBe(false);
  });

  const validDocumentV1 = () => ({
    schemaVersion: "commercial-document.v1",
    id: "11111111-1111-4111-8111-111111111111",
    type: "invoice",
    status: "draft",
    name: "F816-Vertrag",
    groupId: null,
    projectId: null,
    contactId: null,
    archivedAt: null,
    netCents: 0,
    taxCents: 0,
    grossCents: 0,
    paymentStatus: "unpaid",
    dueDate: "2026-11-30",
    skontoPercentBps: null,
    skontoDays: null,
    deliveryDate: null,
    validityDate: null,
    plannedDeliveryDate: null,
    plannedServiceDate: null,
    creditNoteType: null,
    invoiceKind: "schlussrechnung",
    number: null,
    numberYear: null,
    numberSequence: null,
    issuedAt: null,
    sentAt: null,
    voidedAt: null,
    voidReason: null,
    paidCents: 0,
    permissions: { canWrite: true },
  });

  it("liefert die Kennung im Detail-DTO (nullable)", () => {
    const parsed = commercialDocumentDetailV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_VERSION,
      document: validDocumentV1(),
      lines: [],
      linkedDeposits: [],
      remainingCents: 0,
      allocatedFinals: [],
      allocatedRestCents: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("verlangt den Kennungs-Key im Dokumenten-DTO (Pflicht, nullable)", () => {
    const { invoiceKind: _omitted, ...withoutKind } = validDocumentV1();
    expect(_omitted).toBe("schlussrechnung");
    expect(commercialDocumentV1Schema.safeParse(withoutKind).success).toBe(false);
    expect(commercialDocumentV1Schema.safeParse({
      ...withoutKind,
      invoiceKind: null,
    }).success).toBe(true);
  });

  it("versioniert das Kennungs-Kommando (documentId + nullable Kennung)", async () => {
    const mod = await import("@/lib/integrations/invoicing/contract") as unknown as Record<string, unknown>;
    expect(mod.COMMERCIAL_DOCUMENT_INVOICE_KIND_COMMAND_VERSION)
      .toBe("commercial-document-invoice-kind-command.v1");
    const schema = mod.commercialDocumentInvoiceKindCommandV1Schema as
      | { safeParse: (input: unknown) => { success: boolean } }
      | undefined;
    expect(typeof schema?.safeParse).toBe("function");
    const documentId = "22222222-2222-4222-8222-222222222222";
    expect(schema!.safeParse({
      schemaVersion: "commercial-document-invoice-kind-command.v1",
      documentId,
      invoiceKind: "teilrechnung",
    }).success).toBe(true);
    expect(schema!.safeParse({
      schemaVersion: "commercial-document-invoice-kind-command.v1",
      documentId,
      invoiceKind: null,
    }).success).toBe(true);
    expect(schema!.safeParse({
      schemaVersion: "commercial-document-invoice-kind-command.v1",
      documentId,
      invoiceKind: "ratezahlung",
    }).success).toBe(false);
    // Strict-Disziplin: unbekannte Keys abweisen.
    expect(schema!.safeParse({
      schemaVersion: "commercial-document-invoice-kind-command.v1",
      documentId,
      invoiceKind: "anzahlung",
      surprise: true,
    }).success).toBe(false);
  });

  it("erstellt Dokumente mit Kennung (Command-Huelle)", () => {
    const parsed = commercialDocumentDraftInputV1Schema.safeParse({
      ...invoiceDraft,
      invoiceKind: null,
    });
    expect(parsed.success).toBe(true);
    expect(COMMERCIAL_DOCUMENT_COMMAND_VERSION).toBe("commercial-document-command.v1");
  });
});
