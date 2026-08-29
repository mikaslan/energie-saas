import {
  validatePlanningCalculationResultForRequest,
  type CalculationContractResult,
  type PlanningCalculationResultV1,
} from "./contract";
import { calculatePlanningEstimate } from "./engine";

const MAX_DIFFERENCE_PATHS = 20;

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizedResult(value: PlanningCalculationResultV1): PlanningCalculationResultV1 {
  return {
    ...value,
    warnings: [...value.warnings].sort((left, right) => {
      const leftKey = `${left.code}:${left.severity}`;
      const rightKey = `${right.code}:${right.severity}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
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

/**
 * Persistenz-/Lesekante für serverseitige Ergebnisse. Die leichte Prüfung im
 * Contract bindet Schema, Hash, zentrale Ableitungen und Warnungen. Diese
 * zweite, bewusst modellexakte Grenze berechnet den deterministischen v1-Kern
 * noch einmal und verhindert auch kohärent gemeinsam veränderte Energieflüsse.
 */
export function validatePlanningCalculationResultExactlyForRequest(
  requestValue: unknown,
  resultValue: unknown,
): CalculationContractResult<PlanningCalculationResultV1> {
  const bound = validatePlanningCalculationResultForRequest(requestValue, resultValue);
  if (!bound.ok) return bound;

  let expected: PlanningCalculationResultV1;
  try {
    expected = calculatePlanningEstimate(requestValue);
  } catch {
    return { ok: false, paths: ["/calculation"] };
  }
  const paths = exactDifferencePaths(
    normalizedResult(expected),
    normalizedResult(bound.value),
  );
  return paths.length === 0
    ? { ok: true, value: bound.value }
    : { ok: false, paths };
}
