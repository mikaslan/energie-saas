import { z } from "zod";

// F3-04c Belegung-vs-Sperrzonen-Kollision Stufe-0 — Client-sicherer
// Contract (keine Server-Imports). Gruppen-Rechteck vs.
// Restriction-Rechtecke desselben Dachs → betroffene Paare +
// Schnittfläche (nur echter Schnitt, Fläche > 0; Kante/Ecke = keiner).
export const PLANNING_PANEL_COLLISION_VERSION =
  "planning-panel-collision.v1" as const;

export const planningPanelCollisionRectV1Schema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
export type PlanningPanelCollisionRectV1 = z.infer<
  typeof planningPanelCollisionRectV1Schema
>;

export const planningPanelCollisionCheckV1Schema = z.strictObject({
  group: z.strictObject({
    id: z.string().uuid(),
    rect: planningPanelCollisionRectV1Schema,
  }),
  restrictions: z.array(
    z.strictObject({
      id: z.string().uuid(),
      kind: z.string(),
      label: z.string().min(1),
      rect: planningPanelCollisionRectV1Schema,
    }),
  ),
});
export type PlanningPanelCollisionCheckV1 = z.infer<
  typeof planningPanelCollisionCheckV1Schema
>;

export type PlanningPanelCollision = {
  restrictionId: string;
  kind: string;
  label: string;
  overlapArea: number;
};

// Rechteck-Schnitt auf kontinuierlicher Ebene: nur Überlappung mit
// Fläche > 0 zählt (Kanten-/Eckenberührung ist kein Schnitt).
export function groupRestrictionCollisions(
  input: PlanningPanelCollisionCheckV1,
): PlanningPanelCollision[] {
  const parsed = planningPanelCollisionCheckV1Schema.parse(input);
  const group = parsed.group.rect;
  const groupMaxX = group.x + group.width;
  const groupMaxY = group.y + group.height;
  const hits: PlanningPanelCollision[] = [];
  for (const restriction of parsed.restrictions) {
    const rect = restriction.rect;
    const overlapWidth =
      Math.min(groupMaxX, rect.x + rect.width) - Math.max(group.x, rect.x);
    const overlapHeight =
      Math.min(groupMaxY, rect.y + rect.height) - Math.max(group.y, rect.y);
    if (overlapWidth > 0 && overlapHeight > 0) {
      hits.push({
        restrictionId: restriction.id,
        kind: restriction.kind,
        label: restriction.label,
        overlapArea: overlapWidth * overlapHeight,
      });
    }
  }
  return hits;
}
