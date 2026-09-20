import { describe, expect, it } from "vitest";

import {
  PLANNING_ROOF_CONTRACT_VERSION,
  PLANNING_SOURCE_CONTRACT_VERSION,
  planningRoofCreateV1Schema,
  planningRoofPolygonV1Schema,
  planningRoofTiltDegSchema,
  planningSourceCreateV1Schema,
  planningSourceKindSchema,
  planningSourceScaleRefV1Schema,
} from "@/lib/integrations/planning/contracts";

const RESERVED_KINDS = [
  "ortho",
  "google_solar",
  "earth_3d",
  "building_ai",
  "drone",
] as const;

const rectangle = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

const bowtie = [
  { x: 0, y: 0 },
  { x: 10, y: 10 },
  { x: 10, y: 0 },
  { x: 0, y: 10 },
];

const regularPolygon = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n;
    return { x: 50 + 40 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) };
  });

describe("F3 Batch-1 Planungs-Contract (F3-02/F3-03)", () => {
  it("F302-CON-01: kind-Enum akzeptiert upload + self_drawn, rejectet RESERVED ohne Fallback", () => {
    expect(planningSourceKindSchema.safeParse("upload").success).toBe(true);
    expect(planningSourceKindSchema.safeParse("self_drawn").success).toBe(true);

    for (const kind of RESERVED_KINDS) {
      expect(planningSourceKindSchema.safeParse(kind).success).toBe(false);
    }
    for (const value of ["Upload", "SELF_DRAWN", "", null, undefined, 0, {}]) {
      expect(planningSourceKindSchema.safeParse(value).success).toBe(false);
    }
  });

  it("F302-CON-02: scale_ref verlangt strikt positive Zahlen", () => {
    const valid = { meters: 12.5, pixelLength: 640 };
    expect(planningSourceScaleRefV1Schema.safeParse(valid).success).toBe(true);

    for (const candidate of [
      { meters: 0, pixelLength: 640 },
      { meters: -1, pixelLength: 640 },
      { meters: 12.5, pixelLength: 0 },
      { meters: 12.5, pixelLength: -0.5 },
      { meters: Number.NaN, pixelLength: 640 },
      { meters: 12.5, pixelLength: Number.POSITIVE_INFINITY },
      { meters: "12.5", pixelLength: 640 },
      { meters: 12.5 },
      { pixelLength: 640 },
      {},
      { meters: 12.5, pixelLength: 640, extra: 1 },
    ]) {
      expect(planningSourceScaleRefV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("F302-CON-03: source-Create ist versioniert und bindet scale_ref an kind", () => {
    const upload = {
      schemaVersion: PLANNING_SOURCE_CONTRACT_VERSION,
      kind: "upload" as const,
      scaleRef: { meters: 12.5, pixelLength: 640 },
    };
    expect(planningSourceCreateV1Schema.safeParse(upload).success).toBe(true);

    const selfDrawn = {
      schemaVersion: PLANNING_SOURCE_CONTRACT_VERSION,
      kind: "self_drawn" as const,
    };
    expect(planningSourceCreateV1Schema.safeParse(selfDrawn).success).toBe(true);

    for (const candidate of [
      { ...upload, schemaVersion: "planning-source.v2" },
      { ...upload, schemaVersion: "upload" },
      { ...upload, kind: "ortho" },
      { ...upload, kind: "drone" },
      { ...upload, scaleRef: { meters: 0, pixelLength: 640 } },
    ]) {
      expect(planningSourceCreateV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("F303-CON-01: Polygon braucht 3..64 Punkte mit numerischen Koordinaten", () => {
    expect(planningRoofPolygonV1Schema.safeParse(rectangle).success).toBe(true);
    expect(
      planningRoofPolygonV1Schema.safeParse(regularPolygon(3)).success,
    ).toBe(true);
    expect(
      planningRoofPolygonV1Schema.safeParse(regularPolygon(64)).success,
    ).toBe(true);

    for (const candidate of [
      [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      regularPolygon(65),
      [],
      [{ x: 0, y: 0 }, { x: "10", y: 0 }, { x: 10, y: 6 }],
      [{ x: 0, y: 0 }, { x: 10 }, { x: 10, y: 6 }],
      [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 10, y: 6 }],
      "polygon",
      null,
    ]) {
      expect(planningRoofPolygonV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("F303-CON-02: Polygon mit Selbstschnitt wird rejectet", () => {
    expect(planningRoofPolygonV1Schema.safeParse(rectangle).success).toBe(true);
    expect(planningRoofPolygonV1Schema.safeParse(regularPolygon(8)).success).toBe(
      true,
    );
    expect(planningRoofPolygonV1Schema.safeParse(bowtie).success).toBe(false);
  });

  it("F303-CON-03: tilt 0–90 gilt an den Grenzen, sonst reject", () => {
    for (const tilt of [0, 90, 35, 0.5, 89.99]) {
      expect(planningRoofTiltDegSchema.safeParse(tilt).success).toBe(true);
    }
    for (const tilt of [-0.1, -1, 90.1, 180, Number.NaN, "35", null, undefined]) {
      expect(planningRoofTiltDegSchema.safeParse(tilt).success).toBe(false);
    }
  });

  it("F303-CON-04: Dach-Create verlangt genau eine Neigungsform (flat XOR per-edge)", () => {
    const base = {
      schemaVersion: PLANNING_ROOF_CONTRACT_VERSION,
      polygon: rectangle,
    };
    const flat = { ...base, flatSingleTilt: 30 };
    const perEdge = { ...base, tiltPerEdge: [30, 35, 30, 35] };
    expect(planningRoofCreateV1Schema.safeParse(flat).success).toBe(true);
    expect(planningRoofCreateV1Schema.safeParse(perEdge).success).toBe(true);

    for (const candidate of [
      { ...base, flatSingleTilt: 30, tiltPerEdge: [30, 35, 30, 35] },
      { ...base },
      { ...base, flatSingleTilt: -1 },
      { ...base, flatSingleTilt: 91 },
      { ...base, tiltPerEdge: [30, 35, 30, 91] },
      { ...base, tiltPerEdge: [30, 35, 30] },
      { ...base, flatSingleTilt: 30, polygon: bowtie },
      { ...base, flatSingleTilt: 30, polygon: regularPolygon(65) },
      { ...flat, schemaVersion: "planning-roof.v2" },
    ]) {
      expect(planningRoofCreateV1Schema.safeParse(candidate).success).toBe(false);
    }
  });
});
