import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CATALOG_CSV_PREVIEW_MEDIA_TYPE,
  CATALOG_CSV_PREVIEW_WIRE_VERSION,
  CATALOG_CSV_WIRE_MAX_METADATA_BYTES,
  handleCatalogCsvPreviewRequest,
  type CatalogCsvPreviewHttpDependencies,
} from "@/lib/integrations/catalog/import-http";
import {
  CATALOG_CSV_MAPPING_VERSION,
  CATALOG_CSV_MAX_BYTES,
} from "@/lib/integrations/catalog/import-contract";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const ROUTE = `/w/${WORKSPACE_ID}/katalog/import/preview`;
const mapping = {
  schemaVersion: CATALOG_CSV_MAPPING_VERSION,
  columns: [{ field: "internalSku" as const, sourceHeader: "SKU" }],
};

function metadata(mode: "inspect" | "preview" = "inspect") {
  return mode === "inspect"
    ? {
        schemaVersion: CATALOG_CSV_PREVIEW_WIRE_VERSION,
        mode,
        intentId: INTENT_ID,
        filename: "produkte.csv",
      }
    : {
        schemaVersion: CATALOG_CSV_PREVIEW_WIRE_VERSION,
        mode,
        intentId: INTENT_ID,
        filename: "produkte.csv",
        mapping,
      };
}

function envelope(meta: unknown, file = new TextEncoder().encode("SKU\r\nPV-1\r\n"), padding = 0) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const metadataBytes = new Uint8Array(json.byteLength + padding);
  metadataBytes.set(json);
  metadataBytes.fill(0x20, json.byteLength);
  const bytes = new Uint8Array(4 + metadataBytes.byteLength + file.byteLength);
  new DataView(bytes.buffer).setUint32(0, metadataBytes.byteLength, false);
  bytes.set(metadataBytes, 4);
  bytes.set(file, 4 + metadataBytes.byteLength);
  return bytes;
}

function request(body: Uint8Array, changedHeaders: Readonly<Record<string, string>> = {}) {
  const headers = new Headers({
    "content-type": CATALOG_CSV_PREVIEW_MEDIA_TYPE,
    "sec-fetch-site": "same-origin",
    host: "clone.test",
    origin: "https://clone.test",
  });
  for (const [name, value] of Object.entries(changedHeaders)) {
    if (value === "") headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(`https://clone.test${ROUTE}`, {
    method: "POST",
    headers,
    body: body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer,
  });
}

function dependencies(
  overrides: Partial<CatalogCsvPreviewHttpDependencies> = {},
): CatalogCsvPreviewHttpDependencies {
  return {
    process: vi.fn(async (input) => input.mode === "inspect"
      ? {
          status: "inspected" as const,
          intentId: input.intentId,
          inspection: {
            filename: input.filename,
            sizeBytes: input.bytes.byteLength,
            sha256: "a".repeat(64),
            encoding: "utf-8" as const,
            delimiter: ";" as const,
            parserVersion: "papaparse-5.7.0-wmee.v1" as const,
            rowCount: 1,
            headers: ["SKU"],
          },
          mapping,
        }
      : {
          status: "prepared" as const,
          intentId: input.intentId,
          importId: "33333333-3333-4333-8333-333333333333",
          state: "ready_for_review" as const,
          replayed: false,
          counts: { total: 1, valid: 1, invalid: 0 },
          previewExpiresAt: "2026-09-07T12:00:00.000Z",
        }),
    ...overrides,
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("M108B-ROUTE-01 catalog CSV preview wire v1", () => {
  it.each(["inspect", "preview"] as const)(
    "dekodiert %s mit 4-Byte-Big-Endian-Präfix und unveränderten Dateibytes",
    async (mode) => {
      const process = vi.fn(dependencies().process);
      const file = new Uint8Array([0x53, 0x4b, 0x55, 0x0d, 0x0a, 0x80]);
      const response = await handleCatalogCsvPreviewRequest(
        request(envelope(metadata(mode), file)),
        { workspaceId: WORKSPACE_ID },
        dependencies({ process }),
      );

      expect(response.status).toBe(200);
      expectPrivate(response);
      expect(process).toHaveBeenCalledOnce();
      expect(process).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        mode,
        intentId: INTENT_ID,
        filename: "produkte.csv",
        bytes: file,
        ...(mode === "preview" ? { mapping } : {}),
      }));
      expect(await responseBody(response)).toMatchObject({
        status: mode === "inspect" ? "inspected" : "prepared",
        intentId: INTENT_ID,
      });
    },
  );

  it("akzeptiert exakt 32 KiB Metadaten und exakt 1 MiB Datei", async () => {
    const process = vi.fn(dependencies().process);
    const base = new TextEncoder().encode(JSON.stringify(metadata()));
    const file = new Uint8Array(CATALOG_CSV_MAX_BYTES).fill(0x41);
    const response = await handleCatalogCsvPreviewRequest(
      request(envelope(
        metadata(),
        file,
        CATALOG_CSV_WIRE_MAX_METADATA_BYTES - base.byteLength,
      )),
      { workspaceId: WORKSPACE_ID },
      dependencies({ process }),
    );

    expect(response.status).toBe(200);
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ bytes: file }));
  });

  it.each([
    ["ungültige Workspace-ID", request(envelope(metadata())), { workspaceId: "kein-uuid" }],
    ["falscher Content-Type", request(envelope(metadata()), { "content-type": "text/csv" }), { workspaceId: WORKSPACE_ID }],
    ["komprimierter Body", request(envelope(metadata()), { "content-encoding": "gzip" }), { workspaceId: WORKSPACE_ID }],
    ["fehlendes Sec-Fetch-Site", request(envelope(metadata()), { "sec-fetch-site": "" }), { workspaceId: WORKSPACE_ID }],
    ["cross-site", request(envelope(metadata()), { "sec-fetch-site": "cross-site" }), { workspaceId: WORKSPACE_ID }],
  ] as const)("verwirft %s vor Parser/Persistenz", async (_label, invalidRequest, params) => {
    const process = vi.fn(dependencies().process);
    const response = await handleCatalogCsvPreviewRequest(
      invalidRequest,
      params,
      dependencies({ process }),
    );

    expect([400, 403, 404]).toContain(response.status);
    expectPrivate(response);
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    ["fehlende Origin", { origin: "" }],
    ["fremde Origin", { origin: "https://angreifer.test" }],
    ["abweichender Host", { host: "angreifer.test", "x-forwarded-host": "clone.test" }],
  ])("verwirft %s ohne Objektzugriff", async (_label, headers) => {
    const process = vi.fn(dependencies().process);
    const response = await handleCatalogCsvPreviewRequest(
      request(envelope(metadata()), headers),
      { workspaceId: WORKSPACE_ID },
      dependencies({ process }),
    );

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toMatchObject({ error: { code: "origin_mismatch" } });
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    ["abgeschnittenes Präfix", new Uint8Array([0, 0, 0])],
    ["leere Metadaten", new Uint8Array([0, 0, 0, 0, 1])],
    ["abgeschnittene Metadaten", new Uint8Array([0, 0, 0, 10, 0x7b])],
    ["leere Datei", envelope(metadata(), new Uint8Array())],
    ["unbekanntes Metadatenfeld", envelope({ ...metadata(), tenant: "fremd" })],
    ["nicht normalisierter Dateiname", envelope({ ...metadata(), filename: "e\u0301.csv" })],
    ["Mapping bei inspect", envelope({ ...metadata(), mapping })],
    ["fehlendes Mapping bei preview", envelope({ ...metadata(), mode: "preview" })],
  ] as const)("verwirft %s strikt vor Verarbeitung", async (_label, body) => {
    const process = vi.fn(dependencies().process);
    const response = await handleCatalogCsvPreviewRequest(
      request(body),
      { workspaceId: WORKSPACE_ID },
      dependencies({ process }),
    );

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ error: { code: "invalid_request" } });
    expect(process).not.toHaveBeenCalled();
  });

  it("verwirft Metadatenlänge 32 KiB + 1 vor JSON- und Fachverarbeitung", async () => {
    const process = vi.fn(dependencies().process);
    const body = new Uint8Array(5);
    new DataView(body.buffer).setUint32(0, CATALOG_CSV_WIRE_MAX_METADATA_BYTES + 1, false);
    const response = await handleCatalogCsvPreviewRequest(
      request(body),
      { workspaceId: WORKSPACE_ID },
      dependencies({ process }),
    );
    expect(response.status).toBe(400);
    expect(process).not.toHaveBeenCalled();
  });

  it("verwirft 1 MiB + 1 und liest höchstens das eine Erkennungsbyte", async () => {
    const process = vi.fn(dependencies().process);
    const response = await handleCatalogCsvPreviewRequest(
      request(envelope(metadata(), new Uint8Array(CATALOG_CSV_MAX_BYTES + 1))),
      { workspaceId: WORKSPACE_ID },
      dependencies({ process }),
    );
    expect(response.status).toBe(413);
    expect(await responseBody(response)).toMatchObject({ error: { code: "file_too_large" } });
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
  ] as const)("übersetzt %s privat und ohne Fachdetails", async (status, expectedStatus) => {
    const response = await handleCatalogCsvPreviewRequest(
      request(envelope(metadata())),
      { workspaceId: WORKSPACE_ID },
      dependencies({ process: vi.fn(async () => ({ status })) }),
    );
    expect(response.status).toBe(expectedStatus);
    expectPrivate(response);
    expect(await responseBody(response)).toMatchObject({ error: { code: status } });
  });
});
