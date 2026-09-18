import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  BROKER_INTAKE_SCHEMA_SHA256,
  validateBrokerIntake,
} from "@/lib/integrations/broker/contract";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/broker-intake.v1.schema.json");
const fixturePath = resolve(root, "contracts/examples/broker-intake.v1.json");
const openapiPath = resolve(root, "contracts/broker-intake.v1.openapi.yaml");

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

describe("broker-intake.v1 contract", () => {
  it("pinnt die bytegenaue kanonische Schema-Datei", () => {
    const actual = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
    expect(actual).toBe(BROKER_INTAKE_SCHEMA_SHA256);
  });

  it("validiert das gemeinsame Golden Fixture", () => {
    expect(validateBrokerIntake(fixture())).toEqual({ ok: true, value: fixture() });
  });

  it("lehnt unbekannte Felder fail-closed ab und nennt nur Pfade", () => {
    const value = fixture();
    (value.customer as Record<string, unknown>).internalNote = "PII darf nicht in Fehlerantworten";
    const result = validateBrokerIntake(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.paths).toContain("/customer");
    expect(JSON.stringify(result)).not.toContain("PII darf nicht");
  });

  it("lehnt unbekannte Broker-Keys fail-closed ab", () => {
    for (const brokerKey of ["check24", "WATTFOX", "", "wattfox "]) {
      const value = fixture();
      value.brokerKey = brokerKey;
      expect(validateBrokerIntake(value).ok, brokerKey).toBe(false);
    }
    for (const brokerKey of ["wattfox", "aroundhome", "daa", "eza", "interlead", "bitrix"]) {
      const value = fixture();
      value.brokerKey = brokerKey;
      expect(validateBrokerIntake(value).ok, brokerKey).toBe(true);
    }
  });

  it("erzwingt Record-ID-Grenzen, E-Mail-Format und Notiz-Cap", () => {
    const cases: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.brokerRecordId = ""; },
      (value) => { value.brokerRecordId = "x".repeat(129); },
      (value) => { (value.customer as Record<string, unknown>).email = "keine-mail"; },
      (value) => { value.note = "n".repeat(2001); },
      (value) => { delete value.note; },
    ];
    for (const [index, mutate] of cases.entries()) {
      const value = fixture();
      mutate(value);
      expect(validateBrokerIntake(value).ok, `case ${index}`).toBe(false);
    }
    const boundary = fixture();
    boundary.brokerRecordId = "r".repeat(128);
    boundary.note = "n".repeat(2000);
    expect(validateBrokerIntake(boundary).ok).toBe(true);
  });

  it("OpenAPI referenziert genau das kanonische Schema und alle Statuscodes", () => {
    const document = parseYaml(readFileSync(openapiPath, "utf8")) as Record<string, unknown>;
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const operation = paths["/api/inbound/broker/v1"].post as Record<string, unknown>;
    const body = operation.requestBody as Record<string, unknown>;
    const content = body.content as Record<string, Record<string, unknown>>;
    expect(body["x-max-body-bytes"]).toBe(262144);
    expect(body["x-content-encoding-policy"]).toBe("forbidden-including-identity");
    expect((content["application/json"].schema as Record<string, unknown>).$ref)
      .toBe("./broker-intake.v1.schema.json");
    expect(Object.keys(operation.responses as Record<string, unknown>).sort()).toEqual(
      ["200", "201", "400", "401", "409", "413", "415", "422", "429", "500", "503"],
    );
  });
});
