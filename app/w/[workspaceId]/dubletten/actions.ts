"use server";

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
    // F1-22: KEIN Revalidate — jede Pfad-Anweisung rendert die AKTUELLE
    // Route (Detail) per RSC neu und aufgeloeste Eintraege fallen aus
    // getDedupeDetail (404); das Erfolgs-Feedback bliebe nicht stehen.
    // Queue/Board/Akte lesen bei Weiter-Navigation frisch.
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
    // F1-22: KEIN Revalidate (siehe markDedupeReviewedAction).
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
