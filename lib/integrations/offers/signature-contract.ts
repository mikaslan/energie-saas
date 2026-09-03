import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const SIGNATURE_REQUEST_CREATE_VERSION = "signature-request-create.v1" as const;
export const SIGNATURE_REQUEST_WITHDRAW_VERSION = "signature-request-withdraw.v1" as const;
export const SIGNATURE_REQUEST_ANALOG_VERSION = "signature-request-analog.v1" as const;
export const SIGNATURE_REQUEST_SIGN_VERSION = "signature-request-sign.v1" as const;

export const SIGNATURE_TTL_DAYS_MIN = 1;
export const SIGNATURE_TTL_DAYS_MAX = 60;
export const SIGNATURE_TTL_DAYS_DEFAULT = 14;

export const SIGNATURE_REVOCATION_WINDOW_DAYS = 14;

export const SIGNATURE_PNG_MAX_BYTES = 512 * 1024;
export const SIGNATURE_ANALOG_MAX_BYTES = 8 * 1024 * 1024;

export const SIGNATURE_STATUS = [
  "pending",
  "signed",
  "expired",
  "withdrawn",
  "revoked_by_customer",
] as const;

export const SIGNATURE_MODE = ["click", "draw", "analog"] as const;

export const SIGNATURE_WITHDRAWAL_REASON = [
  "content_error",
  "recipient_error",
  "commercial_error",
  "other",
] as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const ttlDaysSchema = z.int().safe().min(SIGNATURE_TTL_DAYS_MIN).max(SIGNATURE_TTL_DAYS_MAX);

export const signatureRequestCreateV1Schema = z.strictObject({
  schemaVersion: z.literal(SIGNATURE_REQUEST_CREATE_VERSION),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  variantId: uuidSchema,
  ttlDays: ttlDaysSchema,
});

export type SignatureRequestCreateV1 = z.infer<typeof signatureRequestCreateV1Schema>;

export const signatureRequestWithdrawV1Schema = z.strictObject({
  schemaVersion: z.literal(SIGNATURE_REQUEST_WITHDRAW_VERSION),
  workspaceId: uuidSchema,
  requestId: uuidSchema,
  reasonCode: z.enum(SIGNATURE_WITHDRAWAL_REASON),
});

export type SignatureRequestWithdrawV1 = z.infer<typeof signatureRequestWithdrawV1Schema>;

export const signatureRequestAnalogV1Schema = z.strictObject({
  schemaVersion: z.literal(SIGNATURE_REQUEST_ANALOG_VERSION),
  workspaceId: uuidSchema,
  requestId: uuidSchema,
  mimeType: z.enum(["application/pdf", "image/jpeg"]),
  signingDate: z.iso.datetime({ offset: true }),
  artifactBytes: z.custom<Buffer>((value) => Buffer.isBuffer(value))
    .refine((value) => value.length >= 1 && value.length <= SIGNATURE_ANALOG_MAX_BYTES),
});

export type SignatureRequestAnalogV1 = z.infer<typeof signatureRequestAnalogV1Schema>;

export const signatureRequestSignV1Schema = z.strictObject({
  schemaVersion: z.literal(SIGNATURE_REQUEST_SIGN_VERSION),
  token: z.string().min(1),
  mode: z.enum(["click", "draw"]),
  artifactMimeType: z.literal("image/png").nullable(),
  artifactBytes: z.custom<Buffer>((value) => Buffer.isBuffer(value)).nullable(),
});

export type SignatureRequestSignV1 = z.infer<typeof signatureRequestSignV1Schema>;

export type SignatureRequestStatus = (typeof SIGNATURE_STATUS)[number];
export type SignatureMode = (typeof SIGNATURE_MODE)[number];
export type SignatureWithdrawalReason = (typeof SIGNATURE_WITHDRAWAL_REASON)[number];

// Content-Hash-Bindung: das freigegebene Ausstellungsfassungs-Artefakt wird vor
// Erzeugung und vor jeder Signierung erneut gehasht (SHA-256, hex).
export function hashSignatureContent(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// Token: 32 Byte hoch-entropisch; in der DB liegt ausschließlich SHA-256(token).
export function generateSignatureToken(): {
  token: string;
  tokenHash: Buffer;
} {
  const raw = randomBytes(32);
  return {
    token: raw.toString("base64url"),
    tokenHash: createHash("sha256").update(raw).digest(),
  };
}

export function hashSignatureToken(token: string): Buffer {
  // base64url dekodiert (der Token wird als base64url erzeugt).
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== 32) throw new TypeError("Ungueltiges Signatur-Token.");
  return createHash("sha256").update(raw).digest();
}
