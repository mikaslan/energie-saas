import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { ContactValidationError } from "./errors";

// F1-16: Kontakt-Vorschläge für das manuelle Anfrage-Modal. Bewusst KEINE
// neue Permission — die Suche läuft unter contact.read, die Anlage weiter
// unter project.write.
export const CONTACT_SUGGEST_LIMIT = 8 as const;
export const CONTACT_SUGGEST_MIN_QUERY = 2 as const;
export const CONTACT_SUGGEST_MAX_QUERY = 100 as const;

const suggestQuerySchema = z.strictObject({
  query: z.string().trim().min(CONTACT_SUGGEST_MIN_QUERY).max(CONTACT_SUGGEST_MAX_QUERY),
});

export type ContactSuggestion = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
};

type SuggestRow = {
  id: string;
  display_name: string;
  email_primary: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  address_street: string | null;
  address_house_number: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  [key: string]: unknown;
};

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

/**
 * Kontakt-Suche für die Vorbefüllung (F1-16). Tenant-lokal, nur ungelöschte
 * Kontakte, Treffer auf Name/E-Mail/Telefon, gedeckelt auf 8.
 */
export async function suggestContacts(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { query: string },
): Promise<ContactSuggestion[]> {
  if (!can(ctx, "contact.read")) {
    throw new PermissionDeniedError("contact.read", "contact", undefined, ctx.actor);
  }
  const parsed = suggestQuerySchema.safeParse(input);
  if (!parsed.success) throw new ContactValidationError();
  const pattern = `%${escapeLikeLiteral(parsed.data.query)}%`;

  const found = await tx.execute<SuggestRow>(sql`
    select id, display_name, email_primary, phone_raw, phone_e164,
           address_street, address_house_number, address_postal_code, address_city
      from contact
     where workspace_id = ${ctx.workspaceId}::uuid
       and deleted_at is null
       and (
         display_name ilike ${pattern}
         or email_primary ilike ${pattern}
         or email_normalized ilike ${pattern}
         or phone_raw ilike ${pattern}
         or phone_e164 ilike ${pattern}
       )
     order by lower(display_name), id
     limit ${CONTACT_SUGGEST_LIMIT}
  `);
  return found.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    email: row.email_primary,
    phone: row.phone_raw ?? row.phone_e164,
    street: row.address_street,
    houseNumber: row.address_house_number,
    postalCode: row.address_postal_code,
    city: row.address_city,
  }));
}
