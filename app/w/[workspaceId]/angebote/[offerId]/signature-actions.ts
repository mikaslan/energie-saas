"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedOfferMutationAction,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  SIGNATURE_REQUEST_ANALOG_VERSION,
  SIGNATURE_REQUEST_CREATE_VERSION,
  SIGNATURE_REQUEST_WITHDRAW_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import type { SignatureActionState } from "./signature-action-state";
import type * as SignaturesModule from "@/modules/signatures";

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const TTL_DAYS_SCHEMA = z.coerce.number().int().min(1).max(60);
const REASON_SCHEMA = z.enum(["content_error", "recipient_error", "commercial_error", "other"]);
const ANALOG_MIME = z.enum(["application/pdf", "image/jpeg"]);

function workspaceIdFrom(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = UUID_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapSignatureError(error: unknown, services: typeof SignaturesModule): SignatureActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof services.SignatureValidationError) {
    return error.paths.length === 0 ? { status: "invalid" } : { status: "invalid", paths: error.paths };
  }
  if (error instanceof services.SignatureNotFoundError) return { status: "not_found" };
  if (error instanceof services.SignatureConflictError) {
    return { status: "conflict", code: error.code };
  }
  if (
    error instanceof services.SignatureIntegrityError
    || error instanceof services.SignaturePersistenceError
  ) return { status: "unavailable" };
  return null;
}

export async function createSignatureRequestAction(
  _previousState: SignatureActionState,
  formData: FormData,
): Promise<SignatureActionState> {
  const workspaceId = workspaceIdFrom(formData);
  if (!workspaceId) return { status: "invalid" };
  const services = await import("@/modules/signatures");
  try {
    const offerId = formData.get("offerId");
    const variantId = formData.get("variantId");
    const ttlDaysRaw = formData.get("ttlDays");
    if (typeof offerId !== "string" || typeof variantId !== "string" || typeof ttlDaysRaw !== "string") {
      return { status: "invalid" };
    }
    const parsed = z.strictObject({
      schemaVersion: z.literal(SIGNATURE_REQUEST_CREATE_VERSION),
      workspaceId: UUID_SCHEMA,
      offerId: UUID_SCHEMA,
      variantId: UUID_SCHEMA,
      ttlDays: TTL_DAYS_SCHEMA,
    }).safeParse({
      schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
      workspaceId,
      offerId,
      variantId,
      ttlDays: ttlDaysRaw,
    });
    if (!parsed.success) return { status: "invalid" };
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.signature.create"],
      "signature_request",
      (tx, ctx) => services.createSignatureRequest(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return {
      status: "created",
      requestId: result.requestId,
      token: result.token,
      expiresAt: result.expiresAt,
      replayed: result.replayed,
    };
  } catch (error) {
    const mapped = mapSignatureError(error, services);
    if (mapped) return mapped;
    throw error;
  }
}

export async function withdrawSignatureRequestAction(
  _previousState: SignatureActionState,
  formData: FormData,
): Promise<SignatureActionState> {
  const workspaceId = workspaceIdFrom(formData);
  if (!workspaceId) return { status: "invalid" };
  const services = await import("@/modules/signatures");
  try {
    const requestId = formData.get("requestId");
    const reasonCode = formData.get("reasonCode");
    if (typeof requestId !== "string" || typeof reasonCode !== "string") return { status: "invalid" };
    const parsed = z.strictObject({
      schemaVersion: z.literal(SIGNATURE_REQUEST_WITHDRAW_VERSION),
      workspaceId: UUID_SCHEMA,
      requestId: UUID_SCHEMA,
      reasonCode: REASON_SCHEMA,
    }).safeParse({
      schemaVersion: SIGNATURE_REQUEST_WITHDRAW_VERSION,
      workspaceId,
      requestId,
      reasonCode,
    });
    if (!parsed.success) return { status: "invalid" };
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.signature.withdraw"],
      "signature_request",
      (tx, ctx) => services.withdrawSignatureRequest(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return { status: "withdrawn", requestId: result.requestId, reasonCode: result.reasonCode };
  } catch (error) {
    const mapped = mapSignatureError(error, services);
    if (mapped) return mapped;
    throw error;
  }
}

export async function uploadAnalogSignatureAction(
  _previousState: SignatureActionState,
  formData: FormData,
): Promise<SignatureActionState> {
  const workspaceId = workspaceIdFrom(formData);
  if (!workspaceId) return { status: "invalid" };
  const services = await import("@/modules/signatures");
  try {
    const requestId = formData.get("requestId");
    const signingDate = formData.get("signingDate");
    const file = formData.get("artifact");
    if (typeof requestId !== "string" || typeof signingDate !== "string" || !(file instanceof File)) {
      return { status: "invalid" };
    }
    const mimeParsed = ANALOG_MIME.safeParse(file.type);
    if (!mimeParsed.success) return { status: "invalid" };
    const bytes = Buffer.from(await file.arrayBuffer());
    const parsed = z.strictObject({
      schemaVersion: z.literal(SIGNATURE_REQUEST_ANALOG_VERSION),
      workspaceId: UUID_SCHEMA,
      requestId: UUID_SCHEMA,
      mimeType: ANALOG_MIME,
      signingDate: z.string().min(1),
      artifactBytes: z.custom<Buffer>((value) => Buffer.isBuffer(value)),
    }).safeParse({
      schemaVersion: SIGNATURE_REQUEST_ANALOG_VERSION,
      workspaceId,
      requestId,
      mimeType: mimeParsed.data,
      signingDate,
      artifactBytes: bytes,
    });
    if (!parsed.success) return { status: "invalid" };
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["offer.signature.upload_analog"],
      "signature_request",
      (tx, ctx) => services.uploadAnalogSignature(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    return { status: "signed", requestId: result.requestId, mode: "analog" };
  } catch (error) {
    const mapped = mapSignatureError(error, services);
    if (mapped) return mapped;
    throw error;
  }
}
