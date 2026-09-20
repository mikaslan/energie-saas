// F3-04a Panel-Gruppen: geteiltes DTO plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-roof-restriction-model.ts).
export type PlanningPanelGroupKind = "h" | "v";

export type PlanningPanelGroupOrigin = {
  x: number;
  y: number;
};

export type PlanningPanelGroupDto = {
  id: string;
  roofId: string;
  kind: PlanningPanelGroupKind;
  label: string;
  origin: PlanningPanelGroupOrigin;
  rows: number;
  cols: number;
  moduleWM: number;
  moduleHM: number;
  gapM: number;
  tiltDeg: number | null;
  createdAt: string;
};

export type PlanningPanelGroupRow = {
  id: string;
  roof_id: string;
  kind: string;
  label: string;
  origin_json: unknown;
  rows: number;
  cols: number;
  module_w_m: number | string;
  module_h_m: number | string;
  gap_m: number | string;
  tilt_deg: number | string | null;
  created_at: string | Date;
};

export const PLANNING_PANEL_GROUP_KIND_LABELS: Record<PlanningPanelGroupKind, string> = {
  h: "Horizontal",
  v: "Vertikal",
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

export function planningPanelGroupOrigin(value: unknown): PlanningPanelGroupOrigin | null {
  const candidate = parseJsonb(value);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) return null;
  return { x: record.x, y: record.y };
}

function planningPanelGroupDecimal(value: number | string | null): number | null | undefined {
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

// Fail-closed: kind aus der 0273-Menge, Ursprung mit endlichen Zahlen,
// Zeilen/Spalten 1..200 ganzzahlig (DB-CHECK-Spiegel), sonst DTO null.
export function toPlanningPanelGroupDto(row: PlanningPanelGroupRow): PlanningPanelGroupDto | null {
  if (row.kind !== "h" && row.kind !== "v") return null;
  if (typeof row.label !== "string" || row.label.length < 1) return null;
  const origin = planningPanelGroupOrigin(row.origin_json);
  if (!origin) return null;
  if (!Number.isInteger(row.rows) || row.rows < 1 || row.rows > 200) return null;
  if (!Number.isInteger(row.cols) || row.cols < 1 || row.cols > 200) return null;
  const moduleWM = planningPanelGroupDecimal(row.module_w_m);
  const moduleHM = planningPanelGroupDecimal(row.module_h_m);
  const gapM = planningPanelGroupDecimal(row.gap_m);
  const tiltDeg = planningPanelGroupDecimal(row.tilt_deg);
  if (moduleWM === undefined || moduleWM === null) return null;
  if (moduleHM === undefined || moduleHM === null) return null;
  if (gapM === undefined || gapM === null) return null;
  if (tiltDeg === undefined) return null;
  return {
    id: row.id,
    roofId: row.roof_id,
    kind: row.kind,
    label: row.label,
    origin,
    rows: row.rows,
    cols: row.cols,
    moduleWM,
    moduleHM,
    gapM,
    tiltDeg,
    createdAt: toIso(row.created_at),
  };
}
