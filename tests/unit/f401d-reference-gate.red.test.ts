import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import { runPlanningCalculationV2 } from "@/lib/integrations/calculation/run-v2";
import * as versionsV2 from "@/lib/integrations/calculation/versions-v2";

// F4-01d Referenzvalidierungs-Gate `pvgis-reference-validation.v1`
// (Spec: docs/spec/F4-01d-pvgis-referenzvalidierung-gate.md).
//
// RED-Stand: Das Gate ist auf diesem Branch SPECIFIED, aber nicht
// implementiert. Jeder Test fordert einen Gate-Bestandteil ein und muss
// heute FEHLschlagen. Aktivierung erst nach Monats-Amendment +
// Punkt-Statistik + Live-Smoke + Review (siehe Spec).

const SITES = ["berlin", "madrid", "stockholm"] as const;
const TILTS = [0, 30, 60, 90] as const;
const ASPECTS = ["north", "east", "south", "west"] as const;

const NO_STORAGE = {
  capacityKwh: 0,
  socMinKwh: 0,
  socMaxKwh: 0,
  chargeKw: 0,
  dischargeKw: 0,
  etaCharge: 1,
  etaDischarge: 1,
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: "planning-calculation.v2",
    canonicalizationVersion: "planning-jcs.v1",
    branch: "new_installation",
    asOfDate: "2026-08-29",
    commissioningDate: "2026-08-29",
    bindings: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      siteId: "33333333-3333-4333-8333-333333333333",
      addressRevision: 1,
      pinConfirmedAddressRevision: 1,
      energyProfileId: "44444444-4444-4444-8444-444444444444",
      energyProfileRevision: 1,
      confirmedEnergyProfileRevision: 1,
      confirmedEnergyProfileAddressRevision: 1,
      projectRequirementId: "55555555-5555-4555-8555-555555555555",
      projectRequirementRevision: 1,
      sourceCalculatorSnapshotId: null,
    },
    site: { countryCode: "DE", latitude: 52.52, longitude: 13.41 },
    axis: { slots: 35_040, resolution: "quarter_hour" },
    storage: { ...NO_STORAGE },
    ...overrides,
  };
}

describe.skip("RED F4-01d: Gate SPECIFIED, nicht implementiert (5/5 ROT belegt) — Spec: docs/spec/F4-01d-pvgis-referenzvalidierung-gate.md", () => {
  it("tilted-Fixture-Matrix 4x4 je Site vorhanden (tilt x aspect x site)", () => {
    const dir = path.resolve(process.cwd(), "tests/fixtures/f401");
    const present = new Set(readdirSync(dir));
    const missing: string[] = [];
    for (const site of SITES) {
      for (const tilt of TILTS) {
        for (const aspect of ASPECTS) {
          const name = `pvgis-tilted${tilt}-${aspect}-2020-${site}.json`;
          if (!present.has(name)) missing.push(name);
        }
      }
    }
    // Heute nur tilted30-south je Site (3 von 48) — Matrix fehlt.
    expect(missing).toEqual([]);
  });

  it("Toleranzversion muneer-validation-tolerances.v1 ist in versions-v2 gepinnt", () => {
    expect(versionsV2).toHaveProperty(
      "CALCULATION_V2_MUNEER_TOLERANCES_VERSION",
      "muneer-validation-tolerances.v1",
    );
  });

  it("Gate-Version pvgis-reference-validation.v1 ist gepinnt (sonst Gate inaktiv)", () => {
    // Ohne Pin keine gueltige Gate-Aktivierung; validationStatus darf bis
    // dahin nicht f4_public_reference_validated tragen (siehe Spec).
    expect(versionsV2).toHaveProperty(
      "CALCULATION_V2_REFERENCE_VALIDATION_VERSION",
      "pvgis-reference-validation.v1",
    );
  });

  it("Punktgate-Statistik-API reference-validation-v2 existiert", () => {
    const modulePath = path.resolve(
      process.cwd(),
      "lib/integrations/calculation/reference-validation-v2.ts",
    );
    expect(existsSync(modulePath)).toBe(true);
  });

  it("run-v2 traegt validation-report-Provenienz des Gates", () => {
    const result = runPlanningCalculationV2({
      request: request(),
      pvKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(1),
      loadKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(0.5),
      providerEstimate: false,
    });
    const provenance = (
      result as unknown as { referenceValidation?: { version?: unknown } }
    ).referenceValidation;
    expect(provenance?.version).toBe("pvgis-reference-validation.v1");
  });
});
