"use server";

import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CONTACT_SUGGEST_MAX_QUERY,
  CONTACT_SUGGEST_MIN_QUERY,
  ContactValidationError,
  suggestContacts,
  type ContactSuggestion,
} from "@/modules/contacts";

const uuidSchema = z.uuid();
const querySchema = z.string().trim().min(CONTACT_SUGGEST_MIN_QUERY).max(CONTACT_SUGGEST_MAX_QUERY);

// F1-16: Kontakt-Suche für das manuelle Anfrage-Modal. Direkter
// Server-Action-Aufruf (Suche-beim-Tippen, kein Formular-POST). Ohne
// contact.read leere Liste mit Hinweis — das Formular bleibt nutzbar.
export type ManualLeadContactSuggestState =
  | { status: "results"; suggestions: ContactSuggestion[] }
  | { status: "empty" }
  | { status: "denied" }
  | { status: "invalid" }
  | { status: "unauthenticated" };

export async function suggestManualLeadContacts(
  workspaceId: string,
  query: string,
): Promise<ManualLeadContactSuggestState> {
  if (!uuidSchema.safeParse(workspaceId).success) return { status: "invalid" };
  if (!querySchema.safeParse(query).success) return { status: "invalid" };
  try {
    const suggestions = await authorizedQuery(
      workspaceId,
      "contact.read",
      "contact_suggest",
      (tx, ctx) => suggestContacts(tx, ctx, { query }),
    );
    return suggestions.length === 0
      ? { status: "empty" }
      : { status: "results", suggestions };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof ContactValidationError) return { status: "invalid" };
    throw error;
  }
}
