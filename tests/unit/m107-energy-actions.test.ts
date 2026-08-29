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
    confirmProfile: vi.fn(),
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
  confirmProjectEnergyProfile: deps.confirmProfile,
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

import {
  confirmProjectEnergyProfileAction,
  saveProjectEnergyProfileAction,
} from "@/app/w/[workspaceId]/anfragen/energy-actions";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";

const unknownField = Object.freeze({
  status: "unknown" as const,
  value: null,
  source: "not_collected" as const,
});

function candidate() {
  return {
    projectId: PROJECT_ID,
    siteId: "30000000-0000-4000-8000-000000000003",
    sourceSnapshotId: "40000000-0000-4000-8000-000000000004",
    addressRevision: 3,
    expectedLatestRevision: 0,
    profile: {
      schemaVersion: "site-energy-profile.v1" as const,
      inputMode: "consumption" as const,
      building: {
        type: { ...unknownField },
        year: { ...unknownField },
        heatedAreaM2: { ...unknownField },
      },
      roofs: [{
        id: "default-roof-1",
        areaM2: 48,
        azimuthDeg: 5,
        tiltDeg: 30,
        type: "pitched" as const,
        shading: { ...unknownField },
        source: "default" as const,
      }],
      consumption: {
        householdKwhPerYear: {
          status: "known" as const,
          value: 4_200,
          source: "customer_metered" as const,
        },
        electricityPriceCentsPerKwh: { ...unknownField },
        annualPriceIncreasePercent: { ...unknownField },
        loadProfile: { ...unknownField },
        evKmPerYear: { ...unknownField },
        evChargingPattern: { ...unknownField },
        heatPumpKwhPerYear: { ...unknownField },
        coolingKwhPerYear: { ...unknownField },
        heatingAcKwhPerYear: { ...unknownField },
        hotWaterKwhPerYear: { ...unknownField },
      },
      existingAssets: {
        pv: { status: "known_absent" as const, source: "rechner_branch" as const },
        storage: { status: "unknown" as const, source: "not_collected" as const },
        wallbox: { status: "unknown" as const, source: "not_collected" as const },
        ev: { status: "unknown" as const, source: "not_collected" as const },
      },
      provenance: {
        source: "rechner_snapshot" as const,
        sourceSchemaVersion: "wmee-solar-snapshot.v1" as const,
        sourceEngine: "wmee-solar.v1" as const,
        roof: "default" as const,
        consumption: "metered_kwh" as const,
        electricityPrice: "default" as const,
        annualPriceIncrease: "default" as const,
      },
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

function validConfirmForm(): FormData {
  const form = new FormData();
  form.set("workspaceId", WORKSPACE_ID);
  form.set("projectId", PROJECT_ID);
  form.set("expectedAddressRevision", "3");
  form.set("expectedProfileRevision", "1");
  return form;
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
  deps.getCandidate.mockResolvedValue(candidate());
  deps.saveProfile.mockResolvedValue({
    profileId: "50000000-0000-4000-8000-000000000005",
    revision: 1,
    addressRevision: 3,
    changed: true,
    confirmed: false,
  });
  deps.confirmProfile.mockResolvedValue({
    profileId: "50000000-0000-4000-8000-000000000005",
    profileRevision: 1,
    addressRevision: 3,
    jobId: "60000000-0000-4000-8000-000000000006",
    reservationKey: "a".repeat(64),
    replayed: false,
  });
});

describe("M1-07 Energieprofil-Actions", () => {
  it("rekonstruiert das Profil erst nach autorisiertem Preflight und schreibt frisch", async () => {
    const order: string[] = [];
    deps.authorizedQuery.mockImplementationOnce(async (
      _workspaceId: string,
      _action: string,
      _resource: string,
      callback: (tx: object, ctx: object) => Promise<unknown>,
    ) => {
      order.push("preflight");
      return callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" });
    });
    deps.authorizedAction.mockImplementationOnce(async (
      _workspaceId: string,
      _action: string,
      _resource: string,
      callback: (tx: object, ctx: object) => Promise<unknown>,
    ) => {
      order.push("mutation");
      return callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" });
    });

    await expect(saveProjectEnergyProfileAction(
      { status: "idle" },
      validProfileForm(),
    )).resolves.toEqual({
      status: "success",
      revision: 1,
      changed: true,
      confirmed: false,
    });

    expect(order).toEqual(["preflight", "mutation"]);
    expect(deps.saveProfile).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      expect.objectContaining({
        projectId: PROJECT_ID,
        expectedAddressRevision: 3,
        expectedLatestRevision: 0,
        roofAcknowledgements: ["manual-roof-a3-r1"],
        profile: expect.objectContaining({
          consumption: expect.objectContaining({
            householdKwhPerYear: {
              status: "unknown",
              value: null,
              source: "not_collected",
            },
          }),
          roofs: [expect.objectContaining({
            id: "manual-roof-a3-r1",
            areaM2: 51.5,
            shading: {
              status: "known",
              value: "light",
              source: "operator_reviewed",
            },
          })],
        }),
      }),
    );
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`,
    );
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}/energieprofil`,
    );
  });

  it("weist zusätzliche, fehlende und wiederholte Fachfelder vor jeder Abhängigkeit zurück", async () => {
    const additional = validProfileForm();
    additional.set("unexpected", "browser-trust");
    const repeated = validProfileForm();
    repeated.append("householdKwhPerYear", "999999");
    const missing = validProfileForm();
    missing.delete("pvStatus");

    for (const form of [additional, repeated, missing]) {
      await expect(saveProjectEnergyProfileAction({ status: "idle" }, form))
        .resolves.toEqual({ status: "invalid" });
    }
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("stoppt bei einer veralteten Preflight-Revision ohne Mutation", async () => {
    deps.getCandidate.mockResolvedValueOnce({
      ...candidate(),
      expectedLatestRevision: 2,
    });

    await expect(saveProjectEnergyProfileAction(
      { status: "idle" },
      validProfileForm(),
    )).resolves.toEqual({ status: "stale" });
    expect(deps.authorizedAction).not.toHaveBeenCalled();
    expect(deps.saveProfile).not.toHaveBeenCalled();
  });

  it.each([
    [deps.NotAuthenticatedError, "unauthenticated"],
    [deps.PermissionDeniedError, "denied"],
    [deps.EnergyProfileConflictError, "stale"],
    [deps.EnergyProfileRoofAcknowledgementError, "roof_review_required"],
    [deps.EnergyProfileUnsupportedSourceError, "unsupported_source"],
    [deps.EnergyProfileInvalidError, "invalid"],
  ] as const)("bildet erwarteten Save-Fehler %s klein und PII-frei ab", async (
    ErrorType,
    status,
  ) => {
    deps.saveProfile.mockRejectedValueOnce(new ErrorType());

    await expect(saveProjectEnergyProfileAction(
      { status: "idle" },
      validProfileForm(),
    )).resolves.toEqual({ status });
  });

  it("bestätigt nur die geschlossene ID-/Revisions-Allowlist und gibt keinen Reservation-Key zurück", async () => {
    const result = await confirmProjectEnergyProfileAction(
      { status: "idle" },
      validConfirmForm(),
    );

    expect(result).toEqual({
      status: "success",
      jobId: "60000000-0000-4000-8000-000000000006",
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toContain("reservation");
    expect(deps.confirmProfile).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        projectId: PROJECT_ID,
        expectedAddressRevision: 3,
        expectedProfileRevision: 1,
      },
    );

    const forged = validConfirmForm();
    forged.set("retry", "true");
    await expect(confirmProjectEnergyProfileAction({ status: "idle" }, forged))
      .resolves.toEqual({ status: "invalid" });
  });

  it.each([
    [deps.EnergyProfileRetryConflictError, "retry_conflict"],
    [deps.EnergyProfileRoofAcknowledgementError, "roof_review_required"],
    [deps.EnergyProfileConflictError, "stale"],
    [deps.PermissionDeniedError, "denied"],
  ] as const)("bildet erwarteten Confirm-Fehler %s stabil ab", async (
    ErrorType,
    status,
  ) => {
    deps.confirmProfile.mockRejectedValueOnce(new ErrorType());
    await expect(confirmProjectEnergyProfileAction(
      { status: "idle" },
      validConfirmForm(),
    )).resolves.toEqual({ status });
  });

  it("bildet das Confirm-Quota mit ausschließlich der stabilen Wartezeit ab", async () => {
    deps.confirmProfile.mockRejectedValueOnce(new deps.EnergyProfileRateLimitError(17));

    const result = await confirmProjectEnergyProfileAction(
      { status: "idle" },
      validConfirmForm(),
    );

    expect(result).toEqual({ status: "rate_limited", retryAfterSeconds: 17 });
    expect(JSON.stringify(result)).not.toContain("project calculation reservation");
  });
});
