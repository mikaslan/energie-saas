import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "@/contracts/rest-intake.v1.schema.json";
import type { RestIntakeV1 } from "./types";

// Provideradapter pinnen exakt diese Datei. Eine Vertragsänderung verlangt
// damit bewusst einen neuen Review statt stillschweigender Drift.
export const REST_INTAKE_SCHEMA_SHA256 =
  "8883ee8532fa00ec68466287cfb480a2c03edfe023d22b8b5d853f2c12b3ee7f" as const;

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);

const validate = ajv.compile(schema) as ValidateFunction<RestIntakeV1>;

function pathOf(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missing === "string") {
      return `${error.instancePath}/${missing}` || "/";
    }
  }
  return error.instancePath || "/";
}

function publicPaths(errors: ErrorObject[] | null | undefined): string[] {
  return [...new Set((errors ?? []).map(pathOf))].slice(0, 20);
}

export type RestContractResult =
  | { ok: true; value: RestIntakeV1 }
  | { ok: false; paths: string[] };

export function validateRestIntake(value: unknown): RestContractResult {
  if (validate(value)) return { ok: true, value };
  return { ok: false, paths: publicPaths(validate.errors) };
}
