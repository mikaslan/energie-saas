"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { listFileRequests } from "@/modules/file-requests";
import {
  ensureGridRegistration,
  GridRegistrationNotFoundError,
  gridRegistrationStatuses,
  GridRegistrationValidationError,
  setGridRegistrationAddons,
  setGridRegistrationDetails,
  transitionGridRegistration,
  type GridRegistrationStatus,
} from "@/modules/grid-registration";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const addonProduktSchema = z.enum(["pv", "wp"]);

// F13-12 §3: Stufe-2-Titel (Präfix-Verknüpfung wie F13-07); die Akte
// zählt Uploads aller Anfragen mit diesem Präfix, legt aber KEINE
// Anfragen automatisch an (kein Automatismus).
const FERTIGMELDUNG_PHOTO_TITLE_PREFIX = "Netz-Fertigmeldungs-Fotos";

export type GridRegistrationActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function mapError(error: unknown): GridRegistrationActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof GridRegistrationNotFoundError) return { status: "not_found" };
  if (error instanceof GridRegistrationValidationError) return { status: "invalid" };
  throw error;
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

// F13-02: Anlage ist idempotent (ein Datensatz je Projekt).
export async function ensureGridRegistrationAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", (tx, ctx) =>
      ensureGridRegistration(tx, ctx, ids.projectId),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Netzanmeldung angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

function optionalText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().slice(0, max);
}

function parseCheckbox(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true";
}

// F13-12 §5: Preis-Snapshot; leer = kein Snapshot, sonst int ≥ 0.
function parseBetragCents(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!/^\d{1,9}$/u.test(value.trim())) return "invalid";
  return Number(value.trim());
}

function parseAddons(formData: FormData): {
  mastrAddon: boolean;
  wallboxAddon: boolean;
  addonProdukt: "pv" | "wp" | null;
  addonBetragCents: number | null;
} | null {
  const produktRaw = optionalText(formData.get("addonProdukt"), 8);
  const addonProdukt = produktRaw === null ? null : addonProduktSchema.safeParse(produktRaw).data ?? null;
  if (produktRaw !== null && addonProdukt === null) return null;
  const addonBetragCents = parseBetragCents(formData.get("addonBetragCents"));
  if (addonBetragCents === "invalid") return null;
  return {
    mastrAddon: parseCheckbox(formData.get("mastrAddon")),
    wallboxAddon: parseCheckbox(formData.get("wallboxAddon")),
    addonProdukt,
    addonBetragCents,
  };
}

export async function setGridRegistrationDetailsAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const operatorName = optionalText(formData.get("operatorName"), 160);
  const meterNumber = optionalText(formData.get("meterNumber"), 64);
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", (tx, ctx) =>
      setGridRegistrationDetails(tx, ctx, {
        projectId: ids.projectId,
        operatorName,
        meterNumber,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Angaben gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

// F13-12 §5: Add-on-Vormerkung ohne Status-Sperre (eigener Service,
// eigenes Formular; Details-Sperre §6 gilt nur für Betreiber/Zähler).
export async function setGridRegistrationAddonsAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const addons = parseAddons(formData);
  if (!addons) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", (tx, ctx) =>
      setGridRegistrationAddons(tx, ctx, {
        projectId: ids.projectId,
        ...addons,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Add-ons gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function transitionGridRegistrationAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const statusValue = formData.get("status");
  const status = typeof statusValue === "string" ? statusValue : "";
  if (!(gridRegistrationStatuses as readonly string[]).includes(status)) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", async (tx, ctx) => {
      // F13-12 §2: nur vor →fertiggemeldet zählen (Erst-Beleg + Folge-
      // Uploads aller Stufe-2-Anfragen mit Titel-Präfix). Andere
      // Übergänge ohne Zählung (keine Zusatz-Permission nötig).
      let photoCount: number | undefined;
      if (status === "fertiggemeldet") {
        const requests = await listFileRequests(tx, ctx, ids.projectId);
        photoCount = requests
          .filter((request) => request.title.startsWith(FERTIGMELDUNG_PHOTO_TITLE_PREFIX))
          .reduce(
            (sum, request) => sum + request.uploads.length + (request.uploadedAt === null ? 0 : 1),
            0,
          );
      }
      return transitionGridRegistration(tx, ctx, {
        projectId: ids.projectId,
        status: status as GridRegistrationStatus,
        photoCount,
      });
    });
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Status geändert." };
  } catch (error) {
    if (error instanceof GridRegistrationValidationError) return { status: "conflict" };
    return mapError(error);
  }
}
