"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  authorizedAction,
  NotAuthenticatedError,
} from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";

type DeliveryServiceModule = typeof import("@/modules/invoicing");

export type MarkSentWithDeliveryActionState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "unavailable" }
  | {
    status: "success";
    sentAt: string;
    invoiceJobId: string;
    paymentJobId: string | null;
  };

export const MARK_SENT_WITH_DELIVERY_INITIAL_STATE = {
  status: "idle",
} as const satisfies MarkSentWithDeliveryActionState;

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
// F8-19: exakte Domänenfelder (workspaceId/documentId/channel, keine
// Extrafelder). Der Dokumenttyp für die Revalidierung kommt aus dem
// Service-Ergebnis, nicht aus dem Formular.
const DELIVERY_FIELDS = new Set([
  "workspaceId",
  "documentId",
  "channel",
]);
const deliveryFormSchema = z.strictObject({
  workspaceId: WORKSPACE_ID_SCHEMA,
  documentId: z.uuid().transform((value) => value.toLowerCase()),
  channel: z.literal("manual"),
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function parseExactForm(formData: FormData): z.infer<typeof deliveryFormSchema> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!DELIVERY_FIELDS.has(name)) return null;
    values.set(name, value);
  }

  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== DELIVERY_FIELDS.size
    || ![...DELIVERY_FIELDS].every((name) => values.has(name))
  ) return null;

  const parsed = deliveryFormSchema.safeParse(Object.fromEntries(domainEntries));
  return parsed.success ? parsed.data : null;
}

function mapDeliveryError(
  error: unknown,
  deliveryService: DeliveryServiceModule,
): MarkSentWithDeliveryActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof deliveryService.InvoicingValidationError) return { status: "invalid" };
  if (error instanceof deliveryService.InvoicingNotFoundError) return { status: "not_found" };
  if (error instanceof deliveryService.InvoicingConflictError) return { status: "conflict" };
  if (error instanceof deliveryService.InvoicingIntegrityError) return { status: "unavailable" };
  return null;
}

export async function markSentWithDeliveryAction(
  _previousState: MarkSentWithDeliveryActionState,
  formData: FormData,
): Promise<MarkSentWithDeliveryActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  // Erst beim tatsächlichen Server-Action-Aufruf laden. So bleibt die Client-
  // Referenz frei von der server-only DAL; Next ersetzt diese Funktion im
  // Browser ohnehin durch die verschlüsselte Action-Referenz.
  const deliveryService: DeliveryServiceModule = await import("@/modules/invoicing");

  try {
    const command = parseExactForm(formData);
    if (!command) throw new deliveryService.InvoicingValidationError();
    const result = await authorizedAction(
      workspaceId,
      "invoicing.write",
      "commercial_document_delivery",
      async (tx, ctx) => deliveryService.markSentWithDelivery(tx, ctx, {
        schemaVersion: deliveryService.COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION,
        documentId: command.documentId,
        channel: command.channel,
      }),
    );

    revalidatePath(`/w/${workspaceId}/rechnungen/${result.type}/${command.documentId}`);
    return {
      status: "success",
      sentAt: result.sentAt,
      invoiceJobId: result.invoiceJobId,
      paymentJobId: result.paymentJobId,
    };
  } catch (error) {
    const mapped = mapDeliveryError(error, deliveryService);
    if (mapped) return mapped;
    throw error;
  }
}
