import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OfferPdfDraftIntegrityError,
  OfferPdfDraftNotFoundError,
  readOfferPdfDraftArtifact,
} from "@/modules/offers";

export const dynamic = "force-dynamic";

const paramsSchema = z.strictObject({
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
  offerId: z.uuid().transform((value) => value.toLowerCase()),
  pdfDraftId: z.uuid().transform((value) => value.toLowerCase()),
});
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.pdf$/u;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

function privateFailure(status: number): Response {
  return new Response(null, { status, headers: PRIVATE_HEADERS });
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      workspaceId: string;
      offerId: string;
      pdfDraftId: string;
    }>;
  },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { workspaceId, offerId, pdfDraftId } = parsed.data;

  try {
    const artifact = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_pdf_draft_artifact",
      (tx, ctx) => readOfferPdfDraftArtifact(tx, ctx, {
        workspaceId,
        offerId,
        jobId: pdfDraftId,
      }),
    );
    if (!SAFE_FILENAME_PATTERN.test(artifact.filename)) return privateFailure(503);

    const disposition = `attachment; filename="${artifact.filename}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`;
    return new Response(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": artifact.mimeType,
        "Content-Length": String(artifact.sizeBytes),
        "Content-Disposition": disposition,
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return privateFailure(401);
    if (error instanceof PermissionDeniedError) return privateFailure(403);
    if (error instanceof OfferPdfDraftNotFoundError) return privateFailure(404);
    if (error instanceof OfferPdfDraftIntegrityError) return privateFailure(503);
    throw error;
  }
}
