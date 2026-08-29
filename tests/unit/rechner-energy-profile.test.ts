import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RechnerCalculationSnapshotV1 } from "@/lib/integrations/rechner/types";
import {
  projectRechnerSnapshotToEnergyProfile,
} from "@/lib/integrations/calculation/rechner-profile";

const fixturePath = resolve(
  import.meta.dirname,
  "../../contracts/examples/rechner-intake.v1.json",
);

function snapshotFixture(): RechnerCalculationSnapshotV1 {
  const intake = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    calculation: RechnerCalculationSnapshotV1;
  };
  return structuredClone(intake.calculation);
}

describe("Rechner-Snapshot -> operative Site-Energieprofil-Kandidatur", () => {
  it("projiziert nur whitelisted Eingaben und explizite Provenienz", () => {
    const result = projectRechnerSnapshotToEnergyProfile(snapshotFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Golden Fixture muss projizierbar sein.");

    expect(result.value).toMatchObject({
      schemaVersion: "site-energy-profile.v1",
      inputMode: "consumption",
      building: {
        type: { status: "unknown", value: null, source: "not_collected" },
        year: { status: "unknown", value: null, source: "not_collected" },
        heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
      },
      consumption: {
        householdKwhPerYear: { status: "known", value: 4_200, source: "customer_metered" },
        electricityPriceCentsPerKwh: { status: "known", value: 36, source: "customer_input" },
        annualPriceIncreasePercent: {
          status: "unknown",
          value: null,
          source: "not_collected",
        },
        loadProfile: { status: "unknown", value: null, source: "not_collected" },
      },
      existingAssets: {
        pv: { status: "known_absent", source: "rechner_branch" },
        storage: { status: "unknown", source: "not_collected" },
        wallbox: { status: "unknown", source: "not_collected" },
        ev: { status: "known_present", source: "rechner_consumption" },
      },
      provenance: {
        source: "rechner_snapshot",
        sourceSchemaVersion: "wmee-solar-snapshot.v1",
        sourceEngine: "wmee-solar.v1",
        roof: "user_drawn",
        consumption: "metered_kwh",
        electricityPrice: "customer",
        annualPriceIncrease: "default",
      },
    });
    expect(result.value.roofs).toEqual([
      {
        id: "dach-1",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched",
        shading: { status: "unknown", value: null, source: "not_collected" },
        source: "user_drawn",
      },
    ]);
  });

  it("laesst fehlende Rechnerfelder unknown statt sie zu Null/false umzudeuten", () => {
    const snapshot = snapshotFixture();
    const consumption = snapshot.inputs.consumption as Record<string, unknown>;
    consumption.buildingType = null;
    consumption.buildingYear = null;
    consumption.heatedAreaM2 = null;
    consumption.evChargingPattern = null;
    consumption.hotWaterKwhPerYear = null;
    snapshot.inputs.roofs[0].shading = null;

    const result = projectRechnerSnapshotToEnergyProfile(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Null-Felder muessen als unknown projizierbar sein.");

    expect(result.value.building).toEqual({
      type: { status: "unknown", value: null, source: "not_collected" },
      year: { status: "unknown", value: null, source: "not_collected" },
      heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
    });
    expect(result.value.roofs[0].shading).toEqual({
      status: "unknown",
      value: null,
      source: "not_collected",
    });
    expect(result.value.consumption.evChargingPattern).toEqual({
      status: "unknown",
      value: null,
      source: "not_collected",
    });
  });

  it("erhebt sichtbare Rechner-Defaults ohne beantwortete Frage nicht zur Kundenangabe", () => {
    const snapshot = snapshotFixture();
    snapshot.inputs.answeredFieldIds = snapshot.inputs.answeredFieldIds.filter(
      (id) => !["eauto", "waermepumpe", "klimaKuehlen", "klimaHeizen"].includes(id),
    );

    const result = projectRechnerSnapshotToEnergyProfile(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Golden Fixture muss projizierbar sein.");

    for (const field of [
      "evKmPerYear",
      "heatPumpKwhPerYear",
      "coolingKwhPerYear",
      "heatingAcKwhPerYear",
    ] as const) {
      expect(result.value.consumption[field]).toEqual({
        status: "unknown",
        value: null,
        source: "not_collected",
      });
    }
    expect(result.value.existingAssets.ev).toEqual({
      status: "unknown",
      source: "not_collected",
    });
  });

  it("ignoriert importiertes Resultat, Economics und Requested Products vollstaendig", () => {
    const first = snapshotFixture();
    const second = snapshotFixture();
    second.result = {
      mode: "new_installation",
      economics: {
        investmentCents: 999_999_999,
        priceSource: "market_estimate",
      },
      forgedServerTruth: true,
    };
    second.inputs.requestedProducts = {
      targetStorageKwh: 40,
      wallbox: false,
      bidirectionalCharging: true,
      backupPower: true,
    };

    const projectedFirst = projectRechnerSnapshotToEnergyProfile(first);
    const projectedSecond = projectRechnerSnapshotToEnergyProfile(second);
    expect(projectedFirst.ok).toBe(true);
    expect(projectedSecond.ok).toBe(true);
    if (!projectedFirst.ok || !projectedSecond.ok) throw new Error("unreachable");
    expect(projectedSecond.value).toEqual(projectedFirst.value);
    expect(JSON.stringify(projectedSecond.value)).not.toContain("market_estimate");
    expect(JSON.stringify(projectedSecond.value)).not.toContain("targetStorageKwh");
  });

  it("bildet die bekannte Bestands-PV und den Bestandsspeicher getrennt ab", () => {
    const snapshot = snapshotFixture();
    snapshot.branch = "existing_installation";
    snapshot.inputs.existingInstallation = {
      peakPowerKwp: 7.4,
      commissioningYear: 2012,
      storageKwh: 5,
    };
    snapshot.inputs.answeredFieldIds.push(
      "bestandKwp",
      "bestandJahr",
      "bestandSpeicher",
    );
    snapshot.result = {
      mode: "existing_installation",
      existingPeakPowerKwp: 7.4,
      existingStorageKwh: 5,
      requestedAdditionalStorageKwh: 8,
      retrofit: null,
    };

    const result = projectRechnerSnapshotToEnergyProfile(snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Bestands-Fall muss projizierbar sein.");
    expect(result.value.existingAssets.pv).toEqual({
      status: "known_present",
      source: "rechner_input",
      peakPowerKwp: 7.4,
      commissioningYear: 2012,
    });
    expect(result.value.existingAssets.storage).toEqual({
      status: "known_present",
      source: "rechner_input",
      capacityKwh: 5,
    });
  });

  it("lehnt unbekannte Quellversionen, inkonsistente Branches und ungueltige Inputs fail-closed ab", () => {
    const version = snapshotFixture();
    version.schemaVersion = "future-schema" as "wmee-solar-snapshot.v1";
    expect(projectRechnerSnapshotToEnergyProfile(version)).toEqual({
      ok: false,
      code: "unsupported_source",
    });

    const branch = snapshotFixture();
    branch.branch = "existing_installation";
    branch.inputs.existingInstallation = null;
    expect(projectRechnerSnapshotToEnergyProfile(branch)).toEqual({
      ok: false,
      code: "invalid_source",
    });

    const invalid = snapshotFixture();
    (invalid.inputs.consumption as Record<string, unknown>).householdKwhPerYear = -1;
    expect(projectRechnerSnapshotToEnergyProfile(invalid)).toEqual({
      ok: false,
      code: "invalid_source",
    });
  });
});
