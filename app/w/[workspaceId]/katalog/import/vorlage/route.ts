import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { catalogCsvTemplate } from "@/lib/integrations/catalog/import-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { assertCatalogImportAccess } from "@/modules/catalog";

export const dynamic = "force-dynamic";

const paramsSchema = z.strictObject({ workspaceId: z.uuid() });
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
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { workspaceId } = parsed.data;
  try {
    const template = await authorizedQuery(
      workspaceId,
      "catalog.manage",
      "catalog_import_template",
      async (_tx, ctx) => {
        assertCatalogImportAccess(ctx);
        return catalogCsvTemplate();
      },
    );
    return new Response(template, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"wmee-katalog-vorlage.csv\"",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return privateFailure(401);
    if (error instanceof PermissionDeniedError) return privateFailure(403);
    throw error;
  }
}
