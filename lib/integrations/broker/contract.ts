import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "@/contracts/broker-intake.v1.schema.json";
import type { BrokerIntakeV1 } from "./types";

// Provideradapter pinnen exakt diese Datei. Eine Vertragsänderung verlangt
// damit bewusst einen neuen Review statt stillschweigender Drift.
export const BROKER_INTAKE_SCHEMA_SHA256 =
  "564fc7e560c56291b31a344027b4f6f4204ab702564253cee69b4c06effb1068" as const;

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);

const validate = ajv.compile(schema) as ValidateFunction<BrokerIntakeV1>;

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

export type BrokerContractResult =
  | { ok: true; value: BrokerIntakeV1 }
  | { ok: false; paths: string[] };

export function validateBrokerIntake(value: unknown): BrokerContractResult {
  if (validate(value)) return { ok: true, value };
  return { ok: false, paths: publicPaths(validate.errors) };
}
