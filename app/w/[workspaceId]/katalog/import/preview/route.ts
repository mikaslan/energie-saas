import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  autoMapCatalogCsvHeaders,
  CatalogCsvImportError,
  inspectCatalogCsvFile,
  parseCatalogCsvPreview,
} from "@/lib/integrations/catalog/import-contract";
import {
  handleCatalogCsvPreviewRequest,
  type CatalogCsvPreviewProcessResult,
  type CatalogCsvPreviewWireInput,
} from "@/lib/integrations/catalog/import-http";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  assertCatalogImportAccess,
  CatalogImportConflictError,
  CatalogImportDispatchError,
  CatalogImportInputError,
  CatalogImportIntegrityError,
  CatalogImportPersistenceError,
  prepareCatalogImport,
} from "@/modules/catalog";

export const dynamic = "force-dynamic";

async function processCatalogCsvPreview(
  input: CatalogCsvPreviewWireInput,
): Promise<CatalogCsvPreviewProcessResult> {
  try {
    return await authorizedAction(
      input.workspaceId,
      "catalog.manage",
      "catalog_import_preview",
      async (tx, ctx) => {
        assertCatalogImportAccess(ctx);
        if (input.mode === "inspect") {
          const inspection = inspectCatalogCsvFile({
            filename: input.filename,
            bytes: input.bytes,
          });
          return {
            status: "inspected" as const,
            intentId: input.intentId,
            inspection,
            mapping: autoMapCatalogCsvHeaders(inspection.headers),
          };
        }
        const preview = parseCatalogCsvPreview({
          filename: input.filename,
          bytes: input.bytes,
          mapping: input.mapping,
        });
        const prepared = await prepareCatalogImport(tx, ctx, {
          intentId: input.intentId,
          preview,
        });
        return {
          status: "prepared" as const,
          intentId: prepared.intentId,
          importId: prepared.importId,
          state: prepared.status,
          replayed: prepared.replayed,
          counts: {
            total: prepared.totalCount,
            valid: prepared.validCount,
            invalid: prepared.invalidCount,
          },
          previewExpiresAt: prepared.previewExpiresAt,
        };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "forbidden" };
    if (error instanceof CatalogCsvImportError) {
      return { status: "invalid", code: error.code };
    }
    if (error instanceof CatalogImportInputError) {
      return { status: "invalid", code: error.code };
    }
    if (error instanceof CatalogImportConflictError) {
      return { status: "conflict", code: error.code };
    }
    if (
      error instanceof CatalogImportIntegrityError
      || error instanceof CatalogImportPersistenceError
      || error instanceof CatalogImportDispatchError
    ) return { status: "unavailable" };
    throw error;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  return handleCatalogCsvPreviewRequest(
    request,
    await context.params,
    { process: processCatalogCsvPreview },
  );
}
