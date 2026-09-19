import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class EnergyProfileConflictError extends Error {}
  class EnergyProfileInvalidError extends Error {}
  class EnergyProfileNotFoundError extends Error {}
  class EnergyProfileUnsupportedSourceError extends Error {}
  class EnergyProfileRoofAcknowledgementError extends Error {}
  class EnergyProfileRetryConflictError extends Error {}
  class EnergyProfileRateLimitError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
      super("project calculation reservation is rate limited");
    }
  }
  class EnergyProfilePrerequisitesError extends Error {
    constructor(public readonly reason: "address_pin" | "profile_confirmation") {
      super(reason);
    }
  }

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    EnergyProfileConflictError,
    EnergyProfileInvalidError,
    EnergyProfileNotFoundError,
    EnergyProfileUnsupportedSourceError,
    EnergyProfileRoofAcknowledgementError,
    EnergyProfileRetryConflictError,
    EnergyProfileRateLimitError,
    EnergyProfilePrerequisitesError,
    authorizedAction: vi.fn(),
    authorizedQuery: vi.fn(),
    getCandidate: vi.fn(),
    revalidatePath: vi.fn(),
    saveProfile: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/energy", () => ({
  EnergyProfileConflictError: deps.EnergyProfileConflictError,
  EnergyProfileInvalidError: deps.EnergyProfileInvalidError,
  EnergyProfileNotFoundError: deps.EnergyProfileNotFoundError,
  EnergyProfilePrerequisitesError: deps.EnergyProfilePrerequisitesError,
  EnergyProfileRateLimitError: deps.EnergyProfileRateLimitError,
  EnergyProfileRetryConflictError: deps.EnergyProfileRetryConflictError,
  EnergyProfileRoofAcknowledgementError: deps.EnergyProfileRoofAcknowledgementError,
  EnergyProfileUnsupportedSourceError: deps.EnergyProfileUnsupportedSourceError,
  getProjectEnergyProfileCandidate: deps.getCandidate,
  saveProjectEnergyProfile: deps.saveProfile,
}));

import { saveProjectEnergyProfileAction } from "@/app/w/[workspaceId]/anfragen/energy-actions";
import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import { buildLoadSourcesFromProfileV2 } from "@/lib/integrations/calculation/fetch-compose-v2";

// F4-02d Commercial-Gate + Laender-Slices (Spec
// docs/spec/F4-02d-commercial-gate-laender.md). RED-Test: Das Gate
// (scope=commercial) existiert noch nicht — Save und Compose nehmen heute
// jede CSV ohne Scope an. Nur existierende Imports (m107-/f402c-Muster).

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";

function candidate(scope: "residential" | "commercial") {
  return {
    projectId: PROJECT_ID,
    scope,
    addressRevision: 3,
    expectedLatestRevision: 0,
    profile: {
      roofs: [{ id: "default-roof-1", source: "default" }],
      building: {},
      consumption: {},
      existingAssets: {},
    },
  };
}

function validProfileForm(): FormData {
  const form = new FormData();
  const values: Record<string, string> = {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    expectedAddressRevision: "3",
    expectedLatestRevision: "0",
    roofCount: "1",
    buildingType: "",
    buildingYear: "",
    heatedAreaM2: "",
    householdKwhPerYear: "",
    electricityPriceCentsPerKwh: "36.5",
    annualPriceIncreasePercent: "",
    loadProfile: "",
    evKmPerYear: "",
    evChargingPattern: "",
    heatPumpKwhPerYear: "",
    heatPumpThermalKwhPerYear: "",
    heatPumpCopNominal: "",
    heatPumpBivalenceTempC: "",
    heatPumpHotWaterShare: "",
    investmentEuro: "",
    feedInTariffCtPerKwh: "",
    feedInCommissioningYear: "",
    groundAlbedo: "",
    alternativeImportPriceCtPerKwh: "",
    alternativeImportPriceEscalationPct: "",
    baseFeeEuroPerYear: "",
    alternativeBaseFeeEuroPerYear: "",
    demandChargeEuroPerKw: "",
    alternativeDemandChargeEuroPerKw: "",
    cmp0Name: "",
    cmp0Price: "",
    cmp0Escalation: "",
    cmp0BaseFee: "",
    cmp0Demand: "",
    cmp1Name: "",
    cmp1Price: "",
    cmp1Escalation: "",
    cmp1BaseFee: "",
    cmp1Demand: "",
    cmp2Name: "",
    cmp2Price: "",
    cmp2Escalation: "",
    cmp2BaseFee: "",
    cmp2Demand: "",
    touImportPricesCt: "",
    coolingKwhPerYear: "",
    heatingAcKwhPerYear: "",
    hotWaterKwhPerYear: "",
    pvStatus: "known_absent",
    pvPeakPowerKwp: "",
    pvCommissioningYear: "",
    storageStatus: "unknown",
    storageCapacityKwh: "",
    wallboxStatus: "unknown",
    evStatus: "unknown",
    "roof.0.id": "default-roof-1",
    "roof.0.areaM2": "51.5",
    "roof.0.azimuthDeg": "4",
    "roof.0.tiltDeg": "35",
    "roof.0.type": "pitched",
    "roof.0.shading": "light",
    "roof.0.reviewed": "true",
    "roof.0.replaceDefault": "true",
  };
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

function csvForm(): FormData {
  const form = validProfileForm();
  form.set("loadProfile", "customer_csv.v1");
  form.set("loadProfileCsv", new Array(8_760).fill("1").join("\n"));
  return form;
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

const csvKnown = (value: unknown) => ({
  status: "known",
  value,
  source: "operator_reviewed",
});

function csvConsumption(): Record<string, unknown> {
  return {
    householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    loadProfile: csvKnown("customer_csv.v1"),
    customCsvKwh: csvKnown(new Array(8_760).fill(1)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.getCandidate.mockResolvedValue(candidate("commercial"));
  deps.saveProfile.mockResolvedValue({
    profileId: "50000000-0000-4000-8000-000000000005",
    revision: 1,
    addressRevision: 3,
    changed: true,
    confirmed: false,
  });
});

// SKIP-Grund: RED-Test zur Spec F4-02d (docs/spec/F4-02d-commercial-gate-laender.md,
// Abschnitt 5). Das Commercial-Gate ist SPECIFIED, nicht gebaut: Save und Compose
// kennen heute keinen Scope (ROT-Beleg: 3 failed | 2 passed am 2026-09-19).
// Entskippen, sobald der Bau-Slice das Gate implementiert.
describe.skip("F4-02d Commercial-Gate (Save)", () => {
  it("verweigert den CSV-Save bei residential Scope fail-closed", async () => {
    deps.getCandidate.mockResolvedValueOnce(candidate("residential"));
    await expect(saveProjectEnergyProfileAction({ status: "idle" }, csvForm()))
      .resolves.toEqual({ status: "invalid" });
    expect(deps.saveProfile).not.toHaveBeenCalled();
  });

  it("nimmt den CSV-Save bei commercial Scope an (Guard)", async () => {
    await expect(saveProjectEnergyProfileAction({ status: "idle" }, csvForm()))
      .resolves.toMatchObject({ status: "success" });
  });
});

describe.skip("F4-02d Commercial-Gate (Compose)", () => {
  it("verweigert die CSV-Basis bei residential Scope", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      { consumption: csvConsumption(), scope: "residential" },
      loadContext(),
    )).toThrow();
  });

  it("verlangt scope im Profil-Request auf dem CSV-Pfad", () => {
    expect(() => buildLoadSourcesFromProfileV2(
      { consumption: csvConsumption() },
      loadContext(),
    )).toThrow();
  });
});

describe.skip("F4-02d Laender-Default (DE-only)", () => {
  it("weist synthetische Laenderprofile fail-closed ab (Guard)", () => {
    const context = loadContext();
    for (const profile of ["linky_pull.v1", "it_f1f2f3.v1", "br_netmetering.v1"]) {
      expect(() => buildLoadSourcesFromProfileV2(
        {
          consumption: {
            householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
            loadProfile: csvKnown(profile),
          },
        },
        context,
      )).toThrow();
    }
  });
});
