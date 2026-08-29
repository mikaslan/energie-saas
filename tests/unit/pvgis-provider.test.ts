import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchPvgisYieldSnapshots } from "@/lib/integrations/calculation/pvgis";
import type { PlanningCalculationRequestV1 } from "@/lib/integrations/calculation/contract";

const OFFICIAL_BASE_URL = "https://re.jrc.ec.europa.eu/api/v5_3";
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const FETCHED_AT = "2026-08-29T10:00:00.000Z";

const ORIGINAL_ENV = {
  baseUrl: process.env.PVGIS_BASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

type RoofRequest = {
  roofId: string;
  tiltDeg: number;
  azimuthDeg: number;
};

type YieldSnapshot = PlanningCalculationRequestV1["yieldSnapshots"][number];

const ROOFS: RoofRequest[] = [
  { roofId: "roof-z-west", tiltDeg: 35, azimuthDeg: 90 },
  { roofId: "roof-a-east", tiltDeg: 30, azimuthDeg: -90 },
];

const SOURCE_TIMESTAMPS_UTC = Array.from({ length: 8_784 }, (_, hour) =>
  new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
);
const RAW_POWER_W_PER_KWP = Array.from({ length: 8_784 }, (_, hour) => (hour % 24) + 1);
const RAW_TEMPERATURE_C = Array.from({ length: 8_784 }, (_, hour) => 10 + hour / 1_000);

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function localizeLikePinnedRechner(values: number[]): number[] {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const localized = new Array<number>(8_784).fill(0);

  for (let sourceHour = 0; sourceHour < 8_784; sourceHour += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(Date.UTC(2020, 0, 1, sourceHour)))
        .map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
    );
    let targetHour = Math.round((asUtc - Date.UTC(Number(parts.year), 0, 1)) / 3_600_000);
    if (targetHour < 0) targetHour += 8_784;
    if (targetHour >= 8_784) targetHour -= 8_784;
    localized[targetHour] = values[sourceHour] ?? 0;
  }

  // This intentionally pins the current Rechner-v3 DST convention: the later
  // autumn value wins and a spring gap between non-zero neighbours is rounded.
  for (let hour = 1; hour < localized.length - 1; hour += 1) {
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
  ];
}

const LOCAL_POWER_BEFORE_SCALING = dropLocalFebruary29(
  localizeLikePinnedRechner(RAW_POWER_W_PER_KWP),
);
const EXPECTED_POWER_W_PER_KWP = LOCAL_POWER_BEFORE_SCALING.map((value) => value * 2);
const EXPECTED_TEMPERATURE_C = dropLocalFebruary29(
  localizeLikePinnedRechner(RAW_TEMPERATURE_C),
);
const ANNUAL_YIELD_KWH_PER_KWP = EXPECTED_POWER_W_PER_KWP.reduce(
  (sum, value) => sum + value,
  0,
) / 1_000;
const MONTHLY_YIELD_KWH_PER_KWP = [
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  ANNUAL_YIELD_KWH_PER_KWP - 165,
];

function nonLeapLocalHour(monthIndex: number, day: number, hour: number): number {
  const daysBeforeMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return ((daysBeforeMonth[monthIndex] ?? 0) + day - 1) * 24 + hour;
}

function leapUtcHour(monthIndex: number, day: number, hour: number): number {
  return Math.round(
    (Date.UTC(2020, monthIndex, day, hour) - Date.UTC(2020, 0, 1)) / 3_600_000,
  );
}

function pvgisTimestamp(hour: number): string {
  const date = new Date(Date.UTC(2020, 0, 1, hour));
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const utcHour = String(date.getUTCHours()).padStart(2, "0");
  // SARAH timestamps carry the satellite observation minute. The planning
  // contract canonicalizes the hourly slot while hashing the byte-exact raw body.
  return `${year}${month}${day}:${utcHour}11`;
}

function responseInputs(
  roof: RoofRequest,
  radiationDatabase = "PVGIS-SARAH3",
  hourly = false,
): Record<string, unknown> {
  return {
    location: { latitude: 49.285, longitude: 8.738, elevation: 133 },
    meteo_data: {
      radiation_db: radiationDatabase,
      meteo_db: "ERA5",
      year_min: hourly ? 2020 : 2005,
      year_max: hourly ? 2020 : 2023,
      use_horizon: true,
      horizon_db: hourly ? null : "DEM-calculated",
    },
    mounting_system: {
      fixed: {
        slope: { value: roof.tiltDeg, optimal: false },
        azimuth: { value: roof.azimuthDeg, optimal: false },
        type: "free-standing",
      },
    },
    pv_module: { technology: "c-Si", peak_power: 1, system_loss: 14 },
  };
}

function annualPayload(
  roof: RoofRequest,
  radiationDatabase = "PVGIS-SARAH3",
): Record<string, unknown> {
  return {
    inputs: responseInputs(roof, radiationDatabase),
    outputs: {
      // Provider order is not trusted; the adapter maps months by month number.
      monthly: {
        fixed: MONTHLY_YIELD_KWH_PER_KWP.map((yieldKwh, index) => ({
          month: index + 1,
          E_d: yieldKwh / 30,
          E_m: yieldKwh,
          "H(i)_d": 4,
          "H(i)_m": 120,
          SD_m: 5,
          providerSecret: "must-not-escape",
        })).reverse(),
      },
      totals: {
        fixed: {
          E_y: ANNUAL_YIELD_KWH_PER_KWP,
          "H(i)_y": 1_300,
          providerSecret: "must-not-escape",
        },
      },
    },
    meta: { providerSecret: "must-not-escape" },
  };
}

function hourlyPayload(
  roof: RoofRequest,
  options: {
    radiationDatabase?: string;
    length?: number;
    changedTemperatureAt?: number;
    changedTimestampAt?: number;
  } = {},
): Record<string, unknown> {
  const length = options.length ?? 8_784;
  return {
    inputs: responseInputs(roof, options.radiationDatabase, true),
    outputs: {
      hourly: Array.from({ length }, (_, hour) => ({
        time: hour === options.changedTimestampAt ? "20200101:0011" : pvgisTimestamp(hour),
        P: RAW_POWER_W_PER_KWP[hour],
        "G(i)": 100,
        H_sun: 10,
        T2m: (RAW_TEMPERATURE_C[hour] ?? 10)
          + (hour === options.changedTemperatureAt ? 0.25 : 0),
        WS10m: 2,
        Int: 0,
        providerSecret: "must-not-escape",
      })),
    },
    meta: { providerSecret: "must-not-escape" },
  };
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function jsonResponseBody(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type ContractFetchOptions = {
  radiationDatabase?: string;
  hourlyLength?: number;
  changedTemperatureRoofId?: string;
  changedTimestampRoofId?: string;
};

function installContractFetch(
  roofs: RoofRequest[],
  options: ContractFetchOptions = {},
): {
  fetchMock: ReturnType<typeof vi.fn>;
  rawBodies: Map<string, string>;
} {
  const rawBodies = new Map<string, string>();
  for (const roof of roofs) {
    rawBodies.set(
      `${roof.roofId}:PVcalc`,
      jsonBody(annualPayload(roof, options.radiationDatabase)),
    );
    rawBodies.set(
      `${roof.roofId}:seriescalc`,
      jsonBody(hourlyPayload(roof, {
        radiationDatabase: options.radiationDatabase,
        length: options.hourlyLength,
        changedTemperatureAt: roof.roofId === options.changedTemperatureRoofId ? 100 : undefined,
        changedTimestampAt: roof.roofId === options.changedTimestampRoofId ? 100 : undefined,
      })),
    );
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const roof = roofs.find((candidate) =>
      String(candidate.tiltDeg) === url.searchParams.get("angle")
      && String(candidate.azimuthDeg) === url.searchParams.get("aspect"),
    );
    const tool = url.pathname.endsWith("/PVcalc")
      ? "PVcalc"
      : url.pathname.endsWith("/seriescalc")
        ? "seriescalc"
        : "unknown";
    const body = roof ? rawBodies.get(`${roof.roofId}:${tool}`) : undefined;
    return body === undefined
      ? jsonResponseBody(JSON.stringify({ error: "unexpected provider request" }), 400)
      : jsonResponseBody(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, rawBodies };
}

function request(roofs: RoofRequest[] = ROOFS): Record<string, unknown> {
  return {
    latitude: 49.28463,
    longitude: 8.73821,
    roofs,
    // Untrusted extra input must never turn into an upstream query parameter.
    providerQuery: { userhorizon: "0,0,0", optimalangles: 1, browser: 1 },
  };
}

async function loadSnapshots(input: Record<string, unknown>): Promise<YieldSnapshot[]> {
  return fetchPvgisYieldSnapshots(input) as Promise<YieldSnapshot[]>;
}

function expectExactQuery(url: URL, roof: RoofRequest): void {
  const common = {
    angle: String(roof.tiltDeg),
    aspect: String(roof.azimuthDeg),
    lat: "49.285",
    lon: "8.738",
    loss: "14",
    mountingplace: "free",
    outputformat: "json",
    peakpower: "1",
    pvtechchoice: "crystSi",
    raddatabase: "PVGIS-SARAH3",
    usehorizon: "1",
  };
  const expected = url.pathname.endsWith("/seriescalc")
    ? {
        ...common,
        endyear: "2020",
        pvcalculation: "1",
        startyear: "2020",
        trackingtype: "0",
      }
    : common;
  expect(Object.fromEntries([...url.searchParams].sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  ))).toEqual(expected);
}

async function captureProviderError(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & Record<string, unknown>;
  }
  throw new Error("expected PVGIS provider rejection");
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  setEnv("PVGIS_BASE_URL", undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FETCHED_AT));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setEnv("PVGIS_BASE_URL", ORIGINAL_ENV.baseUrl);
  setEnv("NODE_ENV", ORIGINAL_ENV.nodeEnv);
});

describe("PVGIS v5.3 request and closed snapshot contract", () => {
  it("uses only the exact PVcalc/seriescalc GET allowlists and deterministic roofId order", async () => {
    const { fetchMock } = installContractFetch(ROOFS);

    const snapshots = await loadSnapshots(request());

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      const [input, init] = call as [RequestInfo | URL, RequestInit];
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname.replace(/\/(?:PVcalc|seriescalc)$/u, "")}`)
        .toBe(OFFICIAL_BASE_URL);
      expect(["/api/v5_3/PVcalc", "/api/v5_3/seriescalc"]).toContain(url.pathname);
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      const roof = ROOFS.find((candidate) =>
        String(candidate.tiltDeg) === url.searchParams.get("angle")
        && String(candidate.azimuthDeg) === url.searchParams.get("aspect"),
      );
      expect(roof).toBeDefined();
      if (roof) expectExactQuery(url, roof);
    }

    expect(snapshots.map((snapshot) => snapshot.roofId)).toEqual([
      "roof-a-east",
      "roof-z-west",
    ]);
  });

  it("maps units and provider evidence without leaking raw response fields", async () => {
    const { rawBodies } = installContractFetch(ROOFS);

    const snapshots = await loadSnapshots(request());
    const snapshot = snapshots[0];

    expect(snapshot).toMatchObject({
      roofId: "roof-a-east",
      provider: "pvgis",
      apiVersion: "5_3",
      radiationDatabase: "PVGIS-SARAH3",
      request: {
        queryContractVersion: "pvgis-query.v1",
        coordinateRounding: "pvgis-coordinate-rounding-3dp.v1",
        latitude: 49.285,
        longitude: 8.738,
        tiltDeg: 30,
        azimuthDeg: -90,
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
        fetchedAt: FETCHED_AT,
        rawResponseSha256: sha256(rawBodies.get("roof-a-east:PVcalc") ?? ""),
        annualYieldKwhPerKwp: ANNUAL_YIELD_KWH_PER_KWP,
        monthlyYieldKwhPerKwp: MONTHLY_YIELD_KWH_PER_KWP,
      },
      hourly: {
        tool: "seriescalc",
        weatherYear: 2020,
        startYear: 2020,
        endYear: 2020,
        fetchedAt: FETCHED_AT,
        rawResponseSha256: sha256(rawBodies.get("roof-a-east:seriescalc") ?? ""),
        sourceLength: 8_784,
        sourceTimeBasis: "utc",
        normalization: "pvgis_utc_to_europe_berlin_then_drop_feb_29.v1",
        targetTimeZone: "Europe/Berlin",
        normalizedHourConvention: "local_non_leap_jan01_00.v1",
        annualScaling: "scale_hourly_shape_to_pvcalc_annual.v1",
      },
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      "annual",
      "apiVersion",
      "hourly",
      "provider",
      "radiationDatabase",
      "request",
      "roofId",
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("providerSecret");
    expect(snapshot.hourly.hourlyPowerWPerKwp.reduce((sum, value) => sum + value, 0) / 1_000)
      .toBeCloseTo(ANNUAL_YIELD_KWH_PER_KWP, 10);
  });
});

describe("PVGIS 2020 UTC to Europe/Berlin normalization", () => {
  it("keeps 8784 canonical UTC slots, applies the pinned DST rule, then removes local Feb 29", async () => {
    installContractFetch([ROOFS[0]]);

    const [snapshot] = await loadSnapshots(request([ROOFS[0]]));

    expect(snapshot.hourly.sourceTimestampsUtc).toEqual(SOURCE_TIMESTAMPS_UTC);
    expect(snapshot.hourly.hourlyPowerWPerKwp).toHaveLength(8_760);
    expect(snapshot.hourly.hourlyTemperatureC).toHaveLength(8_760);
    snapshot.hourly.hourlyPowerWPerKwp.forEach((value, index) => {
      expect(value).toBeCloseTo(EXPECTED_POWER_W_PER_KWP[index] ?? 0, 10);
    });
    expect(snapshot.hourly.hourlyTemperatureC).toEqual(EXPECTED_TEMPERATURE_C);

    // Winter UTC+1 wraps the final UTC hour into local Jan 1 00.
    expect(snapshot.hourly.hourlyTemperatureC[0]).toBe(RAW_TEMPERATURE_C.at(-1));
    expect(snapshot.hourly.hourlyTemperatureC[1]).toBe(RAW_TEMPERATURE_C[0]);
    // Summer UTC+2.
    expect(snapshot.hourly.hourlyTemperatureC[nonLeapLocalHour(6, 1, 2)])
      .toBe(RAW_TEMPERATURE_C[leapUtcHour(6, 1, 0)]);
    // Spring local 02:00 is the rounded gap; autumn local 02:00 keeps the later UTC value.
    const springUtc = leapUtcHour(2, 29, 0);
    expect(snapshot.hourly.hourlyTemperatureC[nonLeapLocalHour(2, 29, 2)])
      .toBe(Math.round(((RAW_TEMPERATURE_C[springUtc] ?? 0)
        + (RAW_TEMPERATURE_C[springUtc + 1] ?? 0)) / 2));
    expect(snapshot.hourly.hourlyTemperatureC[nonLeapLocalHour(9, 25, 2)])
      .toBe(RAW_TEMPERATURE_C[leapUtcHour(9, 25, 1)]);
    // The first slot after Feb 28 is local March 1, proving local-date removal.
    expect(snapshot.hourly.hourlyTemperatureC[nonLeapLocalHour(2, 1, 0)])
      .toBe(EXPECTED_TEMPERATURE_C[nonLeapLocalHour(2, 1, 0)]);
  });

  it("rejects a non-hourly or incomplete source series", async () => {
    let harness = installContractFetch([ROOFS[0]], { hourlyLength: 8_783 });
    let error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });

    vi.unstubAllGlobals();
    harness = installContractFetch([ROOFS[0]], { changedTimestampRoofId: ROOFS[0].roofId });
    error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });
    expect(harness.fetchMock).toHaveBeenCalled();
  });

  it("requires identical site/year temperature series across all roofs", async () => {
    installContractFetch(ROOFS, { changedTemperatureRoofId: "roof-z-west" });

    const error = await captureProviderError(loadSnapshots(request()));

    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });
  });
});

describe("PVGIS response and transport hardening", () => {
  it("rejects a provider database echo other than SARAH3", async () => {
    installContractFetch([ROOFS[0]], { radiationDatabase: "PVGIS-ERA5" });

    const error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));

    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });
  });

  it("rejects missing and duplicate annual months before they reach the engine", async () => {
    let harness = installContractFetch([ROOFS[0]]);
    const annualKey = `${ROOFS[0].roofId}:PVcalc`;
    const missing = annualPayload(ROOFS[0]);
    const missingMonths = (missing.outputs as {
      monthly: { fixed: unknown[] };
    }).monthly.fixed;
    missingMonths.pop();
    harness.rawBodies.set(annualKey, jsonBody(missing));
    let error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });

    vi.unstubAllGlobals();
    harness = installContractFetch([ROOFS[0]]);
    const duplicate = annualPayload(ROOFS[0]);
    const duplicateMonths = (duplicate.outputs as {
      monthly: { fixed: Array<{ month: number }> };
    }).monthly.fixed;
    duplicateMonths[duplicateMonths.length - 1] = {
      ...duplicateMonths[0]!,
    };
    harness.rawBodies.set(annualKey, jsonBody(duplicate));
    error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });
  });

  it("accepts application/json only and enforces an inclusive 2 MiB streamed byte cap", async () => {
    let fetchMock = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    let error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });

    vi.unstubAllGlobals();
    const harness = installContractFetch([ROOFS[0]]);
    const annualKey = `${ROOFS[0].roofId}:PVcalc`;
    const annualBody = harness.rawBodies.get(annualKey) ?? "";
    harness.rawBodies.set(annualKey, annualBody + " ".repeat(MAX_RESPONSE_BYTES - annualBody.length));
    await expect(loadSnapshots(request([ROOFS[0]]))).resolves.toHaveLength(1);

    vi.unstubAllGlobals();
    fetchMock = vi.fn(async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_invalid_response", retryable: false });
  });

  it.each([
    [429, "provider_rate_limited", true],
    [529, "provider_overloaded", true],
    [400, "provider_http_error", false],
    [404, "provider_http_error", false],
    [500, "provider_unavailable", true],
    [503, "provider_unavailable", true],
  ] as const)("maps HTTP %i to the closed error class", async (status, code, retryable) => {
    const secretBody = `provider secret for ${status}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(secretBody, {
      status,
      headers: { "content-type": "text/plain" },
    })));

    const error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));

    expect(error).toMatchObject({ code, retryable });
    expect(String(error)).not.toContain(secretBody);
    expect(Object.keys(error).sort()).toEqual(["code", "retryable"]);
  });

  it.each([
    [429, "120", "provider_rate_limited", true, 120_000],
    [503, "7200", "provider_unavailable", true, MAX_RETRY_AFTER_MS],
    [
      503,
      new Date(new Date(FETCHED_AT).getTime() + 30_000).toUTCString(),
      "provider_unavailable",
      true,
      30_000,
    ],
    [400, "120", "provider_http_error", false, undefined],
  ] as const)(
    "parses and caps Retry-After for HTTP %i without making permanent 4xx retryable",
    async (status, retryAfter, code, retryable, expectedRetryAfterMs) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("provider secret", {
        status,
        headers: {
          "content-type": "text/plain",
          "retry-after": retryAfter,
        },
      })));

      const error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));

      expect(error).toMatchObject({ code, retryable });
      expect(error.retryAfterMs).toBe(expectedRetryAfterMs);
    },
  );

  it("aborts a hanging sibling request when another request rejects early", async () => {
    let siblingAborted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/PVcalc")) {
        return Promise.resolve(new Response("permanent request failure", { status: 400 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          siblingAborted = true;
          reject(new DOMException("sibling aborted", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));

    expect(error).toMatchObject({ code: "provider_http_error", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(siblingAborted).toBe(true);
  });

  it("aborts the complete provider operation after exactly 10 seconds", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal) signals.push(init.signal);
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("secret PVGIS transport URL", "AbortError"));
        }, { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = loadSnapshots(request([ROOFS[0]]));
    const rejection = captureProviderError(pending);
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS - 1);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    await expect(rejection).resolves.toMatchObject({
      code: "provider_timeout",
      retryable: true,
    });
  });

  it("maps network failures without logging or exposing provider details", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("https://re.jrc.ec.europa.eu/private?coordinates=secret");
    }));

    const error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));

    expect(error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(String(error)).not.toContain("coordinates");
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("allows only a loopback base override outside production", async () => {
    setEnv("PVGIS_BASE_URL", "http://127.0.0.1:43123/api/v5_3");
    const harness = installContractFetch([ROOFS[0]]);

    await loadSnapshots(request([ROOFS[0]]));
    expect(harness.fetchMock.mock.calls.every(([input]) =>
      new URL(String(input)).origin === "http://127.0.0.1:43123",
    )).toBe(true);

    vi.unstubAllGlobals();
    setEnv("PVGIS_BASE_URL", "https://example.test/api/v5_3");
    let fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_configuration", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.stubEnv("NODE_ENV", "production");
    setEnv("PVGIS_BASE_URL", "http://localhost:43123/api/v5_3");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    error = await captureProviderError(loadSnapshots(request([ROOFS[0]])));
    expect(error).toMatchObject({ code: "provider_configuration", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();

  });
});
