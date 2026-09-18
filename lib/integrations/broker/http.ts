import { randomUUID } from "node:crypto";
import {
  BrokerAuthenticationError,
  BrokerCredentialConfigurationError,
  BrokerIdempotencyConflictError,
  BrokerInvalidRequestError,
  BrokerPayloadTooLargeError,
  BrokerRateLimitError,
  BrokerTemporarilyUnavailableError,
  BrokerUnsupportedMediaTypeError,
} from "./errors";
import {
  assertNoBrokerContentEncoding,
  assertBrokerJsonContentType,
  parseBrokerJson,
  readBrokerBody,
} from "./body";
import { validateBrokerIntake } from "./contract";
import {
  BROKER_INTAKE_PATH,
  sha256Hex,
  verifyBrokerSignature,
  type VerifiedBrokerIdentity,
} from "./signature";
import type {
  BrokerIntakeErrorCode,
  BrokerIntakeErrorV1,
  BrokerIntakeMeta,
  BrokerIntakeReceiptV1,
  BrokerIntakeV1,
} from "./types";

export type BrokerIntakeTransportMeta = BrokerIntakeMeta & {
  requestId: string;
};

export type BrokerIntakeProcessor = (
  identity: VerifiedBrokerIdentity,
  payload: BrokerIntakeV1,
  meta: BrokerIntakeTransportMeta,
) => Promise<BrokerIntakeReceiptV1>;

type HandlerOptions = {
  now?: () => Date;
  credentialsJson?: string;
};

function json(body: BrokerIntakeReceiptV1 | BrokerIntakeErrorV1, status: number, headers?: HeadersInit): Response {
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
  code: BrokerIntakeErrorCode,
  requestId: string,
  retryable: boolean,
  paths?: string[],
): BrokerIntakeErrorV1 {
  return {
    contractVersion: "broker-intake-error.v1",
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
  console.error("broker intake failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "NonError",
  });
}

export async function handleBrokerIntakeRequest(
  request: Request,
  processIntake: BrokerIntakeProcessor,
  options: HandlerOptions = {},
): Promise<Response> {
  const requestId = randomUUID();

  try {
    assertBrokerJsonContentType(request.headers.get("content-type"));
    assertNoBrokerContentEncoding(request.headers.get("content-encoding"));
    const bodyBytes = await readBrokerBody(request);
    // Das Replay-Fenster gilt am Ende des vollständigen, begrenzten Uploads.
    // Ein absichtlich langsamer Body darf keinen vorab eingefrorenen Zeitwert
    // und damit auch kein veraltetes receivedAt konservieren.
    const now = options.now?.() ?? new Date();
    const url = new URL(request.url);
    const signedPath = url.search === "" ? url.pathname : `${url.pathname}${url.search}`;
    const idempotencyKey = request.headers.get("idempotency-key");
    const signedAtHeader = request.headers.get("x-broker-timestamp");
    const identity = verifyBrokerSignature({
      method: request.method,
      path: signedPath,
      body: bodyBytes,
      nowSeconds: Math.floor(now.getTime() / 1000),
      credentialsJson: options.credentialsJson,
      headers: {
        keyId: request.headers.get("x-broker-key-id"),
        timestamp: signedAtHeader,
        idempotencyKey,
        contentSha256: request.headers.get("x-broker-content-sha256"),
        signature: request.headers.get("x-broker-signature"),
      },
    });

    const parsed = parseBrokerJson(bodyBytes);
    const contract = validateBrokerIntake(parsed);
    if (!contract.ok) {
      return json(errorBody("schema_invalid", requestId, false, contract.paths), 422);
    }
    // Bewusst KEIN Header-Binding wie Rechner-Intake: Broker-Record-IDs sind
    // freie Texte (keine UUIDs). Die Dedupe-Domäne ist
    // (Workspace, Broker-Key, Broker-Record-ID) im Fachservice; der
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
    if (error instanceof BrokerUnsupportedMediaTypeError) {
      return json(errorBody("unsupported_media_type", requestId, false), 415);
    }
    if (error instanceof BrokerPayloadTooLargeError) {
      return json(errorBody("payload_too_large", requestId, false), 413);
    }
    if (error instanceof BrokerAuthenticationError) {
      return json(errorBody("authentication_failed", requestId, false), 401);
    }
    if (error instanceof BrokerInvalidRequestError) {
      return json(errorBody("invalid_request", requestId, false), 400);
    }
    if (error instanceof BrokerIdempotencyConflictError) {
      return json(errorBody("idempotency_conflict", requestId, false), 409);
    }
    if (error instanceof BrokerRateLimitError) {
      return json(
        errorBody("rate_limited", requestId, true),
        429,
        { "Retry-After": String(error.retryAfterSeconds) },
      );
    }
    if (
      error instanceof BrokerCredentialConfigurationError
      || error instanceof BrokerTemporarilyUnavailableError
    ) {
      logUnexpected(requestId, error);
      return json(errorBody("temporarily_unavailable", requestId, true), 503);
    }

    logUnexpected(requestId, error);
    return json(errorBody("internal_error", requestId, true), 500);
  }
}

export { BROKER_INTAKE_PATH };
