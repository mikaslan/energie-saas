import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { commercialDocumentTypes } from "@/lib/integrations/invoicing/contract";
import {
  InvoicePdfIntegrityError,
  InvoicePdfNotFoundError,
  readInvoicePdfArtifact,
} from "@/modules/invoicing";

export const dynamic = "force-dynamic";

const paramsSchema = z.strictObject({
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
  type: z.enum(commercialDocumentTypes),
  documentId: z.uuid().transform((value) => value.toLowerCase()),
  jobId: z.uuid().transform((value) => value.toLowerCase()),
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
      type: string;
      documentId: string;
      jobId: string;
    }>;
  },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { workspaceId, documentId, jobId } = parsed.data;

  try {
    const artifact = await authorizedQuery(
      workspaceId,
      "invoicing.issuing_details.write",
      "invoice_pdf_artifact",
      (tx, ctx) => readInvoicePdfArtifact(tx, ctx, {
        workspaceId,
        documentId,
        jobId,
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
    if (error instanceof InvoicePdfNotFoundError) return privateFailure(404);
    if (error instanceof InvoicePdfIntegrityError) return privateFailure(503);
    throw error;
  }
}
