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

function loadExample(fileName: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(root, "contracts/examples", fileName), "utf8"),
  ) as Record<string, unknown>;
}

const CONTRACTS = [
  "simulation-clock",
  "linky-import",
  "italy-tou-bands",
  "brasil-net-metering",
  "ev-database",
  "storage-degradation",
  "extension-delta",
] as const;

describe("F4E contract schemas (3E-Fortsetzung)", () => {
  for (const name of CONTRACTS) {
    it(`${name}.v1 akzeptiert sein Beispiel-Dokument`, () => {
      const validate = loadValidator(`${name}.v1.schema.json`);
      expect(validate(loadExample(`${name}.v1.json`))).toBe(true);
    });

    it(`${name}.v1 weist const-Verletzung und Fremd-Property ab`, () => {
      const validate = loadValidator(`${name}.v1.schema.json`);
      const wrongVersion = {
        ...loadExample(`${name}.v1.json`),
        contractVersion: "falsch.v9",
      };
      expect(validate(wrongVersion)).toBe(false);
      const extraProp = {
        ...loadExample(`${name}.v1.json`),
        erfundenesFeld: 1,
      };
      expect(validate(extraProp)).toBe(false);
    });
  }
});
