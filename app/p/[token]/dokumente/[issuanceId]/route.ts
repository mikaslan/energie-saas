import { z } from "zod";

import { publicTokenCapsule } from "@/lib/action";
import {
  OfferIssuanceIntegrityError,
  OfferIssuanceNotFoundError,
  OfferIssuancePersistenceError,
  readPortalDocumentArtifactByToken,
} from "@/modules/offers";

export const dynamic = "force-dynamic";

// F10-07 Portal-Dokument-Download (My-Files-Rest): anonymer GET auf die
// freigegebene Ausstellungsfassung. Autorisierung ist allein das
// hoch-entropische Portal-Token (F10.1-Kapsel, kein Session-Kontext).
// Unbekannt/deformiert/entzogen/abgelaufen, fremde/unfreigegebene/
// zurückgezogene Issuance -> identischer 404-Endzustand (kein Orakel).
// Private Header + Attachment wie am internen Pfad; kein Caching
// sensibler Dokumente.
const paramsSchema = z.strictObject({
  token: z.string().min(1),
  issuanceId: z.uuid().transform((value) => value.toLowerCase()),
});
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.pdf$/u;
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

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ token: string; issuanceId: string }>;
  },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { token, issuanceId } = parsed.data;

  try {
    const artifact = await publicTokenCapsule((pool) =>
      readPortalDocumentArtifactByToken(pool, { token, issuanceId }),
    );
    if (
      !SAFE_FILENAME_PATTERN.test(artifact.filename)
      || artifact.mimeType !== "application/pdf"
      || !artifact.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
      || !/%%EOF[\t\r\n ]*$/u.test(
        artifact.bytes.subarray(Math.max(0, artifact.bytes.length - 1_024)).toString("latin1"),
      )
    ) return privateFailure(503);

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
    if (error instanceof OfferIssuanceNotFoundError) return privateFailure(404);
    if (
      error instanceof OfferIssuanceIntegrityError
      || error instanceof OfferIssuancePersistenceError
    ) return privateFailure(503);
    throw error;
  }
}
