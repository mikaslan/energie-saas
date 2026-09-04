// F7.3 Checklisten-Vorlagen — Template-CRUD + Anwendung am Projekt.
// Kein "server-only" (konsistent mit F7.2-Modul).
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  checklistBlocksSchema,
  type ChecklistBlocksV1,
} from "@/lib/integrations/checklists/contract";
import {
  CHECKLIST_TEMPLATE_SCHEMA_VERSION,
  checklistTemplateDtoSchema,
  checklistTemplateItemsSchema,
  checklistTemplateTargetsSchema,
  createChecklistTemplateCommandSchema,
  updateChecklistTemplateCommandSchema,
  type ChecklistTemplateDto,
  type CreateChecklistTemplateCommand,
  type UpdateChecklistTemplateCommand,
} from "@/lib/integrations/checklists/template-contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "checklist.read")) {
    throw new PermissionDeniedError("checklist.read", "checklist_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "checklist.write")) {
    throw new PermissionDeniedError("checklist.write", "checklist_template", undefined, ctx.actor);
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

export function normalizeTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  position: number;
  active: boolean;
  targets: unknown;
  items: unknown;
  created_at: string;
  updated_at: string;
};

function toDto(row: TemplateRow, canWrite: boolean): ChecklistTemplateDto {
  return checklistTemplateDtoSchema.parse({
    schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    description: row.description,
    position: row.position,
    active: row.active,
    targets: row.targets,
    items: row.items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

const TEMPLATE_SELECT = sql`
  select id, name, description, position, active, targets, items,
         created_at, updated_at
    from checklist_template
`;

export async function listChecklistTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<ChecklistTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const canWrite = can(ctx, "checklist.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

// Katalog-Referenzen der Items gegen den EIGENEN Katalog validieren.
async function validateItemComponents(
  tx: TenantTx,
  workspaceId: string,
  items: unknown,
): Promise<void> {
  const parsed = checklistTemplateItemsSchema.safeParse(items);
  if (!parsed.success) throw new ChecklistValidationError();
  const componentIds = [...new Set(parsed.data.map((item) => item.componentId))];
  if (componentIds.length === 0) return;
  const result = await tx.execute<{ id: string }>(sql`
    select id from catalog_component
     where workspace_id = ${workspaceId}::uuid
       and id in (${sql.join(componentIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  if (result.rows.length !== componentIds.length) throw new ChecklistValidationError();
}

export async function createChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateChecklistTemplateCommand,
): Promise<ChecklistTemplateDto> {
  requireWrite(ctx);
  const parsed = createChecklistTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  await validateItemComponents(tx, ctx.workspaceId, command.items);

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into checklist_template (
        workspace_id, name, name_normalized, description, position,
        targets, items, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeTemplateName(command.name)},
        ${command.description},
        ${command.position ?? 0},
        ${JSON.stringify(command.targets ?? [])}::jsonb,
        ${JSON.stringify(command.items ?? [])}::jsonb,
        ${ctx.actor}::uuid
      )
      returning id, name, description, position, active, targets, items,
                created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new ChecklistConflictError(command.name);
    if (code === "23514") throw new ChecklistValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "checklist_template",
    aggregateId: row.id,
    eventType: "checklist_template.created",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "checklist_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updateChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateChecklistTemplateCommand,
): Promise<ChecklistTemplateDto> {
  requireWrite(ctx);
  const parsed = updateChecklistTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  // Voll-Update-Semantik (wie F1.8): weggelassene Felder = leer.
  const targets = command.targets ?? [];
  const items = command.items ?? [];
  await validateItemComponents(tx, ctx.workspaceId, items);

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update checklist_template
         set name = ${command.name},
             name_normalized = ${normalizeTemplateName(command.name)},
             description = ${command.description},
             position = ${command.position},
             targets = ${JSON.stringify(targets)}::jsonb,
             items = ${JSON.stringify(items)}::jsonb,
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
       returning id, name, description, position, active, targets, items,
                 created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new ChecklistConflictError(command.name);
    if (code === "23514") throw new ChecklistValidationError();
    throw error;
  }
  if (!rows[0]) throw new ChecklistNotFoundError(command.id);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "checklist_template",
    aggregateId: command.id,
    eventType: "checklist_template.updated",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "checklist_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
  active: boolean,
): Promise<ChecklistTemplateDto> {
  requireWrite(ctx);
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update checklist_template
         set active = ${active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${id}::uuid
         and active is distinct from ${active}
       returning id, name, description, position, active, targets, items,
                 created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new ChecklistConflictError(id);
    if (code === "23514") throw new ChecklistValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<TemplateRow>(sql`
      ${TEMPLATE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new ChecklistNotFoundError(id);
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "checklist_template",
    aggregateId: id,
    eventType: active ? "checklist_template.restored" : "checklist_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "checklist_template",
    allowed: true,
    details: { id, active },
  });
  return toDto(row, true);
}

export function archiveChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<ChecklistTemplateDto> {
  return setTemplateActive(tx, ctx, id, false);
}

export function restoreChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<ChecklistTemplateDto> {
  return setTemplateActive(tx, ctx, id, true);
}

// ESTIMATE-Mapping (Spec §2.2, DECIDED): Vorlage → Projekt-Checkliste als
// ein Block (Template-Name) mit Segment „Material" und Items
// „«Komponentenname» × quantity". Radio-/Bild-Typen = Slice B.
export async function applyChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { templateId: string; projectId: string },
): Promise<{ projectId: string; version: number }> {
  requireWrite(ctx);
  const template = await tx.execute<TemplateRow & { component_rows: unknown }>(sql`
    select template_record.id, template_record.name, template_record.active,
           template_record.items,
           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'componentId', component_record.id,
                 'componentName', component_record.internal_sku
               )
             )
               from jsonb_array_elements(template_record.items) item(value)
               left join catalog_component component_record
                 on component_record.workspace_id = template_record.workspace_id
                and component_record.id = (item.value->>'componentId')::uuid
           ), '[]'::jsonb) as component_rows
      from checklist_template template_record
     where template_record.workspace_id = ${ctx.workspaceId}::uuid
       and template_record.id = ${input.templateId}::uuid
       and template_record.active = true
     limit 1
  `);
  const row = template.rows[0];
  if (!row) throw new ChecklistNotFoundError(input.templateId);

  const itemsParsed = checklistTemplateItemsSchema.parse(row.items);
  const components = (row.component_rows as Array<{
    componentId: string;
    componentName: string;
  }>);
  // Kimi-P0-1: ID-basierte Lookup-Map — KEINE Index-Korrelation (die
  // Aggregation ist unsortiert, Items liegen in Template-Reihenfolge vor).
  const nameById = new Map(components.map((component) => [
    component.componentId, component.componentName,
  ]));
  const blocks: ChecklistBlocksV1 = [{
    name: row.name,
    position: 0,
    segments: [{
      name: "Material",
      position: 0,
      items: itemsParsed.map((item) => ({
        title: `${nameById.get(item.componentId) ?? "Komponente"} × ${item.quantity}`,
        done: false,
      })),
    }],
  }];
  checklistBlocksSchema.parse(blocks);

  // 1:1: nur anlegen, wenn noch keine Checkliste existiert (F7.2-Semantik).
  const existing = await tx.execute<{ version: number }>(sql`
    select version from project_checklist
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     limit 1
  `);
  if (existing.rows[0]) throw new ChecklistConflictError(Number(existing.rows[0].version));

  const projectExists = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.projectId}::uuid
     limit 1
  `);
  if (!projectExists.rows[0]) throw new ChecklistNotFoundError(input.projectId);

  try {
    await tx.execute(sql`
      insert into project_checklist (
        workspace_id, project_id, version, blocks, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${input.projectId}::uuid, 1,
        ${JSON.stringify(blocks)}::jsonb, ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    // Kimi-P1-1: parallele Applies kollidieren am 1:1-Unique → Conflict.
    const code = postgresErrorCode(error);
    if (code === "23505") throw new ChecklistConflictError("concurrent apply");
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_checklist",
    aggregateId: input.projectId,
    eventType: "checklist.applied_from_template",
    actor: ctx.actor,
    payload: { templateId: input.templateId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "project_checklist",
    allowed: true,
    details: { templateId: input.templateId, projectId: input.projectId },
  });
  return { projectId: input.projectId, version: 1 };
}
