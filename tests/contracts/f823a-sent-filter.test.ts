import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  commercialDocumentListCommandV1Schema,
} from "@/lib/integrations/invoicing/contract";

// F8-23a (F823A-CT-01): sent-Filter im Listen-Command.
describe("F823A-CT-01 sent-Filter", () => {
  it("parst sent=sent", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: { sent: "sent" },
    });
    expect(parsed.success).toBe(true);
  });

  it("parst sent=unsent", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: { sent: "unsent" },
    });
    expect(parsed.success).toBe(true);
  });

  it("defaultet sent auf all", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.filters?.sent).toBe("all");
  });

  it("rejectet unbekannten sent-Wert", () => {
    const parsed = commercialDocumentListCommandV1Schema.safeParse({
      schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
      type: "invoice",
      filters: { sent: "vielleicht" },
    });
    expect(parsed.success).toBe(false);
  });
});
