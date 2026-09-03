import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "@/contracts/rechner-intake.v1.schema.json";
import type { RechnerIntakeV1 } from "./types";

// Provideradapter pinnen exakt diese Datei. Eine Vertragsänderung verlangt
// damit bewusst einen neuen Review statt stillschweigender Drift.
export const RECHNER_INTAKE_SCHEMA_SHA256 =
  "9a61e31f1934a9958ed60ad978da0c902e0f509ef7bb43fb89862228e3c3e7fc" as const;

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);

const validate = ajv.compile(schema) as ValidateFunction<RechnerIntakeV1>;

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

export type RechnerContractResult =
  | { ok: true; value: RechnerIntakeV1 }
  | { ok: false; paths: string[] };

export function validateRechnerIntake(value: unknown): RechnerContractResult {
  if (validate(value)) return { ok: true, value };
  return { ok: false, paths: publicPaths(validate.errors) };
}
