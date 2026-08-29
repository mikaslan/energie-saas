import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RechnerIdempotencyConflictError,
  RechnerRateLimitError,
} from "@/lib/integrations/rechner/errors";
import { handleRechnerIntakeRequest, type RechnerIntakeProcessor } from "@/lib/integrations/rechner/http";
import {
  RECHNER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyRechnerSignature,
} from "@/lib/integrations/rechner/signature";

const NOW = new Date("2026-08-29T08:30:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SUBMISSION_ID = "8d10a44f-b2f8-4f55-8dd7-8a5309800d4e";
const WORKSPACE_ID = "6f771760-8201-4b44-a813-b4fd5bbbe7b7";
const KEY_ID = "rechner-current";
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const FIXTURE_BYTES = readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
);

function credentials(entries = [{ keyId: KEY_ID, workspaceId: WORKSPACE_ID, secret: SECRET }]): string {
  return JSON.stringify(entries.map((entry) => ({
    keyId: entry.keyId,
    workspaceId: entry.workspaceId,
    scope: "rechner-intake.write",
    secretBase64: entry.secret.toString("base64"),
  })));
}

function signedRequest(input: {
  body?: Uint8Array;
  keyId?: string;
  secret?: Uint8Array;
  timestamp?: number;
  idempotencyKey?: string;
  path?: string;
  method?: string;
  contentType?: string;
  contentEncoding?: string;
  contentHash?: string;
  signaturePath?: string;
  signatureMethod?: string;
  signatureTransform?: (signature: string) => string;
} = {}): Request {
  const body = input.body ?? FIXTURE_BYTES;
  const keyId = input.keyId ?? KEY_ID;
  const timestamp = String(input.timestamp ?? NOW_SECONDS);
  const idempotencyKey = input.idempotencyKey ?? SUBMISSION_ID;
  const method = input.method ?? "POST";
  const path = input.path ?? RECHNER_INTAKE_PATH;
  const contentSha256 = input.contentHash ?? sha256Hex(body);
  const calculatedSignature = createHmac("sha256", input.secret ?? SECRET)
    .update(signatureMessage({
      method: input.signatureMethod ?? method,
      path: input.signaturePath ?? path,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");
  const signature = input.signatureTransform?.(calculatedSignature) ?? calculatedSignature;

  const headers = new Headers({
    "content-type": input.contentType ?? "application/json",
    "idempotency-key": idempotencyKey,
    "x-rechner-key-id": keyId,
    "x-rechner-timestamp": timestamp,
    "x-rechner-content-sha256": contentSha256,
    "x-rechner-signature": `v1=${signature}`,
  });
  if (input.contentEncoding !== undefined) headers.set("content-encoding", input.contentEncoding);

  return new Request(`https://clone.test${path}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD"
      ? undefined
      : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
}

function processor(duplicate = false, expectedSignedAt = NOW): RechnerIntakeProcessor {
  const implementation: RechnerIntakeProcessor = async (identity, payload, meta) => {
    expect(identity.workspaceId).toBe(WORKSPACE_ID);
    expect(identity.actor).toBe(`api:${KEY_ID}`);
    expect(payload.submissionId).toBe(SUBMISSION_ID);
    expect(meta.payloadSha256).toBe(createHash("sha256").update(FIXTURE_BYTES).digest("hex"));
    expect(meta.signedAt).toEqual(expectedSignedAt);
    return {
      contractVersion: "rechner-intake-receipt.v1",
      receiptId: "85174f91-cea2-4134-80a6-51d5f9773691",
      submissionId: payload.submissionId,
      status: "processed",
      duplicate,
    };
  };
  return vi.fn(implementation);
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Rechner HMAC", () => {
  it("hat einen festen sprachunabhaengigen Golden-Vektor", () => {
    const signature = createHmac("sha256", SECRET)
      .update(signatureMessage({
        method: "POST",
        path: RECHNER_INTAKE_PATH,
        keyId: KEY_ID,
        timestamp: "1787982600",
        idempotencyKey: SUBMISSION_ID,
        contentSha256: "8365d4fe1e3dd73096cc51abd460ba5686302e13ac04db84c01e3bd89da2345c",
      }))
      .digest("base64url");
    expect(SECRET.toString("base64")).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
    expect(signature).toBe("Ivg7oc_2mFMQI0H4AoPO9MzOEP4pxSF6NEVFHv-H4S8");
  });

  it("akzeptiert einen vorherigen Rotations-Key mit eigenem Workspace-Mapping", () => {
    const previousSecret = Buffer.alloc(32, 0x42);
    const previousId = "rechner-previous";
    const request = signedRequest({ keyId: previousId, secret: previousSecret });
    const identity = verifyRechnerSignature({
      method: request.method,
      path: RECHNER_INTAKE_PATH,
      body: FIXTURE_BYTES,
      nowSeconds: NOW_SECONDS,
      credentialsJson: credentials([
        { keyId: KEY_ID, workspaceId: WORKSPACE_ID, secret: SECRET },
        { keyId: previousId, workspaceId: WORKSPACE_ID, secret: previousSecret },
      ]),
      headers: {
        keyId: request.headers.get("x-rechner-key-id"),
        timestamp: request.headers.get("x-rechner-timestamp"),
        idempotencyKey: request.headers.get("idempotency-key"),
        contentSha256: request.headers.get("x-rechner-content-sha256"),
        signature: request.headers.get("x-rechner-signature"),
      },
    });
    expect(identity.keyId).toBe(previousId);
    expect(identity.workspaceId).toBe(WORKSPACE_ID);
  });
});

describe("POST /api/inbound/rechner/v1 transport", () => {
  it("liefert 201 erst nach erfolgreicher Verarbeitung", async () => {
    const processIntake = processor();
    const response = await handleRechnerIntakeRequest(signedRequest(), processIntake, {
      now: () => NOW,
      credentialsJson: credentials(),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await responseBody(response)).toMatchObject({ duplicate: false, status: "processed" });
    expect(processIntake).toHaveBeenCalledTimes(1);
  });

  it("prueft Zeitfenster und receivedAt erst nach vollstaendig gelesenem Body", async () => {
    const request = signedRequest();
    const now = vi.fn(() => {
      expect(request.bodyUsed).toBe(true);
      return NOW;
    });
    const response = await handleRechnerIntakeRequest(request, processor(), {
      now,
      credentialsJson: credentials(),
    });
    expect(response.status).toBe(201);
    expect(now).toHaveBeenCalledOnce();
  });

  it("liefert fuer dieselbe persistierte Receipt 200 duplicate=true", async () => {
    const response = await handleRechnerIntakeRequest(signedRequest(), processor(true), {
      now: () => NOW,
      credentialsJson: credentials(),
    });
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({ duplicate: true });
  });

  it.each([
    ["falscher Key", signedRequest({ keyId: "unknown" })],
    ["falsches Secret", signedRequest({ secret: Buffer.alloc(32, 9) })],
    ["falscher Body-Hash", signedRequest({ contentHash: "0".repeat(64) })],
    ["falscher Signaturpfad", signedRequest({ signaturePath: "/api/inbound/rechner/v2" })],
    ["falsche Methode", signedRequest({ method: "PUT" })],
    ["Query am Pfad", signedRequest({ path: `${RECHNER_INTAKE_PATH}?tenant=other` })],
    ["zu alter Zeitstempel", signedRequest({ timestamp: NOW_SECONDS - 301 })],
    ["zukuenftiger Zeitstempel", signedRequest({ timestamp: NOW_SECONDS + 301 })],
    ["nicht-kanonische Base64url-Signatur", signedRequest({
      signatureTransform: (value) => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        const last = alphabet.indexOf(value.at(-1)!);
        return `${value.slice(0, -1)}${alphabet[last + 1]}`;
      },
    })],
  ])("antwortet bei %s generisch mit 401", async (_label, request) => {
    const processIntake = processor();
    const response = await handleRechnerIntakeRequest(request, processIntake, {
      now: () => NOW,
      credentialsJson: credentials(),
    });
    expect(response.status).toBe(401);
    expect(await responseBody(response)).toMatchObject({
      error: { code: "authentication_failed", retryable: false },
    });
    expect(processIntake).not.toHaveBeenCalled();
  });

  it.each([NOW_SECONDS - 300, NOW_SECONDS + 300])(
    "akzeptiert die inklusive Zeitfenstergrenze %s",
    async (timestamp) => {
      const response = await handleRechnerIntakeRequest(
        signedRequest({ timestamp }),
        processor(false, new Date(timestamp * 1000)),
        { now: () => NOW, credentialsJson: credentials() },
      );
      expect(response.status).toBe(201);
    },
  );

  it("lehnt einen von submissionId abweichenden Idempotency-Key mit 400 ab", async () => {
    const response = await handleRechnerIntakeRequest(
      signedRequest({ idempotencyKey: "5f69fc7a-b2b6-455a-ac1e-45cb9fe666d0" }),
      processor(),
      { now: () => NOW, credentialsJson: credentials() },
    );
    expect(response.status).toBe(400);
    expect(await responseBody(response)).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("nennt bei Schemafehlern nur JSON-Pfade, nie den Wert", async () => {
    const value = JSON.parse(FIXTURE_BYTES.toString("utf8")) as Record<string, unknown>;
    (value.customer as Record<string, unknown>).email = "GEHEIM-NICHT-LOGGEN";
    const bytes = Buffer.from(JSON.stringify(value));
    const response = await handleRechnerIntakeRequest(signedRequest({ body: bytes }), processor(), {
      now: () => NOW,
      credentialsJson: credentials(),
    });
    const body = await responseBody(response);
    expect(response.status).toBe(422);
    expect(body).toMatchObject({ error: { code: "schema_invalid" } });
    expect(JSON.stringify(body)).not.toContain("GEHEIM-NICHT-LOGGEN");
  });

  it("begrenzt den Stream auch ohne vertrauenswuerdiges Content-Length", async () => {
    const bytes = Buffer.alloc(256 * 1024 + 1, 0x20);
    const response = await handleRechnerIntakeRequest(signedRequest({ body: bytes }), processor(), {
      now: () => NOW,
      credentialsJson: credentials(),
    });
    expect(response.status).toBe(413);
    expect(await responseBody(response)).toMatchObject({ error: { code: "payload_too_large" } });
  });

  it("akzeptiert nur JSON mit optionalem UTF-8-Charset", async () => {
    const bad = await handleRechnerIntakeRequest(
      signedRequest({ contentType: "text/plain" }),
      processor(),
      { now: () => NOW, credentialsJson: credentials() },
    );
    expect(bad.status).toBe(415);

    const good = await handleRechnerIntakeRequest(
      signedRequest({ contentType: "application/json; charset=utf-8" }),
      processor(),
      { now: () => NOW, credentialsJson: credentials() },
    );
    expect(good.status).toBe(201);
  });

  it.each(["gzip", "identity"])(
    "lehnt Content-Encoding %s als mehrdeutigen Signaturpfad ab",
    async (contentEncoding) => {
      const response = await handleRechnerIntakeRequest(
        signedRequest({ contentEncoding }),
        processor(),
        { now: () => NOW, credentialsJson: credentials() },
      );
      expect(response.status).toBe(415);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it("ist bei fehlender Secret-Konfiguration fail-closed und gibt kein Detail aus", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleRechnerIntakeRequest(signedRequest(), processor(), {
      now: () => NOW,
      credentialsJson: "",
    });
    expect(response.status).toBe(503);
    const body = await responseBody(response);
    expect(body).toMatchObject({ error: { code: "temporarily_unavailable", retryable: true } });
    expect(JSON.stringify(body)).not.toContain("RECHNER_INTAKE_KEYS_JSON");
  });

  it("mappt Conflict und Rate Limit ohne PII", async () => {
    const conflict = await handleRechnerIntakeRequest(
      signedRequest(),
      async () => { throw new RechnerIdempotencyConflictError(); },
      { now: () => NOW, credentialsJson: credentials() },
    );
    expect(conflict.status).toBe(409);
    expect(await responseBody(conflict)).toMatchObject({ error: { code: "idempotency_conflict" } });

    const limited = await handleRechnerIntakeRequest(
      signedRequest(),
      async () => { throw new RechnerRateLimitError(37); },
      { now: () => NOW, credentialsJson: credentials() },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("37");
  });
});
