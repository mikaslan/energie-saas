import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  assertCatalogImportAccess,
  CatalogImportIntegrityError,
  CatalogImportPersistenceError,
  getCatalogImportErrorReport,
} from "@/modules/catalog";

export const dynamic = "force-dynamic";

const paramsSchema = z.strictObject({
  workspaceId: z.uuid(),
  importId: z.uuid(),
});
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
  context: { params: Promise<{ workspaceId: string; importId: string }> },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { workspaceId, importId } = parsed.data;
  try {
    const report = await authorizedQuery(
      workspaceId,
      "catalog.manage",
      "catalog_import_error_report",
      async (tx, ctx) => {
        assertCatalogImportAccess(ctx);
        return getCatalogImportErrorReport(tx, ctx, { importId });
      },
    );
    if (report === null) return privateFailure(404);
    const filename = `katalog-import-${importId}-fehler.csv`;
    return new Response(report, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return privateFailure(401);
    if (error instanceof PermissionDeniedError) return privateFailure(403);
    if (
      error instanceof CatalogImportIntegrityError
      || error instanceof CatalogImportPersistenceError
    ) return privateFailure(503);
    throw error;
  }
}
