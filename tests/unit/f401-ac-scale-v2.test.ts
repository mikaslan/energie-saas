import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { scaleRoofAnnualToReference } from "@/lib/integrations/calculation/ac-scale-v2";
import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import { F401ProviderError } from "@/lib/integrations/calculation/provider-v2";

// F4.1 v2-AC-Skalierung: Wetterjahr -> E_y-Referenz mit 0.01-Gate.
// Der Berlin-Fall nutzt das echte geneigte Fixture + E_y=1006.46 aus dem
// verifizierten PVcalc-Abruf.

function berlinTiltedP(): number[] {
  const fixture = JSON.parse(readFileSync(
    path.resolve(
      process.cwd(),
      "tests/fixtures/f401/pvgis-tilted30-south-2020-berlin.json",
    ),
    "utf8",
  )) as { hours: Array<{ t: string; p: number }> };
  const byTime = new Map(fixture.hours.map((hour) => [hour.t, hour.p]));
  const slots = mapProviderYearToQuarterSlots(fixture.hours.map((hour) => hour.t));
  const seen = new Set<string>();
  const normalized: number[] = [];
  for (const slot of slots) {
    if (seen.has(slot.providerObservedAtUtc)) continue;
    seen.add(slot.providerObservedAtUtc);
    normalized.push(byTime.get(slot.providerObservedAtUtc)!);
  }
  return normalized;
}

describe("F4.1 v2 ac scale", () => {
  it("skaliert exakt und haelt das E_y-Gate", () => {
    const hourly = new Array<number>(8_760).fill(100);
    const { scaleFactor, pScaled } = scaleRoofAnnualToReference(hourly, 1006.46);
    expect(scaleFactor).toBeCloseTo(1006.46 / 876, 12);
    expect(pScaled).toHaveLength(8_760);
    expect(neumaierSum(pScaled) / 1000).toBeCloseTo(1006.46, 9);
  });

  it("skaliert Berlin geneigt 2020 (1041.3) auf E_y=1006.46", () => {
    const normalized = berlinTiltedP();
    expect(normalized).toHaveLength(8_760);
    const { scaleFactor, pScaled } = scaleRoofAnnualToReference(normalized, 1006.46);
    // Wetterjahr sonniger als langjaehrig; Größenordnung aus Live-Daten.
    expect(scaleFactor).toBeGreaterThan(0.9);
    expect(scaleFactor).toBeLessThan(1);
    expect(scaleFactor).toBeCloseTo(0.9665, 3);
    expect(neumaierSum(pScaled) / 1000).toBeCloseTo(1006.46, 2);
  });

  it("bricht fail-closed bei Laenge, Vorzeichen und Referenz ab", () => {
    const hourly = new Array<number>(8_760).fill(100);
    expect(() => scaleRoofAnnualToReference(hourly.slice(0, 8_759), 100)).toThrow(
      F401ProviderError,
    );
    const negative = [...hourly];
    negative[7] = -1;
    expect(() => scaleRoofAnnualToReference(negative, 100)).toThrow(F401ProviderError);
    expect(() => scaleRoofAnnualToReference(hourly, 0)).toThrow(F401ProviderError);
    expect(() => scaleRoofAnnualToReference(new Array<number>(8_760).fill(0), 100)).toThrow(
      F401ProviderError,
    );
  });
});
