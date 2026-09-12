"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OrderPartNotFoundError,
  OrderPartValidationError,
  postOrderPartMessage,
  requestOrderPart,
  setOrderPartStatus,
  type OrderPartStatus,
} from "@/modules/order-parts";
import { InstallationNotFoundError } from "@/modules/installations";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type OrderPartActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function mapError(error: unknown): OrderPartActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof OrderPartNotFoundError) return { status: "not_found" };
  if (error instanceof InstallationNotFoundError) return { status: "not_found" };
  if (error instanceof OrderPartValidationError) return { status: "invalid" };
  throw error;
}

export async function requestOrderPartAction(
  _previous: OrderPartActionState,
  formData: FormData,
): Promise<OrderPartActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const installationId = uuidSchema.safeParse(formData.get("installationId"));
  const lineDomainId = z.string().trim().min(1).max(120).safeParse(formData.get("lineDomainId"));
  const quantityUnits = z.coerce.number().int().min(1).max(1_000_000).safeParse(
    formData.get("quantityUnits"),
  );
  if (!installationId.success || !lineDomainId.success || !quantityUnits.success) {
    return { status: "invalid" };
  }
  const noteValue = formData.get("note");
  const note = typeof noteValue === "string" && noteValue.trim() !== "" ? noteValue : null;
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "order_part", (tx, ctx) =>
      requestOrderPart(tx, ctx, {
        installationId: installationId.data,
        lineDomainId: lineDomainId.data,
        quantityUnits: quantityUnits.data,
        note,
      }),);
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Nachbestellung angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function postOrderPartMessageAction(
  _previous: OrderPartActionState,
  formData: FormData,
): Promise<OrderPartActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const id = uuidSchema.safeParse(formData.get("id"));
  const body = z.string().trim().min(1).max(2000).safeParse(formData.get("body"));
  if (!id.success || !body.success) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "order_part", (tx, ctx) =>
      postOrderPartMessage(tx, ctx, { id: id.data, body: body.data }),);
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Nachricht gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

const statuses: readonly OrderPartStatus[] = ["open", "ordered", "delivered", "cancelled"];

export async function setOrderPartStatusAction(
  _previous: OrderPartActionState,
  formData: FormData,
): Promise<OrderPartActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const id = uuidSchema.safeParse(formData.get("id"));
  const status = z.enum(statuses).safeParse(formData.get("status"));
  if (!id.success || !status.success) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "order_part", (tx, ctx) =>
      setOrderPartStatus(tx, ctx, { id: id.data, status: status.data }),);
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Status gesetzt." };
  } catch (error) {
    return mapError(error);
  }
}
