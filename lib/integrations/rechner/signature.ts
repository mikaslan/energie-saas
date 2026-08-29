import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  RechnerAuthenticationError,
  RechnerCredentialConfigurationError,
  RechnerInvalidRequestError,
} from "./errors";
import { RECHNER_INTAKE_SCOPE, type RechnerIntakeV1 } from "./types";

export const RECHNER_INTAKE_PATH = "/api/inbound/rechner/v1" as const;
export const RECHNER_SIGNATURE_WINDOW_SECONDS = 300;

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWER_HEX_256 = /^[0-9a-f]{64}$/;
const UNIX_SECONDS = /^[0-9]{10}$/;
const SIGNATURE = /^v1=([A-Za-z0-9_-]{43})$/;
const WORKSPACE_UUID = UUID;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DUMMY_SECRET = Buffer.alloc(32, 0x5a);
const ZERO_256 = Buffer.alloc(32);

type RechnerCredentialConfig = {
  keyId: string;
  workspaceId: string;
  scope: typeof RECHNER_INTAKE_SCOPE;
  secretBase64: string;
};

const verifiedBrand: unique symbol = Symbol("VerifiedRechnerIdentity");

export type VerifiedRechnerIdentity = {
  readonly keyId: string;
  readonly workspaceId: string;
  readonly scope: typeof RECHNER_INTAKE_SCOPE;
  readonly actor: `api:${string}`;
  readonly [verifiedBrand]: true;
};

export type RechnerSignatureHeaders = {
  keyId: string | null;
  timestamp: string | null;
  idempotencyKey: string | null;
  contentSha256: string | null;
  signature: string | null;
};

export type RechnerSignatureInput = {
  method: string;
  path: string;
  body: Uint8Array;
  headers: RechnerSignatureHeaders;
  nowSeconds?: number;
  credentialsJson?: string;
};

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!BASE64.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function parseCredentials(raw: string | undefined): Array<RechnerCredentialConfig & { secret: Buffer }> {
  if (!raw) throw new RechnerCredentialConfigurationError("RECHNER_INTAKE_KEYS_JSON fehlt");

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RechnerCredentialConfigurationError("JSON ist ungueltig");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new RechnerCredentialConfigurationError("erwartet werden 1 bis 20 Keys");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} ist kein Objekt`);
    }
    const record = entry as Record<string, unknown>;
    const names = Object.keys(record).sort();
    const expected = ["keyId", "scope", "secretBase64", "workspaceId"].sort();
    if (names.length !== expected.length || names.some((name, i) => name !== expected[i])) {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} hat unbekannte oder fehlende Felder`);
    }
    const { keyId, workspaceId, scope, secretBase64 } = record;
    if (typeof keyId !== "string" || !KEY_ID.test(keyId) || seen.has(keyId)) {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} hat keine eindeutige gueltige keyId`);
    }
    if (typeof workspaceId !== "string" || !WORKSPACE_UUID.test(workspaceId)) {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} hat keine gueltige workspaceId`);
    }
    if (scope !== RECHNER_INTAKE_SCOPE) {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} hat einen unzulaessigen Scope`);
    }
    if (typeof secretBase64 !== "string") {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} hat kein Secret`);
    }
    const secret = decodeCanonicalBase64(secretBase64);
    if (!secret || secret.length < 32 || secret.length > 64) {
      throw new RechnerCredentialConfigurationError(`Key ${index + 1} braucht 32 bis 64 Zufallsbytes`);
    }
    seen.add(keyId);
    return { keyId, workspaceId, scope, secretBase64, secret };
  });
}

function fixedEqual(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function signatureMessage(input: {
  method: string;
  path: string;
  keyId: string;
  timestamp: string;
  idempotencyKey: string;
  contentSha256: string;
}): string {
  return [
    "v1",
    input.method,
    input.path,
    input.keyId,
    input.timestamp,
    input.idempotencyKey,
    input.contentSha256,
  ].join("\n");
}

export function verifyRechnerSignature(input: RechnerSignatureInput): VerifiedRechnerIdentity {
  const credentials = parseCredentials(input.credentialsJson ?? process.env.RECHNER_INTAKE_KEYS_JSON);
  const raw = input.headers;

  const validKeyId = typeof raw.keyId === "string" && KEY_ID.test(raw.keyId);
  const validTimestamp = typeof raw.timestamp === "string" && UNIX_SECONDS.test(raw.timestamp);
  const validIdempotency = typeof raw.idempotencyKey === "string" && UUID.test(raw.idempotencyKey);
  const validHash = typeof raw.contentSha256 === "string" && LOWER_HEX_256.test(raw.contentSha256);
  const signatureMatch = typeof raw.signature === "string" ? SIGNATURE.exec(raw.signature) : null;

  const keyId = validKeyId ? raw.keyId! : "invalid-key";
  const timestamp = validTimestamp ? raw.timestamp! : "0000000000";
  const idempotencyKey = validIdempotency
    ? raw.idempotencyKey!
    : "00000000-0000-4000-8000-000000000000";
  const suppliedHash = validHash ? Buffer.from(raw.contentSha256!, "hex") : ZERO_256;
  const suppliedSignature = signatureMatch ? Buffer.from(signatureMatch[1], "base64url") : ZERO_256;
  const canonicalSignature = signatureMatch !== null
    && suppliedSignature.length === 32
    && suppliedSignature.toString("base64url") === signatureMatch[1];
  const credential = credentials.find((candidate) => candidate.keyId === keyId);
  const secret = credential?.secret ?? DUMMY_SECRET;
  const actualHashHex = sha256Hex(input.body);
  const actualHash = Buffer.from(actualHashHex, "hex");
  const message = signatureMessage({
    method: input.method,
    path: input.path,
    keyId,
    timestamp,
    idempotencyKey,
    contentSha256: validHash ? raw.contentSha256! : "0".repeat(64),
  });
  const actualSignature = createHmac("sha256", secret).update(message).digest();

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const requestTime = Number(timestamp);
  const timeIsFresh = validTimestamp && Number.isSafeInteger(requestTime)
    && Math.abs(now - requestTime) <= RECHNER_SIGNATURE_WINDOW_SECONDS;
  const authenticated =
    input.method === "POST"
    && input.path === RECHNER_INTAKE_PATH
    && validKeyId
    && validIdempotency
    && validHash
    && canonicalSignature
    && credential !== undefined
    && timeIsFresh
    && fixedEqual(suppliedHash, actualHash)
    && fixedEqual(suppliedSignature, actualSignature);

  if (!authenticated || !credential) throw new RechnerAuthenticationError();

  return {
    keyId: credential.keyId,
    workspaceId: credential.workspaceId,
    scope: credential.scope,
    actor: `api:${credential.keyId}`,
    [verifiedBrand]: true,
  };
}

export function assertSubmissionMatchesHeader(
  body: RechnerIntakeV1,
  idempotencyKey: string | null,
): void {
  if (idempotencyKey !== body.submissionId) throw new RechnerInvalidRequestError();
}
