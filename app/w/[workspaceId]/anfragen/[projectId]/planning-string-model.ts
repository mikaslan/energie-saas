// F3-05a manuelle Strings: geteilte DTOs plus reine Helfer. Absichtlich
// ohne "use client"/"use server", damit Server-Actions und Client-Sektion
// dieselbe Abbildung nutzen (Muster: planning-panel-group-model.ts).
import type { PlanningStringAdvisory } from "@/lib/integrations/planning/contracts/string-plan";

export type PlanningStringDto = {
  id: string;
  inverterId: string;
  trackerSlot: number;
  label: string;
  memberGroupIds: string[];
  createdAt: string;
};

export type PlanningStringRow = {
  id: string;
  inverter_id: string;
  tracker_slot: number;
  label: string;
  member_json: unknown;
  created_at: string | Date;
};

// Listen-Eintrag für die Sektion: String plus aufgelöste WR-/Gruppen-
// Labels plus Advisories aus stringAdvisories (Warnliste, nie Reject).
export type PlanningStringListItem = {
  id: string;
  inverterId: string;
  inverterLabel: string;
  trackerSlot: number;
  label: string;
  memberLabels: string[];
  advisories: PlanningStringAdvisory[];
};

export type PlanningStringGroupOption = {
  id: string;
  label: string;
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

// Member-Array aus member_json: [{group_id}] mit UUID-Strings, 1..200
// Einträge (0274-CHECK-Spiegel). Fail-closed → null.
export function planningStringMemberGroupIds(value: unknown): string[] | null {
  const candidate = parseJsonb(value);
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 200) {
    return null;
  }
  const ids: string[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const groupId = (entry as Record<string, unknown>).group_id;
    if (typeof groupId !== "string" || !UUID_PATTERN.test(groupId)) return null;
    ids.push(groupId.toLowerCase());
  }
  return ids;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: Label nicht leer, Slot int ≥1, Member-Array gültig,
// sonst DTO null.
export function toPlanningStringDto(row: PlanningStringRow): PlanningStringDto | null {
  if (typeof row.label !== "string" || row.label.length < 1) return null;
  if (!Number.isInteger(row.tracker_slot) || row.tracker_slot < 1) return null;
  const memberGroupIds = planningStringMemberGroupIds(row.member_json);
  if (!memberGroupIds) return null;
  return {
    id: row.id,
    inverterId: row.inverter_id,
    trackerSlot: row.tracker_slot,
    label: row.label,
    memberGroupIds,
    createdAt: toIso(row.created_at),
  };
}

// Anzeige-Text je Advisory. Der Contract-Text für orientation-mix
// enthält kein "Mix" — der E2E-Vertrag fordert /Mix/i, daher fällt die
// UI auf einen code-basierten Zusatz zurück (nie Reject).
export function planningStringAdvisoryText(advisory: PlanningStringAdvisory): string {
  if (
    advisory.code === "orientation-mix"
    && !/mix/i.test(advisory.message)
  ) {
    return `${advisory.message} (H/V-Mix)`;
  }
  return advisory.message;
}
