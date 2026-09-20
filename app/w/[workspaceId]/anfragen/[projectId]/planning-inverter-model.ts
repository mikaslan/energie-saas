// F3-05a Wechselrichter-Registry: geteiltes DTO plus reine Helfer.
// Absichtlich ohne "use client"/"use server", damit Server-Actions und
// Client-Sektion dieselbe Abbildung nutzen (Muster:
// planning-panel-group-model.ts).
export type PlanningInverterDto = {
  id: string;
  projectId: string;
  label: string;
  mppTrackers: number;
  maxStringModules: number | null;
  createdAt: string;
};

export type PlanningInverterRow = {
  id: string;
  project_id: string;
  label: string;
  mpp_trackers: number;
  max_string_modules: number | null;
  created_at: string | Date;
};

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Fail-closed: Label nicht leer, Tracker int 1..12, Max NULL oder int
// ≥1 (0274-CHECK-Spiegel), sonst DTO null.
export function toPlanningInverterDto(row: PlanningInverterRow): PlanningInverterDto | null {
  if (typeof row.label !== "string" || row.label.length < 1) return null;
  if (!Number.isInteger(row.mpp_trackers) || row.mpp_trackers < 1 || row.mpp_trackers > 12) {
    return null;
  }
  if (
    row.max_string_modules !== null
    && (!Number.isInteger(row.max_string_modules) || row.max_string_modules < 1)
  ) {
    return null;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    mppTrackers: row.mpp_trackers,
    maxStringModules: row.max_string_modules,
    createdAt: toIso(row.created_at),
  };
}
