import { z } from "zod";

export const PLANNING_ROOF_CONTRACT_VERSION = "planning-roof.v1" as const;

export const PLANNING_ROOF_POLYGON_MIN_POINTS = 3 as const;
export const PLANNING_ROOF_POLYGON_MAX_POINTS = 64 as const;
export const PLANNING_ROOF_TILT_MIN_DEG = 0 as const;
export const PLANNING_ROOF_TILT_MAX_DEG = 90 as const;

const planningRoofPointV1Schema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type PlanningRoofPointV1 = z.infer<typeof planningRoofPointV1Schema>;

type Point = { x: number; y: number };

function orientation(a: Point, b: Point, c: Point): 0 | 1 | 2 {
  const value =
    (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (value === 0) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    q.x <= Math.max(p.x, r.x) &&
    q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) &&
    q.y >= Math.min(p.y, r.y)
  );
}

function segmentsIntersect(p1: Point, q1: Point, p2: Point, q2: Point): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;

  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;

  return false;
}

function sharesVertex(
  points: Point[],
  i: number,
  j: number,
): boolean {
  const n = points.length;
  const a1 = i;
  const a2 = (i + 1) % n;
  const b1 = j;
  const b2 = (j + 1) % n;
  return a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2;
}

function hasSelfIntersection(points: Point[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (sharesVertex(points, i, j)) continue;
      if (
        segmentsIntersect(
          points[i]!,
          points[(i + 1) % n]!,
          points[j]!,
          points[(j + 1) % n]!,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export const planningRoofPolygonV1Schema = z
  .array(
    planningRoofPointV1Schema,
    { error: "polygon must be an array of points" },
  )
  .min(PLANNING_ROOF_POLYGON_MIN_POINTS)
  .max(PLANNING_ROOF_POLYGON_MAX_POINTS)
  .superRefine((points, ctx) => {
    if (hasSelfIntersection(points)) {
      ctx.addIssue({
        code: "custom",
        message: "polygon must not self-intersect",
      });
    }
  });
export type PlanningRoofPolygonV1 = z.infer<typeof planningRoofPolygonV1Schema>;

export const planningRoofTiltDegSchema = z
  .number()
  .finite()
  .min(PLANNING_ROOF_TILT_MIN_DEG)
  .max(PLANNING_ROOF_TILT_MAX_DEG);
export type PlanningRoofTiltDeg = z.infer<typeof planningRoofTiltDegSchema>;

export const planningRoofCreateV1Schema = z
  .strictObject({
    schemaVersion: z.literal(PLANNING_ROOF_CONTRACT_VERSION),
    polygon: planningRoofPolygonV1Schema,
    flatSingleTilt: planningRoofTiltDegSchema.optional(),
    tiltPerEdge: z.array(planningRoofTiltDegSchema).optional(),
  })
  .superRefine((value, ctx) => {
    const hasFlat = value.flatSingleTilt !== undefined;
    const hasPerEdge = value.tiltPerEdge !== undefined;
    if (hasFlat === hasPerEdge) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of flatSingleTilt or tiltPerEdge is required",
        path: hasFlat ? ["tiltPerEdge"] : ["flatSingleTilt"],
      });
      return;
    }
    if (
      hasPerEdge &&
      value.tiltPerEdge!.length !== value.polygon.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "tiltPerEdge length must equal polygon point count",
        path: ["tiltPerEdge"],
      });
    }
  });
export type PlanningRoofCreateV1 = z.infer<typeof planningRoofCreateV1Schema>;
