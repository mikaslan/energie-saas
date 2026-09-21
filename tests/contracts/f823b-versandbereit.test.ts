import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  commercialDocumentListCommandV1Schema,
  commercialDocumentV1Schema,
} from "@/lib/integrations/invoicing/contract";

// F8-23b (F823B-CT-01): versandbereit-Preset im Listen-Command.
describe("F823B-CT-01 versandbereit-Preset", () => {
  it("parst versandbereit=true", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: { versandbereit: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("versandbereit ist optional (undefined = aus)", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.filters?.versandbereit).toBeUndefined();
  });

  it("rejectet nicht-booleschen Wert", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: { versandbereit: "ja" },
    });
    expect(parsed.success).toBe(false);
  });
});

// F8-23b: Job-Flag im Dokumenten-DTO (Badge-Quelle).
describe("F823B-CT-02 hasSucceededInvoiceJob", () => {
  const validDocumentV1 = () => ({
    schemaVersion: "commercial-document.v1",
    id: "11111111-1111-4111-8111-111111111111",
    type: "invoice",
    status: "draft",
    name: "F823B-Vertrag",
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
    invoiceKind: null,
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

  it("parst mit hasSucceededInvoiceJob=true", () => {
    expect(commercialDocumentV1Schema.safeParse({
      ...validDocumentV1(), hasSucceededInvoiceJob: true,
    }).success).toBe(true);
  });

  it("defaultet hasSucceededInvoiceJob auf false (rueckwaertskompatibel)", () => {
    const parsed = commercialDocumentV1Schema.safeParse(validDocumentV1());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.hasSucceededInvoiceJob).toBe(false);
  });
});
