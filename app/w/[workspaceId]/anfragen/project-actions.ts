"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizedAction,
  authorizedQuery,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  AddressPlaceIdSchema,
  GeocodingInvalidResponseError,
  GeocodingRateLimitedError,
  GeocodingTimeoutError,
  GeocodingUnavailableError,
  resolveAddressCandidate,
  type AddressCandidate,
} from "@/lib/integrations/geocoding";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  confirmProjectSitePin,
  correctProjectSiteAddress,
  getProjectAddressCorrectionContext,
  SiteAddressCollisionError,
  SiteAddressConflictError,
  SiteAddressInvalidError,
  SiteAddressNotEditableError,
  SiteAddressSharedError,
  SitePinNotConfirmableError,
  SitePinOutOfRangeError,
} from "@/modules/projects";

const confirmPinInputSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  expectedAddressRevision: z.coerce.number().int().positive(),
});

const formCoordinateSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => Number(value))
  .pipe(z.number().finite());

const addressCorrectionInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  expectedAddressRevision: z.coerce.number().int().positive(),
  placeId: AddressPlaceIdSchema,
  pinLatitude: formCoordinateSchema.pipe(z.number().min(-90).max(90)),
  pinLongitude: formCoordinateSchema.pipe(z.number().min(-180).max(180)),
});

const addressCorrectionFormFields = new Set([
  "workspaceId",
  "projectId",
  "expectedAddressRevision",
  "placeId",
  "pinLatitude",
  "pinLongitude",
]);

function hasUnexpectedOrRepeatedAddressField(formData: FormData): boolean {
  const seen = new Set<string>();
  for (const name of formData.keys()) {
    // React/Next fügt eigene, verschlüsselte Action-Metafelder ein. Sie sind
    // keine Fachfelder und werden nie in den Parser oder Service übernommen.
    if (name.startsWith("$ACTION_")) continue;
    if (!addressCorrectionFormFields.has(name) || seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

export type ConfirmProjectPinState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "stale" }
  | { status: "not_confirmable" };

export type CorrectProjectAddressState =
  | { status: "idle" }
  | { status: "success"; addressRevision: number }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "stale" }
  | { status: "not_editable" }
  | { status: "collision" }
  | { status: "shared_site" }
  | { status: "pin_out_of_range" }
  | { status: "provider_rate_limited" }
  | { status: "provider_timeout" }
  | { status: "provider_unavailable" }
  | { status: "provider_invalid_response" };

export async function correctProjectAddressAction(
  _previousState: CorrectProjectAddressState,
  formData: FormData,
): Promise<CorrectProjectAddressState> {
  if (hasUnexpectedOrRepeatedAddressField(formData)) {
    return { status: "invalid" };
  }
  const parsed = addressCorrectionInputSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    projectId: formData.get("projectId"),
    expectedAddressRevision: formData.get("expectedAddressRevision"),
    placeId: formData.get("placeId"),
    pinLatitude: formData.get("pinLatitude"),
    pinLongitude: formData.get("pinLongitude"),
  });
  if (!parsed.success) return { status: "invalid" };

  const {
    workspaceId,
    projectId,
    expectedAddressRevision,
    placeId,
    pinLatitude,
    pinLongitude,
  } = parsed.data;

  try {
    const context = await authorizedQuery(
      workspaceId,
      "project.write",
      "site_address",
      (tx, ctx) => getProjectAddressCorrectionContext(tx, ctx, projectId),
    );
    if (!context || !context.editable) return { status: "not_editable" };
    if (context.addressRevision !== expectedAddressRevision) {
      return { status: "stale" };
    }
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { status: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { status: "denied" };
    }
    throw error;
  }

  let resolvedAddress: AddressCandidate;
  try {
    // Provider-I/O bleibt bewusst außerhalb jeder DB-Transaktion. Die folgende
    // Mutation autorisiert und prüft Site sowie Revision anschließend erneut.
    resolvedAddress = await resolveAddressCandidate(placeId);
  } catch (error) {
    if (error instanceof GeocodingRateLimitedError) {
      return { status: "provider_rate_limited" };
    }
    if (error instanceof GeocodingTimeoutError) {
      return { status: "provider_timeout" };
    }
    if (error instanceof GeocodingUnavailableError) {
      return { status: "provider_unavailable" };
    }
    if (error instanceof GeocodingInvalidResponseError) {
      return { status: "provider_invalid_response" };
    }
    throw error;
  }

  try {
    const result = await authorizedAction(
      workspaceId,
      "project.write",
      "site_address",
      (tx, ctx) => correctProjectSiteAddress(tx, ctx, {
        projectId,
        expectedAddressRevision,
        resolvedAddress,
        pin: { latitude: pinLatitude, longitude: pinLongitude },
      }),
    );

    revalidatePath(`/w/${workspaceId}/anfragen/${projectId}`);
    revalidatePath(`/w/${workspaceId}/anfragen`);
    return { status: "success", addressRevision: result.addressRevision };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { status: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { status: "denied" };
    }
    if (error instanceof SiteAddressConflictError) {
      return { status: "stale" };
    }
    if (error instanceof SiteAddressNotEditableError) {
      return { status: "not_editable" };
    }
    if (error instanceof SiteAddressCollisionError) {
      return { status: "collision" };
    }
    if (error instanceof SiteAddressSharedError) {
      return { status: "shared_site" };
    }
    if (error instanceof SitePinOutOfRangeError) {
      return { status: "pin_out_of_range" };
    }
    if (error instanceof SiteAddressInvalidError) {
      return { status: "provider_invalid_response" };
    }
    throw error;
  }
}

export async function confirmProjectSitePinAction(
  _previousState: ConfirmProjectPinState,
  formData: FormData,
): Promise<ConfirmProjectPinState> {
  const parsed = confirmPinInputSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    projectId: formData.get("projectId"),
    expectedAddressRevision: formData.get("expectedAddressRevision"),
  });
  if (!parsed.success) return { status: "invalid" };

  const { workspaceId, projectId, expectedAddressRevision } = parsed.data;
  try {
    await authorizedAction(
      workspaceId,
      "project.write",
      "site_pin",
      (tx, ctx) => confirmProjectSitePin(tx, ctx, {
        projectId,
        expectedAddressRevision,
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { status: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { status: "denied" };
    }
    if (error instanceof SiteAddressConflictError) {
      return { status: "stale" };
    }
    if (error instanceof SitePinNotConfirmableError) {
      return { status: "not_confirmable" };
    }
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/anfragen/${projectId}`);
  revalidatePath(`/w/${workspaceId}/anfragen`);
  return { status: "success" };
}
