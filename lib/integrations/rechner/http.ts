import { randomUUID } from "node:crypto";
import {
  RechnerAuthenticationError,
  RechnerCredentialConfigurationError,
  RechnerIdempotencyConflictError,
  RechnerInvalidRequestError,
  RechnerPayloadTooLargeError,
  RechnerRateLimitError,
  RechnerTemporarilyUnavailableError,
  RechnerUnsupportedMediaTypeError,
} from "./errors";
import {
  assertNoRechnerContentEncoding,
  assertRechnerJsonContentType,
  parseRechnerJson,
  readRechnerBody,
} from "./body";
import { validateRechnerIntake } from "./contract";
import {
  assertSubmissionMatchesHeader,
  RECHNER_INTAKE_PATH,
  sha256Hex,
  verifyRechnerSignature,
  type VerifiedRechnerIdentity,
} from "./signature";
import type {
  RechnerIntakeErrorCode,
  RechnerIntakeErrorV1,
  RechnerIntakeMeta,
  RechnerIntakeReceiptV1,
  RechnerIntakeV1,
} from "./types";

export type RechnerIntakeTransportMeta = RechnerIntakeMeta & {
  requestId: string;
};

export type RechnerIntakeProcessor = (
  identity: VerifiedRechnerIdentity,
  payload: RechnerIntakeV1,
  meta: RechnerIntakeTransportMeta,
) => Promise<RechnerIntakeReceiptV1>;

type HandlerOptions = {
  now?: () => Date;
  credentialsJson?: string;
};

function json(body: RechnerIntakeReceiptV1 | RechnerIntakeErrorV1, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function errorBody(
  code: RechnerIntakeErrorCode,
  requestId: string,
  retryable: boolean,
  paths?: string[],
): RechnerIntakeErrorV1 {
  return {
    contractVersion: "rechner-intake-error.v1",
    error: {
      code,
      requestId,
      retryable,
      ...(paths && paths.length > 0 ? { paths } : {}),
    },
  };
}

function logUnexpected(requestId: string, error: unknown): void {
  // Keine Error-Message/Stack: Treiberfehler können Queryparameter und damit
  // PII enthalten. Request-ID + Klasse reichen für die korrelierte Diagnose.
  console.error("rechner intake failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "NonError",
  });
}

export async function handleRechnerIntakeRequest(
  request: Request,
  processIntake: RechnerIntakeProcessor,
  options: HandlerOptions = {},
): Promise<Response> {
  const requestId = randomUUID();

  try {
    assertRechnerJsonContentType(request.headers.get("content-type"));
    assertNoRechnerContentEncoding(request.headers.get("content-encoding"));
    const bodyBytes = await readRechnerBody(request);
    // Das Replay-Fenster gilt am Ende des vollständigen, begrenzten Uploads.
    // Ein absichtlich langsamer Body darf keinen vorab eingefrorenen Zeitwert
    // und damit auch kein veraltetes receivedAt konservieren.
    const now = options.now?.() ?? new Date();
    const url = new URL(request.url);
    const signedPath = url.search === "" ? url.pathname : `${url.pathname}${url.search}`;
    const idempotencyKey = request.headers.get("idempotency-key");
    const signedAtHeader = request.headers.get("x-rechner-timestamp");
    const identity = verifyRechnerSignature({
      method: request.method,
      path: signedPath,
      body: bodyBytes,
      nowSeconds: Math.floor(now.getTime() / 1000),
      credentialsJson: options.credentialsJson,
      headers: {
        keyId: request.headers.get("x-rechner-key-id"),
        timestamp: signedAtHeader,
        idempotencyKey,
        contentSha256: request.headers.get("x-rechner-content-sha256"),
        signature: request.headers.get("x-rechner-signature"),
      },
    });

    const parsed = parseRechnerJson(bodyBytes);
    const contract = validateRechnerIntake(parsed);
    if (!contract.ok) {
      return json(errorBody("schema_invalid", requestId, false, contract.paths), 422);
    }
    assertSubmissionMatchesHeader(contract.value, idempotencyKey);

    const receipt = await processIntake(identity, contract.value, {
      payloadSha256: sha256Hex(bodyBytes),
      signedAt: new Date(Number(signedAtHeader) * 1000),
      receivedAt: now,
      requestId,
    });
    return json(receipt, receipt.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof RechnerUnsupportedMediaTypeError) {
      return json(errorBody("unsupported_media_type", requestId, false), 415);
    }
    if (error instanceof RechnerPayloadTooLargeError) {
      return json(errorBody("payload_too_large", requestId, false), 413);
    }
    if (error instanceof RechnerAuthenticationError) {
      return json(errorBody("authentication_failed", requestId, false), 401);
    }
    if (error instanceof RechnerInvalidRequestError) {
      return json(errorBody("invalid_request", requestId, false), 400);
    }
    if (error instanceof RechnerIdempotencyConflictError) {
      return json(errorBody("idempotency_conflict", requestId, false), 409);
    }
    if (error instanceof RechnerRateLimitError) {
      return json(
        errorBody("rate_limited", requestId, true),
        429,
        { "Retry-After": String(error.retryAfterSeconds) },
      );
    }
    if (
      error instanceof RechnerCredentialConfigurationError
      || error instanceof RechnerTemporarilyUnavailableError
    ) {
      logUnexpected(requestId, error);
      return json(errorBody("temporarily_unavailable", requestId, true), 503);
    }

    logUnexpected(requestId, error);
    return json(errorBody("internal_error", requestId, true), 500);
  }
}

export { RECHNER_INTAKE_PATH };
