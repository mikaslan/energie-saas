// F7.3 Checklisten-Vorlagen — Template-CRUD + Anwendung am Projekt.
// Kein "server-only" (konsistent mit F7.2-Modul).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  editableChecklistBlocksSchema,
  type EditableChecklistBlocksV2,
} from "@/lib/integrations/checklists/contract";
import {
  CHECKLIST_TEMPLATE_SCHEMA_VERSION,
  checklistTemplateDtoSchema,
  checklistTemplateItemsSchema,
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
import { saveProjectChecklist } from "./service";

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
// F7-13: gerenderte Vorlage (Name + Positionen mit stabiler componentId)
// als gemeinsame Basis für Erst-Anlage, Merge und Reset.
type RenderedTemplate = {
  name: string;
  items: Array<{ componentId: string; title: string }>;
};

async function loadTemplateRender(
  tx: TenantTx,
  workspaceId: string,
  templateId: string,
): Promise<RenderedTemplate> {
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
     where template_record.workspace_id = ${workspaceId}::uuid
       and template_record.id = ${templateId}::uuid
       and template_record.active = true
     limit 1
  `);
  const row = template.rows[0];
  if (!row) throw new ChecklistNotFoundError(templateId);

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
  return {
    name: row.name,
    items: itemsParsed.map((item) => ({
      componentId: item.componentId,
      title: `${nameById.get(item.componentId) ?? "Komponente"} × ${item.quantity}`,
    })),
  };
}

function renderFreshBlocks(render: RenderedTemplate, position: number): EditableChecklistBlocksV2 {
  const blocks: EditableChecklistBlocksV2 = [{
    id: randomUUID(),
    name: render.name,
    position,
    visible: true,
    segments: [{
      id: randomUUID(),
      name: "Material",
      position: 0,
      visible: true,
      items: render.items.map((item) => ({
        id: randomUUID(),
        title: item.title,
        done: false,
        required: false,
        visible: true,
        componentId: item.componentId,
      })),
    }],
  }];
  return editableChecklistBlocksSchema.parse(blocks);
}

export async function applyChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { templateId: string; projectId: string },
): Promise<{ projectId: string; version: number }> {
  requireWrite(ctx);
  const render = await loadTemplateRender(tx, ctx.workspaceId, input.templateId);
  const blocks = renderFreshBlocks(render, 0);

  // Apply wird pro Projekt serialisiert. Damit gilt auch ohne den alten
  // 1:1-Unique-Index: Projekt-Lock -> Existing-Check -> Checklist-Insert.
  // Parallele Apply-Transaktionen sehen nach dem Lock-Warten den Commit des
  // Gewinners und die zweite Transaktion endet als fachlicher Conflict.
  const projectExists = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.projectId}::uuid
     limit 1
     for update
  `);
  if (!projectExists.rows[0]) throw new ChecklistNotFoundError(input.projectId);

  // 1:1: nur anlegen, wenn noch keine Checkliste existiert (F7.2-Semantik).
  const existing = await tx.execute<{ version: number }>(sql`
    select version from project_checklist
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
       and phase = 'site_documentation'
     limit 1
  `);
  if (existing.rows[0]) throw new ChecklistConflictError(Number(existing.rows[0].version));

  const created = await saveProjectChecklist(tx, ctx, {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: null,
    projectId: input.projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion: 0,
    blocks,
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_checklist",
    aggregateId: created.checklistId!,
    eventType: "checklist.applied_from_template",
    actor: ctx.actor,
    payload: { templateId: input.templateId, checklistId: created.checklistId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "project_checklist",
    allowed: true,
    details: {
      templateId: input.templateId,
      projectId: input.projectId,
      checklistId: created.checklistId,
    },
  });
  return { projectId: input.projectId, version: created.version };
}

export const checklistReapplyModes = ["merge", "reset"] as const;
export type ChecklistReapplyMode = (typeof checklistReapplyModes)[number];

const reapplyChecklistTemplateCommandSchema = z.strictObject({
  projectId: z.uuid(),
  templateId: z.uuid(),
  mode: z.enum(checklistReapplyModes),
});

function requireConfigure(ctx: ServiceCtx): void {
  if (!can(ctx, "checklist.configure")) {
    throw new PermissionDeniedError("checklist.configure", "project_checklist", undefined, ctx.actor);
  }
}

function requireReset(ctx: ServiceCtx): void {
  // Katalog F7.3 „Admin-only" über den bestehenden Unlock-Key —
  // KEINE neue Permission.
  if (!can(ctx, "checklist.unlock")) {
    throw new PermissionDeniedError("checklist.unlock", "project_checklist", undefined, ctx.actor);
  }
}

/**
 * F7-13 Template Re-Apply (Katalog F7.3). Erfordert eine vorhandene
 * Checkliste (keine Auto-Anlage — dafür bleibt die Erst-Anlage zuständig).
 * Merge ergänzt fehlende Vorlagen-Positionen und lässt alle vorhandenen
 * Werte unangetastet (idempotent); Reset ersetzt den Baum durch frisches
 * Rendering (Admin-only, Werte gehen verloren). Speichern mit Versions-CAS
 * (Race → Conflict statt stillem Overwrite).
 */
export async function reapplyChecklistTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; templateId: string; mode: ChecklistReapplyMode },
): Promise<{ projectId: string; version: number; mode: ChecklistReapplyMode; added: number }> {
  const parsed = reapplyChecklistTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  // Merge ergänzt Knoten = Strukturänderung: wie jede Strukturänderung des
  // Produkts (Kapsel + canEditStructure-Regel) Admin-genehmigt
  // (checklist.configure). Reset ersetzt destruktiv (checklist.unlock).
  if (command.mode === "reset") requireReset(ctx);
  else requireConfigure(ctx);

  const render = await loadTemplateRender(tx, ctx.workspaceId, command.templateId);
  if (render.items.length === 0) throw new ChecklistValidationError("template has no items");

  // Kein FOR UPDATE: Die App-Rolle hat kein Tabellen-UPDATE (Schreibzugriff
  // nur über die Kapsel); der Versions-CAS beim Speichern trägt Races
  // korrekt aus (Verlierer → Conflict statt stiller Overwrite).
  const stored = await tx.execute<{ id: string; version: number; title: string; blocks: unknown }>(sql`
    select id, version, title, blocks
      from project_checklist
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and phase = 'site_documentation'
     limit 1
  `);
  const current = stored.rows[0];
  if (!current) throw new ChecklistNotFoundError(command.projectId);
  const blocks = editableChecklistBlocksSchema.parse(current.blocks);

  let added = 0;
  let next: EditableChecklistBlocksV2;
  if (command.mode === "reset") {
    next = renderFreshBlocks(render, 0);
  } else {
    const knownComponents = new Set<string>();
    const knownTitles = new Set<string>();
    for (const block of blocks) {
      for (const segment of block.segments) {
        for (const item of segment.items) {
          if (item.componentId !== null && item.componentId !== undefined) {
            knownComponents.add(item.componentId);
          }
          knownTitles.add(item.title);
        }
      }
    }
    // Umbenannte Vorlage erzeugt bewusst neue Punkte (kein Werteverlust
    // durch stille Überschreibung); Legacy-Bestand matcht per Titel.
    const missing = render.items.filter((item) =>
      !knownComponents.has(item.componentId) && !knownTitles.has(item.title),
    );
    added = missing.length;
    const target = blocks.find((block) => block.name === render.name) ?? (() => {
      const position = blocks.reduce((max, block) => Math.max(max, block.position), -1) + 1;
      const fresh = renderFreshBlocks({ name: render.name, items: [] }, position);
      blocks.push(fresh[0]!);
      return fresh[0]!;
    })();
    let segment = target.segments[0];
    if (!segment) {
      segment = {
        id: randomUUID(), name: "Material", position: 0, visible: true, items: [],
      };
      target.segments.push(segment);
    }
    for (const item of missing) {
      segment.items.push({
        id: randomUUID(),
        title: item.title,
        done: false,
        required: false,
        visible: true,
        componentId: item.componentId,
      });
    }
    const merged = editableChecklistBlocksSchema.safeParse(blocks);
    if (!merged.success) throw new ChecklistValidationError();
    next = merged.data;
  }

  const saved = await saveProjectChecklist(tx, ctx, {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: current.id,
    projectId: command.projectId,
    phase: "site_documentation",
    title: current.title,
    baseVersion: Number(current.version),
    blocks: next,
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_checklist",
    aggregateId: saved.checklistId!,
    eventType: "checklist.template_reapplied",
    actor: ctx.actor,
    payload: { templateId: command.templateId, mode: command.mode, added },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "project_checklist",
    allowed: true,
    details: {
      templateId: command.templateId,
      projectId: command.projectId,
      checklistId: saved.checklistId,
      mode: command.mode,
    },
  });
  return { projectId: command.projectId, version: saved.version, mode: command.mode, added };
}
