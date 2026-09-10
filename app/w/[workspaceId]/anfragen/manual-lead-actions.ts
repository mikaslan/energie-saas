"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { LeadSourceNotFoundError } from "@/modules/lead-sources/errors";
import {
  createManualLead,
  ManualLeadLaneError,
  ManualLeadValidationError,
} from "@/modules/projects";

const uuidSchema = z.uuid();

const manualLeadFormSchema = z.strictObject({
  workspaceId: uuidSchema,
  scope: z.enum(["residential", "commercial"]),
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  street: z.string().trim().max(200).optional(),
  houseNumber: z.string().trim().max(30).optional(),
  postalCode: z.string().trim().max(10).optional(),
  city: z.string().trim().max(200).optional(),
  leadSourceId: z.string().trim().max(100).optional(),
  note: z.string().trim().max(2000).optional(),
});

export type ManualLeadActionState =
  | { status: "idle" }
  | { status: "success"; projectId: string; contactReused: boolean }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "lane-missing" };

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

export async function createManualLeadAction(
  workspaceId: string,
  _previousState: ManualLeadActionState,
  formData: FormData,
): Promise<ManualLeadActionState> {
  const parsed = manualLeadFormSchema.safeParse({
    workspaceId,
    scope: formData.get("scope"),
    displayName: formData.get("displayName"),
    email: emptyToUndefined(formData.get("email")),
    phone: emptyToUndefined(formData.get("phone")),
    street: emptyToUndefined(formData.get("street")),
    houseNumber: emptyToUndefined(formData.get("houseNumber")),
    postalCode: emptyToUndefined(formData.get("postalCode")),
    city: emptyToUndefined(formData.get("city")),
    leadSourceId: emptyToUndefined(formData.get("leadSourceId")),
    note: emptyToUndefined(formData.get("note")),
  });
  if (!parsed.success) return { status: "invalid" };
  const input = parsed.data;

  try {
    const result = await authorizedAction(
      input.workspaceId,
      "project.write",
      "manual_lead",
      (tx, ctx) => createManualLead(tx, ctx, {
        scope: input.scope,
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
        street: input.street,
        houseNumber: input.houseNumber,
        postalCode: input.postalCode,
        city: input.city,
        leadSourceId: input.leadSourceId,
        note: input.note,
      }),
    );
    revalidatePath(`/w/${input.workspaceId}/anfragen`);
    return {
      status: "success",
      projectId: result.projectId,
      contactReused: result.contactReused,
    };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (
      error instanceof ManualLeadValidationError
      || error instanceof LeadSourceNotFoundError
    ) {
      return { status: "invalid" };
    }
    if (error instanceof ManualLeadLaneError) return { status: "lane-missing" };
    throw error;
  }
}
