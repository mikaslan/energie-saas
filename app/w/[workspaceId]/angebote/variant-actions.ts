"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedOfferMutationAction,
  NotAuthenticatedError,
} from "@/lib/action";
import {
  OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
  OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
  OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
} from "@/lib/integrations/offers/contract";
import {
  parseBundlesJsonInput,
  parseEuroCentsInput,
} from "@/lib/integrations/offers/variant-controls";
import { PermissionDeniedError } from "@/lib/permissions";
import type {
  SetPrimaryVariantEditorState,
  SetTotalOverrideEditorState,
  SetVariantBundlesEditorState,
} from "./variant-action-state";

type OfferServiceModule = typeof import("@/modules/offers");

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

const PRIMARY_FIELDS = new Set(["workspaceId", "offerId", "variantId"]);
const OVERRIDE_FIELDS = new Set(["workspaceId", "offerId", "overrideEuros"]);
const BUNDLES_FIELDS = new Set(["workspaceId", "offerId", "variantId", "bundlesJson"]);

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function exactFields(formData: FormData, allowed: ReadonlySet<string>): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!allowed.has(name)) return null;
    values.set(name, value);
  }
  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== allowed.size
    || ![...allowed].every((name) => values.has(name))
  ) return null;
  return Object.fromEntries(domainEntries);
}

function mapOfferError(
  error: unknown,
  offers: OfferServiceModule,
): { status: "unauthenticated" | "denied" | "not_found" | "unavailable" } | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof offers.OfferNotFoundError) return { status: "not_found" };
  if (
    error instanceof offers.OfferIntegrityError
    || error instanceof offers.OfferPersistenceError
    || error instanceof offers.OfferConflictError
  ) return { status: "unavailable" };
  return null;
}

export async function setPrimaryVariantEditorAction(
  _previousState: SetPrimaryVariantEditorState,
  formData: FormData,
): Promise<SetPrimaryVariantEditorState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const offers = await import("@/modules/offers");

  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = exactFields(formData, PRIMARY_FIELDS);
        if (!fields) throw new offers.OfferValidationError();
        const parsed = z.strictObject({
          offerId: UUID_SCHEMA,
          variantId: UUID_SCHEMA,
        }).safeParse({ offerId: fields.offerId, variantId: fields.variantId });
        if (!parsed.success) throw new offers.OfferValidationError();
        return offers.setPrimaryVariant(tx, ctx, {
          schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
          ...parsed.data,
        });
      },
    );

    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    revalidatePath(`/w/${workspaceId}/angebote`);
    return { status: "success", alreadyPrimary: result.alreadyPrimary };
  } catch (error) {
    if (error instanceof offers.OfferValidationError) return { status: "invalid" };
    const mapped = mapOfferError(error, offers);
    if (mapped) return mapped;
    throw error;
  }
}

export async function setTotalOverrideEditorAction(
  _previousState: SetTotalOverrideEditorState,
  formData: FormData,
): Promise<SetTotalOverrideEditorState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const offers = await import("@/modules/offers");

  try {
    const outcome = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write", "price.edit"],
      "offer",
      async (tx, ctx) => {
        const fields = exactFields(formData, OVERRIDE_FIELDS);
        if (!fields) throw new offers.OfferValidationError();
        const raw = fields.overrideEuros.trim();
        const cents = raw === "" ? null : parseEuroCentsInput(raw);
        if (raw !== "" && cents === null) throw new offers.OfferValidationError();
        return offers.setTotalPriceOverride(tx, ctx, {
          schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
          offerId: fields.offerId,
          totalPriceOverrideNetCents: cents,
        });
      },
    );

    revalidatePath(`/w/${workspaceId}/angebote/${outcome.offerId}`);
    revalidatePath(`/w/${workspaceId}/angebote`);
    return {
      status: "success",
      changed: outcome.changed,
      cleared: outcome.totalPriceOverrideNetCents === null,
    };
  } catch (error) {
    if (error instanceof offers.OfferValidationError) return { status: "invalid" };
    const mapped = mapOfferError(error, offers);
    if (mapped) return mapped;
    throw error;
  }
}

export async function setVariantBundlesEditorAction(
  _previousState: SetVariantBundlesEditorState,
  formData: FormData,
): Promise<SetVariantBundlesEditorState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const offers = await import("@/modules/offers");

  try {
    const result = await authorizedOfferMutationAction(
      workspaceId,
      ["project.write"],
      "offer_variant",
      async (tx, ctx) => {
        const fields = exactFields(formData, BUNDLES_FIELDS);
        if (!fields) throw new offers.OfferValidationError();
        const parsedIds = z.strictObject({
          offerId: UUID_SCHEMA,
          variantId: UUID_SCHEMA,
        }).safeParse({ offerId: fields.offerId, variantId: fields.variantId });
        const bundles = parseBundlesJsonInput(fields.bundlesJson);
        if (!parsedIds.success || bundles === null) throw new offers.OfferValidationError();
        return offers.setOptionalBundles(tx, ctx, {
          schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
          ...parsedIds.data,
          bundles,
        });
      },
    );

    revalidatePath(`/w/${workspaceId}/angebote/${result.offerId}`);
    revalidatePath(`/w/${workspaceId}/angebote`);
    return { status: "success", changed: result.changed };
  } catch (error) {
    if (error instanceof offers.OfferValidationError) return { status: "invalid" };
    const mapped = mapOfferError(error, offers);
    if (mapped) return mapped;
    throw error;
  }
}
