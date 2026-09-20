import { z } from "zod";

// F3-05c String-Member Stufe-0 — Client-sicherer Contract (keine
// Server-Imports). Rechteck-Ranges je String-Member (Gruppen-Ref +
// Zeilen-/Spalten-Fenster) + Überlapp-Erkennung + Effektiv-Count
// (Zellen minus Deselect-Schnittmenge) zur Nachnutzung.
export const PLANNING_STRING_MEMBER_VERSION =
  "planning-string-member.v1" as const;

export const planningStringMemberAddV1Schema = z
  .strictObject({
    schemaVersion: z.literal(PLANNING_STRING_MEMBER_VERSION),
    stringId: z.string().uuid(),
    groupId: z.string().uuid(),
    rowFrom: z.number().int().min(1),
    rowTo: z.number().int().min(1),
    colFrom: z.number().int().min(1),
    colTo: z.number().int().min(1),
  })
  .refine((value) => value.rowFrom <= value.rowTo, {
    message: "rowFrom must be <= rowTo",
  })
  .refine((value) => value.colFrom <= value.colTo, {
    message: "colFrom must be <= colTo",
  });
export type PlanningStringMemberAddV1 = z.infer<
  typeof planningStringMemberAddV1Schema
>;

export type PlanningStringMemberRange = {
  groupId: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
};

export type PlanningStringMemberDeselectedCell = {
  groupId?: string;
  row: number;
  col: number;
};

export type EffectiveMemberCountInput = {
  ranges: PlanningStringMemberRange[];
  deselected: PlanningStringMemberDeselectedCell[];
};

// Gleiche Gruppe + Rechteck-Schnitt (inklusive Intervalle).
// Kantenberührung (z. B. rowTo 2 / rowFrom 3) ist kein Schnitt.
export function rangesOverlap(
  a: PlanningStringMemberRange,
  b: PlanningStringMemberRange,
): boolean {
  if (a.groupId !== b.groupId) {
    return false;
  }
  const rowsOverlap = a.rowFrom <= b.rowTo && b.rowFrom <= a.rowTo;
  const colsOverlap = a.colFrom <= b.colTo && b.colFrom <= a.colTo;
  return rowsOverlap && colsOverlap;
}

function isCellInRange(
  cell: PlanningStringMemberDeselectedCell,
  range: PlanningStringMemberRange,
): boolean {
  if (cell.groupId !== undefined && cell.groupId !== range.groupId) {
    return false;
  }
  return (
    cell.row >= range.rowFrom &&
    cell.row <= range.rowTo &&
    cell.col >= range.colFrom &&
    cell.col <= range.colTo
  );
}

// Summe der Range-Zellen minus Deselect-Schnittmenge. Deselects werden
// je Zelle nur einmal abgezogen (keine Doppelzählung); Service
// garantiert überschneidungsfreie Ranges und gültige Deselects.
export function effectiveMemberCount(
  input: EffectiveMemberCountInput,
): number {
  const total = input.ranges.reduce(
    (sum, range) =>
      sum + (range.rowTo - range.rowFrom + 1) * (range.colTo - range.colFrom + 1),
    0,
  );
  const seen = new Set<string>();
  let inside = 0;
  for (const cell of input.deselected) {
    const key =
      cell.groupId === undefined
        ? `${cell.row}:${cell.col}`
        : `${cell.groupId}:${cell.row}:${cell.col}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (input.ranges.some((range) => isCellInRange(cell, range))) {
      inside += 1;
    }
  }
  return total - inside;
}
