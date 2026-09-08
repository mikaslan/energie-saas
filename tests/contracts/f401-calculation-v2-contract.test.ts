import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_RESULT_CONTRACT_VERSION,
  CALCULATION_V2_SCHEMA_SHA256,
} from "@/lib/integrations/calculation/versions-v2";
import {
  planningCalculationRequestV2Schema,
  planningCalculationResultV2Schema,
  renderPlanningCalculationJsonSchemaV2,
  type PlanningCalculationRequestV2,
  type PlanningCalculationResultV2,
} from "@/lib/integrations/calculation/contract-v2";

// F4.1 v2-Vertragskette RED: Request/Result strikt, Tupel exakt, ohne
// Implementierung rot.

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CALCULATION_V2_CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    branch: "new_installation",
    asOfDate: "2026-08-29",
    commissioningDate: "2026-10-01",
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
    axis: { slots: 35040, resolution: "quarter_hour" },
    storage: {
      capacityKwh: 10,
      socMinKwh: 1,
      socMaxKwh: 9,
      chargeKw: 5,
      dischargeKw: 5,
      etaCharge: 0.95,
      etaDischarge: 0.95,
    },
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CALCULATION_V2_RESULT_CONTRACT_VERSION,
    canonicalizationVersion: "planning-jcs.v1",
    model: {
      id: "wmee-solar",
      version: "2.0.0",
      sourceRevision: "6637feab232b265020fc4b257574df76a0b071bd",
    },
    inputSha256: "b".repeat(64),
    quality: "server_reproduced_public_reference",
    validationStatus: "f4_public_reference_validated",
    temporalResolution: "quarter_hour_35040",
    roundingVersion: "wmee-energy-rounding.v1",
    annual: {
      generationKwh: 8000,
      consumptionKwh: 4500,
      directConsumptionKwh: 2500,
      fromStorageKwh: 800,
      selfConsumptionKwh: 3300,
      feedInKwh: 4700,
      gridImportKwh: 1200,
      storageLossKwh: 120,
      selfConsumptionRate: 0.41,
      autonomyRate: 0.73,
      storageFullCycles: 90,
    },
    monthly: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      generationKwh: 600,
      selfConsumptionKwh: 250,
      gridImportKwh: 100,
      feedInKwh: 350,
    })),
    warnings: [],
    ...overrides,
  };
}

describe("F4.1 v2 request contract", () => {
  it("akzeptiert einen gueltigen v2-Request", () => {
    const parsed: PlanningCalculationRequestV2 =
      planningCalculationRequestV2Schema.parse(request());
    expect(parsed.contractVersion).toBe(CALCULATION_V2_CONTRACT_VERSION);
  });

  it("weist v1-Vertrag und unbekannte Felder ab (strikt)", () => {
    expect(() =>
      planningCalculationRequestV2Schema.parse(
        request({ contractVersion: "planning-calculation.v1" }),
      )).toThrow();
    expect(() =>
      planningCalculationRequestV2Schema.parse(request({ extra: true }))).toThrow();
  });

  it("weist unphysikalische Speicherparameter ab", () => {
    expect(() =>
      planningCalculationRequestV2Schema.parse(
        request({ storage: {
          capacityKwh: 10, socMinKwh: 9, socMaxKwh: 8, chargeKw: 5,
          dischargeKw: 5, etaCharge: 0.95, etaDischarge: 0.95,
        } }),
      )).toThrow();
    expect(() =>
      planningCalculationRequestV2Schema.parse(
        request({ axis: { slots: 8760, resolution: "quarter_hour" } }),
      )).toThrow();
  });
});

describe("F4.1 v2 result contract", () => {
  it("akzeptiert ein gueltiges v2-Resultat mit exaktem Tupel", () => {
    const parsed: PlanningCalculationResultV2 =
      planningCalculationResultV2Schema.parse(result());
    expect(parsed.validationStatus).toBe("f4_public_reference_validated");
  });

  it("weist v1-Quality/Status und falsche Aufloesung ab", () => {
    expect(() =>
      planningCalculationResultV2Schema.parse(result({
        quality: "server_reproduced_estimate",
        validationStatus: "not_f4_reference_validated",
      }))).toThrow();
    expect(() =>
      planningCalculationResultV2Schema.parse(
        result({ temporalResolution: "hourly_8760" }),
      )).toThrow();
    expect(() =>
      planningCalculationResultV2Schema.parse(result({ extra: 1 }))).toThrow();
  });

  it("fordert exactly 12 Monatszeilen", () => {
    const monthly = (result().monthly as unknown[]).slice(0, 11);
    expect(() =>
      planningCalculationResultV2Schema.parse(result({ monthly }))).toThrow();
  });
});

describe("F4.1 v2 schema artefact", () => {
  it("haelt Runtime-Schema, generiertes Artefakt und gepinnten SHA bytegleich", () => {
    const schemaPath = resolve(
      import.meta.dirname,
      "../../contracts/planning-calculation.v2.schema.json",
    );
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toBe(renderPlanningCalculationJsonSchemaV2());
    expect(createHash("sha256").update(schema).digest("hex")).toBe(
      CALCULATION_V2_SCHEMA_SHA256,
    );
  });
});
