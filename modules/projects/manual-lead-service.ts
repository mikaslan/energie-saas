// F1-11 Manuelle Anfrage-Erfassung: Kontakt + Standort + Projekt auf der
// Intake-Spalte des gewählten Bereichs — ohne Rechner-Payload.
// Berechtigung: bestehendes project.write (KEIN neuer Key). Optionale Notiz
// erfordert note.write (kein stilles Verschlucken).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { contactNameSplitV1 } from "@/lib/db/schema/contact-name-split";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { PROJECT_NOTE_COMMAND_VERSION } from "@/lib/integrations/notes/note-contract";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { normalizeRechnerPhone } from "@/modules/intake/service";
import { LeadSourceNotFoundError } from "@/modules/lead-sources/errors";
import { executeProjectNoteCommand } from "@/modules/notes/service";

export class ManualLeadValidationError extends Error {
  constructor(message = "manual lead validation failed") {
    super(message);
    this.name = "ManualLeadValidationError";
  }
}

export class ManualLeadLaneError extends Error {
  constructor(message = "manual lead intake lane unavailable") {
    super(message);
    this.name = "ManualLeadLaneError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .optional();
}

const manualLeadCommandSchema = z.strictObject({
  scope: z.enum(["residential", "commercial"]),
  displayName: z.string().trim().min(1).max(200),
  email: z.email().trim().max(200).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  street: optionalText(200),
  houseNumber: optionalText(30),
  postalCode: z.string().trim().regex(/^[0-9]{5}$/).optional(),
  city: optionalText(200),
  leadSourceId: uuidSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});

export type ManualLeadResult = {
  contactId: string;
  siteId: string;
  projectId: string;
  contactReused: boolean;
  dedupeReviewRequired: boolean;
};

function requireManualLeadWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "project", undefined, ctx.actor);
  }
}

function normalizedEmail(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.normalize("NFKC").trim();
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

/**
 * Manuelle Anfrage anlegen. Kontakt-Dedupe per normalisierter E-Mail oder
 * E164-Nummer: Treffer nutzt den bestehenden Kontakt und markiert das
 * Projekt zur Nachprüfung (keine Blockade, keine stillen Überschreibungen).
 */
export async function createManualLead(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    scope: "residential" | "commercial";
    displayName: string;
    email?: string;
    phone?: string;
    street?: string;
    houseNumber?: string;
    postalCode?: string;
    city?: string;
    leadSourceId?: string;
    note?: string;
  },
): Promise<ManualLeadResult> {
  requireManualLeadWrite(ctx);
  const parsed = manualLeadCommandSchema.safeParse(input);
  if (!parsed.success) throw new ManualLeadValidationError();
  const command = parsed.data;

  const emailNormalized = normalizedEmail(command.email);
  let phoneE164: string | null = null;
  let phoneRaw: string | null = null;
  if (command.phone !== undefined) {
    phoneRaw = command.phone.normalize("NFKC").trim();
    phoneE164 = normalizeRechnerPhone(phoneRaw);
    if (phoneE164 === null) throw new ManualLeadValidationError("phone not routable");
  }
  // Kontakt-CHECK: mindestens ein erreichbarer Weg.
  if (emailNormalized === null && phoneE164 === null) {
    throw new ManualLeadValidationError("email or phone required");
  }
  const emailForRow = emailNormalized === null ? null : command.email!.normalize("NFKC").trim();

  if (command.note !== undefined && !can(ctx, "note.write")) {
    throw new PermissionDeniedError("note.write", "project_note", undefined, ctx.actor);
  }

  let leadSourceId: string | null = null;
  if (command.leadSourceId !== undefined) {
    const source = await tx.execute<{ id: string }>(sql`
      select id from lead_source
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.leadSourceId}::uuid
       limit 1
    `);
    if (!source.rows[0]) throw new LeadSourceNotFoundError(command.leadSourceId);
    leadSourceId = command.leadSourceId;
  }

  // Intake-Lane des Bereichs (fail-closed, kein Scope-Fallback).
  const lane = await tx.execute<{ board_id: string; column_id: string }>(sql`
    select board.id as board_id, intake.id as column_id
      from kanban_board board
      join kanban_column intake
        on intake.workspace_id = board.workspace_id
       and intake.board_id = board.id
     where board.workspace_id = ${ctx.workspaceId}::uuid
       and board.scope = ${command.scope}
       and board.is_default = true
       and board.archived_at is null
       and intake.is_intake = true
       and intake.column_type = 'lead'
       and intake.archived_at is null
     limit 2
  `);
  if (lane.rows.length !== 1 || !lane.rows[0]) {
    throw new ManualLeadLaneError(`default ${command.scope} intake lane is missing or ambiguous`);
  }

  // Dedupe: existierender Kontakt wird wiederverwendet.
  const duplicate = await tx.execute<{ id: string }>(sql`
    select id from contact
     where workspace_id = ${ctx.workspaceId}::uuid
       and deleted_at is null
       and (
         (${emailNormalized}::text is not null and email_normalized = ${emailNormalized}::text)
         or (${phoneE164}::text is not null and phone_e164 = ${phoneE164}::text)
       )
     order by created_at asc
     limit 1
  `);
  const contactReused = duplicate.rows.length > 0;

  const names = contactNameSplitV1(command.displayName);
  const contactId = duplicate.rows[0]?.id ?? randomUUID();
  if (!contactReused) {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized, phone_raw, phone_e164,
        dedupe_review_required
      ) values (
        ${contactId}::uuid, ${ctx.workspaceId}::uuid, ${command.displayName}::text,
        ${names.firstName}::text, ${names.lastName}::text,
        ${emailForRow}::text, ${emailNormalized}::text,
        ${phoneRaw}::text, ${phoneE164}::text, false
      )
    `);
  }

  const siteId = randomUUID();
  await tx.execute(sql`
    insert into site (
      id, workspace_id, contact_id, label, address_mode,
      street, house_number, postal_code, city, country,
      address_follow_up_required, pin_confirmed,
      address_revision, pin_adjusted, formatted_address,
      address_fingerprint_version, address_fingerprint,
      geocode_source, geocode_precision, geocode_place_id,
      pin_confirmed_address_revision
    ) values (
      ${siteId}::uuid, ${ctx.workspaceId}::uuid, ${contactId}::uuid, 'Manueller Standort', 'legacy',
      ${command.street ?? null}::text, ${command.houseNumber ?? null}::text,
      ${command.postalCode ?? null}::text, ${command.city ?? null}::text, 'DE',
      true, false, 1, false, null, 1, null, null, null, null, null
    )
  `);

  const projectId = randomUUID();
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id,
      kanban_board_id, kanban_column_id,
      name, source_key, lead_source_id,
      phase, outcome, catalog_resolution_status,
      dedupe_review_required
    ) values (
      ${projectId}::uuid, ${ctx.workspaceId}::uuid,
      ${contactId}::uuid, ${siteId}::uuid,
      ${lane.rows[0].board_id}::uuid, ${lane.rows[0].column_id}::uuid,
      ${command.displayName}::text, 'manual', ${leadSourceId}::uuid,
      'request', 'open', 'pending', ${contactReused}
    )
  `);

  if (command.note !== undefined) {
    await executeProjectNoteCommand(tx, ctx, {
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId,
      textMarkdown: command.note,
      pinned: false,
    });
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: projectId,
    eventType: "manual_lead.created",
    actor: ctx.actor,
    payload: { scope: command.scope, contactReused, leadSourceId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "manual_lead.create",
    resource: "project",
    allowed: true,
    details: { projectId, scope: command.scope, contactReused },
  });

  return {
    contactId,
    siteId,
    projectId,
    contactReused,
    dedupeReviewRequired: contactReused,
  };
}
