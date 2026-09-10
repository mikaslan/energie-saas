/**
 * F4.1 v2-Fetch-Komposition (Spec F4-01 "Providerabrufe"): Standort-
 * Horizont + standortweiter horizontaler seriescalc (Gb_h/Gd_h) + je Dach
 * geneigter seriescalc (PVGIS-Rezept, Planungstechnik) und
 * PVcalc-Jahresreferenz -> PVcalc-Skalierung -> Muneer-Geometriegewichte
 * `G_T,q` (TS-Sonnengeometrie, keine Laufzeit-Abhaengigkeit) ->
 * kWp-Summation; Last aus belegten Provenienz-Quellen (H0, Heizgrad,
 * EV-Pattern, Kuehlgrad, Warmwasser-Tagesgang).
 *
 * Begruendete Zunaechst-Entscheidungen (alle versioniert + transparent):
 * - Substundenform: Muneer-Gewichte aus stündlichem Horizontalwetter und
 *   viertelstündlicher Geometrie (`muneer-weights-v2`, Albedo 0.2
 *   fixture-gepinnt); solare Viertelgewichte sind Spec-ESTIMATE.
 * - Planungstechnik/Montage/Verluste/kWp: planning-assumptions-v2
 *   (v1-Produktionspins + dokumentierte Midpoints).
 * - Lastform: Haushalts-Basis als BDEW-H0 (h0-load-v2), WP-Strom nach
 *   Heizgradstunden (degree-day-load-v2, T2m-Wetterjahr), EV nach belegtem
 *   Ladepattern, Kuehlung nach Kuehlgradstunden, Warmwasser nach Tagesgang
 *   (load-shapes-v2, v1-Ports), alle energieexakt auf belegte kWh normiert.
 * `providerEstimate` ist zunächst immer true -> Resultat-Warnung
 * `provider_estimate` (Haftungskennzeichnung, F4-Goal).
 */
import { z } from "zod";

import { scaleRoofAnnualToReference } from "./ac-scale-v2";
import { mapProviderYearToQuarterSlots } from "./axis-v2";
import { QUARTER_HOUR_SLOTS } from "./engine-v2";
import {
  fetchPrinthorizonV2,
  fetchPVcalcSnapshotV2,
  fetchSeriescalcSnapshotV2,
} from "./fetch-v2";
import { buildHeatingDegreeSourceV2 } from "./degree-day-load-v2";
import { buildHeatPumpCopSourceV2 } from "./heat-pump-cop-v2";
import {
  buildExistingPvSeriesV2,
  degradationFactorV2,
} from "./existing-pv-v2";
import { buildH0BasisSourceV2 } from "./h0-load-v2";
import { customLoadProfileValueSchema } from "./contract";
import {
  buildCommercialIntervalSourceV2,
  buildCoolingDegreeSourceV2,
  buildCsvProfileSourceV2,
  buildEvPatternSourceV2,
  buildHotWaterProfileSourceV2,
  buildMonthlyProfileSourceV2,
} from "./load-shapes-v2";
import {
  MUNEER_WEIGHTS_ALBEDO,
  MUNEER_WEIGHTS_V2_VERSION,
  muneerQuarterWeightsV2,
  quarterGeometryForHourV2,
} from "./muneer-weights-v2";
import {
  PLANNING_ASSUMPTIONS_V2,
  PLANNING_ASSUMPTIONS_V2_VERSION,
  resolveRoofProviderInputsV2,
  type ResolvedRoofV2,
} from "./planning-assumptions-v2";
import {
  resolveTotalLoadProfile,
  type LoadProfileSourceV2,
} from "./load-v2";
import {
  assembleSlotPvEnergy,
  distributeScaledPowerToQuarters,
} from "./p-distribute-v2";
import {
  buildPrinthorizonUrl,
  type CanonicalHorizon,
} from "./horizon-v2";
import { southZeroToNorthClockwise } from "./preparation-v2";
import { existingPvContextV2Schema } from "./prepare-v2";
import {
  buildHorizontalSeriescalcUrl,
  buildRoofPVcalcUrl,
  buildRoofSeriescalcUrl,
  F401ProviderError,
  providerAspectDeg,
  type ParsedSeriescalcSnapshot,
  type RoofQuery,
} from "./provider-v2";
import type { ParsedPVcalcSnapshot } from "./pvcalc-v2";

function composeError(detail: string): never {
  throw new F401ProviderError(`Fetch-Komposition v2 verletzt: ${detail}`);
}

const siteSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type SnapshotTransportV2 = {
  fetchHorizon(url: string): Promise<CanonicalHorizon>;
  fetchSeries(url: string): Promise<ParsedSeriescalcSnapshot>;
  fetchHorizontal(url: string): Promise<ParsedSeriescalcSnapshot>;
  fetchAnnual(url: string): Promise<ParsedPVcalcSnapshot>;
};

export function defaultSnapshotTransportV2(): SnapshotTransportV2 {
  return {
    fetchHorizon: (url) => fetchPrinthorizonV2(url),
    fetchSeries: (url) => fetchSeriescalcSnapshotV2(url, { tilted: true }),
    fetchHorizontal: (url) => fetchSeriescalcSnapshotV2(url, { tilted: false }),
    fetchAnnual: (url) => fetchPVcalcSnapshotV2(url),
  };
}

const knownValueSchema = z.object({
  status: z.string(),
  value: z.number().nullish(),
});

const evPatternSchema = z.object({
  status: z.string(),
  value: z.string().nullish(),
});

const loadProfileSchema = z.object({
  status: z.string(),
  value: z.string().nullish(),
});

// Belegte Haushaltsformen (v1-Default und -Enum): H0 ersetzt beide
// v1-Wohnformen als belegte F4.2-Basis. Gewerbe (`commercial_interval.v1`)
// hat eine eigene v1-exakte Intervallform (kein BDEW-G0-Port noetig:
// v1 formt werktags 7-19h geschlossen).
const RESIDENTIAL_LOAD_PROFILES_V2 = [
  "wmee_household_hourly.v1",
  "customer_monthly_hourly.v1",
] as const;

const COMMERCIAL_LOAD_PROFILE_V2 = "commercial_interval.v1";
const MONTHLY_LOAD_PROFILE_V2 = "customer_monthly_hourly.v1";
const CSV_LOAD_PROFILE_V2 = "customer_csv.v1";

// F4.3: belegter thermischer WP-Bedarf mit optionalen Kennlinienparametern
// oder null (nicht belegt). Unbekannt/fehlend ist kein Fehler — erst der
// COP-Pfad ohne Thermalwerte bzw. belegte Werte ausserhalb der
// Vertragsbereiche brechen fail-closed ab.
function parseHeatPumpThermal(consumption: unknown): {
  thermalKwh: number;
  copNominal?: number;
  bivalenceTempC?: number;
  hotWaterShare?: number;
} | null {
  const holder = (consumption ?? {}) as Record<string, unknown>;
  const thermal = holder.heatPumpThermalKwhPerYear as
    | { status?: unknown; value?: unknown }
    | undefined;
  if (thermal === undefined || thermal.status !== "known") return null;
  if (typeof thermal.value !== "number" || !Number.isFinite(thermal.value) || thermal.value < 0) {
    composeError("Waermepumpe hat ungueltige thermische kWh");
  }
  const optionalParam = (key: string, name: string): number | undefined => {
    const entry = holder[key] as { status?: unknown; value?: unknown } | undefined;
    if (entry === undefined || entry.status !== "known") return undefined;
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      composeError(`${name} ist ungueltig`);
    }
    return entry.value;
  };
  return {
    thermalKwh: thermal.value,
    copNominal: optionalParam("heatPumpCopNominal", "COP-Nennwert"),
    bivalenceTempC: optionalParam("heatPumpBivalenceTempC", "Bivalenzpunkt"),
    hotWaterShare: optionalParam("heatPumpHotWaterShare", "Warmwasser-Anteil"),
  };
}

// Boden-Albedo aus belegtem Profil (0..1) oder fixture-gepinnter Default.
// Unbekannt/fehlend ist kein Fehler; ausserhalb [0,1] bricht der
// Muneer-Builder fail-closed ab (kein stiller Ersatzwert).
function parseAlbedo(consumption: unknown): number {
  const holder = (consumption ?? {}) as Record<string, unknown>;
  const entry = holder.groundAlbedo as
    | { status?: unknown; value?: unknown }
    | undefined;
  if (entry === undefined || entry.status !== "known") return MUNEER_WEIGHTS_ALBEDO;
  if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
    composeError("Boden-Albedo ist ungueltig");
  }
  return entry.value;
}

// F4.2: belegtes Custom-Lastprofil (12 Monats-kWh + optionale Tagesgänge)
// oder null (nicht belegt). Unbekannt/fehlend ist kein Fehler an sich —
// erst die Monatsprofil-Option ohne Werte bricht fail-closed ab.
function parseCustomLoadProfile(consumption: unknown): z.infer<typeof customLoadProfileValueSchema> | null {
  const holder = (consumption ?? {}) as { customLoadProfile?: unknown };
  const entry = holder.customLoadProfile as
    | { status?: unknown; value?: unknown }
    | undefined;
  if (entry === undefined || entry.status !== "known") return null;
  const parsed = customLoadProfileValueSchema.safeParse(entry.value);
  if (!parsed.success) composeError("Custom-Lastprofil ist ungueltig");
  return parsed.data;
}

// F4.2c: belegte Lastgang-CSV (exakt 8.760/35.040 endliche kWh >= 0,
// Summe > 0) oder null (nicht belegt). Unbekannt/fehlend ist kein Fehler
// an sich — erst die CSV-Option ohne Reihe bricht fail-closed ab.
function parseCustomCsv(consumption: unknown): number[] | null {
  const holder = (consumption ?? {}) as { customCsvKwh?: unknown };
  const entry = holder.customCsvKwh as
    | { status?: unknown; value?: unknown }
    | undefined;
  if (entry === undefined || entry.status !== "known") return null;
  if (!Array.isArray(entry.value)) composeError("Lastgang-CSV ist kein Array");
  const values = entry.value as unknown[];
  if (values.length !== 8_760 && values.length !== 35_040) {
    composeError(`Lastgang-CSV braucht 8760 oder 35040 Werte, gefunden: ${values.length}`);
  }
  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      composeError("Lastgang-CSV enthaelt ungueltige kWh");
    }
    numbers.push(value);
  }
  let sum = 0;
  for (const value of numbers) sum += value;
  if (!(sum > 0)) composeError("Lastgang-CSV hat keine positive Summe");
  return numbers;
}

const consumptionSchema = z.object({
  householdKwhPerYear: knownValueSchema,
  loadProfile: loadProfileSchema.optional(),
  // F4.2 Custom-Lastprofil (known/unknown-Hülle; Detailprüfung in
  // parseCustomLoadProfile gegen das strikte Vertragsschema).
  customLoadProfile: z.object({
    status: z.string(),
    value: z.unknown().optional(),
  }).optional(),
  // F4.2c Lastgang-CSV (known/unknown-Huelle; Detailpruefung in
  // parseCustomCsv).
  customCsvKwh: z.object({
    status: z.string(),
    value: z.unknown().optional(),
  }).optional(),
  evKmPerYear: knownValueSchema.optional(),
  evChargingPattern: evPatternSchema.optional(),
  heatPumpKwhPerYear: knownValueSchema.optional(),
  // F4.3 Waermepumpe mit COP-Kennlinie (thermischer Bedarf + optionale
  // Kennlinienparameter; Detailpruefung in parseHeatPumpCop gegen den
  // strikten Vertrag).
  heatPumpThermalKwhPerYear: knownValueSchema.optional(),
  heatPumpCopNominal: knownValueSchema.optional(),
  heatPumpBivalenceTempC: knownValueSchema.optional(),
  heatPumpHotWaterShare: knownValueSchema.optional(),
  // Boden-Albedo (Muneer-Reflexion; unbelegt = fixture-gepinnt 0.2).
  groundAlbedo: knownValueSchema.optional(),
  heatingAcKwhPerYear: knownValueSchema.optional(),
  coolingKwhPerYear: knownValueSchema.optional(),
  hotWaterKwhPerYear: knownValueSchema.optional(),
});

function knownKwh(
  entry: { status: string; value?: number | null } | undefined,
  name: string,
  requireKnown: boolean,
): number | null {
  if (entry === undefined || entry.status !== "known") {
    if (requireKnown) composeError(`${name} ist nicht belegt`);
    return null;
  }
  const value = entry.value;
  if (value === null || value === undefined) {
    if (requireKnown) composeError(`${name} ist nicht belegt`);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    composeError(`${name} hat ungueltige kWh`);
  }
  return value;
}

export type LoadContextV2 = {
  /** 35.040 Achsen-Slotlabels (H0-Datum/Wochentag). */
  slotLabels: readonly unknown[];
  /** Stundentemperaturen des Wetterjahrs (Heizgradstunden). */
  hourlyTemperatureC: ReadonlyMap<string, number>;
  /** 8.760 normalisierte Stundenzeiten in Achsenreihenfolge. */
  hourTimesInOrder: readonly string[];
};

/**
 * Belegtes Verbrauchsprofil -> Provenienz-Quellen: Haushalt als
 * Pflicht-Basis in BDEW-H0-Form, Gewerbe als v1-exakte Intervall-Basis,
 * Monatsprofil-Option als Monats-Basis aus belegten Monatswerten (F4.2);
 * Waermepumpe nach Heizgradstunden
 * (T2m-Wetterjahr); EV nach belegtem Ladepattern (km x Planungsfaktor),
 * Kuehlung nach Kuehlgradstunden, Warmwasser nach Tagesgang (v1-Ports,
 * `wmee-load-shapes.v1`). Zusatzlasten nur bei bekannten Werten > 0.
 * Unbekannte Zusatzlasten werden geskippt (sichtbar in sources[]);
 * unbekannte Basis verweigert fail-closed (kein erfundener Verbrauch).
 * EV-km ohne belegtes Pattern verweigern ebenfalls fail-closed (kein
 * erfundener Ladeplan).
 */
export function buildLoadSourcesFromProfileV2(
  profile: unknown,
  loadContext: LoadContextV2,
): LoadProfileSourceV2[] {
  const parsed = z.object({ consumption: consumptionSchema }).safeParse(profile);
  if (!parsed.success) composeError("Profil traegt keinen Verbrauch");
  const consumption = parsed.data.consumption;
  // Gewerbe laeuft als v1-exakte Intervall-Basis (`commercial_interval.v1`,
  // werktags 7-19h, Winterfaktor); unbekannte oder Wohnformen laufen als
  // H0-Basis (v1-Default ist Haushalt). Fremde Profilwerte bleiben
  // fail-closed (keine erfundene Lastform).
  const loadProfile = consumption.loadProfile;
  const commercial = loadProfile !== undefined
    && loadProfile.status === "known"
    && loadProfile.value === COMMERCIAL_LOAD_PROFILE_V2;
  // F4.2: Monatsprofil-Option verlangt belegte Monatswerte (bislang lief
  // sie still als H0 — erfundene Form). Monatswerte ohne Option ebenfalls
  // fail-closed (keine doppelte Basisdefinition).
  const monthlyOption = loadProfile !== undefined
    && loadProfile.status === "known"
    && loadProfile.value === MONTHLY_LOAD_PROFILE_V2;
  const monthly = parseCustomLoadProfile(consumption);
  if (monthlyOption && monthly === null) {
    composeError("Monatsprofil ohne Monatswerte ist nicht belegt");
  }
  if (!monthlyOption && monthly !== null) {
    composeError("Monatswerte ohne Monatsprofil-Option sind nicht belegt");
  }
  // F4.2c: CSV-Option verlangt die belegte Reihe (und umgekehrt) —
  // sonst fail-closed wie Monatswerte.
  const csvOption = loadProfile !== undefined
    && loadProfile.status === "known"
    && loadProfile.value === CSV_LOAD_PROFILE_V2;
  const csv = parseCustomCsv(consumption);
  if (csvOption && csv === null) {
    composeError("CSV-Profil ohne Lastgang-Reihe ist nicht belegt");
  }
  if (!csvOption && csv !== null) {
    composeError("Lastgang-Reihe ohne CSV-Profil-Option ist nicht belegt");
  }
  if (
    loadProfile !== undefined
    && loadProfile.status === "known"
    && loadProfile.value != null
    && !(RESIDENTIAL_LOAD_PROFILES_V2 as readonly string[]).includes(loadProfile.value)
    && loadProfile.value !== COMMERCIAL_LOAD_PROFILE_V2
    && loadProfile.value !== CSV_LOAD_PROFILE_V2
  ) {
    composeError("Gewerbe-Lastprofil ist nicht belegt");
  }
  const basisKwh = knownKwh(
    consumption.householdKwhPerYear,
    commercial ? "Gewerbe" : "Haushalt",
    // F4.2: Monatssumme ist die Jahres-Basis (Reonic: Summe separat);
    // householdKwhPerYear muss dann unbekannt sein oder im Rundungsband
    // (±0,06 kWh = 12 × halber Cent) liegen — sonst Widerspruch. F4.2c:
    // CSV-Summe ist die Jahres-Basis (gleiches Band).
    monthly !== null || csv !== null ? false : true,
  ) as number | null;
  if (monthly !== null) {
    const monthlySum = monthly.monthlyKwh.reduce((sum, kwh) => sum + kwh, 0);
    if (basisKwh !== null && Math.abs(monthlySum - basisKwh) > 0.06) {
      composeError("Monatssumme widerspricht der Jahres-kWh");
    }
  }
  if (csv !== null) {
    const csvSum = csv.reduce((sum, kwh) => sum + kwh, 0);
    if (basisKwh !== null && Math.abs(csvSum - basisKwh) > 0.06) {
      composeError("CSV-Summe widerspricht der Jahres-kWh");
    }
  }
  const sources: LoadProfileSourceV2[] = [
    monthly !== null
      ? buildMonthlyProfileSourceV2({
        monthlyKwh: monthly.monthlyKwh,
        weekdayHourlyKwh: monthly.weekdayHourlyKwh,
        weekendHourlyKwh: monthly.weekendHourlyKwh,
        slotLabels: loadContext.slotLabels,
      })
      : csv !== null
        ? buildCsvProfileSourceV2({ values: csv })
        : commercial
        ? buildCommercialIntervalSourceV2({
          annualKwh: basisKwh as number,
          slotLabels: loadContext.slotLabels,
        })
        : buildH0BasisSourceV2({
          annualKwh: basisKwh as number,
          slotLabels: loadContext.slotLabels,
        }),
  ];
  const evKm = knownKwh(consumption.evKmPerYear, "EV", false);
  if (evKm !== null && evKm > 0) {
    const pattern = consumption.evChargingPattern;
    if (pattern === undefined || pattern.status !== "known" || pattern.value == null) {
      composeError("EV-Ladepattern ist nicht belegt");
    }
    sources.push(buildEvPatternSourceV2({
      annualKwh: evKm * PLANNING_ASSUMPTIONS_V2.load.evKwhPerKm,
      pattern: pattern.value,
      slotLabels: loadContext.slotLabels,
    }));
  }
  // F4.3: belegter thermischer WP-Bedarf laeuft ueber die COP-Kennlinie;
  // legacy-elektrische kWh daneben sind ein Widerspruch (keine stille
  // Praezedenz). Ohne Thermalwerte rechnet die legacy Gradquelle weiter
  // (byte-identische SHAs).
  const heatThermal = parseHeatPumpThermal(consumption);
  const heatKwh = knownKwh(consumption.heatPumpKwhPerYear, "Waermepumpe", false);
  // Legacy-Null (explizit 0 kWh) zaehlt nicht als Belegung.
  if (heatThermal !== null && heatKwh !== null && heatKwh > 0) {
    composeError("Waermepumpe thermisch und elektrisch zugleich belegt");
  }
  if (heatThermal !== null) {
    if (heatThermal.thermalKwh > 0) {
      sources.push(buildHeatPumpCopSourceV2({
        thermalKwh: heatThermal.thermalKwh,
        copNominal: heatThermal.copNominal,
        bivalenceTempC: heatThermal.bivalenceTempC,
        hotWaterShare: heatThermal.hotWaterShare,
        hourlyTemperatureC: loadContext.hourlyTemperatureC,
        hourTimesInOrder: loadContext.hourTimesInOrder,
      }));
    }
  } else if (heatKwh !== null && heatKwh > 0) {
    sources.push(buildHeatingDegreeSourceV2({
      annualKwh: heatKwh,
      hourlyTemperatureC: loadContext.hourlyTemperatureC,
      hourTimesInOrder: loadContext.hourTimesInOrder,
    }));
  }
  // Heizungs-Klimatisierung: v1 formt sie mit denselben Heizgradstunden
  // (eigene Quelle/Provenienz, kein stilles Fallenlassen belegter kWh).
  const heatingAcKwh = knownKwh(
    consumption.heatingAcKwhPerYear,
    "Heizungs-Klimatisierung",
    false,
  );
  if (heatingAcKwh !== null && heatingAcKwh > 0) {
    sources.push(buildHeatingDegreeSourceV2({
      annualKwh: heatingAcKwh,
      hourlyTemperatureC: loadContext.hourlyTemperatureC,
      hourTimesInOrder: loadContext.hourTimesInOrder,
      variant: "heating_ac",
    }));
  }
  const coolingKwh = knownKwh(consumption.coolingKwhPerYear, "Kuehlung", false);
  if (coolingKwh !== null && coolingKwh > 0) {
    sources.push(buildCoolingDegreeSourceV2({
      annualKwh: coolingKwh,
      hourlyTemperatureC: loadContext.hourlyTemperatureC,
      hourTimesInOrder: loadContext.hourTimesInOrder,
    }));
  }
  const hotWaterKwh = knownKwh(consumption.hotWaterKwhPerYear, "Warmwasser", false);
  if (hotWaterKwh !== null && hotWaterKwh > 0) {
    sources.push(buildHotWaterProfileSourceV2({
      annualKwh: hotWaterKwh,
      slotLabels: loadContext.slotLabels,
    }));
  }
  return sources;
}

export type ComposedRoofProvenanceV2 = {
  roofId: string;
  seriesUrl: string;
  annualUrl: string;
  seriesSha256: string;
  annualSha256: string;
  annualReferenceKwhPerKwp: number;
  scaleFactor: number;
  /** Effektive Boden-Albedo (Profil oder fixture-gepinnt 0.2). */
  albedo: number;
};

export type ComposedSeriesProvenanceV2 = {
  paramsVersion: typeof PLANNING_ASSUMPTIONS_V2_VERSION;
  subhourMethod: typeof MUNEER_WEIGHTS_V2_VERSION;
  horizonSha256: string;
  horizontalUrl: string;
  horizontalSha256: string;
  roofs: ComposedRoofProvenanceV2[];
  loadSourceIds: string[];
};

export type ComposedPlanningSeriesV2 = {
  pvKwh: number[];
  loadKwh: number[];
  providerEstimate: true;
  /**
   * Slice A: Bestands-Reihe (nur Bestand-Branch mit belegter Anlage;
   * sonst null). Der Run nutzt sie erst ab Slice B (Gate bleibt).
   */
  existingPvKwh: number[] | null;
  provenance: ComposedSeriesProvenanceV2;
};

function roofQuery(
  site: { latitude: number; longitude: number },
  roof: ResolvedRoofV2,
  horizon: readonly number[],
): RoofQuery {
  return {
    latitude: site.latitude,
    longitude: site.longitude,
    pvTechnology: roof.pvTechnology,
    mountingPlace: roof.mountingPlace,
    systemLossPercent: roof.systemLossPercent,
    providerTiltDeg: roof.tiltDeg,
    // Aufgeloeste Daecher tragen Sued-Null-Azimute (v1-Profilschema);
    // providerAspectDeg spiegelt exakt diese Konvention (f401-gepinnt).
    providerAspectDeg: providerAspectDeg(roof.azimuthDeg),
    canonicalHorizon: horizon,
  };
}

function verifySiteEcho(
  snapshot: { site: { latitude: number; longitude: number } },
  site: { latitude: number; longitude: number },
  name: string,
): void {
  if (
    snapshot.site.latitude !== site.latitude
    || snapshot.site.longitude !== site.longitude
  ) {
    composeError(`${name} antwortet auf fremden Standort`);
  }
}

export type HorizontalHourV2 = {
  beamWhPerM2: number;
  diffuseWhPerM2: number;
  temperatureC: number;
};

async function composeRoofPower(
  site: { latitude: number; longitude: number },
  roof: ResolvedRoofV2,
  horizon: readonly number[],
  horizontalByTime: ReadonlyMap<string, HorizontalHourV2>,
  transport: SnapshotTransportV2,
  albedo: number,
): Promise<{
  roofId: string;
  peakPowerKwp: number;
  powerWPerKwp: number[];
  provenance: ComposedRoofProvenanceV2;
}> {
  const query = roofQuery(site, roof, horizon);
  const seriesUrl = buildRoofSeriescalcUrl(query);
  const annualUrl = buildRoofPVcalcUrl(query);
  const [series, annual] = await Promise.all([
    transport.fetchSeries(seriesUrl),
    transport.fetchAnnual(annualUrl),
  ]);
  verifySiteEcho(series, site, "seriescalc");
  verifySiteEcho(annual, site, "PVcalc");
  if (series.hours.length !== 8784) {
    composeError(`seriescalc liefert ${series.hours.length} statt 8784 Stunden`);
  }
  if (
    annual.mounting.tiltDeg !== roof.tiltDeg
    || annual.mounting.aspectDeg !== query.providerAspectDeg
  ) {
    composeError("PVcalc spiegelt fremde Dachgeometrie");
  }
  const times = series.hours.map((hour) => hour.time);
  const slots = mapProviderYearToQuarterSlots(times);
  const powerByTime = new Map<string, number>();
  for (const hour of series.hours) {
    // Parser garantiert P fuer tilted:true; null waere ein unbekannter
    // Zustand -> fail-closed statt stiller Nullleistung.
    if (hour.p === null) composeError("geneigte Stunde ohne P");
    powerByTime.set(hour.time, hour.p);
  }
  const seen = new Set<string>();
  const hourly: number[] = [];
  const hourIndexOfHour: number[] = [];
  for (const slot of slots) {
    if (seen.has(slot.providerObservedAtUtc)) continue;
    seen.add(slot.providerObservedAtUtc);
    const power = powerByTime.get(slot.providerObservedAtUtc);
    if (power === null || power === undefined) {
      composeError("Stundenleistung fehlt im seriescalc");
    }
    hourly.push(power);
    hourIndexOfHour.push(slot.hourIndex);
  }
  if (hourly.length !== 8760) {
    composeError(`normalisierte Dachreihe hat ${hourly.length} statt 8760 Stunden`);
  }
  const { scaleFactor, pScaled } = scaleRoofAnnualToReference(
    hourly,
    annual.annualReferenceKwhPerKwp,
  );
  // Muneer-Flaeche: Aufgeloeste Daecher tragen Sued-Null-Azimute
  // (v1-Profilschema); die Konvention wandelt exakt nach Nord (preparation-v2).
  // Albedo kommt aus dem Profil (Default 0.2); der Builder validiert 0..1.
  const surface = {
    tiltDeg: roof.tiltDeg,
    azimuthDegNorth: southZeroToNorthClockwise(roof.azimuthDeg),
    albedo,
  };
  const hourPosition = new Map<number, number>();
  hourIndexOfHour.forEach((hourIndex, position) => {
    hourPosition.set(hourIndex, position);
  });
  const hourInstants = new Map<number, [string, string, string, string]>();
  for (const slot of slots) {
    let entry = hourInstants.get(slot.hourIndex);
    if (entry === undefined) {
      entry = ["", "", "", ""];
      hourInstants.set(slot.hourIndex, entry);
    }
    entry[slot.quarterIndex] = slot.evaluationInstantUtc;
  }
  const powerWPerKwp = new Array<number>(QUARTER_HOUR_SLOTS);
  const distributed = new Map<number, readonly [number, number, number, number]>();
  for (const slot of slots) {
    let quarters = distributed.get(slot.hourIndex);
    if (quarters === undefined) {
      const position = hourPosition.get(slot.hourIndex);
      if (position === undefined) composeError("Stundenindex fehlt in Dachreihe");
      const horizontal = horizontalByTime.get(slot.providerObservedAtUtc);
      if (horizontal === undefined) {
        composeError("horizontale Stunde fehlt im seriescalc");
      }
      const instants = hourInstants.get(slot.hourIndex);
      if (instants === undefined || instants.some((instant) => instant === "")) {
        composeError("Auswertezeitpunkte der Stunde fehlen");
      }
      quarters = distributeScaledPowerToQuarters(
        pScaled[position]!,
        muneerQuarterWeightsV2({
          beamHourWhPerM2: horizontal.beamWhPerM2,
          diffuseHourWhPerM2: horizontal.diffuseWhPerM2,
          quarterGeometry: quarterGeometryForHourV2({
            latitude: site.latitude,
            longitude: site.longitude,
            quarterInstantsUtc: instants,
          }),
          horizonHeights48: horizon,
          surface,
        }),
      );
      distributed.set(slot.hourIndex, quarters);
    }
    powerWPerKwp[slot.slot] = quarters[slot.quarterIndex]!;
  }
  return {
    roofId: roof.roofId,
    peakPowerKwp: roof.peakPowerKwp,
    powerWPerKwp,
    provenance: {
      roofId: roof.roofId,
      seriesUrl,
      annualUrl,
      seriesSha256: series.rawSha256,
      annualSha256: annual.rawSha256,
      annualReferenceKwhPerKwp: annual.annualReferenceKwhPerKwp,
      scaleFactor,
      albedo,
    },
  };
}

export async function fetchPlanningSeriesV2(input: {
  request: unknown;
  transport?: SnapshotTransportV2;
}): Promise<ComposedPlanningSeriesV2> {
  // Einzige Fetch-Anfrage ist die eingefrorene Claim-Sicht
  // (PlanningCalculationProviderRequestV2): Geokoordinaten, Profil-Daecher,
  // Verbrauch plus Branch/Stichtag/Bestand-Kontext (Slice A). Dach- und
  // Lastaufloesung validieren je fail-closed.
  const parsed = z.object({
    latitude: z.number(),
    longitude: z.number(),
    roofs: z.unknown(),
    consumption: z.unknown(),
    branch: z.enum(["new_installation", "existing_installation"]),
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    existingPv: z.unknown(),
  }).safeParse(input.request);
  if (!parsed.success) composeError("Fetch-Anfrage ist ungueltig");
  const parsedSite = siteSchema.safeParse({
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
  });
  if (!parsedSite.success) composeError("Standort ist ungueltig");
  const site = {
    latitude: roundCoordinate(parsedSite.data.latitude),
    longitude: roundCoordinate(parsedSite.data.longitude),
  };
  const requestRoofs = Array.isArray(parsed.data.roofs) ? parsed.data.roofs : [];
  const roofs = resolveRoofProviderInputsV2({
    roofs: requestRoofs.map((roof) => {
      const entry = roof as Partial<{
        roofId: unknown;
        tiltDeg: unknown;
        azimuthDeg: unknown;
        areaM2: unknown;
      }>;
      return {
        id: entry.roofId,
        tiltDeg: entry.tiltDeg,
        azimuthDeg: entry.azimuthDeg,
        areaM2: entry.areaM2,
      };
    }),
  });
  const transport = input.transport ?? defaultSnapshotTransportV2();
  const horizontalUrl = buildHorizontalSeriescalcUrl(site);
  const [horizon, horizontal] = await Promise.all([
    transport.fetchHorizon(buildPrinthorizonUrl(site)),
    transport.fetchHorizontal(horizontalUrl),
  ]);
  if (!Array.isArray(horizon.heights) || horizon.heights.length !== 48) {
    composeError("Horizont hat nicht 48 Hoehen");
  }
  verifySiteEcho(horizontal, site, "horizontal-seriescalc");
  if (horizontal.hours.length !== 8784) {
    composeError(`horizontal-seriescalc liefert ${horizontal.hours.length} statt 8784 Stunden`);
  }
  const horizontalByTime = new Map<string, HorizontalHourV2>();
  for (const hour of horizontal.hours) {
    horizontalByTime.set(hour.time, {
      beamWhPerM2: hour.gb,
      diffuseWhPerM2: hour.gd,
      temperatureC: hour.t2m,
    });
  }
  // H0-Basis folgt den Achsenlabels der standortweiten Horizontalreihe
  // (Berliner Standardzeit-Daten, gleiche Achse wie die Daecherserien);
  // Heizgradstunden nutzen deren T2m in normalisierter Stundenfolge.
  const horizontalSlots = mapProviderYearToQuarterSlots(
    horizontal.hours.map((hour) => hour.time),
  );
  const seenHours = new Set<string>();
  const hourTimesInOrder: string[] = [];
  for (const slot of horizontalSlots) {
    if (seenHours.has(slot.providerObservedAtUtc)) continue;
    seenHours.add(slot.providerObservedAtUtc);
    hourTimesInOrder.push(slot.providerObservedAtUtc);
  }
  const hourlyTemperatureC = new Map<string, number>();
  for (const time of hourTimesInOrder) {
    hourlyTemperatureC.set(time, horizontalByTime.get(time)!.temperatureC);
  }
  const total = resolveTotalLoadProfile(
    buildLoadSourcesFromProfileV2(
      { consumption: parsed.data.consumption },
      {
        slotLabels: horizontalSlots.map((slot) => slot.slotLabel),
        hourlyTemperatureC,
        hourTimesInOrder,
      },
    ),
  );
  const albedo = parseAlbedo(parsed.data.consumption);
  const composed = await Promise.all(
    roofs.map((roof) => composeRoofPower(site, roof, horizon.heights, horizontalByTime, transport, albedo)),
  );
  const pvKwh = assembleSlotPvEnergy(composed.map((roof) => ({
    roofId: roof.roofId,
    peakPowerKwp: roof.peakPowerKwp,
    powerWPerKwp: roof.powerWPerKwp,
  })));
  // Slice A: Bestands-Reihe nur im Bestand-Branch mit belegter Anlage
  // (v1 verlangt `known_present`, sonst fail-closed); Neuanlage -> null.
  // Der Run bleibt bis Slice B gegated und nutzt die Reihe noch nicht.
  let existingPvKwh: number[] | null = null;
  if (parsed.data.branch === "existing_installation") {
    const existingParsed = existingPvContextV2Schema.safeParse(parsed.data.existingPv);
    if (!existingParsed.success) composeError("Bestands-PV ist nicht belegt");
    const context = existingParsed.data;
    if (context.status !== "known_present") {
      composeError("Bestands-PV ist nicht belegt");
    }
    const asOfYear = Number(parsed.data.asOfDate.slice(0, 4));
    if (!Number.isInteger(asOfYear)) composeError("Stichtag ist ungueltig");
    const built = buildExistingPvSeriesV2({
      roofs: composed.map((roof, index) => ({
        roofId: roof.roofId,
        areaM2: roofs[index]!.areaM2,
        newPowerWPerKwp: roof.powerWPerKwp,
      })),
      existingKwp: context.peakPowerKwp,
      degradationFactor: degradationFactorV2({
        commissioningYear: context.commissioningYear,
        asOfYear,
      }),
    });
    existingPvKwh = built.existingPvKwh;
  }
  return {
    pvKwh,
    loadKwh: [...total.slotEnergyKwh],
    providerEstimate: true,
    existingPvKwh,
    provenance: {
      paramsVersion: PLANNING_ASSUMPTIONS_V2_VERSION,
      subhourMethod: MUNEER_WEIGHTS_V2_VERSION,
      horizonSha256: horizon.rawSha256,
      horizontalUrl,
      horizontalSha256: horizontal.rawSha256,
      roofs: composed.map((roof) => roof.provenance),
      loadSourceIds: total.sources.map((source) => source.sourceId),
    },
  };
}
