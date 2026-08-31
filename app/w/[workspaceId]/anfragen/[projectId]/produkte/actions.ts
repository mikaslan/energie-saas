"use server";

import { z } from "zod";

import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CatalogInputError,
  CatalogIntegrityError,
  CatalogPersistenceError,
  searchActiveProjectCatalogComponents,
} from "@/modules/catalog";
import {
  toResolutionSelectableComponent,
  type ResolutionSelectableComponent,
} from "./selection-view";

export type ProjectCatalogSearchState =
  | { status: "idle" }
  | {
      status: "success";
      query: string;
      components: readonly ResolutionSelectableComponent[];
    }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" };

const searchSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  query: z.string().max(120)
    .transform((value) => value.normalize("NFKC").trim())
    .pipe(z.string().min(2).max(120)),
});

function exactSearchForm(formData: FormData): Record<string, string> | null {
  const fields = new Set(["workspaceId", "projectId", "query"]);
  const values: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("$ACTION_")) continue;
    if (!fields.has(name) || name in values || typeof value !== "string") return null;
    values[name] = value;
  }
  return Object.keys(values).length === fields.size ? values : null;
}

export async function searchProjectCatalogAction(
  _previous: ProjectCatalogSearchState,
  formData: FormData,
): Promise<ProjectCatalogSearchState> {
  const parsed = searchSchema.safeParse(exactSearchForm(formData));
  if (!parsed.success) return { status: "invalid" };
  try {
    const result = await authorizedAction(
      parsed.data.workspaceId,
      "project.read",
      "project_catalog_search",
      (tx, ctx) => searchActiveProjectCatalogComponents(tx, ctx, {
        projectId: parsed.data.projectId,
        query: parsed.data.query,
      }),
    );
    if (result === null) return { status: "not_found" };
    return {
      status: "success",
      query: parsed.data.query,
      components: result.map(toResolutionSelectableComponent),
    };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof CatalogInputError) return { status: "invalid" };
    if (
      error instanceof CatalogIntegrityError
      || error instanceof CatalogPersistenceError
      || error instanceof TypeError
    ) return { status: "unavailable" };
    throw error;
  }
}
