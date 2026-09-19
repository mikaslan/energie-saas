import { randomUUID } from "node:crypto";
import {
  RestAuthenticationError,
  RestCredentialConfigurationError,
  RestIdempotencyConflictError,
  RestInvalidRequestError,
  RestPayloadTooLargeError,
  RestRateLimitError,
  RestTemporarilyUnavailableError,
  RestUnsupportedMediaTypeError,
} from "./errors";
import {
  assertNoRestContentEncoding,
  assertRestJsonContentType,
  parseRestJson,
  readRestBody,
} from "./body";
import { validateRestIntake } from "./contract";
import {
  REST_INTAKE_PATH,
  sha256Hex,
  verifyRestSignature,
  type VerifiedRestIdentity,
} from "./signature";
import type {
  RestIntakeErrorCode,
  RestIntakeErrorV1,
  RestIntakeMeta,
  RestIntakeReceiptV1,
  RestIntakeV1,
} from "./types";

export type RestIntakeTransportMeta = RestIntakeMeta & {
  requestId: string;
};

export type RestIntakeProcessor = (
  identity: VerifiedRestIdentity,
  payload: RestIntakeV1,
  meta: RestIntakeTransportMeta,
) => Promise<RestIntakeReceiptV1>;

type HandlerOptions = {
  now?: () => Date;
  credentialsJson?: string;
};

function json(body: RestIntakeReceiptV1 | RestIntakeErrorV1, status: number, headers?: HeadersInit): Response {
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
  code: RestIntakeErrorCode,
  requestId: string,
  retryable: boolean,
  paths?: string[],
): RestIntakeErrorV1 {
  return {
    contractVersion: "rest-intake-error.v1",
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
  console.error("rest intake failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "NonError",
  });
}

export async function handleRestIntakeRequest(
  request: Request,
  processIntake: RestIntakeProcessor,
  options: HandlerOptions = {},
): Promise<Response> {
  const requestId = randomUUID();

  try {
    assertRestJsonContentType(request.headers.get("content-type"));
    assertNoRestContentEncoding(request.headers.get("content-encoding"));
    const bodyBytes = await readRestBody(request);
    // Das Replay-Fenster gilt am Ende des vollständigen, begrenzten Uploads.
    // Ein absichtlich langsamer Body darf keinen vorab eingefrorenen Zeitwert
    // und damit auch kein veraltetes receivedAt konservieren.
    const now = options.now?.() ?? new Date();
    const url = new URL(request.url);
    const signedPath = url.search === "" ? url.pathname : `${url.pathname}${url.search}`;
    const idempotencyKey = request.headers.get("idempotency-key");
    const signedAtHeader = request.headers.get("x-rest-timestamp");
    const identity = verifyRestSignature({
      method: request.method,
      path: signedPath,
      body: bodyBytes,
      nowSeconds: Math.floor(now.getTime() / 1000),
      credentialsJson: options.credentialsJson,
      headers: {
        keyId: request.headers.get("x-rest-key-id"),
        timestamp: signedAtHeader,
        idempotencyKey,
        contentSha256: request.headers.get("x-rest-content-sha256"),
        signature: request.headers.get("x-rest-signature"),
      },
    });

    const parsed = parseRestJson(bodyBytes);
    const contract = validateRestIntake(parsed);
    if (!contract.ok) {
      return json(errorBody("schema_invalid", requestId, false, contract.paths), 422);
    }
    // Bewusst KEIN Header-Binding wie Rechner-Intake: Client-Record-IDs sind
    // freie Texte (keine UUIDs). Die Dedupe-Domäne ist
    // (Workspace, Client-Record-ID) OHNE Key-ID im Fachservice; der
    // Idempotency-Key bleibt reiner Signatur-Nonce.
    void idempotencyKey;

    const receipt = await processIntake(identity, contract.value, {
      payloadSha256: sha256Hex(bodyBytes),
      signedAt: new Date(Number(signedAtHeader) * 1000),
      receivedAt: now,
      requestId,
    });
    return json(receipt, receipt.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof RestUnsupportedMediaTypeError) {
      return json(errorBody("unsupported_media_type", requestId, false), 415);
    }
    if (error instanceof RestPayloadTooLargeError) {
      return json(errorBody("payload_too_large", requestId, false), 413);
    }
    if (error instanceof RestAuthenticationError) {
      return json(errorBody("authentication_failed", requestId, false), 401);
    }
    if (error instanceof RestInvalidRequestError) {
      return json(errorBody("invalid_request", requestId, false), 400);
    }
    if (error instanceof RestIdempotencyConflictError) {
      return json(errorBody("idempotency_conflict", requestId, false), 409);
    }
    if (error instanceof RestRateLimitError) {
      return json(
        errorBody("rate_limited", requestId, true),
        429,
        { "Retry-After": String(error.retryAfterSeconds) },
      );
    }
    if (
      error instanceof RestCredentialConfigurationError
      || error instanceof RestTemporarilyUnavailableError
    ) {
      logUnexpected(requestId, error);
      return json(errorBody("temporarily_unavailable", requestId, true), 503);
    }

    logUnexpected(requestId, error);
    return json(errorBody("internal_error", requestId, true), 500);
  }
}

export { REST_INTAKE_PATH };
