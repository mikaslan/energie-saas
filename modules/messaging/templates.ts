// F16-10 E-Mail-Vorlagen — Listen (mit idempotentem Seed der 8 fixen
// Schlüssel), Aktualisieren, Archiv/Reaktivieren je Workspace.
// Muster modules/file-requests/templates.ts (F16-07). Keine neuen
// Permissions: project.read/project.write. Versand existiert nicht in
// diesem Slice (Provider-Blocker, fail-closed dokumentiert).
import "server-only";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import {
  archiveEmailTemplateCommandSchema,
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_LABELS,
  EMAIL_TEMPLATE_SCHEMA_VERSION,
  emailTemplateDtoSchema,
  updateEmailTemplateCommandSchema,
  type ArchiveEmailTemplateCommand,
  type EmailTemplateDto,
  type EmailTemplateKey,
  type UpdateEmailTemplateCommand,
} from "@/lib/email-template";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class EmailTemplateNotFoundError extends Error {
  constructor() {
    super("email template not found");
    this.name = "EmailTemplateNotFoundError";
  }
}

export class EmailTemplateValidationError extends Error {
  constructor() {
    super("email template validation failed");
    this.name = "EmailTemplateValidationError";
  }
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "email_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "email_template", undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type TemplateRow = {
  id: string;
  key: EmailTemplateKey;
  subject: string;
  body: string;
  active: boolean;
  updated_at: string;
};

function toDto(row: TemplateRow, canWrite: boolean): EmailTemplateDto {
  return emailTemplateDtoSchema.parse({
    schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    key: row.key,
    label: EMAIL_TEMPLATE_LABELS[row.key],
    subject: row.subject,
    body: row.body,
    active: row.active,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

// Seed der 8 fixen Schlüssel mit der eingebauten DE-Standardfassung
// (ESTIMATE, genau ein Statement, ON CONFLICT DO NOTHING — race-sicher).
// Kein Event/Audit: Seed ist impliziter Default, keine Nutzer-Mutation.
async function ensureSeeded(tx: TenantTx, ctx: ServiceCtx): Promise<void> {
  const rows = EMAIL_TEMPLATE_KEYS.map((key) => sql`(
    ${ctx.workspaceId}::uuid,
    ${key},
    ${EMAIL_TEMPLATE_DEFAULTS[key].subject},
    ${EMAIL_TEMPLATE_DEFAULTS[key].body},
    ${ctx.actor}::uuid
  )`);
  await tx.execute(sql`
    insert into email_template (workspace_id, "key", subject, body, created_by)
    values ${sql.join(rows, sql`, `)}
    on conflict do nothing
  `);
}

export async function listEmailTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<EmailTemplateDto[]> {
  requireRead(ctx);
  await ensureSeeded(tx, ctx);
  const result = await tx.execute<TemplateRow>(sql`
    select id, "key", subject, body, active, updated_at
      from email_template
     where workspace_id = ${ctx.workspaceId}::uuid
     order by array_position(
       array[${sql.join(EMAIL_TEMPLATE_KEYS.map((key) => sql`${key}`), sql`, `)}],
       "key"
     ),
     "key" asc
  `);
  const write = can(ctx, "project.write");
  return result.rows.map((row) => toDto(row, write));
}

export async function updateEmailTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateEmailTemplateCommand,
): Promise<EmailTemplateDto> {
  requireWrite(ctx);
  const parsed = updateEmailTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new EmailTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update email_template
         set subject = ${command.subject},
             body = ${command.body},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and "key" = ${command.key}
      returning id, "key", subject, body, active, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    if (postgresErrorCode(error) === "23514") throw new EmailTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new EmailTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "email_template",
    aggregateId: rows[0].id,
    eventType: "email_template.updated",
    actor: ctx.actor,
    payload: { key: command.key },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "email_template.write",
    resource: "email_template",
    allowed: true,
    details: { key: command.key },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveEmailTemplateCommand,
): Promise<EmailTemplateDto> {
  requireWrite(ctx);
  const parsed = archiveEmailTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new EmailTemplateValidationError();
  const command = parsed.data;

  const updated = await tx.execute<TemplateRow>(sql`
    update email_template
       set active = ${command.active},
           updated_by = ${ctx.actor}::uuid,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and "key" = ${command.key}
    returning id, "key", subject, body, active, updated_at
  `);
  if (!updated.rows[0]) throw new EmailTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "email_template",
    aggregateId: updated.rows[0].id,
    eventType: command.active ? "email_template.restored" : "email_template.archived",
    actor: ctx.actor,
    payload: { key: command.key },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "email_template.write",
    resource: "email_template",
    allowed: true,
    details: { key: command.key, active: command.active },
  });
  return toDto(updated.rows[0], true);
}

export async function archiveEmailTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveEmailTemplateCommand,
): Promise<EmailTemplateDto> {
  if (input.active !== false) throw new EmailTemplateValidationError();
  return setTemplateActive(tx, ctx, input);
}

export async function restoreEmailTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveEmailTemplateCommand,
): Promise<EmailTemplateDto> {
  if (input.active !== true) throw new EmailTemplateValidationError();
  return setTemplateActive(tx, ctx, input);
}
