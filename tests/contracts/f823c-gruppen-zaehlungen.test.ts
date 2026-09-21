import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_DOCUMENT_GROUP_VERSION,
  commercialDocumentGroupV1Schema,
} from "@/lib/integrations/invoicing/contract";

// F8-23c (F823C-CT-01): Status-Counts im Gruppen-DTO.
describe("F823C-CT-01 Gruppen-Status-Counts", () => {
  const validGroupV1 = () => ({
    schemaVersion: COMMERCIAL_DOCUMENT_GROUP_VERSION,
    id: "22222222-2222-4222-8222-222222222222",
    name: "F823C-Gruppe",
    projectId: null,
    archivedAt: null,
    documentCount: 4,
    permissions: { canWrite: true },
  });

  it("parst mit allen 4 Counts", () => {
    expect(commercialDocumentGroupV1Schema.safeParse({
      ...validGroupV1(),
      draftCount: 1,
      issuedCount: 2,
      sentCount: 1,
      voidedCount: 0,
    }).success).toBe(true);
  });

  it("verlangt die Count-Felder (Pflicht)", () => {
    expect(commercialDocumentGroupV1Schema.safeParse(validGroupV1()).success).toBe(false);
  });

  it("rejectet negative Counts", () => {
    expect(commercialDocumentGroupV1Schema.safeParse({
      ...validGroupV1(),
      draftCount: -1,
      issuedCount: 0,
      sentCount: 0,
      voidedCount: 0,
    }).success).toBe(false);
  });
});
