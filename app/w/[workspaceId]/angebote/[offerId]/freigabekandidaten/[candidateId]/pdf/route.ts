import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OfferReleaseIntegrityError,
  OfferReleaseNotFoundError,
  OfferReleasePersistenceError,
  readOfferReleaseCandidateArtifact,
} from "@/modules/offers";

export const dynamic = "force-dynamic";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.pdf$/u;
const paramsSchema = z.strictObject({
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
  offerId: z.uuid().transform((value) => value.toLowerCase()),
  candidateId: z.uuid().transform((value) => value.toLowerCase()),
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
      candidateId: string;
    }>;
  },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { workspaceId, offerId, candidateId } = parsed.data;

  try {
    const artifact = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_release_candidate_artifact",
      (tx, ctx) => readOfferReleaseCandidateArtifact(tx, ctx, {
        workspaceId,
        offerId,
        candidateId,
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
    if (error instanceof OfferReleaseNotFoundError) return privateFailure(404);
    if (
      error instanceof OfferReleaseIntegrityError
      || error instanceof OfferReleasePersistenceError
    ) return privateFailure(503);
    throw error;
  }
}
