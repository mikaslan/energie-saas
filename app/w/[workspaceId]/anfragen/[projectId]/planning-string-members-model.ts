// F3-05c String-Member: geteilte DTOs plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-string-equipment-model.ts).
export type PlanningStringMemberDto = {
  id: string;
  stringId: string;
  groupId: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
  createdAt: string;
};

export type PlanningStringMemberRow = {
  id: string;
  string_id: string;
  group_id: string;
  row_from: number;
  row_to: number;
  col_from: number;
  col_to: number;
  created_at: string | Date;
};

// Listen-Eintrag fuer die Sektion: Member plus aufgeloestes
// Gruppen-Label (E2E-Vertrag: Gruppe + Zeilen-/Spalten-Fenster sichtbar).
export type PlanningStringMemberListItem = {
  id: string;
  stringId: string;
  groupId: string;
  groupLabel: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
};

export type PlanningStringMemberGroupOption = {
  id: string;
  label: string;
  rows: number;
  cols: number;
};

// Sektion je String (String-Listenreihenfolge): Member plus
// Effektiv-Count (Zellen minus Deselect-Schnittmenge) plus
// Abwahl-Warnung, sobald Deselects in Ranges liegen.
export type PlanningStringMemberStringSection = {
  id: string;
  label: string;
  inverterLabel: string;
  members: PlanningStringMemberListItem[];
  effectiveCount: number;
  rawCount: number;
  deselectedInside: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: UUID-Refs, Fenster ints ≥1 mit from≤to
// (0277-CHECK-Spiegel), sonst DTO null.
export function toPlanningStringMemberDto(
  row: PlanningStringMemberRow,
): PlanningStringMemberDto | null {
  if (!UUID_PATTERN.test(row.id)) return null;
  if (typeof row.string_id !== "string" || !UUID_PATTERN.test(row.string_id)) return null;
  if (typeof row.group_id !== "string" || !UUID_PATTERN.test(row.group_id)) return null;
  if (!Number.isInteger(row.row_from) || row.row_from < 1) return null;
  if (!Number.isInteger(row.row_to) || row.row_to < row.row_from) return null;
  if (!Number.isInteger(row.col_from) || row.col_from < 1) return null;
  if (!Number.isInteger(row.col_to) || row.col_to < row.col_from) return null;
  return {
    id: row.id,
    stringId: row.string_id.toLowerCase(),
    groupId: row.group_id.toLowerCase(),
    rowFrom: row.row_from,
    rowTo: row.row_to,
    colFrom: row.col_from,
    colTo: row.col_to,
    createdAt: toIso(row.created_at),
  };
}

// Zellzahl eines Rechteck-Fensters (inklusive Intervalle).
export function planningStringMemberCellCount(item: {
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
}): number {
  return (item.rowTo - item.rowFrom + 1) * (item.colTo - item.colFrom + 1);
}
