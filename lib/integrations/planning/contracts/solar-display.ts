import { z } from "zod";

import { solarQuarterGeometryUtc } from "@/lib/integrations/calculation/solar-geometry-v2";

export const PLANNING_SOLAR_DISPLAY_VERSION =
  "planning-solar-display.v1" as const;

export const planningSolarDisplayV1Schema = z.strictObject({
  schemaVersion: z.literal(PLANNING_SOLAR_DISPLAY_VERSION),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  instantMsUtc: z.number().finite().int().positive(),
});
export type PlanningSolarDisplayV1 = z.infer<
  typeof planningSolarDisplayV1Schema
>;

export type PlanningSolarDisplayResult = {
  elevationDeg: number;
  azimuthDegNorth: number;
  airMass: number | null;
  sunUp: boolean;
};

// Pure Ableitung für die Stufe-0-Anzeige (kein Throw bei
// schema-geprüftem Input; Kern bleibt fail-closed für Rest-Fälle).
export function resolveSolarDisplay(
  input: PlanningSolarDisplayV1,
): PlanningSolarDisplayResult {
  const geometry = solarQuarterGeometryUtc(
    input.instantMsUtc,
    input.latitude,
    input.longitude,
  );
  return {
    elevationDeg: geometry.elevationDeg,
    azimuthDegNorth: geometry.azimuthDegNorth,
    airMass: geometry.airMass,
    sunUp: geometry.elevationDeg > 0,
  };
}
