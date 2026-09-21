import { describe, expect, it } from "vitest";
import { documentStatusBadge } from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/status-badge";

// F8-23d (F823D-UI-01): Kopf-Badge-Mapping.
describe("F823D-UI-01 Status-Badge-Mapping", () => {
  it("draft ohne sentAt → Entwurf", () => {
    expect(documentStatusBadge("draft", null)).toEqual({ label: "Entwurf", tone: "slate" });
  });

  it("issued ohne sentAt → Ausgestellt", () => {
    expect(documentStatusBadge("issued", null)).toEqual({ label: "Ausgestellt", tone: "blue" });
  });

  it("issued mit sentAt → Versendet", () => {
    expect(documentStatusBadge("issued", "2026-09-15T10:00:00.000Z")).toEqual({
      label: "Versendet",
      tone: "emerald",
    });
  });

  it("voided → Storniert (unabhaengig von sentAt)", () => {
    expect(documentStatusBadge("voided", "2026-09-15T10:00:00.000Z")).toEqual({
      label: "Storniert",
      tone: "zinc",
    });
  });
});
