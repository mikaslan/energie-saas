"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { OFFER_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/offers/template-contract";
import {
  archiveOfferTemplate,
  createOfferTemplate,
  restoreOfferTemplate,
  OfferTemplateConflictError,
  OfferTemplateNotFoundError,
  OfferTemplateValidationError,
  updateOfferTemplate,
} from "@/modules/offers";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type OfferTemplateActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (text.length < 1 || text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  return text;
}

// Optionale UUID-Referenz: leerer String heißt „kein Preset".
function parsePresetRef(value: FormDataEntryValue | null): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return null;
  return idSchema.safeParse(text).success ? text : undefined;
}

function parseFields(formData: FormData):
  | { name: string; paymentOptionId: string | null; discountTemplateId: string | null; subsidyTemplateId: string | null; position: number }
  | null {
  const name = parseText(formData.get("name"), 200);
  const positionValue = formData.get("position");
  const paymentOptionId = parsePresetRef(formData.get("paymentOptionId"));
  const discountTemplateId = parsePresetRef(formData.get("discountTemplateId"));
  const subsidyTemplateId = parsePresetRef(formData.get("subsidyTemplateId"));
  if (name === null || paymentOptionId === undefined || discountTemplateId === undefined || subsidyTemplateId === undefined) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  if (paymentOptionId === null && discountTemplateId === null && subsidyTemplateId === null) return null;
  return { name, paymentOptionId, discountTemplateId, subsidyTemplateId, position };
}

function mapError(error: unknown): OfferTemplateActionState {
  if (error instanceof OfferTemplateValidationError) return { status: "invalid" };
  if (error instanceof OfferTemplateConflictError) return { status: "conflict" };
  if (error instanceof OfferTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/angebots-vorlagen`;

export async function createOfferTemplateAction(
  _previous: OfferTemplateActionState,
  formData: FormData,
): Promise<OfferTemplateActionState> {
  const workspace = parseWorkspace(formData);
  if (!workspace) return { status: "invalid" };
  const fields = parseFields(formData);
  if (!fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "offer_template", (tx, ctx) =>
      createOfferTemplate(tx, ctx, {
        schemaVersion: OFFER_TEMPLATE_SCHEMA_VERSION,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateOfferTemplateAction(
  _previous: OfferTemplateActionState,
  formData: FormData,
): Promise<OfferTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  const fields = parseFields(formData);
  if (!parsedId.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "offer_template", (tx, ctx) =>
      updateOfferTemplate(tx, ctx, {
        schemaVersion: OFFER_TEMPLATE_SCHEMA_VERSION,
        id: parsedId.data,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

async function setActive(
  formData: FormData,
  active: boolean,
  message: string,
): Promise<OfferTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  if (!parsedId.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "offer_template", (tx, ctx) =>
      active
        ? restoreOfferTemplate(tx, ctx, {
          schemaVersion: OFFER_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        })
        : archiveOfferTemplate(tx, ctx, {
          schemaVersion: OFFER_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveOfferTemplateAction(
  _previous: OfferTemplateActionState,
  formData: FormData,
): Promise<OfferTemplateActionState> {
  return setActive(formData, false, "Vorlage archiviert.");
}

export async function restoreOfferTemplateAction(
  _previous: OfferTemplateActionState,
  formData: FormData,
): Promise<OfferTemplateActionState> {
  return setActive(formData, true, "Vorlage reaktiviert.");
}
