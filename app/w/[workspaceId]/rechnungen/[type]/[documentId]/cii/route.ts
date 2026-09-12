import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  COMMERCIAL_DOCUMENT_CII_COMMAND_VERSION,
  commercialDocumentTypes,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  exportDocumentCii,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "@/modules/invoicing";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const typeSchema = z.enum(commercialDocumentTypes);
const documentIdSchema = z.uuid();

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

// F8-10 E-Rechnung CII-Export (Muster: Berichte-CSV-Route). Read-Pfad ohne
// neue Permission; Attachment-Download, keine internen Fehlerdetails.
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; type: string; documentId: string }> },
): Promise<Response> {
  void request;
  const params = await context.params;
  const parsedWorkspace = workspaceIdSchema.safeParse(params.workspaceId);
  const parsedType = typeSchema.safeParse(params.type);
  const parsedDocument = documentIdSchema.safeParse(params.documentId);
  if (!parsedWorkspace.success || !parsedType.success || !parsedDocument.success) {
    return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
  }
  const workspaceId = parsedWorkspace.data;

  try {
    const result = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "commercial_document_cii_export",
      (tx, ctx) => exportDocumentCii(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_CII_COMMAND_VERSION,
        type: parsedType.data,
        documentId: parsedDocument.data,
      }),
    );
    return new Response(result.content, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return new Response("Nicht angemeldet", { status: 401, headers: PRIVATE_HEADERS });
    }
    if (error instanceof PermissionDeniedError) {
      return new Response("Nicht freigegeben", { status: 403, headers: PRIVATE_HEADERS });
    }
    if (error instanceof InvoicingNotFoundError) {
      return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
    }
    if (error instanceof InvoicingValidationError) {
      return new Response("E-Rechnung für diesen Beleg nicht möglich", {
        status: 400,
        headers: PRIVATE_HEADERS,
      });
    }
    throw error;
  }
}
