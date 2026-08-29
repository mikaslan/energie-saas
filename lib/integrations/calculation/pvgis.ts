import { createHash } from "node:crypto";
import { z } from "zod";

import type { PlanningCalculationRequestV1 } from "./contract";

const DEFAULT_BASE_URL = "https://re.jrc.ec.europa.eu/api/v5_3";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const WEATHER_YEAR = 2020;
const SOURCE_HOURS = 8_784;
const TARGET_HOURS = 8_760;
const RADIATION_DATABASE = "PVGIS-SARAH3";
const TARGET_TIME_ZONE = "Europe/Berlin";

type YieldSnapshot = PlanningCalculationRequestV1["yieldSnapshots"][number];

export type PvgisProviderErrorCode =
  | "provider_configuration"
  | "provider_invalid_request"
  | "provider_invalid_response"
  | "provider_rate_limited"
  | "provider_overloaded"
  | "provider_http_error"
  | "provider_timeout"
  | "provider_unavailable";

export class PvgisProviderError extends Error {
  declare readonly retryAfterMs?: number;

  constructor(
    public readonly code: PvgisProviderErrorCode,
    public readonly retryable: boolean,
    retryAfterMs?: number,
  ) {
    super("PVGIS provider request failed");
    if (retryAfterMs !== undefined) {
      Object.defineProperty(this, "retryAfterMs", {
        configurable: false,
        enumerable: true,
        value: retryAfterMs,
        writable: false,
      });
    }
  }
}

const finiteNumber = z.number().finite();

const requestSchema = z.object({
  latitude: finiteNumber.min(-90).max(90),
  longitude: finiteNumber.min(-180).max(180),
  roofs: z.array(z.object({
    roofId: z.string().trim().min(1).max(64),
    tiltDeg: finiteNumber.min(0).max(90),
    azimuthDeg: finiteNumber.min(-180).max(180),
  })).min(1).max(4),
});

const providerInputsSchema = z.object({
  location: z.object({
    latitude: finiteNumber,
    longitude: finiteNumber,
  }),
  meteo_data: z.object({
    radiation_db: z.string(),
    year_min: z.number().int().optional(),
    year_max: z.number().int().optional(),
    use_horizon: z.boolean(),
  }),
  mounting_system: z.object({
    fixed: z.object({
      slope: z.object({ value: finiteNumber, optimal: z.boolean() }),
      azimuth: z.object({ value: finiteNumber, optimal: z.boolean() }),
      type: z.string(),
    }),
  }),
  pv_module: z.object({
    technology: z.string(),
    peak_power: finiteNumber,
    system_loss: finiteNumber,
  }),
});

const annualEnvelopeSchema = z.object({
  inputs: providerInputsSchema,
  outputs: z.object({
    monthly: z.object({
      fixed: z.array(z.object({
        month: z.number().int(),
        E_m: finiteNumber,
      })),
    }),
    totals: z.object({
      fixed: z.object({ E_y: finiteNumber }),
    }),
  }),
});

const hourlyEnvelopeSchema = z.object({
  inputs: providerInputsSchema,
  outputs: z.object({
    hourly: z.array(z.object({
      time: z.string(),
      P: finiteNumber,
      T2m: finiteNumber,
    })),
  }),
});

type ParsedRequest = z.infer<typeof requestSchema>;
type RoofRequest = ParsedRequest["roofs"][number];
type ProviderInputs = z.infer<typeof providerInputsSchema>;

type RawJson = {
  rawText: string;
  value: unknown;
};

function providerError(
  code: PvgisProviderErrorCode,
  retryable = false,
  retryAfterMs?: number,
): PvgisProviderError {
  return new PvgisProviderError(code, retryable, retryAfterMs);
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function providerBaseUrl(): string {
  const override = process.env.PVGIS_BASE_URL?.trim();
  if (!override) return DEFAULT_BASE_URL;
  if (process.env.NODE_ENV === "production") throw providerError("provider_configuration");

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw providerError("provider_configuration");
  }

  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  const path = parsed.pathname.replace(/\/$/u, "");
  if (
    !loopback
    || (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || path !== "/api/v5_3"
  ) {
    throw providerError("provider_configuration");
  }
  return `${parsed.origin}${path}`;
}

function discardBody(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => undefined);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  let milliseconds: number;
  if (/^\d+$/u.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    milliseconds = Math.max(0, at - Date.now());
  }
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(Math.round(milliseconds), MAX_RETRY_AFTER_MS);
}

function assertSuccessfulResponse(response: Response): void {
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response);
    discardBody(response);
    throw providerError("provider_rate_limited", true, retryAfter);
  }
  if (response.status === 529) {
    const retryAfter = retryAfterMs(response);
    discardBody(response);
    throw providerError("provider_overloaded", true, retryAfter);
  }
  if (response.status >= 500 && response.status <= 599) {
    const retryAfter = retryAfterMs(response);
    discardBody(response);
    throw providerError("provider_unavailable", true, retryAfter);
  }
  if (!response.ok) {
    discardBody(response);
    throw providerError("provider_http_error");
  }

  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    discardBody(response);
    throw providerError("provider_invalid_response");
  }

  const contentLength = response.headers.get("content-length")?.trim();
  if (
    contentLength !== undefined
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    discardBody(response);
    throw providerError("provider_invalid_response");
  }
}

async function readLimitedJson(response: Response): Promise<RawJson> {
  assertSuccessfulResponse(response);
  if (!response.body) throw providerError("provider_invalid_response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw providerError("provider_invalid_response");
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { rawText, value: JSON.parse(rawText) as unknown };
  } catch {
    throw providerError("provider_invalid_response");
  }
}

function requestParameters(
  coordinates: { latitude: number; longitude: number },
  roof: RoofRequest,
  tool: "PVcalc" | "seriescalc",
): Record<string, string> {
  const parameters: Record<string, string> = {
    lat: String(coordinates.latitude),
    lon: String(coordinates.longitude),
    raddatabase: RADIATION_DATABASE,
    peakpower: "1",
    loss: "14",
    angle: String(roof.tiltDeg),
    aspect: String(roof.azimuthDeg),
    pvtechchoice: "crystSi",
    mountingplace: "free",
    usehorizon: "1",
    outputformat: "json",
  };
  if (tool === "seriescalc") {
    parameters.pvcalculation = "1";
    parameters.startyear = String(WEATHER_YEAR);
    parameters.endyear = String(WEATHER_YEAR);
    parameters.trackingtype = "0";
  }
  return parameters;
}

async function requestTool(
  baseUrl: string,
  coordinates: { latitude: number; longitude: number },
  roof: RoofRequest,
  tool: "PVcalc" | "seriescalc",
  signal: AbortSignal,
  didTimeOut: () => boolean,
): Promise<RawJson> {
  const url = new URL(`${baseUrl}/${tool}`);
  const parameters = requestParameters(coordinates, roof, tool);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
    return await readLimitedJson(response);
  } catch (error) {
    if (error instanceof PvgisProviderError) throw error;
    if (didTimeOut()) throw providerError("provider_timeout", true);
    throw providerError("provider_unavailable", true);
  }
}

function inputsMatch(
  inputs: ProviderInputs,
  coordinates: { latitude: number; longitude: number },
  roof: RoofRequest,
  hourly: boolean,
): boolean {
  return inputs.location.latitude === coordinates.latitude
    && inputs.location.longitude === coordinates.longitude
    && inputs.meteo_data.radiation_db === RADIATION_DATABASE
    && inputs.meteo_data.use_horizon
    && (!hourly
      || (inputs.meteo_data.year_min === WEATHER_YEAR
        && inputs.meteo_data.year_max === WEATHER_YEAR))
    && inputs.mounting_system.fixed.slope.value === roof.tiltDeg
    && !inputs.mounting_system.fixed.slope.optimal
    && inputs.mounting_system.fixed.azimuth.value === roof.azimuthDeg
    && !inputs.mounting_system.fixed.azimuth.optimal
    && inputs.mounting_system.fixed.type === "free-standing"
    && inputs.pv_module.technology === "c-Si"
    && inputs.pv_module.peak_power === 1
    && inputs.pv_module.system_loss === 14;
}

function sha256(rawText: string): string {
  return createHash("sha256").update(rawText, "utf8").digest("hex");
}

function expectedPvgisHour(index: number): string {
  const date = new Date(Date.UTC(WEATHER_YEAR, 0, 1, index));
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${year}${month}${day}:${hour}`;
}

function parseHourlySeries(rows: z.infer<typeof hourlyEnvelopeSchema>["outputs"]["hourly"]): {
  sourceTimestampsUtc: string[];
  powerW: number[];
  temperatureC: number[];
} {
  if (rows.length !== SOURCE_HOURS) throw providerError("provider_invalid_response");

  const sourceTimestampsUtc = new Array<string>(SOURCE_HOURS);
  const powerW = new Array<number>(SOURCE_HOURS);
  const temperatureC = new Array<number>(SOURCE_HOURS);
  for (let index = 0; index < SOURCE_HOURS; index += 1) {
    const row = rows[index];
    const timestamp = /^(\d{8}:\d{2})(\d{2})$/u.exec(row.time);
    if (
      timestamp === null
      || timestamp[1] !== expectedPvgisHour(index)
      || Number(timestamp[2]) > 59
      || row.P < 0
      || row.P > 10_000
      || row.T2m < -100
      || row.T2m > 100
    ) {
      throw providerError("provider_invalid_response");
    }
    sourceTimestampsUtc[index] = new Date(Date.UTC(WEATHER_YEAR, 0, 1, index)).toISOString();
    powerW[index] = row.P;
    temperatureC[index] = row.T2m;
  }
  return { sourceTimestampsUtc, powerW, temperatureC };
}

let localHourMapping: Int32Array | undefined;

function utcToBerlinLocal(values: number[]): number[] {
  if (localHourMapping === undefined) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: TARGET_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    localHourMapping = new Int32Array(SOURCE_HOURS);
    for (let sourceHour = 0; sourceHour < SOURCE_HOURS; sourceHour += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(Date.UTC(WEATHER_YEAR, 0, 1, sourceHour)))
          .map((part) => [part.type, part.value]),
      );
      const localAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
      );
      let targetHour = Math.round(
        (localAsUtc - Date.UTC(Number(parts.year), 0, 1)) / 3_600_000,
      );
      if (targetHour < 0) targetHour += SOURCE_HOURS;
      if (targetHour >= SOURCE_HOURS) targetHour -= SOURCE_HOURS;
      localHourMapping[sourceHour] = targetHour;
    }
  }

  const localized = new Array<number>(SOURCE_HOURS).fill(0);
  for (let sourceHour = 0; sourceHour < SOURCE_HOURS; sourceHour += 1) {
    localized[localHourMapping[sourceHour]] = values[sourceHour] ?? 0;
  }
  for (let hour = 1; hour < SOURCE_HOURS - 1; hour += 1) {
    if (localized[hour] === 0 && localized[hour - 1] !== 0 && localized[hour + 1] !== 0) {
      localized[hour] = Math.round((localized[hour - 1] + localized[hour + 1]) / 2);
    }
  }
  return localized;
}

function dropLocalFebruary29(values: number[]): number[] {
  const february29Start = (31 + 28) * 24;
  return [
    ...values.slice(0, february29Start),
    ...values.slice(february29Start + 24),
  ].slice(0, TARGET_HOURS);
}

function normalizeHourly(values: number[]): number[] {
  return dropLocalFebruary29(utcToBerlinLocal(values));
}

function annualValues(
  parsed: z.infer<typeof annualEnvelopeSchema>,
): { annual: number; monthly: number[] } {
  const annual = parsed.outputs.totals.fixed.E_y;
  if (annual < 0 || annual > 10_000) throw providerError("provider_invalid_response");

  const monthly: number[] = [];
  const seenMonths = new Set<number>();
  for (const entry of parsed.outputs.monthly.fixed) {
    if (
      entry.month < 1
      || entry.month > 12
      || seenMonths.has(entry.month)
      || entry.E_m < 0
      || entry.E_m > 2_000
    ) {
      throw providerError("provider_invalid_response");
    }
    seenMonths.add(entry.month);
    monthly[entry.month - 1] = entry.E_m;
  }
  if (seenMonths.size !== 12 || monthly.length !== 12) {
    throw providerError("provider_invalid_response");
  }
  return { annual, monthly };
}

async function snapshotForRoof(
  baseUrl: string,
  coordinates: { latitude: number; longitude: number },
  roof: RoofRequest,
  fetchedAt: string,
  signal: AbortSignal,
  didTimeOut: () => boolean,
): Promise<YieldSnapshot> {
  const [annualRaw, hourlyRaw] = await Promise.all([
    requestTool(baseUrl, coordinates, roof, "PVcalc", signal, didTimeOut),
    requestTool(baseUrl, coordinates, roof, "seriescalc", signal, didTimeOut),
  ]);
  const annualParsed = annualEnvelopeSchema.safeParse(annualRaw.value);
  const hourlyParsed = hourlyEnvelopeSchema.safeParse(hourlyRaw.value);
  if (
    !annualParsed.success
    || !hourlyParsed.success
    || !inputsMatch(annualParsed.data.inputs, coordinates, roof, false)
    || !inputsMatch(hourlyParsed.data.inputs, coordinates, roof, true)
  ) {
    throw providerError("provider_invalid_response");
  }

  const annual = annualValues(annualParsed.data);
  const hourly = parseHourlySeries(hourlyParsed.data.outputs.hourly);
  const normalizedPower = normalizeHourly(hourly.powerW);
  const normalizedTemperature = normalizeHourly(hourly.temperatureC);
  const hourlyAnnualKwh = normalizedPower.reduce((sum, value) => sum + value, 0) / 1_000;
  if (hourlyAnnualKwh <= 0 && annual.annual > 0) {
    throw providerError("provider_invalid_response");
  }
  const scale = hourlyAnnualKwh === 0 ? 0 : annual.annual / hourlyAnnualKwh;
  const scaledPower = normalizedPower.map((value) => value * scale);
  if (scaledPower.some((value) => !Number.isFinite(value) || value < 0 || value > 10_000)) {
    throw providerError("provider_invalid_response");
  }

  return {
    roofId: roof.roofId,
    provider: "pvgis",
    apiVersion: "5_3",
    radiationDatabase: RADIATION_DATABASE,
    request: {
      queryContractVersion: "pvgis-query.v1",
      coordinateRounding: "pvgis-coordinate-rounding-3dp.v1",
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      tiltDeg: roof.tiltDeg,
      azimuthDeg: roof.azimuthDeg,
      azimuthConvention: "pvgis_south_zero_east_negative",
      peakPowerKwp: 1,
      systemLossPercent: 14,
      pvCalculation: true,
      pvTechnology: "crystSi",
      mountingPlace: "free",
      useHorizon: true,
      trackingType: 0,
      outputFormat: "json",
    },
    annual: {
      tool: "PVcalc",
      fetchedAt,
      rawResponseSha256: sha256(annualRaw.rawText),
      annualYieldKwhPerKwp: annual.annual,
      monthlyYieldKwhPerKwp: annual.monthly,
    },
    hourly: {
      tool: "seriescalc",
      weatherYear: WEATHER_YEAR,
      startYear: WEATHER_YEAR,
      endYear: WEATHER_YEAR,
      fetchedAt,
      rawResponseSha256: sha256(hourlyRaw.rawText),
      sourceLength: SOURCE_HOURS,
      sourceTimeBasis: "utc",
      sourceTimestampsUtc: hourly.sourceTimestampsUtc,
      normalization: "pvgis_utc_to_europe_berlin_then_drop_feb_29.v1",
      targetTimeZone: TARGET_TIME_ZONE,
      normalizedHourConvention: "local_non_leap_jan01_00.v1",
      annualScaling: "scale_hourly_shape_to_pvcalc_annual.v1",
      hourlyPowerWPerKwp: scaledPower,
      hourlyTemperatureC: normalizedTemperature,
    },
  };
}

export async function fetchPvgisYieldSnapshots(input: unknown): Promise<YieldSnapshot[]> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.roofs.map((roof) => roof.roofId)).size
    !== parsed.data.roofs.length) {
    throw providerError("provider_invalid_request");
  }

  const baseUrl = providerBaseUrl();
  const coordinates = {
    latitude: roundCoordinate(parsed.data.latitude),
    longitude: roundCoordinate(parsed.data.longitude),
  };
  const roofs = [...parsed.data.roofs].sort((left, right) =>
    left.roofId < right.roofId ? -1 : left.roofId > right.roofId ? 1 : 0,
  );
  const fetchedAt = new Date().toISOString();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const snapshots = await Promise.all(roofs.map((roof) => snapshotForRoof(
      baseUrl,
      coordinates,
      roof,
      fetchedAt,
      controller.signal,
      () => timedOut,
    )));
    const referenceTemperature = snapshots[0]?.hourly.hourlyTemperatureC;
    if (
      referenceTemperature === undefined
      || snapshots.some((snapshot) => snapshot.hourly.hourlyTemperatureC.some(
        (value, index) => value !== referenceTemperature[index],
      ))
    ) {
      throw providerError("provider_invalid_response");
    }
    return snapshots;
  } finally {
    clearTimeout(timeout);
    // Auch ein frueher permanenter Teilfehler beendet alle noch laufenden
    // Schwesterrequests derselben Provider-Operation sofort.
    controller.abort();
  }
}
