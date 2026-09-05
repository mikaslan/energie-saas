"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  DISCOUNT_KIND_FIX,
  DISCOUNT_KIND_PERCENT,
  DISCOUNT_TEMPLATE_SCHEMA_VERSION,
} from "@/lib/integrations/discounts/contract";
import {
  archiveDiscountTemplate,
  createDiscountTemplate,
  DiscountTemplateConflictError,
  DiscountTemplateNotFoundError,
  DiscountTemplateValidationError,
  restoreDiscountTemplate,
  updateDiscountTemplate,
} from "@/modules/discounts";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type DiscountTemplateActionState =
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

// UI spricht Euro/Prozent, DB spricht Cent/Basispunkte (ehrliche Umrechnung,
// keine Float-Cents: Math.round auf ganze Einheiten).
function parseEuroToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/u.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function parsePercentToBps(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/u.test(normalized)) return null;
  const bps = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(bps) && bps >= 1 && bps <= 10_000 ? bps : null;
}

// F16.3 Slice A: kind-gesteuerte Felder — Fix braucht Betrag, Prozent
// braucht bps (Cap optional). Service + DB-CHECKs entscheiden final.
function parseFields(formData: FormData):
  | { name: string; kind: typeof DISCOUNT_KIND_FIX | typeof DISCOUNT_KIND_PERCENT; amountCents: number | null; percentBps: number | null; capCents: number | null; position: number }
  | null {
  const nameValue = formData.get("name");
  const kindValue = formData.get("kind");
  const positionValue = formData.get("position");
  if (typeof nameValue !== "string" || typeof positionValue !== "string") return null;
  const name = nameValue.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 200) return null;
  const position = /^\d+$/u.test(positionValue) ? Number(positionValue) : NaN;
  if (!Number.isSafeInteger(position) || position < 0) return null;
  if (kindValue !== DISCOUNT_KIND_FIX && kindValue !== DISCOUNT_KIND_PERCENT) return null;

  const amountCents = parseEuroToCents(formData.get("amountEuro"));
  const percentBps = parsePercentToBps(formData.get("percentValue"));
  const capCents = parseEuroToCents(formData.get("capEuro"));
  if (kindValue === DISCOUNT_KIND_FIX) {
    if (amountCents === null || percentBps !== null || capCents !== null) return null;
    return { name, kind: kindValue, amountCents, percentBps: null, capCents: null, position };
  }
  if (percentBps === null || amountCents !== null) return null;
  return { name, kind: kindValue, amountCents: null, percentBps, capCents, position };
}

function mapError(error: unknown): DiscountTemplateActionState {
  if (error instanceof DiscountTemplateValidationError) return { status: "invalid" };
  if (error instanceof DiscountTemplateConflictError) return { status: "conflict" };
  if (error instanceof DiscountTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/rabatt-vorlagen`;

export async function createDiscountTemplateAction(
  _previous: DiscountTemplateActionState,
  formData: FormData,
): Promise<DiscountTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const fields = parseFields(formData);
  if (!workspace || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "discount_template", (tx, ctx) =>
      createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: fields.name,
        kind: fields.kind,
        amountCents: fields.amountCents,
        percentBps: fields.percentBps,
        capCents: fields.capCents,
        position: fields.position,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateDiscountTemplateAction(
  _previous: DiscountTemplateActionState,
  formData: FormData,
): Promise<DiscountTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const fields = parseFields(formData);
  if (!workspace || !id?.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "discount_template", (tx, ctx) =>
      updateDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        id: id.data,
        name: fields.name,
        kind: fields.kind,
        amountCents: fields.amountCents,
        percentBps: fields.percentBps,
        capCents: fields.capCents,
        position: fields.position,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleActive(
  workspace: string,
  id: string,
  active: boolean,
): Promise<DiscountTemplateActionState> {
  try {
    await authorizedAction(workspace, "discount_template.write", "discount_template", (tx, ctx) =>
      active
        ? restoreDiscountTemplate(tx, ctx, id)
        : archiveDiscountTemplate(tx, ctx, id),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: active ? "Vorlage reaktiviert." : "Vorlage archiviert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveDiscountTemplateAction(
  _previous: DiscountTemplateActionState,
  formData: FormData,
): Promise<DiscountTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleActive(workspace, id.data, false);
}

export async function restoreDiscountTemplateAction(
  _previous: DiscountTemplateActionState,
  formData: FormData,
): Promise<DiscountTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleActive(workspace, id.data, true);
}
