import { z } from "zod";
import {
  RECHNER_CALCULATION_SCHEMA_VERSION,
  type RechnerCalculationSnapshotV1,
} from "@/lib/integrations/rechner/types";
import {
  SITE_ENERGY_PROFILE_SCHEMA_VERSION,
  siteEnergyProfileV1Schema,
  type SiteEnergyProfileV1,
} from "./contract";

const finite = () => z.number().finite();
const nonNegative = (maximum: number) => finite().min(0).max(maximum);

const roofSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  areaM2: nonNegative(2_000),
  azimuthDeg: finite().min(-180).max(180),
  tiltDeg: finite().min(0).max(90),
  type: z.enum(["pitched", "flat"]),
  shading: z.enum(["none", "light", "medium", "strong"]).nullable(),
});

const consumptionSchema = z.strictObject({
  householdKwhPerYear: nonNegative(100_000),
  // These fields document the calculator questionnaire, but authoritative
  // projection provenance comes from snapshot.provenance.consumption.
  origin: z.unknown().optional(),
  enteredAnnualCostCents: z.unknown().optional(),
  electricityPriceCentsPerKwh: finite().min(1).max(200),
  annualPriceIncreasePercent: finite().min(-10).max(25),
  evKmPerYear: nonNegative(200_000),
  evChargingPattern: z.enum(["evening", "daytime", "away"]).nullable(),
  heatPumpKwhPerYear: nonNegative(100_000),
  coolingKwhPerYear: nonNegative(100_000),
  heatingAcKwhPerYear: nonNegative(100_000),
  hotWaterKwhPerYear: nonNegative(20_000).nullable(),
  buildingType: z.enum([
    "single_family",
    "two_family",
    "multi_family",
    "commercial",
  ]).nullable(),
  buildingYear: z.int().min(1_800).max(2_200).nullable(),
  heatedAreaM2: nonNegative(1_000).nullable(),
});

const existingInstallationSchema = z.strictObject({
  peakPowerKwp: nonNegative(1_000),
  commissioningYear: z.int().min(2_000).max(2_200),
  storageKwh: nonNegative(40),
});

const projectionSourceSchema = z.strictObject({
  schemaVersion: z.literal(RECHNER_CALCULATION_SCHEMA_VERSION),
  calculatedAt: z.iso.datetime({ offset: true }),
  branch: z.enum(["new_installation", "existing_installation"]),
  questionnaireVariant: z.enum(["short", "standard", "pro"]),
  resultIntegrity: z.literal("client_reported_unverified"),
  inputs: z.strictObject({
    roofs: z.array(roofSchema).min(1).max(4),
    consumption: consumptionSchema,
    // Project intent, assumptions and questionnaire bookkeeping are outside
    // this Site-level projection and deliberately remain opaque.
    requestedProducts: z.unknown().optional(),
    existingInstallation: existingInstallationSchema.nullable(),
    assumptions: z.unknown().optional(),
    answeredFieldIds: z.array(z.string().trim().min(1).max(64)).max(60),
  }),
  provenance: z.strictObject({
    yield: z.unknown().optional(),
    roof: z.enum(["lod2", "user_drawn", "osm", "default"]),
    consumption: z.enum([
      "metered_kwh",
      "derived_from_cost",
      "estimated_people",
      "default",
    ]),
    electricityPrice: z.enum(["customer", "default"]),
    annualPriceIncrease: z.enum(["customer", "default"]),
    investment: z.unknown().optional(),
  }),
  // Client results, including economics, never participate in validation or
  // projection. Only their envelope key is whitelisted here.
  result: z.unknown().optional(),
});

type ImportedKnownSource = "rechner_input" | "customer_metered" | "customer_input";

type ProjectionResult =
  | { ok: true; value: SiteEnergyProfileV1 }
  | { ok: false; code: "unsupported_source" | "invalid_source" };

const unknownField = () => ({
  status: "unknown" as const,
  value: null,
  source: "not_collected" as const,
});

const knownField = <T>(value: T, source: ImportedKnownSource) => ({
  status: "known" as const,
  value,
  source,
});

function knownOrUnknown<T>(value: T | null, source: ImportedKnownSource) {
  return value === null ? unknownField() : knownField(value, source);
}

function answeredKnownOrUnknown<T>(
  answered: boolean,
  value: T | null,
  source: ImportedKnownSource,
) {
  return answered ? knownOrUnknown(value, source) : unknownField();
}

function householdConsumption(
  value: number,
  provenance: z.infer<typeof projectionSourceSchema>["provenance"]["consumption"],
) {
  if (provenance === "default") return unknownField();
  if (provenance === "metered_kwh") return knownField(value, "customer_metered");
  return knownField(value, "rechner_input");
}

function customerValueOrUnknown<T>(value: T, provenance: "customer" | "default") {
  return provenance === "customer" ? knownField(value, "customer_input") : unknownField();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function projectRechnerSnapshotToEnergyProfile(
  snapshot: RechnerCalculationSnapshotV1,
): ProjectionResult {
  if (!isRecord(snapshot)) return { ok: false, code: "invalid_source" };
  if (snapshot.schemaVersion !== RECHNER_CALCULATION_SCHEMA_VERSION) {
    return typeof snapshot.schemaVersion === "string"
      ? { ok: false, code: "unsupported_source" }
      : { ok: false, code: "invalid_source" };
  }

  const parsedSource = projectionSourceSchema.safeParse(snapshot);
  if (!parsedSource.success) return { ok: false, code: "invalid_source" };

  const source = parsedSource.data;
  const answered = new Set(source.inputs.answeredFieldIds);
  const existingInstallation = source.inputs.existingInstallation;
  if (
    (source.branch === "new_installation" && existingInstallation !== null)
    || (source.branch === "existing_installation" && existingInstallation === null)
  ) {
    return { ok: false, code: "invalid_source" };
  }

  const consumption = source.inputs.consumption;
  const importedAssets = source.branch === "new_installation"
    ? {
        pv: { status: "known_absent" as const, source: "rechner_branch" as const },
        storage: { status: "unknown" as const, source: "not_collected" as const },
      }
    : existingInstallation === null
      ? null
      : {
          pv: answered.has("bestandKwp") && answered.has("bestandJahr")
            ? {
                status: "known_present" as const,
                source: "rechner_input" as const,
                peakPowerKwp: existingInstallation.peakPowerKwp,
                commissioningYear: existingInstallation.commissioningYear,
              }
            : { status: "unknown" as const, source: "not_collected" as const },
          storage: !answered.has("bestandSpeicher")
            ? { status: "unknown" as const, source: "not_collected" as const }
            : existingInstallation.storageKwh > 0
              ? {
                  status: "known_present" as const,
                  source: "rechner_input" as const,
                  capacityKwh: existingInstallation.storageKwh,
                }
              : { status: "known_absent" as const, source: "rechner_input" as const },
        };
  if (importedAssets === null) return { ok: false, code: "invalid_source" };

  const candidate = {
    schemaVersion: SITE_ENERGY_PROFILE_SCHEMA_VERSION,
    inputMode: "consumption" as const,
    building: {
      type: answeredKnownOrUnknown(
        answered.has("gebaeudetyp"),
        consumption.buildingType,
        "rechner_input",
      ),
      year: answeredKnownOrUnknown(
        answered.has("baujahr"),
        consumption.buildingYear,
        "rechner_input",
      ),
      heatedAreaM2: answeredKnownOrUnknown(
        answered.has("wohnflaeche"),
        consumption.heatedAreaM2,
        "rechner_input",
      ),
    },
    roofs: source.inputs.roofs.map((roof) => ({
      id: roof.id,
      areaM2: roof.areaM2,
      azimuthDeg: roof.azimuthDeg,
      tiltDeg: roof.tiltDeg,
      type: roof.type,
      shading: answeredKnownOrUnknown(
        answered.has("verschattung"),
        roof.shading,
        "rechner_input",
      ),
      source: source.provenance.roof,
    })),
    consumption: {
      householdKwhPerYear: householdConsumption(
        consumption.householdKwhPerYear,
        source.provenance.consumption,
      ),
      electricityPriceCentsPerKwh: customerValueOrUnknown(
        consumption.electricityPriceCentsPerKwh,
        source.provenance.electricityPrice,
      ),
      annualPriceIncreasePercent: customerValueOrUnknown(
        consumption.annualPriceIncreasePercent,
        source.provenance.annualPriceIncrease,
      ),
      loadProfile: unknownField(),
      evKmPerYear: answeredKnownOrUnknown(
        answered.has("eauto"),
        consumption.evKmPerYear,
        "customer_input",
      ),
      evChargingPattern: answeredKnownOrUnknown(
        answered.has("eauto") && answered.has("ladeort"),
        consumption.evChargingPattern,
        "customer_input",
      ),
      heatPumpKwhPerYear: answeredKnownOrUnknown(
        answered.has("waermepumpe"),
        consumption.heatPumpKwhPerYear,
        "customer_input",
      ),
      coolingKwhPerYear: answeredKnownOrUnknown(
        answered.has("klimaKuehlen"),
        consumption.coolingKwhPerYear,
        "customer_input",
      ),
      heatingAcKwhPerYear: answeredKnownOrUnknown(
        answered.has("klimaHeizen"),
        consumption.heatingAcKwhPerYear,
        "customer_input",
      ),
      hotWaterKwhPerYear: answeredKnownOrUnknown(
        answered.has("warmwasser"),
        consumption.hotWaterKwhPerYear,
        "customer_input",
      ),
    },
    existingAssets: {
      ...importedAssets,
      wallbox: { status: "unknown" as const, source: "not_collected" as const },
      ev: !answered.has("eauto")
        ? { status: "unknown" as const, source: "not_collected" as const }
        : consumption.evKmPerYear > 0
          ? { status: "known_present" as const, source: "rechner_consumption" as const }
          : { status: "known_absent" as const, source: "rechner_consumption" as const },
    },
    provenance: {
      source: "rechner_snapshot" as const,
      sourceSchemaVersion: RECHNER_CALCULATION_SCHEMA_VERSION,
      sourceEngine: "wmee-solar.v1" as const,
      roof: source.provenance.roof,
      consumption: source.provenance.consumption,
      electricityPrice: source.provenance.electricityPrice,
      annualPriceIncrease: source.provenance.annualPriceIncrease,
    },
  };

  const parsedProfile = siteEnergyProfileV1Schema.safeParse(candidate);
  return parsedProfile.success
    ? { ok: true, value: parsedProfile.data }
    : { ok: false, code: "invalid_source" };
}
