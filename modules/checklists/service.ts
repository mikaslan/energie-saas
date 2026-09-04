// Hinweis: KEIN "server-only"-Import (konsistent mit lead-sources/
// time-tracking): der Projekt-Seitengraph wird build-importierbar gehalten.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  checklistBlocksSchema,
  projectChecklistDtoSchema,
  saveProjectChecklistCommandSchema,
  type ChecklistBlocksV1,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "checklist.read")) {
    throw new PermissionDeniedError("checklist.read", "project_checklist", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "checklist.write")) {
    throw new PermissionDeniedError("checklist.write", "project_checklist", undefined, ctx.actor);
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

type ChecklistRow = {
  project_id: string;
  version: number;
  blocks: unknown;
  updated_at: string;
};

function toDto(
  row: ChecklistRow | undefined,
  projectId: string,
  canWrite: boolean,
): ProjectChecklistDto {
  const blocks = checklistBlocksSchema.parse(row?.blocks ?? []);
  return projectChecklistDtoSchema.parse({
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    projectId,
    version: row?.version ?? 0,
    blocks,
    updatedAt: row?.updated_at ?? new Date(0).toISOString(),
    permissions: { canWrite },
  });
}

// Read-Semantik (F4.6-Muster): keine Zeile → DTO mit version 0 und leerer
// Blockliste, KEIN not_found.
export async function getProjectChecklist(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectChecklistDto> {
  requireRead(ctx);
  const result = await tx.execute<ChecklistRow>(sql`
    select project_id, version, blocks, updated_at
      from project_checklist
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     limit 1
  `);
  return toDto(result.rows[0], projectId, can(ctx, "checklist.write"));
}

export async function saveProjectChecklist(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SaveProjectChecklistCommand,
): Promise<ProjectChecklistDto> {
  requireWrite(ctx);
  const parsed = saveProjectChecklistCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  const blocks: ChecklistBlocksV1 = checklistBlocksSchema.parse(command.blocks);

  // Projekt existenzprüfen (FK würde 23503 werfen → ValidationError mappen;
  // hier zusätzlich sauberer Fehlerpfad + M1-09-External-Scope beachten).
  const projectExists = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     limit 1
  `);
  if (!projectExists.rows[0]) throw new ChecklistNotFoundError(command.projectId);

  let row: ChecklistRow;
  try {
    if (command.baseVersion === 0) {
      const inserted = await tx.execute<ChecklistRow>(sql`
        insert into project_checklist (
          workspace_id, project_id, version, blocks, created_by
        ) values (
          ${ctx.workspaceId}::uuid,
          ${command.projectId}::uuid,
          1,
          ${JSON.stringify(blocks)}::jsonb,
          ${ctx.actor}::uuid
        )
        returning project_id, version, blocks, updated_at
      `);
      row = inserted.rows[0]!;
    } else {
      const updated = await tx.execute<ChecklistRow>(sql`
        update project_checklist
           set blocks = ${JSON.stringify(blocks)}::jsonb,
               version = version + 1,
               updated_by = ${ctx.actor}::uuid,
               updated_at = statement_timestamp()
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${command.projectId}::uuid
           and version = ${command.baseVersion}
         returning project_id, version, blocks, updated_at
      `);
      row = updated.rows[0]!;
      if (!row) {
        const current = await tx.execute<{ version: number }>(sql`
          select version from project_checklist
           where workspace_id = ${ctx.workspaceId}::uuid
             and project_id = ${command.projectId}::uuid
           limit 1
        `);
        if (!current.rows[0]) throw new ChecklistNotFoundError(command.projectId);
        throw new ChecklistConflictError(Number(current.rows[0].version));
      }
    }
  } catch (error) {
    if (error instanceof ChecklistConflictError || error instanceof ChecklistNotFoundError) {
      throw error;
    }
    const code = postgresErrorCode(error);
    if (code === "23503") throw new ChecklistNotFoundError(command.projectId);
    if (code === "23505") throw new ChecklistConflictError("concurrent create");
    if (code === "23514") throw new ChecklistValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_checklist",
    aggregateId: command.projectId,
    eventType: command.baseVersion === 0 ? "checklist.created" : "checklist.updated",
    actor: ctx.actor,
    payload: { projectId: command.projectId, version: row.version },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "project_checklist",
    allowed: true,
    details: { projectId: command.projectId, baseVersion: command.baseVersion },
  });

  return toDto(row, command.projectId, true);
}
