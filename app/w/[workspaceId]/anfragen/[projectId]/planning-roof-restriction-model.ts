// F3-03b Dach-Sperrzonen: geteiltes DTO plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-roof-model.ts).
export type PlanningRoofRestrictionKind = "chimney" | "window" | "other";

export type PlanningRoofRestrictionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// F3-04c: Kollisions-Eintrag je ueberlappender Panel-Gruppe
// (Service-DTO-Spiegel: collidingGroups [{groupId, label}]).
export type PlanningRoofRestrictionCollidingGroup = {
  groupId: string;
  label: string;
};

export type PlanningRoofRestrictionDto = {
  id: string;
  roofId: string;
  kind: PlanningRoofRestrictionKind;
  label: string;
  rect: PlanningRoofRestrictionRect;
  heightM: number | null;
  createdAt: string;
  collidingGroups: PlanningRoofRestrictionCollidingGroup[];
};

export type PlanningRoofRestrictionRow = {
  id: string;
  roof_id: string;
  kind: string;
  label: string;
  rect_json: unknown;
  height_m: number | string | null;
  created_at: string | Date;
};

export const PLANNING_ROOF_RESTRICTION_KIND_LABELS: Record<
  PlanningRoofRestrictionKind,
  string
> = {
  chimney: "Schornstein",
  window: "Fenster",
  other: "Sonstige",
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

export function planningRoofRestrictionRect(
  value: unknown,
): PlanningRoofRestrictionRect | null {
  const candidate = parseJsonb(value);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (
    !isFiniteNumber(record.x)
    || !isFiniteNumber(record.y)
    || !isFiniteNumber(record.width)
    || !isFiniteNumber(record.height)
    || record.width <= 0
    || record.height <= 0
  ) {
    return null;
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height };
}

function planningRoofRestrictionHeight(value: number | string | null): number | null | undefined {
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

// Fail-closed: kind aus der 0272-Menge, Rechteck mit endlichen Zahlen und
// Breite/Hoehe > 0 (DB-CHECK-Spiegel), sonst DTO null.
export function toPlanningRoofRestrictionDto(
  row: PlanningRoofRestrictionRow,
): PlanningRoofRestrictionDto | null {
  if (row.kind !== "chimney" && row.kind !== "window" && row.kind !== "other") return null;
  if (typeof row.label !== "string" || row.label.length < 1) return null;
  const rect = planningRoofRestrictionRect(row.rect_json);
  if (!rect) return null;
  const heightM = planningRoofRestrictionHeight(row.height_m);
  if (heightM === undefined) return null;
  return {
    id: row.id,
    roofId: row.roof_id,
    kind: row.kind,
    label: row.label,
    rect,
    heightM,
    createdAt: toIso(row.created_at),
    // F3-04c: Panel reichert collidingGroups an (advisory-only).
    collidingGroups: [],
  };
}
