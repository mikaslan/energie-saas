import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fetchPrinthorizonV2,
  fetchSeriescalcSnapshotV2,
  fetchV2RawText,
} from "@/lib/integrations/calculation/fetch-v2";
import { buildPrinthorizonUrl } from "@/lib/integrations/calculation/horizon-v2";
import {
  F401ConfigurationError,
  F401FetchError,
  F401ProviderError,
  F401RateLimitedError,
  F401SizeError,
} from "@/lib/integrations/calculation/provider-v2";

// F4.1 v2-Fetch gegen echten Loopback-HTTP-Server (keine Mocks):
// Status-Mapping, Schranken, Redirect-Politik, Timeout, Origin-Override.

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function json(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

const CANONICAL = buildPrinthorizonUrl({ latitude: 52.52, longitude: 13.41 });
let savedBaseUrl: string | undefined;

beforeEach(() => {
  savedBaseUrl = process.env.PVGIS_BASE_URL;
});

afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env.PVGIS_BASE_URL;
  else process.env.PVGIS_BASE_URL = savedBaseUrl;
});

async function withOrigin<T>(origin: string, run: () => Promise<T>): Promise<T> {
  process.env.PVGIS_BASE_URL = `${origin}/api/v5_3`;
  return run();
}

describe("F4.1 v2 fetch transport", () => {
  it("holt JSON mit Abrufzeiten und ersetzt nur den Origin", async () => {
    const server = await serve((request, response) => {
      expect(request.url).toMatch(/^\/api\/v5_3\/printhorizon\?/u);
      expect(request.url).toContain("lat=52.52");
      expect(request.url).toContain("outputformat=json");
      json(response, JSON.stringify({ ok: true }));
    });
    try {
      const fetched = await withOrigin(server.origin, () => fetchV2RawText(CANONICAL));
      expect(JSON.parse(fetched.rawText)).toEqual({ ok: true });
      expect(fetched.fetchedAtUtc <= fetched.receivedAtUtc).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("mappt 429/500/Content-Type/Groesse auf die Taxonomie", async () => {
    const server = await serve((request, response) => {
      if (request.url === "/api/v5_3/r429") {
        response.writeHead(429, { "retry-after": "2" });
        response.end();
      } else if (request.url === "/api/v5_3/r500") {
        response.writeHead(500);
        response.end();
      } else if (request.url === "/api/v5_3/rhtml") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html></html>");
      } else if (request.url === "/api/v5_3/rbig-header") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": "99999999",
        });
        response.end("{}");
      } else if (request.url === "/api/v5_3/rbig-stream") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`"${"x".repeat(2_000_000)}"`);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    try {
      const get = (path: string, options?: { maxBytes?: number }) =>
        withOrigin(server.origin, () => fetchV2RawText(`${server.origin}${path}`, options));
      await expect(get("/api/v5_3/r429")).rejects.toMatchObject({
        code: "provider_rate_limited",
        retryAfterMs: 2_000,
      });
      await expect(get("/api/v5_3/r429")).rejects.toBeInstanceOf(F401RateLimitedError);
      await expect(get("/api/v5_3/r500")).rejects.toMatchObject({
        code: "provider_unavailable",
      });
      await expect(get("/api/v5_3/r500")).rejects.toBeInstanceOf(F401FetchError);
      await expect(get("/api/v5_3/rhtml")).rejects.toBeInstanceOf(F401ProviderError);
      await expect(get("/api/v5_3/rbig-header")).rejects.toBeInstanceOf(F401SizeError);
      await expect(get("/api/v5_3/rbig-stream", { maxBytes: 1_000_000 })).rejects.toBeInstanceOf(
        F401SizeError,
      );
    } finally {
      await server.close();
    }
  });

  it("folgt Same-Origin-Redirects und bricht Cross-Origin ab", async () => {
    const other = await serve((_, response) => json(response, JSON.stringify({ other: true })));
    const server = await serve((request, response) => {
      if (request.url === "/api/v5_3/rself") {
        response.writeHead(302, { location: "/api/v5_3/rtarget" });
        response.end();
      } else if (request.url === "/api/v5_3/rtarget") {
        json(response, JSON.stringify({ followed: true }));
      } else if (request.url === "/api/v5_3/rcross") {
        response.writeHead(302, { location: `${other.origin}/api/v5_3/x` });
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    try {
      const followed = await withOrigin(server.origin, () =>
        fetchV2RawText(`${server.origin}/api/v5_3/rself`));
      expect(JSON.parse(followed.rawText)).toEqual({ followed: true });
      await expect(
        withOrigin(server.origin, () => fetchV2RawText(`${server.origin}/api/v5_3/rcross`)),
      ).rejects.toBeInstanceOf(F401ProviderError);
    } finally {
      await server.close();
      await other.close();
    }
  });

  it("bricht haengende Abrufe per Timeout retryable ab", async () => {
    const server = await serve(() => {
      // Absichtlich keine Antwort.
    });
    try {
      await expect(
        withOrigin(server.origin, () => fetchV2RawText(`${server.origin}/api/v5_3/rhang`, {
          timeoutMs: 200,
        })),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
    } finally {
      await server.close();
    }
  });

  it("weist Nicht-Loopback-Overrides vor jedem Fetch ab", async () => {
    process.env.PVGIS_BASE_URL = "https://example.test/api/v5_3";
    await expect(fetchV2RawText(CANONICAL)).rejects.toBeInstanceOf(F401ConfigurationError);
  });
});

describe("F4.1 v2 fetch end to end", () => {
  it("fetchPrinthorizonV2 parst 49 Zeilen ueber HTTP", async () => {
    const profile = Array.from({ length: 49 }, (_, index) => ({
      A: -180 + index * 7.5,
      H_hor: 0.4,
    }));
    const server = await serve((_, response) => {
      json(response, JSON.stringify({
        inputs: {
          location: { latitude: 52.52, longitude: 13.41, elevation: 47 },
          horizon_db: "DEM-calculated",
        },
        outputs: { horizon_profile: profile },
      }));
    });
    try {
      const horizon = await withOrigin(server.origin, () => fetchPrinthorizonV2(CANONICAL));
      expect(horizon.heights).toHaveLength(48);
      expect(horizon.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(horizon.fetchedAtUtc <= horizon.receivedAtUtc).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("fetchSeriescalcSnapshotV2 parst 8784 Zeilen ueber HTTP", async () => {
    const hourly = Array.from({ length: 8_784 }, (_, index) => {
      const date = new Date(Date.UTC(2020, 0, 1, 0, 11) + index * 3_600_000);
      const pad = (value: number): string => String(value).padStart(2, "0");
      return {
        time: `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}:${pad(date.getUTCHours())}11`,
        "Gb(i)": 0,
        "Gd(i)": 10,
        "Gr(i)": 0,
        H_sun: 0,
        T2m: 5,
        WS10m: 2,
        Int: 0,
      };
    });
    const server = await serve((_, response) => {
      json(response, JSON.stringify({
        inputs: {
          location: { latitude: 52.52, longitude: 13.41, elevation: 47 },
          meteo_data: {
            radiation_db: "PVGIS-SARAH3",
            meteo_db: "ERA5",
            year_min: 2020,
            year_max: 2020,
            use_horizon: false,
            horizon_db: null,
          },
        },
        outputs: { hourly },
      }));
    });
    try {
      const snapshot = await withOrigin(server.origin, () =>
        fetchSeriescalcSnapshotV2(
          "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat=52.52&x=1",
          { tilted: false },
        ));
      expect(snapshot.hours).toHaveLength(8_784);
      expect(snapshot.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });
});
