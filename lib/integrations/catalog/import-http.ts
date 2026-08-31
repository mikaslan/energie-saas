import "server-only";

import { z } from "zod";

import {
  CATALOG_CSV_MAX_BYTES,
  CATALOG_CSV_PARSER_VERSION,
  catalogCsvColumnMappingV1Schema,
  catalogCsvRequestErrorCodeSchema,
  type CatalogCsvColumnMappingV1,
  type CatalogCsvInspection,
} from "./import-contract";
import {
  CATALOG_IMPORT_JOB_STATES,
  CATALOG_CSV_PREVIEW_MEDIA_TYPE,
  CATALOG_CSV_PREVIEW_WIRE_VERSION,
  CATALOG_CSV_WIRE_MAX_METADATA_BYTES,
  type CatalogImportJobState,
} from "./import-wire";

export {
  CATALOG_CSV_PREVIEW_MEDIA_TYPE,
  CATALOG_CSV_PREVIEW_WIRE_VERSION,
  CATALOG_CSV_WIRE_MAX_METADATA_BYTES,
} from "./import-wire";

const PREFIX_BYTES = 4;
const MAXIMUM_VALID_BODY_BYTES =
  PREFIX_BYTES + CATALOG_CSV_WIRE_MAX_METADATA_BYTES + CATALOG_CSV_MAX_BYTES;
const MAXIMUM_STREAM_BYTES = MAXIMUM_VALID_BODY_BYTES + 1;
const uuidSchema = z.uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const filenameSchema = z.string().min(1).max(180)
  .regex(/^(?!\s)(?!.*\s$)(?!.*[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]).+\.[cC][sS][vV]$/u)
  .refine((value) => value === value.normalize("NFKC").trim());
const sharedMetadataShape = {
  schemaVersion: z.literal(CATALOG_CSV_PREVIEW_WIRE_VERSION),
  intentId: uuidSchema,
  filename: filenameSchema,
} as const;
const wireMetadataSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...sharedMetadataShape, mode: z.literal("inspect") }),
  z.strictObject({
    ...sharedMetadataShape,
    mode: z.literal("preview"),
    mapping: catalogCsvColumnMappingV1Schema,
  }),
]);

const inspectionSchema = z.strictObject({
  filename: filenameSchema,
  sizeBytes: z.int().safe().min(1).max(CATALOG_CSV_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  encoding: z.enum(["utf-8", "windows-1252"]),
  delimiter: z.enum([";", ","]),
  parserVersion: z.literal(CATALOG_CSV_PARSER_VERSION),
  rowCount: z.int().safe().min(1).max(1_000),
  headers: z.array(z.string().min(1).max(240)).min(1).max(80),
});
const countSchema = z.int().safe().min(0).max(1_000);
const processResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("inspected"),
    intentId: uuidSchema,
    inspection: inspectionSchema,
    mapping: catalogCsvColumnMappingV1Schema,
  }),
  z.strictObject({
    status: z.literal("prepared"),
    intentId: uuidSchema,
    importId: uuidSchema,
    state: z.enum(CATALOG_IMPORT_JOB_STATES),
    replayed: z.boolean(),
    counts: z.strictObject({
      total: z.int().safe().min(1).max(1_000),
      valid: countSchema,
      invalid: countSchema,
    }),
    previewExpiresAt: z.iso.datetime({ offset: true }),
  }).superRefine((value, context) => {
    if (value.counts.valid + value.counts.invalid !== value.counts.total) {
      context.addIssue({ code: "custom", path: ["counts"], message: "count drift" });
    }
  }),
  z.strictObject({ status: z.literal("unauthenticated") }),
  z.strictObject({ status: z.literal("forbidden") }),
  z.strictObject({
    status: z.literal("invalid"),
    code: catalogCsvRequestErrorCodeSchema,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    code: z.enum(["intent_reused", "catalog_changed"]),
  }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

export type CatalogCsvPreviewWireInput =
  | Readonly<{
      workspaceId: string;
      mode: "inspect";
      intentId: string;
      filename: string;
      bytes: Uint8Array;
    }>
  | Readonly<{
      workspaceId: string;
      mode: "preview";
      intentId: string;
      filename: string;
      mapping: CatalogCsvColumnMappingV1;
      bytes: Uint8Array;
    }>;

export type CatalogCsvPreviewProcessResult =
  | Readonly<{
      status: "inspected";
      intentId: string;
      inspection: CatalogCsvInspection;
      mapping: CatalogCsvColumnMappingV1;
    }>
  | Readonly<{
      status: "prepared";
      intentId: string;
      importId: string;
      state: CatalogImportJobState;
      replayed: boolean;
      counts: Readonly<{ total: number; valid: number; invalid: number }>;
      previewExpiresAt: string;
    }>
  | Readonly<{ status: "unauthenticated" }>
  | Readonly<{ status: "forbidden" }>
  | Readonly<{
      status: "invalid";
      code: z.infer<typeof catalogCsvRequestErrorCodeSchema>;
    }>
  | Readonly<{ status: "conflict"; code: "intent_reused" | "catalog_changed" }>
  | Readonly<{ status: "unavailable" }>;

export type CatalogCsvPreviewHttpDependencies = Readonly<{
  process(input: CatalogCsvPreviewWireInput): Promise<CatalogCsvPreviewProcessResult>;
}>;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse({ error: { code } }, status);
}

function invalidRequest(): Response {
  return errorResponse(400, "invalid_request");
}

function mediaTypeIsValid(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null
    && contentType.split(";", 1)[0]?.trim().toLowerCase()
      === CATALOG_CSV_PREVIEW_MEDIA_TYPE;
}

function contentEncodingIsIdentity(request: Request): boolean {
  const value = request.headers.get("content-encoding");
  return value === null || value.trim().toLowerCase() === "identity";
}

function validHostHeader(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\s,/@\\]/u.test(value);
}

function isSameOrigin(request: Request): boolean {
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null) return false;
  let origin: URL;
  let requestUrl: URL;
  try {
    origin = new URL(rawOrigin);
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (
    !["https:", "http:"].includes(origin.protocol)
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) return false;
  const rawHost = request.headers.get("host") ?? requestUrl.host;
  if (!validHostHeader(rawHost) || origin.protocol !== requestUrl.protocol) return false;
  try {
    const effectiveHost = new URL(`${origin.protocol}//${rawHost}`).host.toLowerCase();
    return origin.host.toLowerCase() === effectiveHost
      && origin.host.toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

function isSameOriginFetch(request: Request): boolean {
  return request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin";
}

type BodyRead =
  | Readonly<{ status: "ok"; bytes: Uint8Array }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "too_large" }>;

async function readLimitedBody(request: Request): Promise<BodyRead> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const normalized = declaredLength.trim();
    if (!/^\d+$/u.test(normalized)) return { status: "invalid" };
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) return { status: "invalid" };
    if (parsed > MAXIMUM_VALID_BODY_BYTES) {
      if (request.body) void request.body.cancel().catch(() => undefined);
      return { status: "too_large" };
    }
  }
  if (!request.body) return { status: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return { status: "invalid" };
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total >= MAXIMUM_STREAM_BYTES) {
      void reader.cancel().catch(() => undefined);
      return { status: "too_large" };
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", bytes };
}

function decodeEnvelope(
  body: Uint8Array,
  workspaceId: string,
): CatalogCsvPreviewWireInput | "invalid" | "file_too_large" {
  if (body.byteLength < PREFIX_BYTES) return "invalid";
  const metadataLength = new DataView(
    body.buffer,
    body.byteOffset,
    PREFIX_BYTES,
  ).getUint32(0, false);
  if (
    metadataLength < 1
    || metadataLength > CATALOG_CSV_WIRE_MAX_METADATA_BYTES
    || body.byteLength <= PREFIX_BYTES + metadataLength
  ) return "invalid";
  const fileLength = body.byteLength - PREFIX_BYTES - metadataLength;
  if (fileLength > CATALOG_CSV_MAX_BYTES) return "file_too_large";
  let metadataValue: unknown;
  try {
    const metadataText = new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength),
    );
    metadataValue = JSON.parse(metadataText) as unknown;
  } catch {
    return "invalid";
  }
  const parsed = wireMetadataSchema.safeParse(metadataValue);
  if (!parsed.success) return "invalid";
  const bytes = body.slice(PREFIX_BYTES + metadataLength);
  if (parsed.data.mode === "inspect") {
    return {
      workspaceId,
      mode: "inspect",
      intentId: parsed.data.intentId,
      filename: parsed.data.filename,
      bytes,
    };
  }
  return {
    workspaceId,
    mode: "preview",
    intentId: parsed.data.intentId,
    filename: parsed.data.filename,
    mapping: parsed.data.mapping,
    bytes,
  };
}

function processedResponse(
  input: CatalogCsvPreviewWireInput,
  rawResult: CatalogCsvPreviewProcessResult,
): Response {
  const parsed = processResultSchema.safeParse(rawResult);
  if (!parsed.success) return errorResponse(500, "internal_error");
  const result = parsed.data;
  if ("intentId" in result && result.intentId !== input.intentId) {
    return errorResponse(500, "internal_error");
  }
  switch (result.status) {
    case "inspected":
    case "prepared":
      return jsonResponse(result, 200);
    case "unauthenticated":
      return errorResponse(401, result.status);
    case "forbidden":
      return errorResponse(403, result.status);
    case "invalid":
      return errorResponse(result.code === "file_too_large" ? 413 : 422, result.code);
    case "conflict":
      return errorResponse(409, result.code);
    case "unavailable":
      return errorResponse(503, result.status);
  }
}

export async function handleCatalogCsvPreviewRequest(
  request: Request,
  rawParams: Readonly<{ workspaceId: string }>,
  dependencies: CatalogCsvPreviewHttpDependencies,
): Promise<Response> {
  const params = z.strictObject({ workspaceId: uuidSchema }).safeParse(rawParams);
  if (!params.success) return errorResponse(404, "not_found");
  if (!isSameOrigin(request) || !isSameOriginFetch(request)) {
    return errorResponse(403, "origin_mismatch");
  }
  if (!mediaTypeIsValid(request) || !contentEncodingIsIdentity(request)) {
    return invalidRequest();
  }
  const body = await readLimitedBody(request);
  if (body.status === "too_large") return errorResponse(413, "file_too_large");
  if (body.status === "invalid") return invalidRequest();
  const input = decodeEnvelope(body.bytes, params.data.workspaceId);
  if (input === "invalid") return invalidRequest();
  if (input === "file_too_large") return errorResponse(413, input);
  try {
    return processedResponse(input, await dependencies.process(input));
  } catch {
    return errorResponse(500, "internal_error");
  }
}
