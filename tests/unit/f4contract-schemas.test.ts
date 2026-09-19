import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function loadValidator(fileName: string) {
  const schema = JSON.parse(
    readFileSync(resolve(root, "contracts", fileName), "utf8"),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function validPvgisReferenceValidation(): Record<string, unknown> {
  return {
    contractVersion: "pvgis-reference-validation.v1",
    sites: [
      {
        siteId: "walldorf",
        providerLatitude: 49.285,
        providerLongitude: 8.738,
        coordinateRounding: "pvgis-coordinate-rounding-3dp.v1",
        elevationM: 110,
      },
    ],
    tiltedCases: [
      { tiltDeg: 30, aspect: "S", albedo: 0.2 },
      { tiltDeg: 90, aspect: "O", albedo: 0.2 },
    ],
    queries: {
      canonicalQuery: {
        provider: "pvgis",
        apiVersion: "5_3",
        radiationDatabase: "PVGIS-SARAH3",
      },
      fetchedAt: "2026-09-01T10:00:00.000Z",
    },
    fixtures: [{ name: "tilt30-south", rawSha256: SHA_A }],
    toleranceVersion: "muneer-validation-tolerances.v1",
    gates: {
      point_hourly: { atol: 0.5, rtol: 0.01 },
      monthly: { atol: 1, rtol: 0.02 },
      annual: { atol: 2, rtol: 0.02 },
      night: { atol: 0.1, rtol: 0 },
      energy: { atol: 1, rtol: 0.01 },
    },
    report: {
      inputsSha256: SHA_A,
      fixtureSha256s: [SHA_A, SHA_B],
      statistics: { p99: 0.4, max: 0.9 },
      provenance: ["pvgis-seriescalc", "muneer-transposition"],
      result: "pass",
    },
  };
}

function validDayAheadTariff(): Record<string, unknown> {
  return {
    contractVersion: "day-ahead-tariff.v1",
    priceSeriesCentsPerKwh: Array.from({ length: 8760 }, (_, i) =>
      i % 2 === 0 ? 28.5 : 31.2,
    ),
    source: "csv_import",
    importedAt: "2026-09-01T10:00:00.000Z",
    switchTimes: ["2026-04-01T00:00:00.000Z"],
  };
}

describe("F4 contract schemas", () => {
  it("pvgis-reference-validation.v1 akzeptiert ein gueltiges Dokument", () => {
    const validate = loadValidator("pvgis-reference-validation.v1.schema.json");
    expect(validate(validPvgisReferenceValidation())).toBe(true);
  });

  it("pvgis-reference-validation.v1 weist tilt/aspekt/sha-Verstoesse ab", () => {
    const validate = loadValidator("pvgis-reference-validation.v1.schema.json");
    const doc = validPvgisReferenceValidation();
    (doc.tiltedCases as Record<string, unknown>[])[0] = {
      tiltDeg: 45,
      aspect: "SO",
      albedo: 0.25,
    };
    (doc.fixtures as Record<string, unknown>[])[0] = {
      name: "tilt30-south",
      rawSha256: "kein-sha",
    };
    expect(validate(doc)).toBe(false);
  });

  it("day-ahead-tariff.v1 akzeptiert 8760 Preise", () => {
    const validate = loadValidator("day-ahead-tariff.v1.schema.json");
    expect(validate(validDayAheadTariff())).toBe(true);
  });

  it("day-ahead-tariff.v1 weist falsche Laenge und negative Preise ab", () => {
    const validate = loadValidator("day-ahead-tariff.v1.schema.json");
    const short = { ...validDayAheadTariff(), priceSeriesCentsPerKwh: [28.5] };
    expect(validate(short)).toBe(false);
    const negative = {
      ...validDayAheadTariff(),
      priceSeriesCentsPerKwh: Array.from({ length: 8760 }, () => -1),
    };
    expect(validate(negative)).toBe(false);
  });

  it("ev-profile.v1 akzeptiert ein gueltiges Profil", () => {
    const validate = loadValidator("ev-profile.v1.schema.json");
    expect(
      validate({
        contractVersion: "ev-profile.v1",
        segment: "mittel",
        kwhPerKm: 0.18,
        jahresKm: 12000,
        wallboxMaxKw: 11,
        knownAbsent: false,
      }),
    ).toBe(true);
  });

  it("ev-profile.v1 weist falsches Segment und negative Werte ab", () => {
    const validate = loadValidator("ev-profile.v1.schema.json");
    expect(
      validate({
        contractVersion: "ev-profile.v1",
        segment: "suv",
        kwhPerKm: 0,
        jahresKm: -5,
        knownAbsent: false,
      }),
    ).toBe(false);
  });

  it("economics-guard.v1 akzeptiert einen gueltigen Guard", () => {
    const validate = loadValidator("economics-guard.v1.schema.json");
    expect(
      validate({
        contractVersion: "economics-guard.v1",
        eegOverrideCents: 8.2,
        commissioningYear: 2026,
        country: "DE",
        liabilityNoticeRequired: true,
        basis: "gesamtanlage",
      }),
    ).toBe(true);
  });

  it("economics-guard.v1 weist Jahr/Land/Basis-Verstoesse ab", () => {
    const validate = loadValidator("economics-guard.v1.schema.json");
    expect(
      validate({
        contractVersion: "economics-guard.v1",
        commissioningYear: 1985,
        country: "AT",
        liabilityNoticeRequired: true,
        basis: "vollanlage",
      }),
    ).toBe(false);
  });
});
