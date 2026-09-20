// F3-04b Einzelmodul-Abwahl: geteilte DTOs plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-string-equipment-model.ts).
export type PlanningPanelDeselectDto = {
  id: string;
  groupId: string;
  row: number;
  col: number;
  reason: string | null;
  createdAt: string;
};

export type PlanningPanelDeselectRow = {
  id: string;
  group_id: string;
  row: number;
  col: number;
  reason: string | null;
  created_at: string | Date;
};

// Listen-Eintrag fuer die Sektion: Abwahl plus aufgeloestes
// Gruppen-Label (E2E-Vertrag: Gruppe + Zeile/Spalte sichtbar).
export type PlanningPanelDeselectListItem = {
  id: string;
  groupId: string;
  groupLabel: string;
  row: number;
  col: number;
  reason: string | null;
};

export type PlanningPanelDeselectGroupOption = {
  id: string;
  label: string;
  rows: number;
  cols: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: UUID-Refs, row/col ints ≥1 (0276-CHECK-Spiegel),
// reason null oder ≤280 Zeichen, sonst DTO null.
export function toPlanningPanelDeselectDto(
  row: PlanningPanelDeselectRow,
): PlanningPanelDeselectDto | null {
  if (!UUID_PATTERN.test(row.id)) return null;
  if (typeof row.group_id !== "string" || !UUID_PATTERN.test(row.group_id)) return null;
  if (!Number.isInteger(row.row) || row.row < 1) return null;
  if (!Number.isInteger(row.col) || row.col < 1) return null;
  if (row.reason !== null && (typeof row.reason !== "string" || row.reason.length > 280)) {
    return null;
  }
  return {
    id: row.id,
    groupId: row.group_id.toLowerCase(),
    row: row.row,
    col: row.col,
    reason: row.reason,
    createdAt: toIso(row.created_at),
  };
}
