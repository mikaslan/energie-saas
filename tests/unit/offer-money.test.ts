import { describe, expect, it } from "vitest";
import {
  calculateOfferPricing,
  type OfferPricingInput,
} from "@/lib/integrations/offers/money";

function line(overrides: Partial<OfferPricingInput["sections"][number]["lines"][number]> = {}) {
  return {
    lineDomainId: "11111111-1111-4111-8111-111111111111",
    position: 1,
    unit: "piece" as const,
    positionType: "required" as const,
    isHidden: false,
    quantityMilli: 1_000,
    salesUnitNetCents: 100,
    purchaseUnitNetCents: 50,
    lineDiscountBps: 0,
    taxRateBps: 1_900,
    ...overrides,
  };
}

function input(overrides: Partial<OfferPricingInput> = {}): OfferPricingInput {
  return {
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      position: 1,
      discountBps: 0,
      lines: [line()],
    }],
    ...overrides,
  };
}

describe("M2-01 offer money engine", () => {
  it("rundet Menge und Steuer kaufmaennisch half-up ohne Floatwahrheit", () => {
    const result = calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [line({
          unit: "meter",
          quantityMilli: 1_005,
          salesUnitNetCents: 100,
          purchaseUnitNetCents: 33,
          taxRateBps: 1_900,
        })],
      }],
    }));
    expect(result.lines[0]).toMatchObject({
      lineBaseNetCents: 101,
      finalSalesNetCents: 101,
      salesTaxCents: 19,
      salesGrossCents: 120,
      purchaseNetCents: 33,
    });
  });

  it("verteilt Rabattrest stabil nach Rest, Sektion, Position und Domain-ID", () => {
    const result = calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [
          line({ lineDomainId: "00000000-0000-4000-8000-000000000002", position: 2 }),
          line({ lineDomainId: "00000000-0000-4000-8000-000000000001", position: 1 }),
          line({ lineDomainId: "00000000-0000-4000-8000-000000000003", position: 3 }),
        ],
      }],
      globalDiscountBps: 5_000,
    }));
    expect(result.lines.map((value) => [value.position, value.finalSalesNetCents]))
      .toEqual([[2, 50], [1, 50], [3, 50]]);
    expect(result.totals.basisNetCents).toBe(150);

    const custom = calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [
          line({ lineDomainId: "00000000-0000-4000-8000-000000000002", position: 2 }),
          line({ lineDomainId: "00000000-0000-4000-8000-000000000001", position: 1 }),
          line({ lineDomainId: "00000000-0000-4000-8000-000000000003", position: 3 }),
        ],
      }],
      customDealNetCents: 100,
    }));
    expect(custom.lines.map((value) => [value.position, value.finalSalesNetCents]))
      .toEqual([[2, 33], [1, 34], [3, 33]]);
  });

  it("haelt Optionales getrennt und laesst Hidden die Mathematik nicht aendern", () => {
    const result = calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 1_000,
        lines: [
          line({ isHidden: true, salesUnitNetCents: 1_000 }),
          line({
            lineDomainId: "22222222-2222-4222-8222-222222222222",
            position: 2,
            positionType: "optional",
            salesUnitNetCents: 1_000,
          }),
        ],
      }],
      globalDiscountBps: 1_000,
      customDealNetCents: 800,
    }));
    expect(result.totals).toEqual({
      basisNetCents: 800,
      basisTaxCents: 152,
      basisGrossCents: 952,
      optionalNetCents: 900,
      optionalTaxCents: 171,
      optionalGrossCents: 1_071,
    });
  });

  it("berechnet gemischte Steuer erst nach finaler zeilenweiser Allokation", () => {
    const result = calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [
          line({ salesUnitNetCents: 101, taxRateBps: 1_900 }),
          line({
            lineDomainId: "22222222-2222-4222-8222-222222222222",
            position: 2,
            salesUnitNetCents: 101,
            taxRateBps: 0,
          }),
        ],
      }],
      customDealNetCents: 101,
    }));
    expect(result.lines.map((value) => value.finalSalesNetCents)).toEqual([51, 50]);
    expect(result.lines.map((value) => value.salesTaxCents)).toEqual([10, 0]);
    expect(result.totals).toMatchObject({
      basisNetCents: 101,
      basisTaxCents: 10,
      basisGrossCents: 111,
    });
  });

  it("deckt Custom Deal bei null und weist ungueltige Mengen sowie Overflow ab", () => {
    expect(calculateOfferPricing(input({ customDealNetCents: 0 })).totals.basisNetCents)
      .toBe(0);
    expect(() => calculateOfferPricing(input({ customDealNetCents: 101 }))).toThrow(TypeError);
    expect(() => calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [line({ quantityMilli: 1_001 })],
      }],
    }))).toThrow(TypeError);
    expect(() => calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [line({
          quantityMilli: 100_000_000,
          salesUnitNetCents: 9_000_000_000_000_000,
        })],
      }],
    }))).toThrow(TypeError);
  });

  it("spiegelt die DB-Grenzen und erzwingt eindeutige Positionen", () => {
    expect(() => calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 26,
        discountBps: 0,
        lines: [line()],
      }],
    }))).toThrow(TypeError);
    expect(() => calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [line({ position: 501 })],
      }],
    }))).toThrow(TypeError);
    expect(() => calculateOfferPricing(input({
      sections: [
        {
          sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 1,
          discountBps: 0,
          lines: [line()],
        },
        {
          sectionDomainId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          position: 1,
          discountBps: 0,
          lines: [line({ lineDomainId: "22222222-2222-4222-8222-222222222222" })],
        },
      ],
    }))).toThrow(TypeError);
    expect(() => calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [
          line(),
          line({
            lineDomainId: "22222222-2222-4222-8222-222222222222",
            position: 1,
          }),
        ],
      }],
    }))).toThrow(TypeError);
  });

  it("erhaelt in 128 deterministischen Faellen Allokation, Steuer und Totals", () => {
    let state = 0x51_7a_2c_91;
    const next = (maximum: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % maximum;
    };

    for (let sample = 0; sample < 128; sample += 1) {
      const lines = Array.from({ length: 1 + next(8) }, (_, index) => line({
        lineDomainId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        position: index + 1,
        unit: "meter",
        quantityMilli: 1 + next(50_000),
        salesUnitNetCents: next(500_000),
        purchaseUnitNetCents: next(250_000),
        lineDiscountBps: next(10_001),
        taxRateBps: next(2) === 0 ? 0 : 1_900,
        positionType: next(4) === 0 ? "optional" : "required",
      }));
      const globalDiscountBps = next(10_001);
      const sectionDiscountBps = next(10_001);
      const withoutTarget = calculateOfferPricing(input({
        globalDiscountBps,
        sections: [{
          sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 1,
          discountBps: sectionDiscountBps,
          lines,
        }],
      }));
      const requiredTotal = withoutTarget.lines
        .filter((entry) => entry.positionType !== "optional")
        .reduce((sum, entry) => sum + entry.finalSalesNetCents, 0);
      const customDealNetCents = requiredTotal === 0 ? 0 : next(requiredTotal + 1);
      const result = calculateOfferPricing(input({
        globalDiscountBps,
        customDealNetCents,
        sections: [{
          sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 1,
          discountBps: sectionDiscountBps,
          lines,
        }],
      }));

      const required = result.lines.filter((entry) => entry.positionType !== "optional");
      const optional = result.lines.filter((entry) => entry.positionType === "optional");
      expect(result.totals.basisNetCents).toBe(customDealNetCents);
      expect(result.totals.basisNetCents).toBe(
        required.reduce((sum, entry) => sum + entry.finalSalesNetCents, 0),
      );
      expect(result.totals.basisTaxCents).toBe(
        required.reduce((sum, entry) => sum + entry.salesTaxCents, 0),
      );
      expect(result.totals.optionalNetCents).toBe(
        optional.reduce((sum, entry) => sum + entry.finalSalesNetCents, 0),
      );
      for (const entry of result.lines) {
        expect(entry.salesGrossCents).toBe(entry.finalSalesNetCents + entry.salesTaxCents);
        expect(entry.finalSalesNetCents).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("F16.3 Slice D globaler Fix-Rabatt (rein)", () => {
  function threeLines() {
    return [
      line({ lineDomainId: "00000000-0000-4000-8000-000000000002", position: 2 }),
      line({ lineDomainId: "00000000-0000-4000-8000-000000000001", position: 1 }),
      line({ lineDomainId: "00000000-0000-4000-8000-000000000003", position: 3 }),
    ];
  }

  function fixInput(globalFixDiscountCents: number | null, extra: Partial<OfferPricingInput> = {}) {
    return input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: threeLines(),
      }],
      globalFixDiscountCents,
      ...extra,
    });
  }

  it("zieht Fix exakt ab und verteilt stabil (Largest-Remainder)", () => {
    // 3 x 100 = 300, Fix 100 -> 200, Anteile je 66.67 -> [67, 67, 66]
    // (Positions-/ID-Ordnung wie Prozent-Verteilung).
    const result = calculateOfferPricing(fixInput(100));
    expect(result.lines.map((value) => [value.position, value.finalSalesNetCents]))
      .toEqual([[2, 67], [1, 67], [3, 66]]);
    expect(result.totals.basisNetCents).toBe(200);
  });

  it("floort Über-Fix bei 0 und wirkt nach Prozent, vor Custom-Deal", () => {
    const floored = calculateOfferPricing(fixInput(10_000));
    expect(floored.totals.basisNetCents).toBe(0);
    expect(floored.lines.every((value) => value.finalSalesNetCents === 0)).toBe(true);

    // 300 -50% = 150, -Fix 50 = 100, Custom-Deal 80 gewinnt zuletzt.
    const combined = calculateOfferPricing(fixInput(50, {
      globalDiscountBps: 5_000,
      customDealNetCents: 80,
    }));
    expect(combined.totals.basisNetCents).toBe(80);
    const withoutDeal = calculateOfferPricing(fixInput(50, { globalDiscountBps: 5_000 }));
    expect(withoutDeal.totals.basisNetCents).toBe(100);
  });

  it("lässt Optionale unberührt und null wirkungslos", () => {
    const result = calculateOfferPricing(input({
      sections: [{
        sectionDomainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 1,
        discountBps: 0,
        lines: [
          line({ lineDomainId: "00000000-0000-4000-8000-000000000001", position: 1 }),
          line({
            lineDomainId: "00000000-0000-4000-8000-000000000002",
            position: 2,
            positionType: "optional",
          }),
        ],
      }],
      globalFixDiscountCents: 100,
    }));
    // Basis 100 - Fix 100 = 0; Optional bleibt 100.
    expect(result.totals.basisNetCents).toBe(0);
    expect(result.totals.optionalNetCents).toBe(100);

    const untouched = calculateOfferPricing(fixInput(null));
    expect(untouched.totals.basisNetCents).toBe(300);
  });
});
