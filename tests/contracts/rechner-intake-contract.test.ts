import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  RECHNER_INTAKE_SCHEMA_SHA256,
  validateRechnerIntake,
} from "@/lib/integrations/rechner/contract";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/rechner-intake.v1.schema.json");
const fixturePath = resolve(root, "contracts/examples/rechner-intake.v1.json");
const openapiPath = resolve(root, "contracts/rechner-intake.v1.openapi.yaml");

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

function calculation(value: Record<string, unknown>): Record<string, unknown> {
  return value.calculation as Record<string, unknown>;
}

describe("rechner-intake.v1 contract", () => {
  it("pinnt die bytegenaue kanonische Schema-Datei", () => {
    const actual = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
    expect(actual).toBe(RECHNER_INTAKE_SCHEMA_SHA256);
  });

  it("validiert das gemeinsame Golden Fixture", () => {
    expect(validateRechnerIntake(fixture())).toEqual({ ok: true, value: fixture() });
  });

  it("lehnt unbekannte Felder fail-closed ab und nennt nur Pfade", () => {
    const value = fixture();
    (value.customer as Record<string, unknown>).internalNote = "PII darf nicht in Fehlerantworten";
    const result = validateRechnerIntake(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.paths).toContain("/customer");
    expect(JSON.stringify(result)).not.toContain("PII darf nicht");
  });

  it("erzwingt branch und result mode gemeinsam", () => {
    const value = fixture();
    calculation(value).branch = "existing_installation";
    const result = validateRechnerIntake(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.paths.some((path) => path.startsWith("/calculation"))).toBe(true);
  });

  it("akzeptiert Bestandsanlage mit bewusst fehlender Nachruestungsrechnung", () => {
    const value = fixture();
    const calc = calculation(value);
    const inputs = calc.inputs as Record<string, unknown>;
    inputs.existingInstallation = {
      peakPowerKwp: 7.4,
      commissioningYear: 2012,
      storageKwh: 0,
    };
    calc.branch = "existing_installation";
    calc.result = {
      mode: "existing_installation",
      existingPeakPowerKwp: 7.4,
      existingStorageKwh: 0,
      requestedAdditionalStorageKwh: 8,
      retrofit: null,
    };
    expect(validateRechnerIntake(value).ok).toBe(true);
  });

  it("trennt eine ausgewaehlte Hausadresse strikt von einer Regionalschaetzung", () => {
    const selected = fixture();
    (selected.site as Record<string, unknown>).precision = "street";
    expect(validateRechnerIntake(selected).ok).toBe(false);

    const regional = fixture();
    regional.site = {
      addressMode: "regional_estimate",
      formattedAddress: "Region Rhein-Neckar",
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      countryCode: "DE",
      latitude: 49.4,
      longitude: 8.7,
      geocodeSource: "regional_default",
      precision: "region",
    };
    expect(validateRechnerIntake(regional).ok).toBe(true);
  });

  it("akzeptiert Rechnerpreise ausschliesslich als unverbindliche Marktschaetzung", () => {
    const value = fixture();
    const calc = calculation(value);
    (calc.provenance as Record<string, unknown>).investment = "wmee_price_list";
    expect(validateRechnerIntake(value).ok).toBe(false);
  });

  it("lehnt nicht persistierbare Datumswerte und reine Leertexte am Vertrag ab", () => {
    for (const invalidDate of [
      "2026-12-31T23:59:60Z",
      "2026-08-29T08:30:00+01",
      "2026-08-29T08:30:00+24:00",
      "2026-08-29T08:30:00+23:60",
      "2026-08-29T08:30:00+99:99",
    ]) {
      const value = fixture();
      value.submittedAt = invalidDate;
      expect(validateRechnerIntake(value).ok).toBe(false);
    }

    for (const mutate of [
      (value: Record<string, unknown>) => {
        (value.customer as Record<string, unknown>).displayName = "   ";
      },
      (value: Record<string, unknown>) => {
        (value.privacy as Record<string, unknown>).noticeVersion = "\t";
      },
      (value: Record<string, unknown>) => {
        (value.site as Record<string, unknown>).street = "   ";
      },
    ]) {
      const value = fixture();
      mutate(value);
      expect(validateRechnerIntake(value).ok).toBe(false);
    }
  });

  it("OpenAPI referenziert genau das kanonische Schema und alle Statuscodes", () => {
    const document = parseYaml(readFileSync(openapiPath, "utf8")) as Record<string, unknown>;
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const operation = paths["/api/inbound/rechner/v1"].post as Record<string, unknown>;
    const body = operation.requestBody as Record<string, unknown>;
    const content = body.content as Record<string, Record<string, unknown>>;
    expect(body["x-max-body-bytes"]).toBe(262144);
    expect(body["x-content-encoding-policy"]).toBe("forbidden-including-identity");
    expect((content["application/json"].schema as Record<string, unknown>).$ref)
      .toBe("./rechner-intake.v1.schema.json");
    expect(Object.keys(operation.responses as Record<string, unknown>).sort()).toEqual(
      ["200", "201", "400", "401", "409", "413", "415", "422", "429", "500", "503"],
    );
  });
});
