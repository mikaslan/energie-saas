import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  exportMonatsZip,
  InvoicingNotFoundError,
  InvoicingValidationError,
  INVOICING_MONATS_ZIP_COMMAND_VERSION,
} from "@/modules/invoicing";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const monthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/u);

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

// F8-20 Monats-ZIP (Muster: DATEV-Route). PDF-Bytes verlassen das System,
// daher `invoicing.issuing_details.write` (M3-02d-Schranke); Attachment-
// Download, keine internen Fehlerdetails (kein Orakel).
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const parsed = workspaceIdSchema.safeParse((await context.params).workspaceId);
  if (!parsed.success) {
    return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
  }
  const workspaceId = parsed.data;

  const searchParams = new URL(request.url).searchParams;
  const monthValue = searchParams.get("monat");
  const month = monthValue !== null && monthSchema.safeParse(monthValue).success
    ? monthValue
    : null;
  if (month === null) {
    return new Response("Ungültiger Monat", { status: 400, headers: PRIVATE_HEADERS });
  }

  try {
    const batch = await authorizedQuery(
      workspaceId,
      "invoicing.issuing_details.write",
      "invoicing_monats_zip",
      (tx, ctx) => exportMonatsZip(tx, ctx, {
        schemaVersion: INVOICING_MONATS_ZIP_COMMAND_VERSION,
        month,
      }),
    );
    return new Response(batch.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": batch.contentType,
        "Content-Disposition": `attachment; filename="${batch.fileName}"`,
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
      return new Response("Monats-ZIP für diesen Monat nicht möglich", {
        status: 400,
        headers: PRIVATE_HEADERS,
      });
    }
    throw error;
  }
}
