import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applySubsidyTemplate } from "@/modules/subsidies";
import { SubsidyTemplateValidationError } from "@/modules/subsidies/errors";
import type { SubsidyTemplateDto } from "@/lib/integrations/subsidies/contract";

function fix(amountCents: number): Pick<SubsidyTemplateDto, "kind" | "amountCents" | "percentBps" | "capCents"> {
  return { kind: "fix_cents", amountCents, percentBps: null, capCents: null };
}

function percent(
  percentBps: number,
  capCents: number | null = null,
): Pick<SubsidyTemplateDto, "kind" | "amountCents" | "percentBps" | "capCents"> {
  return { kind: "percent_bps", amountCents: null, percentBps, capCents };
}

describe("F16.3 applySubsidyTemplate (rein, Cent-Arithmetik)", () => {
  it("Fix zieht ab, nie unter null", () => {
    expect(applySubsidyTemplate(10_000, fix(2_500))).toBe(7_500);
    expect(applySubsidyTemplate(1_000, fix(2_500))).toBe(0);
    expect(applySubsidyTemplate(0, fix(2_500))).toBe(0);
  });

  it("Prozent mit floor, Cap deckelt", () => {
    expect(applySubsidyTemplate(10_001, percent(1_000))).toBe(9_001);
    expect(applySubsidyTemplate(10_000, percent(5_000, 1_000))).toBe(9_000);
    expect(applySubsidyTemplate(10_000, percent(5_000))).toBe(5_000);
    expect(applySubsidyTemplate(10_000, percent(10_000))).toBe(0);
  });

  it("ungültige Eingaben werfen ValidationError", () => {
    expect(() => applySubsidyTemplate(-1, fix(100)))
      .toThrow(SubsidyTemplateValidationError);
    expect(() => applySubsidyTemplate(1.5, fix(100)))
      .toThrow(SubsidyTemplateValidationError);
    expect(() => applySubsidyTemplate(1_000, { ...fix(100), amountCents: null }))
      .toThrow(SubsidyTemplateValidationError);
    expect(() => applySubsidyTemplate(1_000, percent(null as unknown as number)))
      .toThrow(SubsidyTemplateValidationError);
    expect(() => applySubsidyTemplate(1_000, percent(12.5)))
      .toThrow(SubsidyTemplateValidationError);
  });

  it("Prozent exakt jenseits 2^53 (Float-Zeuge: 999000175671·9769)", () => {
    expect(applySubsidyTemplate(999_000_175_671, percent(9_769))).toBe(23_076_904_059);
  });
});
