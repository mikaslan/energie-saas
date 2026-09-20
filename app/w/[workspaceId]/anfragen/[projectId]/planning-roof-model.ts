// F3-03 Dach-Minimal (Batch-1): geteiltes DTO plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-source-model.ts).
export type PlanningRoofPoint = {
  x: number;
  y: number;
};

export type PlanningRoofDto = {
  id: string;
  sourceId: string;
  polygon: PlanningRoofPoint[];
  tiltPerEdge: number[] | null;
  flatSingleTilt: number | null;
  createdAt: string;
};

export type PlanningRoofRow = {
  id: string;
  source_id: string;
  polygon_json: unknown;
  tilt_per_edge_json: unknown;
  flat_single_tilt: number | string | null;
  created_at: string | Date;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseJsonb(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function planningRoofPolygon(value: unknown): PlanningRoofPoint[] | null {
  const candidate = parseJsonb(value);
  if (!Array.isArray(candidate)) return null;
  const points: PlanningRoofPoint[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) return null;
    points.push({ x: record.x, y: record.y });
  }
  return points;
}

// NULL = Flachdach-Form (XOR), sonst eine finite Zahl je Kante. DB-CHECKs
// (0271) weisen nicht-numerische/out-of-range Arrays ab; der Leser bleibt
// fail-closed (NaN → DTO null).
export function planningRoofTiltList(value: unknown): number[] | null {
  const candidate = parseJsonb(value);
  if (candidate === null || candidate === undefined) return null;
  if (!Array.isArray(candidate)) return [Number.NaN];
  return candidate.map((entry) => (isFiniteNumber(entry) ? entry : Number.NaN));
}

function planningRoofFlat(value: number | string | null): number | null | undefined {
  if (value === null) return null;
  if (isFiniteNumber(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: genau eine Neigungsform (flat XOR per-edge), Kantenanzahl =
// Punktanzahl (Contract-Regel F303-CON-04).
export function toPlanningRoofDto(row: PlanningRoofRow): PlanningRoofDto | null {
  const polygon = planningRoofPolygon(row.polygon_json);
  if (!polygon) return null;
  const tiltPerEdge = planningRoofTiltList(row.tilt_per_edge_json);
  if (
    tiltPerEdge !== null
    && (tiltPerEdge.length !== polygon.length || tiltPerEdge.some((tilt) => !Number.isFinite(tilt)))
  ) {
    return null;
  }
  const flatSingleTilt = planningRoofFlat(row.flat_single_tilt);
  if (flatSingleTilt === undefined) return null;
  if ((tiltPerEdge === null) === (flatSingleTilt === null)) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    polygon,
    tiltPerEdge,
    flatSingleTilt,
    createdAt: toIso(row.created_at),
  };
}
