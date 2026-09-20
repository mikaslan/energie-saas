import { z } from "zod";

// F3-03b Dach-Sperrzonen Stufe-0 — Client-sicherer Contract (keine
// Server-Imports). Rechteck je Dach; Überlapp-Prüfung folgt.
export const PLANNING_ROOF_RESTRICTION_VERSION =
  "planning-roof-restriction.v1" as const;

export const PLANNING_ROOF_RESTRICTION_HEIGHT_MIN_M = 0 as const;
export const PLANNING_ROOF_RESTRICTION_HEIGHT_MAX_M = 50 as const;

export const planningRoofRestrictionKindSchema = z.enum([
  "chimney",
  "window",
  "other",
]);
export type PlanningRoofRestrictionKind = z.infer<
  typeof planningRoofRestrictionKindSchema
>;

export const planningRoofRestrictionRectV1Schema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
export type PlanningRoofRestrictionRectV1 = z.infer<
  typeof planningRoofRestrictionRectV1Schema
>;

export const planningRoofRestrictionCreateV1Schema = z.strictObject({
  schemaVersion: z.literal(PLANNING_ROOF_RESTRICTION_VERSION),
  kind: planningRoofRestrictionKindSchema,
  label: z.string().min(1),
  rect: planningRoofRestrictionRectV1Schema,
  heightM: z
    .number()
    .finite()
    .min(PLANNING_ROOF_RESTRICTION_HEIGHT_MIN_M)
    .max(PLANNING_ROOF_RESTRICTION_HEIGHT_MAX_M)
    .optional(),
});
export type PlanningRoofRestrictionCreateV1 = z.infer<
  typeof planningRoofRestrictionCreateV1Schema
>;

type Point = { x: number; y: number };

function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (cross !== 0) return false;
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (pointOnSegment(p, a, b)) return true;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// Ecken-Test: alle vier Rechteck-Ecken im Polygon (Kante = drin).
export function rectInsidePolygon(
  rect: PlanningRoofRestrictionRectV1,
  polygon: Point[],
): boolean {
  if (polygon.length < 3) return false;
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  return corners.every((corner) => pointInPolygon(corner, polygon));
}
