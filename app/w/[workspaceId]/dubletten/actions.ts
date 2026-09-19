"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  DedupeConflictError,
  DedupeNotFoundError,
  DedupeValidationError,
  linkDedupeProject,
  markDedupeReviewed,
} from "@/modules/dedupe";

const uuidSchema = z.uuid();
const entitySchema = z.enum(["contact", "project"]);

const markFormSchema = z.strictObject({
  workspaceId: uuidSchema,
  entity: entitySchema,
  id: uuidSchema,
  expectedRevision: z.coerce.number().int().positive().optional(),
});

const linkFormSchema = z.strictObject({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  canonicalContactId: uuidSchema,
});

export type MarkDedupeActionState =
  | { status: "idle" }
  | { status: "success"; changed: boolean }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not-found" }
  | { status: "conflict" };

export type LinkDedupeActionState =
  | { status: "idle" }
  | { status: "success"; changed: boolean }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not-found" }
  | { status: "conflict" };

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function revalidateDedupe(workspaceId: string, entity: string, id: string): void {
  revalidatePath(`/w/${workspaceId}/dubletten`);
  // KEIN Revalidate des Detail-Pfads: Aufgelöste Einträge fallen aus
  // getDedupeDetail (404) — das würde das Erfolgs-Feedback des gerade
  // abgeschickten Formulars durch die 404-Seite ersetzen. Queue/Board/Akte
  // sind die weiterführenden Sichten und werden stale.
  // Triage löst Blocker auf Board und Akte — beide werden stale.
  revalidatePath(`/w/${workspaceId}/anfragen`);
  if (entity === "projekt") revalidatePath(`/w/${workspaceId}/anfragen/${id}`);
}

export async function markDedupeReviewedAction(
  workspaceId: string,
  entity: "contact" | "project",
  id: string,
  _previousState: MarkDedupeActionState,
  formData: FormData,
): Promise<MarkDedupeActionState> {
  // Die Pfad-Parameter werden vor authorizedAction validiert, damit
  // kaputte Segmente keine Tenant-Transaktion öffnen.
  const parsed = markFormSchema.safeParse({
    workspaceId,
    entity,
    id,
    expectedRevision: emptyToUndefined(formData.get("expectedRevision")),
  });
  if (!parsed.success) return { status: "invalid" };
  const input = parsed.data;

  try {
    const result = await authorizedAction(
      input.workspaceId,
      input.entity === "contact" ? "contact.write" : "project.write",
      "dedupe",
      (tx, ctx) => markDedupeReviewed(tx, ctx, {
        entity: input.entity,
        id: input.id,
        expectedRevision: input.expectedRevision,
      }),
    );
    revalidateDedupe(
      input.workspaceId,
      input.entity === "contact" ? "kontakt" : "projekt",
      input.id,
    );
    return { status: "success", changed: result.changed };
  } catch (error) {
    if (error instanceof DedupeValidationError) return { status: "invalid" };
    if (error instanceof DedupeNotFoundError) return { status: "not-found" };
    if (error instanceof DedupeConflictError) return { status: "conflict" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}

export async function linkDedupeProjectAction(
  workspaceId: string,
  projectId: string,
  _previousState: LinkDedupeActionState,
  formData: FormData,
): Promise<LinkDedupeActionState> {
  const parsed = linkFormSchema.safeParse({
    workspaceId,
    projectId,
    canonicalContactId: emptyToUndefined(formData.get("canonicalContactId")),
  });
  if (!parsed.success) return { status: "invalid" };
  const input = parsed.data;

  try {
    const result = await authorizedAction(
      input.workspaceId,
      "project.write",
      "dedupe",
      (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: input.projectId,
        canonicalContactId: input.canonicalContactId,
      }),
    );
    revalidateDedupe(input.workspaceId, "projekt", input.projectId);
    return { status: "success", changed: result.changed };
  } catch (error) {
    if (error instanceof DedupeValidationError) return { status: "invalid" };
    if (error instanceof DedupeNotFoundError) return { status: "not-found" };
    if (error instanceof DedupeConflictError) return { status: "conflict" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}
