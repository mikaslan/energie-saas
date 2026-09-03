import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_DOCUMENT_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  MAX_DOCUMENT_LINE_POSITION,
  MAX_DOCUMENT_MONEY_CENTS,
  MAX_DOCUMENT_QUANTITY_MILLI,
  commercialDocumentCommandV1Schema,
  commercialDocumentGroupCommandV1Schema,
  commercialDocumentLineCommandV1Schema,
  commercialDocumentTypes,
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
