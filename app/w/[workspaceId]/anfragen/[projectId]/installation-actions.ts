"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  completeInstallation,
  createInstallation,
  InstallationConflictError,
  InstallationNotFoundError,
  InstallationValidationError,
  recordHandover,
  setInstallationVariant,
  setLeadInstaller,
} from "@/modules/installations";
import { OfferNotFoundError } from "@/modules/offers";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type InstallationActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceValue = formData.get("workspaceId");
  const projectValue = formData.get("projectId");
  if (typeof workspaceValue !== "string" || typeof projectValue !== "string") return null;
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  const project = idSchema.safeParse(projectValue);
  if (!workspace.success || !project.success) return null;
  return { workspaceId: workspace.data, projectId: project.data };
}

function mapError(error: unknown): InstallationActionState {
  if (error instanceof InstallationValidationError) return { status: "invalid" };
  if (error instanceof InstallationConflictError) return { status: "conflict" };
  if (error instanceof InstallationNotFoundError) return { status: "not_found" };
  if (error instanceof OfferNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

export async function createInstallationAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      createInstallation(tx, ctx, { projectId: ids.projectId }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Installation angelegt — das Projekt steht auf Installation." };
  } catch (error) {
    return mapError(error);
  }
}

export async function completeInstallationAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      completeInstallation(tx, ctx, { projectId: ids.projectId }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Installation abgeschlossen." };
  } catch (error) {
    return mapError(error);
  }
}

// F7-05 Abnahme: Wer/Wann/Bemerkung an abgeschlossener Installation.
// F7-05 Slice 3: Lead Installer setzen/leeren. Leerer Select-Wert gilt als
// explizites Leeren (kein stiller Beibehalt); alles andere Ungültige → invalid.
export async function setLeadInstallerAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const memberValue = formData.get("membershipId");
  if (typeof memberValue !== "string") return { status: "invalid" };
  const trimmed = memberValue.trim();
  const membershipId = trimmed === "" ? null : idSchema.safeParse(trimmed);
  if (membershipId !== null && !membershipId.success) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      setLeadInstaller(tx, ctx, {
        projectId: ids.projectId,
        membershipId: membershipId === null ? null : membershipId.data,
      }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return {
      status: "success",
      message: membershipId === null
        ? "Lead-Zuordnung aufgehoben."
        : "Lead Installer zugewiesen.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function recordHandoverAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const byNameValue = formData.get("byName");
  const noteValue = formData.get("note");
  const byName = typeof byNameValue === "string" ? byNameValue : "";
  const note = typeof noteValue === "string" && noteValue.trim() !== "" ? noteValue : null;
  if (byName.trim() === "") return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      recordHandover(tx, ctx, { projectId: ids.projectId, byName, note }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Abnahme festgehalten." };
  } catch (error) {
    return mapError(error);
  }
}

// F7-08 Workbook: zu installierende Variante binden (explizit; die UI
// schlägt die signierte Variante vor, der Mensch bestätigt).
export async function setInstallationVariantAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const variantValue = formData.get("variantId");
  if (typeof variantValue !== "string") return { status: "invalid" };
  const variant = idSchema.safeParse(variantValue);
  if (!variant.success) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      setInstallationVariant(tx, ctx, { projectId: ids.projectId, variantId: variant.data }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Zu installierende Variante festgelegt." };
  } catch (error) {
    return mapError(error);
  }
}
