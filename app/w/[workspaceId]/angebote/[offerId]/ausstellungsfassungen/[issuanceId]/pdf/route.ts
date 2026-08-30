import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OfferIssuanceIntegrityError,
  OfferIssuanceNotFoundError,
  OfferIssuancePersistenceError,
  readOfferIssuanceArtifact,
} from "@/modules/offers";

export const dynamic = "force-dynamic";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.pdf$/u;
const paramsSchema = z.strictObject({
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
  offerId: z.uuid().transform((value) => value.toLowerCase()),
  issuanceId: z.uuid().transform((value) => value.toLowerCase()),
});
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

function privateFailure(status: number): Response {
  return new Response(null, { status, headers: PRIVATE_HEADERS });
}

function artifactIsValid(artifact: {
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
}): boolean {
  if (
    !SAFE_FILENAME_PATTERN.test(artifact.filename)
    || artifact.mimeType !== "application/pdf"
    || !SHA256_PATTERN.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes < 100
    || artifact.sizeBytes > MAX_ARTIFACT_BYTES
    || artifact.bytes.length !== artifact.sizeBytes
    || !artifact.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
    || !/%%EOF[\t\r\n ]*$/u.test(
      artifact.bytes.subarray(Math.max(0, artifact.bytes.length - 1_024)).toString("latin1"),
    )
  ) return false;
  const actual = createHash("sha256").update(artifact.bytes).digest();
  const expected = Buffer.from(artifact.sha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      workspaceId: string;
      offerId: string;
      issuanceId: string;
    }>;
  },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { workspaceId, offerId, issuanceId } = parsed.data;

  try {
    const artifact = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_issuance_artifact",
      (tx, ctx) => readOfferIssuanceArtifact(tx, ctx, {
        workspaceId,
        offerId,
        issuanceId,
      }),
    );
    if (!artifactIsValid(artifact)) return privateFailure(503);

    const disposition = `attachment; filename="${artifact.filename}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`;
    return new Response(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Length": String(artifact.sizeBytes),
        "Content-Disposition": disposition,
      },
    });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return privateFailure(401);
    if (error instanceof PermissionDeniedError) return privateFailure(403);
    if (error instanceof OfferIssuanceNotFoundError) return privateFailure(404);
    if (
      error instanceof OfferIssuanceIntegrityError
      || error instanceof OfferIssuancePersistenceError
    ) return privateFailure(503);
    throw error;
  }
}
