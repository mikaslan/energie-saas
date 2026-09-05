import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyDiscountTemplate } from "@/modules/discounts";
import { DiscountTemplateValidationError } from "@/modules/discounts/errors";
import type { DiscountTemplateDto } from "@/lib/integrations/discounts/contract";

function fix(amountCents: number): Pick<DiscountTemplateDto, "kind" | "amountCents" | "percentBps" | "capCents"> {
  return { kind: "fix_cents", amountCents, percentBps: null, capCents: null };
}

function percent(
  percentBps: number,
  capCents: number | null = null,
): Pick<DiscountTemplateDto, "kind" | "amountCents" | "percentBps" | "capCents"> {
  return { kind: "percent_bps", amountCents: null, percentBps, capCents };
}

describe("F16.3 applyDiscountTemplate (rein, Cent-Arithmetik)", () => {
  it("Fix zieht ab, nie unter null", () => {
    expect(applyDiscountTemplate(10_000, fix(2_500))).toBe(7_500);
    expect(applyDiscountTemplate(1_000, fix(2_500))).toBe(0);
    expect(applyDiscountTemplate(0, fix(2_500))).toBe(0);
  });

  it("Prozent mit floor, Cap deckelt", () => {
    expect(applyDiscountTemplate(10_001, percent(1_000))).toBe(9_001);
    expect(applyDiscountTemplate(10_000, percent(5_000, 1_000))).toBe(9_000);
    expect(applyDiscountTemplate(10_000, percent(5_000))).toBe(5_000);
    expect(applyDiscountTemplate(10_000, percent(10_000))).toBe(0);
  });

  it("ungültige Eingaben werfen ValidationError", () => {
    expect(() => applyDiscountTemplate(-1, fix(100)))
      .toThrow(DiscountTemplateValidationError);
    expect(() => applyDiscountTemplate(1.5, fix(100)))
      .toThrow(DiscountTemplateValidationError);
    expect(() => applyDiscountTemplate(1_000, { ...fix(100), amountCents: null }))
      .toThrow(DiscountTemplateValidationError);
    expect(() => applyDiscountTemplate(1_000, percent(null as unknown as number)))
      .toThrow(DiscountTemplateValidationError);
    expect(() => applyDiscountTemplate(1_000, percent(12.5)))
      .toThrow(DiscountTemplateValidationError);
  });

  it("Prozent exakt jenseits 2^53 (Float-Zeuge: 999000175671·9769)", () => {
    // Exakt: Skonto 975923271612 → Rest 23076904059. Float rechnet
    // 975923271613 (ein Cent daneben, per Python-Gegenprobe belegt).
    expect(applyDiscountTemplate(999_000_175_671, percent(9_769))).toBe(23_076_904_059);
  });
});
