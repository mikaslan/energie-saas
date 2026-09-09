/**
 * F4.1 v2-Finalize-Grenze (Spec F4-01): modellexakte Re-Run-Pruefung fuer
 * PlanningCalculationResultV2. Die leichte Pruefung (Schema + inputSha)
 * bindet Form und Zugehoerigkeit; diese zweite, bewusst modellexakte Grenze
 * berechnet den deterministischen v2-Kern noch einmal und verhindert auch
 * kohaerent gemeinsam veraenderte Energiefluesse. Additiv neben
 * validate-result.ts.
 */
import {
  planningCalculationRequestV2Schema,
  planningCalculationResultV2Schema,
  type PlanningCalculationResultV2,
} from "./contract-v2";
import { hashPlanningCalculationInputV2 } from "./prepare-v2";
import {
  runPlanningCalculationV2,
  type RunPlanningCalculationV2Input,
} from "./run-v2";

export type V2ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; paths: string[] };

const MAX_DIFFERENCE_PATHS = 20;

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizedWarnings(
  warnings: Array<{ code: string; severity: string }>,
): Array<{ code: string; severity: string }> {
  return [...warnings].sort((left, right) => {
    const leftKey = `${left.code}:${left.severity}`;
    const rightKey = `${right.code}:${right.severity}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function exactDifferencePaths(
  expected: unknown,
  actual: unknown,
  path = "",
  paths: string[] = [],
): string[] {
  if (paths.length >= MAX_DIFFERENCE_PATHS || Object.is(expected, actual)) return paths;
  if (
    expected === null
    || actual === null
    || typeof expected !== "object"
    || typeof actual !== "object"
  ) {
    paths.push(path || "/");
    return paths;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      paths.push(path || "/");
      return paths;
    }
    if (expected.length !== actual.length) paths.push(`${path}/length`);
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length && paths.length < MAX_DIFFERENCE_PATHS; index += 1) {
      exactDifferencePaths(expected[index], actual[index], `${path}/${index}`, paths);
    }
    return paths;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [...new Set([
    ...Object.keys(expectedRecord),
    ...Object.keys(actualRecord),
  ])].sort();
  for (const key of keys) {
    if (paths.length >= MAX_DIFFERENCE_PATHS) break;
    const nextPath = `${path}/${pointerSegment(key)}`;
    if (!(key in expectedRecord) || !(key in actualRecord)) {
      paths.push(nextPath);
      continue;
    }
    exactDifferencePaths(expectedRecord[key], actualRecord[key], nextPath, paths);
  }
  return paths;
}

export function validatePlanningCalculationResultV2Exactly(
  input: RunPlanningCalculationV2Input & { result: unknown },
): V2ContractResult<PlanningCalculationResultV2> {
  const bound = planningCalculationResultV2Schema.safeParse(input.result);
  if (!bound.success) {
    return {
      ok: false,
      paths: [...new Set(bound.error.issues.map((issue) =>
        issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`))]
        .slice(0, MAX_DIFFERENCE_PATHS),
    };
  }
  const boundResult = bound.data;
  const requestParsed = planningCalculationRequestV2Schema.safeParse(input.request);
  if (!requestParsed.success) return { ok: false, paths: ["/"] };
  if (
    boundResult.inputSha256 !== hashPlanningCalculationInputV2(requestParsed.data)
  ) {
    return { ok: false, paths: ["/inputSha256"] };
  }
  let expected: ReturnType<typeof runPlanningCalculationV2>;
  try {
    expected = runPlanningCalculationV2({
      request: requestParsed.data,
      pvKwh: input.pvKwh,
      loadKwh: input.loadKwh,
      providerEstimate: input.providerEstimate,
      existingPvKwh: input.existingPvKwh ?? null,
    });
  } catch {
    return { ok: false, paths: ["/"] };
  }
  const paths = exactDifferencePaths(
    { ...expected, warnings: normalizedWarnings(expected.warnings) },
    { ...boundResult, warnings: normalizedWarnings(boundResult.warnings) },
  );
  return paths.length === 0
    ? { ok: true, value: boundResult }
    : { ok: false, paths };
}
