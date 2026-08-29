import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hashPlanningCalculationInput,
  hashPlanningCalculationResult,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResult,
  validatePlanningCalculationResultForRequest,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import {
  PlanningCalculationEngineError,
  calculatePlanningEstimate,
} from "@/lib/integrations/calculation/engine";
import { validatePlanningCalculationResultExactlyForRequest } from
  "@/lib/integrations/calculation/validate-result";
import {
  PlanningCalculationInputError,
  buildPlanningCalculationInput,
  type PlanningCalculationBuildClaim,
} from "@/lib/integrations/calculation/prepare";

function requestFixture(
  branch: "new" | "existing" = "new",
): PlanningCalculationRequestV1 {
  return JSON.parse(readFileSync(
    resolve(
      import.meta.dirname,
      `../../contracts/examples/planning-calculation.v1.${branch}.request.json`,
    ),
    "utf8",
  )) as PlanningCalculationRequestV1;
}

function concentrateGeneration(
  input: PlanningCalculationRequestV1,
  hour: number,
  annualYieldKwhPerKwp: number,
): void {
  const month = hour < 31 * 24 ? 0 : 11;
  input.yieldSnapshots.forEach((snapshot) => {
    snapshot.annual.annualYieldKwhPerKwp = annualYieldKwhPerKwp;
    snapshot.annual.monthlyYieldKwhPerKwp = Array.from(
      { length: 12 },
      (_, index) => index === month ? annualYieldKwhPerKwp : 0,
    );
    snapshot.hourly.hourlyPowerWPerKwp.fill(0);
    snapshot.hourly.hourlyPowerWPerKwp[hour] = 1_000;
  });
}

function setAnnualConsumption(
  input: PlanningCalculationRequestV1,
  householdKwh: number,
): void {
  input.energyProfile.consumption.householdKwhPerYear = {
    status: "known",
    value: householdKwh,
    source: "customer_metered",
  };
  input.energyProfile.consumption.evKmPerYear = {
    status: "known",
    value: 0,
    source: "customer_input",
  };
  input.effectiveConsumption.householdKwhPerYear = {
    resolution: "profile_value",
    value: householdKwh,
    profileField: "/consumption/householdKwhPerYear",
  };
  input.effectiveConsumption.evKmPerYear = {
    resolution: "profile_value",
    value: 0,
    profileField: "/consumption/evKmPerYear",
  };
}

function buildClaim(
  request: PlanningCalculationRequestV1 = requestFixture(),
): PlanningCalculationBuildClaim {
  return {
    workspaceId: request.bindings.workspaceId,
    projectId: request.bindings.projectId,
    siteId: request.bindings.siteId,
    startedAt: new Date("2026-08-29T22:30:00.000Z"),
    addressRevision: request.bindings.addressRevision,
    pinConfirmedAddressRevision: request.bindings.pinConfirmedAddressRevision,
    energyProfileId: request.bindings.energyProfileId,
    energyProfileRevision: request.bindings.energyProfileRevision,
    confirmedEnergyProfileRevision: request.bindings.confirmedEnergyProfileRevision,
    confirmedEnergyProfileAddressRevision:
      request.bindings.confirmedEnergyProfileAddressRevision,
    projectRequirementId: request.bindings.projectRequirementId,
    projectRequirementRevision: request.bindings.projectRequirementRevision,
    sourceCalculatorSnapshotId: request.bindings.sourceCalculatorSnapshotId as string,
    contractVersion: "planning-calculation.v1",
    defaultsVersion: "wmee-planning-defaults.v1",
    providerRequest: {
      latitude: request.site.latitude,
      longitude: request.site.longitude,
    },
    preparation: {
      profile: request.energyProfile,
      requirements: request.projectRequirements,
      sourceSnapshot: {
        schemaVersion: "wmee-solar-snapshot.v1",
        branch: request.branch,
        inputs: {
          assumptions: {
            systemLossPercent: null,
            storageRoundtripEfficiency: null,
            storageDepthOfDischarge: null,
            moduleDegradationPerYear: null,
            horizonYears: null,
            plannedCommissioningDate: null,
          },
        },
      },
    },
  };
}

describe("planning calculation input builder", () => {
  it("binds persisted claim revisions and resolves every unknown through pinned defaults", () => {
    const source = requestFixture();
    const prepared = buildPlanningCalculationInput({
      claim: buildClaim(source),
      providerSnapshot: source.yieldSnapshots,
    });

    expect(validatePlanningCalculationRequest(prepared.inputSnapshot).ok).toBe(true);
    expect(prepared.inputSnapshot.asOfDate).toBe("2026-08-29");
    expect(prepared.inputSnapshot.commissioningDate).toBe("2026-08-29");
    expect(prepared.inputSnapshot.bindings).toEqual(source.bindings);
    expect(prepared.inputSnapshot.effectiveConsumption.loadProfile).toEqual({
      resolution: "versioned_default",
      value: "wmee_household_hourly.v1",
      defaultKey: "loadProfile",
      defaultsVersion: "wmee-planning-defaults.v1",
    });
    expect(prepared.inputSnapshot.resolvedAssumptions).toMatchObject({
      systemLossPercent: {
        resolution: "versioned_default",
        value: 14,
        defaultKey: "systemLossPercent",
      },
      storageRoundtripEfficiency: {
        resolution: "versioned_default",
        value: 0.92,
        defaultKey: "storageRoundtripEfficiency",
      },
      storageDepthOfDischarge: {
        resolution: "versioned_default",
        value: 0.9,
        defaultKey: "storageDepthOfDischarge",
      },
      moduleDegradationPerYear: {
        resolution: "versioned_default",
        value: 0.005,
        defaultKey: "moduleDegradationPerYear",
      },
      horizonYears: {
        resolution: "versioned_default",
        value: 20,
        defaultKey: "horizonYears",
      },
      commissioningDate: {
        resolution: "versioned_default",
        value: "2026-08-29",
        defaultKey: "commissioningDate",
      },
    });
    expect(prepared.inputSha256).toBe(hashPlanningCalculationInput(prepared.inputSnapshot));
    expect(prepared.inputSha256).toBe(
      "0f73cbc15389d0e3a8354829e27f8d0135b277dcc653723bb08de9cac9fda9c0",
    );
    expect(prepared.providerSnapshot).toEqual(prepared.inputSnapshot.yieldSnapshots);
  });

  it("uses only validated calculator assumptions and an explicit as-of date", () => {
    const source = requestFixture();
    const claim = buildClaim(source);
    claim.preparation.sourceSnapshot.inputs.assumptions = {
      systemLossPercent: 12,
      storageRoundtripEfficiency: 0.94,
      storageDepthOfDischarge: 0.88,
      moduleDegradationPerYear: 0.006,
      horizonYears: 25,
      plannedCommissioningDate: "2027-04-01",
    };
    const prepared = buildPlanningCalculationInput({
      claim,
      providerSnapshot: source.yieldSnapshots,
      asOfDate: "2026-09-01",
    });

    expect(prepared.inputSnapshot.asOfDate).toBe("2026-09-01");
    expect(prepared.inputSnapshot.commissioningDate).toBe("2027-04-01");
    expect(Object.values(prepared.inputSnapshot.resolvedAssumptions)
      .every((assumption) => assumption.resolution === "rechner_input"))
      .toBe(true);
  });

  it("fails closed for incomplete job pins, unsupported source data and provider drift", () => {
    const source = requestFixture();
    const incomplete = buildClaim(source) as Record<string, unknown>;
    delete incomplete.energyProfileRevision;
    expect(() => buildPlanningCalculationInput({
      claim: incomplete as PlanningCalculationBuildClaim,
      providerSnapshot: source.yieldSnapshots,
    })).toThrow(PlanningCalculationInputError);

    const unsupported = buildClaim(source);
    unsupported.preparation.sourceSnapshot.schemaVersion = "wmee-solar-snapshot.v0" as never;
    expect(() => buildPlanningCalculationInput({
      claim: unsupported,
      providerSnapshot: source.yieldSnapshots,
    })).toThrow(PlanningCalculationInputError);

    const wrongRoof = structuredClone(source.yieldSnapshots);
    wrongRoof[0].roofId = "not-the-confirmed-roof";
    expect(() => buildPlanningCalculationInput({
      claim: buildClaim(source),
      providerSnapshot: wrongRoof,
    })).toThrow(PlanningCalculationInputError);
  });

  it("fails input preparation for unresolved storage and roof shading used by the engine", () => {
    const existing = requestFixture("existing");
    existing.energyProfile.existingAssets.storage = {
      status: "unknown",
      source: "not_collected",
    };
    expect(() => buildPlanningCalculationInput({
      claim: buildClaim(existing),
      providerSnapshot: existing.yieldSnapshots,
    })).toThrow(expect.objectContaining({
      paths: ["/energyProfile/existingAssets/storage/status"],
    }));

    const unknownShading = requestFixture();
    unknownShading.energyProfile.roofs[0].shading = {
      status: "unknown",
      value: null,
      source: "not_collected",
    };
    expect(() => buildPlanningCalculationInput({
      claim: buildClaim(unknownShading),
      providerSnapshot: unknownShading.yieldSnapshots,
    })).toThrow(expect.objectContaining({
      paths: ["/energyProfile/roofs/0/shading/status"],
    }));
  });
});

describe("clean-room planning estimate engine", () => {
  it("pins a deterministic validated new-installation vector", () => {
    const input = requestFixture();
    const first = calculatePlanningEstimate(input);
    const second = calculatePlanningEstimate(structuredClone(input));

    expect(first).toEqual(second);
    expect(validatePlanningCalculationResult(first).ok).toBe(true);
    expect(first.resultSha256).toBe(
      "8744da64dd3a5896fa66d4d88a21416ae75a9bbb68612c69649f9e48eee77304",
    );
    expect(first.calculation).toMatchObject({
      systemPeakPowerKwp: 10.4,
      plannedStorageCapacityKwh: 8,
      annual: {
        generationKwh: 11_008.295999,
        consumptionKwh: 6_600.000001,
        selfConsumptionKwh: 5_381.783278,
        storageLossKwh: 228.521739,
      },
    });
  });

  it("pins baseline, planned storage and delta for an existing installation", () => {
    const result = calculatePlanningEstimate(requestFixture("existing"));

    expect(validatePlanningCalculationResult(result).ok).toBe(true);
    expect(result.resultSha256).toBe(
      "b8b5ee1f3bcdf3dd09a495a5fda4a3720c355d53a7360c26d68d1f36086d5aea",
    );
    expect(result.branch).toBe("existing_installation");
    if (result.branch !== "existing_installation") throw new Error("wrong branch");
    expect(result.calculation).toMatchObject({
      existingSystemPeakPowerKwp: 7.4,
      existingStorageCapacityKwh: 0,
      addedStorageCapacityKwh: 8,
      baseline: { annual: { fromStorageKwh: 0, storageFullCycles: 0 } },
      planned: { annual: { fromStorageKwh: 2_628, storageFullCycles: 365 } },
      delta: { additionalSelfConsumptionKwh: 2_628 },
    });
  });

  it("keeps existing storage in the baseline and adds only the requested capacity", () => {
    const input = requestFixture("existing");
    input.energyProfile.existingAssets.storage = {
      status: "known_present",
      source: "operator_reviewed",
      capacityKwh: 4,
    };
    const result = calculatePlanningEstimate(input);
    if (result.branch !== "existing_installation") throw new Error("wrong branch");

    expect(result.calculation.existingStorageCapacityKwh).toBe(4);
    expect(result.calculation.addedStorageCapacityKwh).toBe(8);
    expect(result.calculation.baseline.annual.fromStorageKwh).toBeGreaterThan(0);
    expect(result.calculation.planned.annual.selfConsumptionKwh)
      .toBeGreaterThanOrEqual(result.calculation.baseline.annual.selfConsumptionKwh);
    expect(validatePlanningCalculationResult(result).ok).toBe(true);
  });

  it("does not reinterpret unknown existing storage or shading as engine defaults", () => {
    const existing = requestFixture("existing");
    existing.energyProfile.existingAssets.storage = {
      status: "unknown",
      source: "not_collected",
    };
    expect(() => calculatePlanningEstimate(existing)).toThrow(PlanningCalculationEngineError);

    const unknownShading = requestFixture();
    unknownShading.energyProfile.roofs[0].shading = {
      status: "unknown",
      value: null,
      source: "not_collected",
    };
    expect(() => calculatePlanningEstimate(unknownShading))
      .toThrow(PlanningCalculationEngineError);

    const knownAbsent = requestFixture("existing");
    knownAbsent.energyProfile.existingAssets.storage = {
      status: "known_absent",
      source: "rechner_input",
    };
    const result = calculatePlanningEstimate(knownAbsent);
    if (result.branch !== "existing_installation") throw new Error("wrong branch");
    expect(result.calculation.existingStorageCapacityKwh).toBe(0);
  });

  it("carries battery energy from January into February without rejecting the month", () => {
    const input = requestFixture();
    const january31At23 = 31 * 24 - 1;
    concentrateGeneration(input, january31At23, 100);

    const result = calculatePlanningEstimate(input);
    if (result.branch !== "new_installation") throw new Error("wrong branch");

    const january = result.calculation.monthly[0];
    const february = result.calculation.monthly[1];
    expect(january.generationKwh).toBeGreaterThan(0);
    expect(february.generationKwh).toBe(0);
    expect(february.selfConsumptionKwh).toBeGreaterThan(0);
    expect(february.selfConsumptionKwh + february.feedInKwh)
      .toBeGreaterThan(february.generationKwh);
    expect(validatePlanningCalculationResult(result).ok).toBe(true);
  });

  it("uses a cyclic year boundary and reports only real storage conversion loss", () => {
    const input = requestFixture();
    const finalHour = 8_760 - 1;
    setAnnualConsumption(input, 4);
    concentrateGeneration(input, finalHour, 10);

    const result = calculatePlanningEstimate(input);
    if (result.branch !== "new_installation") throw new Error("wrong branch");
    const annual = result.calculation.annual;
    const efficiency = input.resolvedAssumptions.storageRoundtripEfficiency.value;

    expect(annual.fromStorageKwh).toBeGreaterThan(0);
    expect(annual.feedInKwh).toBeGreaterThan(0);
    expect(annual.storageLossKwh).toBeCloseTo(
      annual.fromStorageKwh * (1 / efficiency - 1),
      5,
    );
    expect(annual.generationKwh).toBeCloseTo(
      annual.selfConsumptionKwh + annual.feedInKwh + annual.storageLossKwh,
      5,
    );
    expect(validatePlanningCalculationResult(result).ok).toBe(true);
  });

  it("keeps a valid centi-kWh load non-negative at the annual rounding boundary", () => {
    const input = requestFixture();
    setAnnualConsumption(input, 0.01);
    input.projectRequirements.requestedProducts.targetStorageKwh = 40;
    input.effectiveStorageRequest.valueKwh = 40;
    concentrateGeneration(input, 8_759, 100);

    const result = calculatePlanningEstimate(input);
    if (result.branch !== "new_installation") throw new Error("wrong branch");

    expect(result.calculation.annual.directConsumptionKwh).toBeGreaterThanOrEqual(0);
    expect(result.calculation.annual.directConsumptionKwh).not.toBe(-0.000_001);
    expect(validatePlanningCalculationResult(result)).toEqual({
      ok: true,
      value: result,
    });
  });

  it("rejects coherently rehashed direct/storage reallocations at the exact boundary", () => {
    const input = requestFixture();
    const tampered = structuredClone(calculatePlanningEstimate(input));
    if (tampered.branch !== "new_installation") throw new Error("wrong branch");
    const annual = tampered.calculation.annual;
    const oldFeedIn = annual.feedInKwh;
    annual.fromStorageKwh += 1;
    annual.directConsumptionKwh -= 1;
    annual.storageLossKwh = annual.fromStorageKwh
      * (1 / input.resolvedAssumptions.storageRoundtripEfficiency.value - 1);
    annual.storageFullCycles = annual.fromStorageKwh
      / (
        tampered.calculation.plannedStorageCapacityKwh
        * input.resolvedAssumptions.storageDepthOfDischarge.value
      );
    annual.feedInKwh = annual.generationKwh
      - annual.selfConsumptionKwh
      - annual.storageLossKwh;
    tampered.calculation.monthly[0].feedInKwh += annual.feedInKwh - oldFeedIn;
    tampered.resultSha256 = hashPlanningCalculationResult(tampered);

    // Die leichte Prüfung ist ein schneller Semantikfilter. Persistenz und
    // Lesen müssen zusätzlich gegen den exakten Modelllauf vergleichen.
    expect(validatePlanningCalculationResultForRequest(input, tampered).ok).toBe(true);
    const exact = validatePlanningCalculationResultExactlyForRequest(input, tampered);
    expect(exact.ok).toBe(false);
    if (!exact.ok) {
      expect(exact.paths).toEqual(expect.arrayContaining([
        "/calculation/annual/directConsumptionKwh",
        "/calculation/annual/fromStorageKwh",
      ]));
    }
  });

  it("discloses requested bidirectional and backup features without inventing physics", () => {
    const input = requestFixture();
    const energyWithoutRequestedFeatures = calculatePlanningEstimate(input).calculation;
    input.projectRequirements.requestedProducts.bidirectionalCharging = true;
    input.projectRequirements.requestedProducts.backupPower = true;

    const result = calculatePlanningEstimate(input);
    if (result.branch !== "new_installation") throw new Error("wrong branch");

    expect(result.warnings).toEqual(expect.arrayContaining([
      { code: "bidirectional_charging_not_modeled", severity: "warning" },
      { code: "backup_power_not_modeled", severity: "warning" },
    ]));
    expect(result.calculation).toEqual(energyWithoutRequestedFeatures);
    expect(result.calculation.annual.fromVehicleKwh).toBe(0);
    expect(validatePlanningCalculationResult(result).ok).toBe(true);
  });

  it("is independent of fetched-at metadata and roof/provider array order", () => {
    const source = requestFixture();
    const reordered = structuredClone(source);
    reordered.energyProfile.roofs.reverse();
    reordered.yieldSnapshots.reverse();
    reordered.yieldSnapshots.forEach((snapshot) => {
      snapshot.annual.fetchedAt = "2026-08-30T10:00:00.000Z";
      snapshot.hourly.fetchedAt = "2026-08-30T10:00:01.000Z";
    });

    expect(hashPlanningCalculationInput(reordered)).toBe(hashPlanningCalculationInput(source));
    expect(calculatePlanningEstimate(reordered)).toEqual(calculatePlanningEstimate(source));
  });

  it("rejects invalid inputs without embedding input values in the error", () => {
    const invalid = structuredClone(requestFixture());
    invalid.bindings.energyProfileRevision += 1;
    expect(() => calculatePlanningEstimate(invalid)).toThrowError(
      new PlanningCalculationEngineError(),
    );
  });
});
