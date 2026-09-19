import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  REST_INTAKE_SCHEMA_SHA256,
  validateRestIntake,
} from "@/lib/integrations/rest/contract";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/rest-intake.v1.schema.json");
const fixturePath = resolve(root, "contracts/examples/rest-intake.v1.json");
const openapiPath = resolve(root, "contracts/rest-intake.v1.openapi.yaml");

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

describe("rest-intake.v1 contract", () => {
  it("pinnt die bytegenaue kanonische Schema-Datei", () => {
    const actual = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
    expect(actual).toBe(REST_INTAKE_SCHEMA_SHA256);
  });

  it("validiert das gemeinsame Golden Fixture", () => {
    expect(validateRestIntake(fixture())).toEqual({ ok: true, value: fixture() });
  });

  it("lehnt unbekannte Felder fail-closed ab und nennt nur Pfade", () => {
    const value = fixture();
    (value.customer as Record<string, unknown>).internalNote = "PII darf nicht in Fehlerantworten";
    const result = validateRestIntake(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.paths).toContain("/customer");
    expect(JSON.stringify(result)).not.toContain("PII darf nicht");
  });

  it("kennt kein brokerKey (generische Aufnahme ohne Broker-Allowlist)", () => {
    const value = fixture();
    value.brokerKey = "wattfox";
    expect(validateRestIntake(value).ok).toBe(false);
  });

  it("erzwingt Record-ID-Grenzen, E-Mail-Format und Notiz-Cap", () => {
    const cases: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.clientRecordId = ""; },
      (value) => { value.clientRecordId = "x".repeat(129); },
      (value) => { (value.customer as Record<string, unknown>).email = "keine-mail"; },
      (value) => { value.note = "n".repeat(2001); },
      (value) => { delete value.note; },
      (value) => { delete value.clientRecordId; },
    ];
    for (const [index, mutate] of cases.entries()) {
      const value = fixture();
      mutate(value);
      expect(validateRestIntake(value).ok, `case ${index}`).toBe(false);
    }
    const boundary = fixture();
    boundary.clientRecordId = "r".repeat(128);
    boundary.note = "n".repeat(2000);
    expect(validateRestIntake(boundary).ok).toBe(true);
  });

  it("sourceName ist optional, aber nie leer und nie Dedupe-Ersatz", () => {
    const absent = fixture();
    delete absent.sourceName;
    expect(validateRestIntake(absent).ok).toBe(true);

    for (const sourceName of ["", "   ", "s".repeat(101)]) {
      const value = fixture();
      value.sourceName = sourceName;
      expect(validateRestIntake(value).ok, JSON.stringify(sourceName)).toBe(false);
    }
    const boundary = fixture();
    boundary.sourceName = "s".repeat(100);
    expect(validateRestIntake(boundary).ok).toBe(true);
  });

  it("weist Whitespace-nur-Adressfelder am Schema ab (kein DB-500)", () => {
    for (const field of ["street", "houseNumber", "city"] as const) {
      const value = fixture();
      ((value.site as Record<string, unknown>)[field] as unknown) = "   ";
      expect(validateRestIntake(value).ok, field).toBe(false);
    }
  });

  it("fordert geocodeSource rest bei selected und regional_default bei Schaetzung", () => {
    const selected = fixture();
    ((selected.site as Record<string, unknown>).geocodeSource as unknown) = "broker";
    expect(validateRestIntake(selected).ok).toBe(false);

    const estimate = fixture();
    const site = estimate.site as Record<string, unknown>;
    site.addressMode = "regional_estimate";
    site.street = null;
    site.houseNumber = null;
    site.postalCode = null;
    site.city = null;
    site.geocodeSource = "regional_default";
    site.precision = "region";
    expect(validateRestIntake(estimate).ok).toBe(true);
  });

  it("OpenAPI referenziert genau das kanonische Schema und alle Statuscodes", () => {
    const document = parseYaml(readFileSync(openapiPath, "utf8")) as Record<string, unknown>;
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const operation = paths["/api/inbound/rest/v1"].post as Record<string, unknown>;
    const body = operation.requestBody as Record<string, unknown>;
    const content = body.content as Record<string, Record<string, unknown>>;
    expect(body["x-max-body-bytes"]).toBe(262144);
    expect(body["x-content-encoding-policy"]).toBe("forbidden-including-identity");
    expect((content["application/json"].schema as Record<string, unknown>).$ref)
      .toBe("./rest-intake.v1.schema.json");
    expect(Object.keys(operation.responses as Record<string, unknown>).sort()).toEqual(
      ["200", "201", "400", "401", "409", "413", "415", "422", "429", "500", "503"],
    );
  });
});
