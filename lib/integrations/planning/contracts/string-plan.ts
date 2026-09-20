import { z } from "zod";

// F3-05a manuelle Stringplanung Stufe-0 — Client-sicherer Contract (keine
// Server-Imports). WR-Registry je Projekt + manuelle Strings aus ganzen
// Panel-Gruppen; Advisories sind Warnliste, nie Reject.
export const PLANNING_STRING_VERSION = "planning-string.v1" as const;

export const PLANNING_STRING_MPP_TRACKERS_MIN = 1 as const;
export const PLANNING_STRING_MPP_TRACKERS_MAX = 12 as const;
export const PLANNING_STRING_MAX_STRING_MODULES_MIN = 1 as const;
export const PLANNING_STRING_TRACKER_SLOT_MIN = 1 as const;
export const PLANNING_STRING_MEMBERS_MIN = 1 as const;
export const PLANNING_STRING_MEMBERS_MAX = 200 as const;

export const planningInverterCreateV1Schema = z.strictObject({
  schemaVersion: z.literal(PLANNING_STRING_VERSION),
  label: z.string().min(1),
  mppTrackers: z
    .number()
    .int()
    .min(PLANNING_STRING_MPP_TRACKERS_MIN)
    .max(PLANNING_STRING_MPP_TRACKERS_MAX),
  maxStringModules: z
    .number()
    .int()
    .min(PLANNING_STRING_MAX_STRING_MODULES_MIN)
    .optional(),
});
export type PlanningInverterCreateV1 = z.infer<
  typeof planningInverterCreateV1Schema
>;

export const planningStringMemberV1Schema = z.strictObject({
  groupId: z.string().uuid(),
});
export type PlanningStringMemberV1 = z.infer<
  typeof planningStringMemberV1Schema
>;

export const planningStringCreateV1Schema = z.strictObject({
  schemaVersion: z.literal(PLANNING_STRING_VERSION),
  inverterId: z.string().uuid(),
  trackerSlot: z.number().int().min(PLANNING_STRING_TRACKER_SLOT_MIN),
  label: z.string().min(1),
  members: z
    .array(planningStringMemberV1Schema)
    .min(PLANNING_STRING_MEMBERS_MIN)
    .max(PLANNING_STRING_MEMBERS_MAX),
});
export type PlanningStringCreateV1 = z.infer<
  typeof planningStringCreateV1Schema
>;

export type PlanningStringAdvisoryCode = "orientation-mix" | "over-length";

export type PlanningStringAdvisory = {
  code: PlanningStringAdvisoryCode;
  message: string;
};

export type PlanningStringAdvisoryGroupInput = {
  id: string;
  kind: string;
  moduleCount: number;
};

export type PlanningStringAdvisoriesInput = {
  groups: PlanningStringAdvisoryGroupInput[];
  maxStringModules?: number | null;
};

// Advisory-Ableitung (nie Reject): H/V-Mix → orientation-mix, Summe der
// Modulzahlen > maxStringModules → over-length, sonst leer.
export function stringAdvisories(
  input: PlanningStringAdvisoriesInput,
): PlanningStringAdvisory[] {
  const advisories: PlanningStringAdvisory[] = [];
  const kinds = new Set(input.groups.map((group) => group.kind));
  if (kinds.size > 1) {
    advisories.push({
      code: "orientation-mix",
      message: "String mischt horizontale und vertikale Panel-Gruppen.",
    });
  }
  const max = input.maxStringModules;
  if (typeof max === "number" && Number.isFinite(max)) {
    const total = input.groups.reduce(
      (sum, group) => sum + group.moduleCount,
      0,
    );
    if (total > max) {
      advisories.push({
        code: "over-length",
        message: `String-Laenge ${total} Module ueberschreitet Grenze ${max}.`,
      });
    }
  }
  return advisories;
}
