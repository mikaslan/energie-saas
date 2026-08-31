"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION } from "@/lib/integrations/catalog/import-contract";
import type { CatalogImportJobState } from "@/lib/integrations/catalog/import-wire";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  cancelCatalogImport,
  CatalogImportConflictError,
  CatalogImportDispatchError,
  CatalogImportInputError,
  CatalogImportIntegrityError,
  CatalogImportPersistenceError,
  startCatalogImport,
} from "@/modules/catalog";

export type CatalogImportActionState =
  | { status: "idle" }
  | { status: "success"; state: CatalogImportJobState; replayed: boolean }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict"; state?: CatalogImportJobState }
  | { status: "expired" }
  | { status: "unavailable" };

const uuidSchema = z.uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const startSchema = z.strictObject({
  workspaceId: uuidSchema,
  importId: uuidSchema,
  rightsAttested: z.literal("yes"),
});
const cancelSchema = z.strictObject({
  workspaceId: uuidSchema,
  importId: uuidSchema,
});

function exactForm(formData: FormData, fields: readonly string[]): Record<string, string> | null {
  const allowed = new Set(fields);
  const values: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("$ACTION_")) continue;
    if (!allowed.has(name) || name in values || typeof value !== "string") return null;
    values[name] = value;
  }
  return Object.keys(values).length === fields.length ? values : null;
}

function actionError(error: unknown): CatalogImportActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof CatalogImportInputError) return { status: "invalid" };
  if (error instanceof CatalogImportConflictError) return { status: "conflict" };
  if (
    error instanceof CatalogImportIntegrityError
    || error instanceof CatalogImportPersistenceError
    || error instanceof CatalogImportDispatchError
  ) return { status: "unavailable" };
  return null;
}

export async function startCatalogImportAction(
  _previous: CatalogImportActionState,
  formData: FormData,
): Promise<CatalogImportActionState> {
  const raw = exactForm(formData, ["workspaceId", "importId", "rightsAttested"]);
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid" };
  const { workspaceId, importId } = parsed.data;
  try {
    const result = await authorizedAction(
      workspaceId,
      "catalog.manage",
      "catalog_import_start",
      (tx, ctx) => startCatalogImport(tx, ctx, {
        importId,
        attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
      }),
    );
    revalidatePath(`/w/${workspaceId}/katalog`);
    revalidatePath(`/w/${workspaceId}/katalog/importe/${importId}`);
    if (result.status === "not_found") return { status: "not_found" };
    if (result.status === "conflict") {
      return "state" in result
        ? { status: "conflict", state: result.state }
        : { status: "conflict" };
    }
    if (result.status === "cancelled_before_start") return { status: "expired" };
    return {
      status: "success",
      state: result.status === "replayed" ? result.state : result.status,
      replayed: result.status === "replayed",
    };
  } catch (error) {
    const state = actionError(error);
    if (state) return state;
    throw error;
  }
}

export async function cancelCatalogImportAction(
  _previous: CatalogImportActionState,
  formData: FormData,
): Promise<CatalogImportActionState> {
  const raw = exactForm(formData, ["workspaceId", "importId"]);
  const parsed = cancelSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid" };
  const { workspaceId, importId } = parsed.data;
  try {
    const result = await authorizedAction(
      workspaceId,
      "catalog.manage",
      "catalog_import_cancel",
      (tx, ctx) => cancelCatalogImport(tx, ctx, { importId }),
    );
    revalidatePath(`/w/${workspaceId}/katalog`);
    revalidatePath(`/w/${workspaceId}/katalog/importe/${importId}`);
    if (result.status === "not_found") return { status: "not_found" };
    if (result.status === "conflict") return { status: "conflict", state: result.state };
    return {
      status: "success",
      state: result.status,
      replayed: result.replayed,
    };
  } catch (error) {
    const state = actionError(error);
    if (state) return state;
    throw error;
  }
}
