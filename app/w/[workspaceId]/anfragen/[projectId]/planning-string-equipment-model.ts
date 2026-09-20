// F3-05b String-Equipment: geteilte DTOs plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-string-model.ts).
export type PlanningStringEquipmentScope = "string" | "panel";
export type PlanningStringEquipmentType = "optimizer" | "micro_inverter";

export type PlanningStringEquipmentPanelRef = {
  groupId: string;
  row: number;
  col: number;
};

export type PlanningStringEquipmentDto = {
  id: string;
  stringId: string;
  scope: PlanningStringEquipmentScope;
  panelRef: PlanningStringEquipmentPanelRef | null;
  equipment: PlanningStringEquipmentType;
  createdAt: string;
};

export type PlanningStringEquipmentRow = {
  id: string;
  string_id: string;
  scope: string;
  panel_ref_json: unknown;
  equipment: string;
  created_at: string | Date;
};

// Listen-Eintrag fuer die Sektion: Equipment plus aufgeloeste String-
// und Gruppen-Labels (Panel-Eintraege zusaetzlich Zeile/Spalte).
export type PlanningStringEquipmentListItem = {
  id: string;
  stringId: string;
  stringLabel: string;
  scope: PlanningStringEquipmentScope;
  equipment: PlanningStringEquipmentType;
  groupLabel: string | null;
  row: number | null;
  col: number | null;
};

export type PlanningStringEquipmentStringOption = {
  id: string;
  label: string;
  memberGroups: { id: string; label: string }[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJsonb(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// Panel-Ref aus panel_ref_json: {group_id, row, col} mit UUID plus
// ints ≥1 (0275-CHECK-Spiegel). Fail-closed → null.
export function planningStringEquipmentPanelRef(
  value: unknown,
): PlanningStringEquipmentPanelRef | null {
  const candidate = parseJsonb(value);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const groupId = record.group_id;
  const row = record.row;
  const col = record.col;
  if (typeof groupId !== "string" || !UUID_PATTERN.test(groupId)) return null;
  if (!Number.isInteger(row) || (row as number) < 1) return null;
  if (!Number.isInteger(col) || (col as number) < 1) return null;
  return { groupId: groupId.toLowerCase(), row: row as number, col: col as number };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: Scope-/Equipment-Mengen, scope=string → panel_ref NULL,
// scope=panel → gueltiger Panel-Ref, sonst DTO null.
export function toPlanningStringEquipmentDto(
  row: PlanningStringEquipmentRow,
): PlanningStringEquipmentDto | null {
  if (row.scope !== "string" && row.scope !== "panel") return null;
  if (row.equipment !== "optimizer" && row.equipment !== "micro_inverter") return null;
  if (row.equipment === "micro_inverter" && row.scope !== "panel") return null;
  let panelRef: PlanningStringEquipmentPanelRef | null = null;
  if (row.scope === "string") {
    if (row.panel_ref_json !== null && row.panel_ref_json !== undefined) return null;
  } else {
    panelRef = planningStringEquipmentPanelRef(row.panel_ref_json);
    if (!panelRef) return null;
  }
  return {
    id: row.id,
    stringId: row.string_id,
    scope: row.scope,
    panelRef,
    equipment: row.equipment,
    createdAt: toIso(row.created_at),
  };
}

// Anzeige-Label je Equipment-Typ (E2E-Vertrag: "Optimierer"/"Mikro-WR").
export function planningStringEquipmentLabel(equipment: PlanningStringEquipmentType): string {
  return equipment === "optimizer" ? "Optimierer" : "Mikro-WR";
}
