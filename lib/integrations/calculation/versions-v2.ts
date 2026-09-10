/**
 * Autoritative v2-Versionspins fuer F4.1 (Spec F4-01, einzig erlaubtes
 * v2-Tupel). `CALCULATION_V2_SOURCE_REVISION` ist der Git-Blob-SHA-1 der
 * eingefrorenen engine-v2.ts-Bytes und wird beim Freeze aus den
 * tatsaechlichen Bytes erzeugt, nie manuell erfunden.
 */
export const CALCULATION_V2_CONTRACT_VERSION = "planning-calculation.v2" as const;
export const CALCULATION_V2_RESULT_CONTRACT_VERSION =
  "planning-calculation-result.v2" as const;
export const CALCULATION_V2_PREPARATION_VERSION =
  "project-calculation-preparation.v2" as const;
export const CALCULATION_V2_RESERVATION_VERSION =
  "project-calculation-reservation.v2" as const;
export const CALCULATION_V2_CATALOG_RESOLUTION_VERSION = "catalog-resolution.v2" as const;
export const CALCULATION_V2_PROVIDER_RECIPE_VERSION =
  "pvgis-5.3-sarah3-2020-quarter-hour.v2" as const;
export const CALCULATION_V2_MODEL_ID = "wmee-solar" as const;
export const CALCULATION_V2_MODEL_VERSION = "2.0.0" as const;
export const CALCULATION_V2_SOURCE_REVISION =
  "6637feab232b265020fc4b257574df76a0b071bd" as const;
export const CALCULATION_V2_DEFAULTS_VERSION = "wmee-planning-defaults.v2" as const;
// Bytegenauer, aus den v2-Runtime-Schemas erzeugter Vertrag
// (contracts/planning-calculation.v2.schema.json). Jede absichtliche
// Aenderung verlangt einen neuen Review und Hash.
export const CALCULATION_V2_SCHEMA_SHA256 =
  "dce0a2733decbbab399d82c0d39f948a7e57b767be0d01fb279bc014fbe28881" as const;
export const CALCULATION_V2_QUALITY = "server_reproduced_public_reference" as const;
export const CALCULATION_V2_VALIDATION_STATUS = "f4_public_reference_validated" as const;
export const CALCULATION_V2_AXIS_VERSION =
  "utc_to_berlin_standard_time_circular_then_drop_feb29.v2" as const;
export const CALCULATION_V2_RECONSTRUCTION_VERSION =
  "energy_conserving_solar_weight.v2" as const;
export const CALCULATION_V2_DISPATCH_VERSION = "load_first_cyclic_soc.v1" as const;
export const CALCULATION_V2_GRID_EXPORT_LIMIT = "unbounded.v1" as const;
export const CALCULATION_V2_SOLAR_GEOMETRY_VERSION =
  "noaa-low-precision_spencer-nrel_sealevel.v1" as const;
export const CALCULATION_V2_SUBHOUR_VERSION = "muneer-geometry-weights.v1" as const;
export const CALCULATION_V2_H0_LOAD_VERSION = "wmee-bdew-h0-dyn.v1" as const;
export const CALCULATION_V2_DEGREE_DAY_VERSION = "wmee-degree-day.v1" as const;
export const CALCULATION_V2_HEAT_PUMP_COP_VERSION = "wmee-heat-pump-cop.v1" as const;
export const CALCULATION_V2_LOAD_SHAPES_VERSION = "wmee-load-shapes.v1" as const;
export const CALCULATION_V2_EXISTING_PV_VERSION = "wmee-existing-pv.v1" as const;
