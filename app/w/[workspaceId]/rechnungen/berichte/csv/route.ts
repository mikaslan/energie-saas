import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { INVOICING_REPORT_COMMAND_VERSION } from "@/lib/integrations/invoicing/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { exportInvoicingReport } from "@/modules/invoicing";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const monthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/u);

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const parsed = workspaceIdSchema.safeParse((await context.params).workspaceId);
  if (!parsed.success) {
    return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
  }
  const workspaceId = parsed.data;

  const monthValue = new URL(request.url).searchParams.get("monat");
  const month = monthValue !== null && monthSchema.safeParse(monthValue).success
    ? monthValue
    : null;
  if (month === null) {
    return new Response("Ungültiger Monat", { status: 400, headers: PRIVATE_HEADERS });
  }

  try {
    const csv = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "invoicing_report_export",
      (tx, ctx) => exportInvoicingReport(tx, ctx, {
        schemaVersion: INVOICING_REPORT_COMMAND_VERSION,
        month,
      }),
    );
    return new Response(csv.content, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": csv.contentType,
        "Content-Disposition": `attachment; filename="${csv.fileName}"`,
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
    throw error;
  }
}
