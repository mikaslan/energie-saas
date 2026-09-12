// Kein "server-only"-Import: Der Projekt-Seitengraph bleibt build-importierbar.
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  checklistBlocksSchema,
  editableChecklistBlocksSchema,
  mutateChecklistSegmentCommandSchema,
  projectChecklistDtoSchema,
  saveProjectChecklistCommandSchema,
  setChecklistItemIrrelevantCommandSchema,
  withOpenSegmentMetadata,
  type ChecklistBlocksV1,
  type MutateChecklistSegmentCommand,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
  type SetChecklistItemIrrelevantCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistSegmentIncompleteError,
  ChecklistSegmentStateError,
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

function requireUnlock(ctx: ServiceCtx): void {
  if (!can(ctx, "checklist.unlock")) {
    throw new PermissionDeniedError("checklist.unlock", "project_checklist", undefined, ctx.actor);
  }
}

type PgError = { code: string | null; detail: string | null; message: string };

function postgresError(error: unknown): PgError {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as { code?: unknown; detail?: unknown; message?: unknown };
    if (typeof value.code === "string") {
      return {
        code: value.code,
        detail: typeof value.detail === "string" ? value.detail : null,
        message: typeof value.message === "string" ? value.message : "",
      };
    }
  }
  return { code: null, detail: null, message: "" };
}

type ChecklistRow = {
  id: string;
  project_id: string;
  phase: "qualification" | "consultation" | "site_documentation";
  title: string;
  version: number;
  blocks: unknown;
  updated_at: string | Date;
  completions: unknown;
};

const completionRowsSchema = z.array(z.object({
  segmentId: z.uuid(),
  completedAt: z.iso.datetime({ offset: true }),
  completedById: z.uuid(),
}).strict());

const capsuleResultSchema = z.object({
  status: z.enum([
    "created",
    "updated",
    "completed",
    "unlocked",
    "replayed",
    "marked",
    "unmarked",
    "unchanged",
  ]),
  checklistId: z.uuid(),
  version: z.number().int().min(1),
}).passthrough();

function timestamp(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ChecklistValidationError("invalid checklist timestamp");
  }
  return parsed.toISOString();
}

function hydrateBlocks(row: ChecklistRow): ChecklistBlocksV1 {
  const stored = editableChecklistBlocksSchema.parse(row.blocks);
  const completions = completionRowsSchema.parse(row.completions);
  const completionBySegment = new Map(completions.map((completion) => [
    completion.segmentId,
    completion,
  ]));
  return checklistBlocksSchema.parse(stored.map((block) => ({
    ...block,
    segments: block.segments.map((segment) => {
      const completion = completionBySegment.get(segment.id);
      return {
        ...segment,
        completedAt: completion?.completedAt ?? null,
        completedById: completion?.completedById ?? null,
      };
    }),
  })));
}

function toDto(
  row: ChecklistRow | undefined,
  projectId: string,
  ctx: ServiceCtx,
): ProjectChecklistDto {
  return projectChecklistDtoSchema.parse({
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: row?.id ?? null,
    projectId,
    phase: row?.phase ?? "site_documentation",
    title: row?.title ?? "Baustellendokumentation",
    version: Number(row?.version ?? 0),
    blocks: row ? hydrateBlocks(row) : withOpenSegmentMetadata([]),
    updatedAt: row ? timestamp(row.updated_at) : new Date(0).toISOString(),
    permissions: {
      canWrite: can(ctx, "checklist.write"),
      canConfigure: can(ctx, "checklist.configure"),
      canComplete: can(ctx, "checklist.write"),
      canUnlock: can(ctx, "checklist.unlock"),
    },
  });
}

const checklistProjection = sql`
  checklist_record.id,
  checklist_record.project_id,
  checklist_record.phase,
  checklist_record.title,
  checklist_record.version,
  checklist_record.blocks,
  checklist_record.updated_at,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'segmentId', completion.segment_id,
      'completedAt', to_char(
        completion.completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'completedById', completion.completed_by
    ) order by completion.segment_id)
      from project_checklist_segment_completion completion
     where completion.workspace_id = checklist_record.workspace_id
       and completion.checklist_id = checklist_record.id
  ), '[]'::jsonb) as completions
`;

async function readChecklistById(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  checklistId: string,
): Promise<ChecklistRow | undefined> {
  const result = await tx.execute<ChecklistRow>(sql`
    select ${checklistProjection}
      from project_checklist checklist_record
     where checklist_record.workspace_id = ${ctx.workspaceId}::uuid
       and checklist_record.project_id = ${projectId}::uuid
       and checklist_record.id = ${checklistId}::uuid
     limit 1
  `);
  return result.rows[0];
}

// Die aktuelle UI öffnet die erste Baustellendokumentation. Das Datenmodell
// erlaubt bereits mehrere gleichnamige Checklisten/Subphasen; eine gezielte
// Auswahl folgt mit dem vollständigen F7.2-Container-Slice.
export async function getProjectChecklist(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectChecklistDto> {
  requireRead(ctx);
  const result = await tx.execute<ChecklistRow>(sql`
    select ${checklistProjection}
      from project_checklist checklist_record
     where checklist_record.workspace_id = ${ctx.workspaceId}::uuid
       and checklist_record.project_id = ${projectId}::uuid
       and checklist_record.phase = 'site_documentation'
     order by checklist_record.created_at, checklist_record.id
     limit 1
  `);
  return toDto(result.rows[0], projectId, ctx);
}

function throwCapsuleError(
  error: unknown,
  ctx: ServiceCtx,
  projectId: string,
  deniedAction: "checklist.configure" | "checklist.write" | "checklist.unlock",
): never {
  const pg = postgresError(error);
  if (pg.code === "P0002" || pg.code === "23503") {
    throw new ChecklistNotFoundError(projectId);
  }
  if (pg.code === "40001") {
    const currentVersion = pg.detail && /^\d+$/u.test(pg.detail)
      ? Number(pg.detail)
      : "concurrent mutation";
    throw new ChecklistConflictError(currentVersion);
  }
  if (pg.code === "42501") {
    throw new PermissionDeniedError(deniedAction, "project_checklist", undefined, ctx.actor);
  }
  if (pg.code === "23505") throw new ChecklistConflictError("duplicate checklist identity");
  if (pg.code === "22023" || pg.code === "23514" || pg.code === "22003") {
    throw new ChecklistValidationError();
  }
  throw error;
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
  if ((command.baseVersion === 0) !== (command.checklistId === null)) {
    throw new ChecklistValidationError("checklist identity does not match base version");
  }

  let capsule: z.infer<typeof capsuleResultSchema>;
  try {
    const result = await tx.execute<{ result: unknown }>(sql`
      select public.save_project_checklist_v2(
        ${ctx.workspaceId}::uuid,
        ${command.projectId}::uuid,
        ${command.checklistId}::uuid,
        ${command.phase},
        ${command.title},
        ${command.baseVersion},
        ${JSON.stringify(command.blocks)}::jsonb
      ) as result
    `);
    capsule = capsuleResultSchema.parse(result.rows[0]?.result);
  } catch (error) {
    throwCapsuleError(error, ctx, command.projectId, "checklist.configure");
  }
  const row = await readChecklistById(tx, ctx, command.projectId, capsule.checklistId);
  if (!row) throw new ChecklistNotFoundError(command.projectId);
  return toDto(row, command.projectId, ctx);
}

export async function completeChecklistSegment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: MutateChecklistSegmentCommand,
): Promise<ProjectChecklistDto> {
  requireWrite(ctx);
  const parsed = mutateChecklistSegmentCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  let capsule: z.infer<typeof capsuleResultSchema>;
  try {
    const result = await tx.execute<{ result: unknown }>(sql`
      select public.complete_project_checklist_segment(
        ${ctx.workspaceId}::uuid,
        ${command.projectId}::uuid,
        ${command.checklistId}::uuid,
        ${command.segmentId}::uuid,
        ${command.baseVersion}
      ) as result
    `);
    capsule = capsuleResultSchema.parse(result.rows[0]?.result);
  } catch (error) {
    const pg = postgresError(error);
    if (pg.code === "23514" && pg.detail && /^\d+$/u.test(pg.detail)) {
      throw new ChecklistSegmentIncompleteError(Number(pg.detail));
    }
    throwCapsuleError(error, ctx, command.projectId, "checklist.write");
  }
  const row = await readChecklistById(tx, ctx, command.projectId, capsule.checklistId);
  if (!row) throw new ChecklistNotFoundError(command.projectId);
  return toDto(row, command.projectId, ctx);
}

// F7-04b: Punkt als irrelevant markieren (reason gesetzt) bzw. Markierung
// aufheben (reason null, idempotent). Dedizierte Op statt Whole-Tree-Save:
// Begründungspflicht, CAS und Event/Audit wie complete/unlock; keine neue
// Permission (checklist.write). 55000 trägt den Segmentzustand im Detail.
export async function setChecklistItemIrrelevant(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SetChecklistItemIrrelevantCommand,
): Promise<ProjectChecklistDto> {
  requireWrite(ctx);
  const parsed = setChecklistItemIrrelevantCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  let capsule: z.infer<typeof capsuleResultSchema>;
  try {
    const result = await tx.execute<{ result: unknown }>(sql`
      select public.set_project_checklist_item_irrelevant(
        ${ctx.workspaceId}::uuid,
        ${command.projectId}::uuid,
        ${command.checklistId}::uuid,
        ${command.segmentId}::uuid,
        ${command.itemId}::uuid,
        ${command.baseVersion},
        ${command.reason}
      ) as result
    `);
    capsule = capsuleResultSchema.parse(result.rows[0]?.result);
  } catch (error) {
    const pg = postgresError(error);
    if (pg.code === "55000") {
      if (pg.detail === "completed") throw new ChecklistSegmentStateError("completed");
      if (pg.detail === "hidden") throw new ChecklistSegmentStateError("hidden");
    }
    throwCapsuleError(error, ctx, command.projectId, "checklist.write");
  }
  const row = await readChecklistById(tx, ctx, command.projectId, capsule.checklistId);
  if (!row) throw new ChecklistNotFoundError(command.projectId);
  return toDto(row, command.projectId, ctx);
}

export async function unlockChecklistSegment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: MutateChecklistSegmentCommand,
): Promise<ProjectChecklistDto> {
  requireUnlock(ctx);
  const parsed = mutateChecklistSegmentCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  let capsule: z.infer<typeof capsuleResultSchema>;
  try {
    const result = await tx.execute<{ result: unknown }>(sql`
      select public.unlock_project_checklist_segment(
        ${ctx.workspaceId}::uuid,
        ${command.projectId}::uuid,
        ${command.checklistId}::uuid,
        ${command.segmentId}::uuid,
        ${command.baseVersion}
      ) as result
    `);
    capsule = capsuleResultSchema.parse(result.rows[0]?.result);
  } catch (error) {
    throwCapsuleError(error, ctx, command.projectId, "checklist.unlock");
  }
  const row = await readChecklistById(tx, ctx, command.projectId, capsule.checklistId);
  if (!row) throw new ChecklistNotFoundError(command.projectId);
  return toDto(row, command.projectId, ctx);
}
