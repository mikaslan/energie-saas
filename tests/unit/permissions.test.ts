import { describe, it, expect } from "vitest";
import { can, ACTION_REQUIREMENTS, type Action } from "@/lib/permissions";
import type { Role } from "@/lib/db/schema";

const ctx = (role: Role, caps: Record<string, boolean> = {}, flags: Record<string, boolean> = { invoicing: true }) =>
  ({ role, capabilities: caps, featureFlags: flags });

describe("Rechte-Matrix: Action × Rolle × Capability", () => {
  it("viewer darf nie schreiben", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      if (ACTION_REQUIREMENTS[a].minRole !== "viewer") expect(can(ctx("viewer"), a), a).toBe(false);
    }
  });
  it("editor braucht die jeweilige Capability", () => {
    expect(can(ctx("editor"), "invoice.issue")).toBe(false);
    expect(can(ctx("editor", { invoicing: true }), "invoice.issue")).toBe(true);
    expect(can(ctx("editor"), "price.read_purchase")).toBe(false);
    expect(can(ctx("editor", { see_purchase_prices: true }), "price.read_purchase")).toBe(true);
  });
  it("admin impliziert alle Capabilities", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) expect(can(ctx("admin"), a), a).toBe(true);
  });
  it("deaktiviertes Workspace-Feature schlägt alles", () => {
    expect(can(ctx("admin", {}, { invoicing: false }), "invoice.issue")).toBe(false);
  });
  it("jede Action hat einen Eintrag (Vollständigkeit)", () => {
    for (const a of Object.keys(ACTION_REQUIREMENTS) as Action[]) {
      expect(ACTION_REQUIREMENTS[a].minRole).toBeDefined();
    }
  });
});
