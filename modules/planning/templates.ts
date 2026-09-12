// F16-08 Planungs-Vorlagen — Template-CRUD (Modus-Preset quick/2d/3d).
// Anwenden liegt angebotsseitig (modules/offers/templates.ts, Muster
// F16-06: kein Modulzyklus, Angebots-Schreibschutz bleibt dort).
// Keine neuen Permissions: planning.settings.read/settings.manage.
import { sql } from "drizzle-orm";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PLANNING_TEMPLATE_SCHEMA_VERSION,
  archivePlanningTemplateCommandSchema,
  createPlanningTemplateCommandSchema,
  planningTemplateDtoSchema,
  updatePlanningTemplateCommandSchema,
  type ArchivePlanningTemplateCommand,
  type CreatePlanningTemplateCommand,
  type PlanningTemplateDto,
  type UpdatePlanningTemplateCommand,
} from "@/lib/integrations/planning/template-contract";
import {
  PlanningTemplateConflictError,
  PlanningTemplateNotFoundError,
  PlanningTemplateValidationError,
} from "./errors";

export type { PlanningTemplateDto };

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "planning.settings.read")) {
    throw new PermissionDeniedError("planning.settings.read", "planning_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "settings.manage")) {
    throw new PermissionDeniedError("settings.manage", "planning_template", undefined, ctx.actor);
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

export function normalizePlanningTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  mode: string;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, mode,
         position, active, created_at, updated_at
    from planning_template
`;

function toDto(row: TemplateRow, canWrite: boolean): PlanningTemplateDto {
  return planningTemplateDtoSchema.parse({
    schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    mode: row.mode,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listPlanningTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<PlanningTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const write = can(ctx, "settings.manage");
  return result.rows.map((row) => toDto(row, write));
}

export async function createPlanningTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreatePlanningTemplateCommand,
): Promise<PlanningTemplateDto> {
  requireWrite(ctx);
  const parsed = createPlanningTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningTemplateValidationError();
  const command = parsed.data;

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into planning_template (
        workspace_id, name, name_normalized, mode,
        position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizePlanningTemplateName(command.name)},
        ${command.mode},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, mode,
                position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PlanningTemplateConflictError();
    if (code === "23514") throw new PlanningTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_template",
    aggregateId: row.id,
    eventType: "planning_template.created",
    actor: ctx.actor,
    payload: { name: command.name, mode: command.mode },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_template.write",
    resource: "planning_template",
    allowed: true,
    details: { name: command.name, mode: command.mode },
  });
  return toDto(row, true);
}

export async function updatePlanningTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdatePlanningTemplateCommand,
): Promise<PlanningTemplateDto> {
  requireWrite(ctx);
  const parsed = updatePlanningTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update planning_template
         set name = ${command.name},
             name_normalized = ${normalizePlanningTemplateName(command.name)},
             mode = ${command.mode},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, mode,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PlanningTemplateConflictError();
    if (code === "23514") throw new PlanningTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new PlanningTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_template",
    aggregateId: command.id,
    eventType: "planning_template.updated",
    actor: ctx.actor,
    payload: { name: command.name, mode: command.mode },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_template.write",
    resource: "planning_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchivePlanningTemplateCommand,
): Promise<PlanningTemplateDto> {
  requireWrite(ctx);
  const parsed = archivePlanningTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningTemplateValidationError();
  const command = parsed.data;
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update planning_template
         set active = ${command.active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
         and active is distinct from ${command.active}
      returning id, name, mode,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PlanningTemplateConflictError();
    if (code === "23514") throw new PlanningTemplateValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<TemplateRow>(sql`
      ${TEMPLATE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new PlanningTemplateNotFoundError();
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_template",
    aggregateId: command.id,
    eventType: command.active ? "planning_template.restored" : "planning_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_template.write",
    resource: "planning_template",
    allowed: true,
    details: { id: command.id, active: command.active },
  });
  return toDto(row, true);
}

export function archivePlanningTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchivePlanningTemplateCommand,
): Promise<PlanningTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: false });
}

export function restorePlanningTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchivePlanningTemplateCommand,
): Promise<PlanningTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: true });
}

// Aktive Vorlage für das angebotsseitige Anwenden lesen (Muster F16-06:
// Berechtigung prüft der Aufrufer, Schreibschutz der Angebots-Pfad).
export async function findActivePlanningTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  templateId: string,
): Promise<{ id: string; mode: "quick" | "2d" | "3d" } | null> {
  const found = await tx.execute<{ id: string; mode: string }>(sql`
    select id, mode
      from planning_template
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${templateId}::uuid
       and active = true
     limit 1
  `);
  const row = found.rows[0];
  if (!row) return null;
  if (row.mode !== "quick" && row.mode !== "2d" && row.mode !== "3d") return null;
  return { id: row.id, mode: row.mode };
}
