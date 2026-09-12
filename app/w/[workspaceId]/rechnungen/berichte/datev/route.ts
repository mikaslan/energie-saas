import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  INVOICING_DATEV_COMMAND_VERSION,
  datevSkrSchema,
} from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  exportDatevBatch,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "@/modules/invoicing";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const monthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/u);

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

// F8-11 DATEV-EXTF Buchungsstapel (Muster: Berichte-CSV-Route). Read-Pfad
// ohne neue Permission; Attachment-Download, keine internen Fehlerdetails.
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
  const skrValue = searchParams.get("skr");
  const skr = skrValue !== null && datevSkrSchema.safeParse(skrValue).success
    ? (skrValue as "03" | "04")
    : null;
  if (skr === null) {
    return new Response("Ungültiger Kontenrahmen (03 oder 04)", {
      status: 400,
      headers: PRIVATE_HEADERS,
    });
  }

  try {
    const batch = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "invoicing_datev_export",
      (tx, ctx) => exportDatevBatch(tx, ctx, {
        schemaVersion: INVOICING_DATEV_COMMAND_VERSION,
        month,
        skr,
      }),
    );
    return new Response(batch.content, {
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
      return new Response("DATEV-Stapel für diesen Monat nicht möglich", {
        status: 400,
        headers: PRIVATE_HEADERS,
      });
    }
    throw error;
  }
}
