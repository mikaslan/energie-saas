import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import { buildLoadSourcesFromProfileV2 } from "@/lib/integrations/calculation/fetch-compose-v2";

// F4-02e FR-Linky-Pull (Spec docs/spec/F4-02e-frankreich-linky.md).
// RED-Test: Der Linky-Slice ist SPECIFIED, nicht gebaut — Compose kennt
// heute weder `linky_pull.v1` noch ein Consent-Gate (DE-only-Guard
// fetch-compose-v2.ts:347-356 weist alles Fremde fail-closed ab).
// Nur existierende Imports (f402d-Muster).

const known = (value: unknown) => ({
  status: "known",
  value,
  source: "operator_reviewed",
});

const unknown = () => ({
  status: "unknown",
  value: null,
  source: "not_collected",
});

function grantedConsent(): Record<string, unknown> {
  return {
    granted: true,
    grantedAt: "2026-09-01T10:00:00+02:00",
    source: "enedis_data_connect",
    policyVersion: "2026-1",
    authorizationReference: "TEST-AUTH-0001",
  };
}

function linkyConsumption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdKwhPerYear: unknown(),
    loadProfile: known("linky_pull.v1"),
    linkyHalfHourKwh: known(new Array(17_520).fill(0.25)),
    linkyConsent: known(grantedConsent()),
    ...overrides,
  };
}

function horizontalTimes(): string[] {
  const envelope = JSON.parse(readFileSync(
    path.resolve(
      process.cwd(),
      "tests/fixtures/f401/pvgis-horizontal-2020-berlin-52-52-13-41.json",
    ),
    "utf8",
  )) as { hours: Array<{ t: string; t2m: number }> };
  return envelope.hours.map((hour) => hour.t);
}

function loadContext(): {
  slotLabels: string[];
  hourlyTemperatureC: Map<string, number>;
  hourTimesInOrder: string[];
} {
  const slots = mapProviderYearToQuarterSlots(horizontalTimes());
  const seen = new Set<string>();
  const hourTimesInOrder: string[] = [];
  for (const slot of slots) {
    if (seen.has(slot.providerObservedAtUtc)) continue;
    seen.add(slot.providerObservedAtUtc);
    hourTimesInOrder.push(slot.providerObservedAtUtc);
  }
  return {
    slotLabels: slots.map((slot) => slot.slotLabel),
    hourlyTemperatureC: new Map(hourTimesInOrder.map((time) => [time, 10])),
    hourTimesInOrder,
  };
}

// SKIP-Grund: RED-Test zur Spec F4-02e (docs/spec/F4-02e-frankreich-linky.md,
// Abschnitt 6). Der Linky-Slice ist SPECIFIED, nicht gebaut: Compose kennt
// weder `linky_pull.v1` noch das Consent-Gate (ROT-Beleg: 3 failed |
// 3 passed am 2026-09-20). Entskippen, sobald der Bau-Slice Pull + Gate
// implementiert.
describe.skip("F4-02e Linky-Pull (Consent-Pflicht)", () => {
  it("nimmt den Linky-Pull mit explizitem Consent an", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      { consumption: linkyConsumption() },
      loadContext(),
    )).not.toThrow();
  });

  it("mappt 17.520 Halbstundenwerte auf 35.040 Viertel-Slots", () => {
    const sources = buildLoadSourcesFromProfileV2(
      { consumption: linkyConsumption() },
      loadContext(),
    );
    const basis = sources[0]!;
    expect(basis.slotEnergyKwh).toHaveLength(35_040);
    const sum = basis.slotEnergyKwh.reduce((total, kwh) => total + kwh, 0);
    expect(sum).toBeCloseTo(17_520 * 0.25, 6);
  });

  it("verweigert die stille Linky-Reihe ohne Pull-Option (stiller-Import-Verbot)", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      {
        consumption: {
          householdKwhPerYear: known(3500),
          linkyHalfHourKwh: known(new Array(17_520).fill(0.25)),
          linkyConsent: known(grantedConsent()),
        },
      },
      loadContext(),
    )).toThrow();
  });
});

describe.skip("F4-02e Linky-Pull (Guards, fail-closed)", () => {
  it("verweigert den Linky-Pull ohne Consent fail-closed", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      {
        consumption: linkyConsumption({
          linkyConsent: known({ ...grantedConsent(), granted: false }),
        }),
      },
      loadContext(),
    )).toThrow();
  });

  it("verweigert Default-Consent (granted ohne Nachweis)", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      {
        consumption: linkyConsumption({
          linkyConsent: known({
            granted: true,
            grantedAt: null,
            source: null,
            policyVersion: null,
            authorizationReference: null,
          }),
        }),
      },
      loadContext(),
    )).toThrow();
  });

  it("weist das Linky-Profil ohne Consent-Shape ab (Guard)", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      {
        consumption: {
          householdKwhPerYear: unknown(),
          loadProfile: known("linky_pull.v1"),
        },
      },
      loadContext(),
    )).toThrow();
  });
});
