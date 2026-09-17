// Kein "server-only"-Import: Der Projekt-Seitengraph bleibt build-importierbar.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { immutableKey, resolveObjectStorage } from "@/lib/storage";
import {
  CHECKLIST_ITEM_PHOTO_KEY_PATTERN,
  CHECKLIST_SCHEMA_VERSION,
  checklistBlocksSchema,
  editableChecklistBlocksSchema,
  mutateChecklistSegmentCommandSchema,
  projectChecklistDtoSchema,
  saveProjectChecklistCommandSchema,
  setChecklistBlockTeamCommandSchema,
  setChecklistItemIrrelevantCommandSchema,
  withOpenSegmentMetadata,
  type ChecklistBlockAssignedTeamV1,
  type ChecklistBlocksV1,
  type EditableChecklistBlocksV2,
  type MutateChecklistSegmentCommand,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
  type SetChecklistBlockTeamCommand,
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
  assignments: unknown;
};

const assignmentRowsSchema = z.array(z.object({
  blockId: z.uuid(),
  teamId: z.uuid(),
  teamName: z.string(),
  teamActive: z.boolean(),
}));

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
  // F7-05b: Block-Team-Zuweisung als Anzeige-Overlay (Ghost-Zeilen
  // gelöschter Blöcke fallen raus; archivierte Teams bleiben lesbar).
  const assignments = assignmentRowsSchema.parse(row.assignments ?? []);
  const teamsByBlock = new Map<string, ChecklistBlockAssignedTeamV1[]>();
  for (const assignment of assignments) {
    const list = teamsByBlock.get(assignment.blockId) ?? [];
    list.push({
      teamId: assignment.teamId,
      teamName: assignment.teamName,
      active: assignment.teamActive,
    });
    teamsByBlock.set(assignment.blockId, list);
  }
  for (const list of teamsByBlock.values()) {
    list.sort((left, right) => left.teamName.localeCompare(right.teamName, "de"));
  }
  return checklistBlocksSchema.parse(stored.map((block) => ({
    ...block,
    assignedTeams: teamsByBlock.get(block.id) ?? [],
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
  ), '[]'::jsonb) as completions,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'blockId', assignment.block_id,
      'teamId', assignment.team_id,
      'teamName', team_record.name,
      'teamActive', team_record.active
    ) order by assignment.block_id, team_record.name, assignment.team_id)
      from project_checklist_block_assignment assignment
      join team team_record
        on team_record.workspace_id = assignment.workspace_id
       and team_record.id = assignment.team_id
     where assignment.workspace_id = checklist_record.workspace_id
       and assignment.checklist_id = checklist_record.id
  ), '[]'::jsonb) as assignments
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

// F7-02G: Foto-Upload/-Lesen am Bild-Punkt (Katalog F7.2).
// Upload-Grenzen (ESTIMATE, reversibel): 10 MiB, JPEG/PNG. Der Key ist
// projekt-skoped und enthaelt NUR Service-seitig gebaute Bestandteile
// (Projekt-/Punkt-ID, Kurz-Hash der Bytes, Allowlist-Endung): Der
// Dateiname des Clients landet nie im Key (Traversal tot).
export const CHECKLIST_PHOTO_MAX_BYTES = 10_485_760;
const CHECKLIST_PHOTO_CONTENT_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

const photoUuidSchema = z.uuid().transform((value) => value.toLowerCase());

const uploadChecklistItemPhotoInputSchema = z.object({
  projectId: photoUuidSchema,
  checklistId: photoUuidSchema.nullable(),
  itemId: photoUuidSchema,
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(128),
}).strict();

export type UploadChecklistItemPhotoInput = {
  projectId: string;
  checklistId: string | null;
  itemId: string;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
};

async function requireVisibleProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<void> {
  const found = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (found.rows.length !== 1) throw new ChecklistNotFoundError(projectId);
}

type ChecklistTreeItem =
  EditableChecklistBlocksV2[number]["segments"][number]["items"][number];

function findChecklistItem(
  blocks: EditableChecklistBlocksV2,
  itemId: string,
): ChecklistTreeItem | undefined {
  for (const block of blocks) {
    for (const segment of block.segments) {
      const found = segment.items.find((item) => item.id === itemId);
      if (found) return found;
    }
  }
  return undefined;
}

// F7-02G: Foto-Bytes pruefen und unveraenderlich ablegen; gibt den Key
// zurueck, den der naechste Whole-Tree-Save (Version-CAS) persistiert.
// checklistId null = Upload vor dem ersten Save (keine Existenzpruefung;
// der Save-Guard validiert Art+Key); sonst Fail-fast am Tree (kein
// Orphan bei Fremd-Punkt). Gleiche Bytes erneut = idempotenter Erfolg
// (Key ist inhalts-deterministisch; WORM-Conflict heisst identischer
// Inhalt). Keine neue Permission (checklist.write).
export async function uploadChecklistItemPhoto(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UploadChecklistItemPhotoInput,
): Promise<{ photoKey: string }> {
  requireWrite(ctx);
  const parsed = uploadChecklistItemPhotoInputSchema.safeParse({
    projectId: input.projectId,
    checklistId: input.checklistId,
    itemId: input.itemId,
    filename: input.filename,
    contentType: input.contentType,
  });
  if (!parsed.success) throw new ChecklistValidationError();
  const { projectId, checklistId, itemId, filename } = parsed.data;
  const contentType = parsed.data.contentType.toLowerCase();
  const expectedExt = (CHECKLIST_PHOTO_CONTENT_TYPES as Record<string, string>)[contentType];
  if (!expectedExt) throw new ChecklistValidationError("content type not allowed");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > CHECKLIST_PHOTO_MAX_BYTES) {
    throw new ChecklistValidationError("byte size out of range");
  }
  const lowerName = filename.toLowerCase();
  const extensionOk = contentType === "image/jpeg"
    ? lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")
    : lowerName.endsWith(`.${expectedExt}`);
  if (!extensionOk) throw new ChecklistValidationError("filename extension mismatch");

  // Fail-fast VOR dem Storage-Put: Projekt-Sicht (RLS) plus ggf. Tree.
  await requireVisibleProject(tx, ctx, projectId);
  if (checklistId !== null) {
    const row = await readChecklistById(tx, ctx, projectId, checklistId);
    if (!row) throw new ChecklistNotFoundError(projectId);
    let stored: EditableChecklistBlocksV2;
    try {
      stored = editableChecklistBlocksSchema.parse(row.blocks);
    } catch {
      throw new ChecklistValidationError("checklist tree is corrupt");
    }
    const item = findChecklistItem(stored, itemId);
    if (!item) throw new ChecklistNotFoundError(projectId);
    if (item.kind !== "image") throw new ChecklistValidationError("photo requires image item");
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const photoKey = immutableKey(
    projectId,
    "checklist-photos",
    `${itemId}_${sha256.slice(0, 8)}.${expectedExt}`,
  );
  try {
    const stored = await resolveObjectStorage().putImmutable(
      photoKey, Buffer.from(input.bytes), contentType,
    );
    if (stored.sha256 !== sha256) {
      throw new ChecklistValidationError("receipt integrity mismatch");
    }
  } catch (error) {
    if (error instanceof ChecklistValidationError) throw error;
    // WORM-Konflikt (LocalStorage) oder S3-Conditional-Write-Race
    // (412 PreconditionFailed, s3.ts IfNoneMatch): Kandidat fuer
    // idempotenten Erfolg — erst der Read-back-Beleg entscheidet.
    const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
      ?.$metadata?.httpStatusCode;
    const isConflict = error instanceof Error
      && (error.message.includes("existiert bereits")
        || error.message.includes("PreconditionFailed")
        || error.message.includes("412")
        || statusCode === 412);
    if (isConflict) {
      // Idempotenz mit Beleg: Gleicher Key heisst gleiche Punkt-ID plus
      // gleichen Kurz-Hash — der volle Hash des liegenden Objekts muss
      // trotzdem stimmen (kein blindes Vertrauen in 32 Bit).
      const existing = await resolveObjectStorage().get(photoKey).catch(() => null);
      const existingSha = existing === null
        ? null
        : createHash("sha256").update(existing.body).digest("hex");
      if (existingSha === sha256) return { photoKey };
      throw new ChecklistValidationError("receipt integrity mismatch");
    }
    throw error;
  }
  return { photoKey };
}

export type ReadChecklistItemPhotoInput = {
  projectId: string;
  checklistId: string;
  itemId: string;
};

// F7-02G: Foto-Bytes dienend lesen (Server-Action baut die Vorschau;
// kein signierter URL-Umweg — F10-04-Praezedenz). Key fail-closed aufs
// Foto-Muster; fehlendes Objekt = NotFound (kein Orakel). Genutzte
// Permission: checklist.read (Viewer sieht Fotos lesend).
export async function readChecklistItemPhoto(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ReadChecklistItemPhotoInput,
): Promise<{ contentType: string; body: Buffer }> {
  requireRead(ctx);
  const parsed = z.object({
    projectId: photoUuidSchema,
    checklistId: photoUuidSchema,
    itemId: photoUuidSchema,
  }).strict().safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const row = await readChecklistById(tx, ctx, parsed.data.projectId, parsed.data.checklistId);
  if (!row) throw new ChecklistNotFoundError(parsed.data.projectId);
  let stored: EditableChecklistBlocksV2;
  try {
    stored = editableChecklistBlocksSchema.parse(row.blocks);
  } catch {
    throw new ChecklistValidationError("checklist tree is corrupt");
  }
  const item = findChecklistItem(stored, parsed.data.itemId);
  const photo = item?.photo ?? null;
  if (!item || photo === null) throw new ChecklistNotFoundError(parsed.data.projectId);
  if (!CHECKLIST_ITEM_PHOTO_KEY_PATTERN.test(photo)) {
    throw new ChecklistValidationError("receipt key mismatch");
  }
  try {
    return await resolveObjectStorage().get(photo);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Integritätsbruch")) throw error;
    throw new ChecklistNotFoundError(parsed.data.projectId);
  }
}

// F7-05b: Teams parallel je Block zuweisen/entfernen (Katalog F7.5).
// Mengen-Idempotenz ohne Revision (kein Tree-Write): doppeltes Zuweisen
// und leeres Entfernen gelingen still. Nur AKTIVE Teams sind zuweisbar
// (Kalender-Präzedenz F1-12, kein Existenz-Leak); archivierte bleiben an
// bestehenden Zuweisungen lesbar. Keine neue Permission (checklist.write).
async function lockChecklistBlock(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  checklistId: string,
  blockId: string,
): Promise<void> {
  const row = await readChecklistById(tx, ctx, projectId, checklistId);
  if (!row) throw new ChecklistNotFoundError(projectId);
  let stored;
  try {
    stored = editableChecklistBlocksSchema.parse(row.blocks);
  } catch {
    throw new ChecklistValidationError("checklist tree is corrupt");
  }
  if (!stored.some((candidate) => candidate.id === blockId)) {
    throw new ChecklistNotFoundError(projectId);
  }
}

async function requireActiveTeam(
  tx: TenantTx,
  ctx: ServiceCtx,
  teamId: string,
): Promise<void> {
  const result = await tx.execute<{ id: string }>(sql`
    select id
      from team
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${teamId}::uuid
       and active = true
  `);
  if (result.rows.length !== 1) throw new ChecklistValidationError("unknown team");
}

async function emitBlockTeamEvidence(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    checklistId: string;
    blockId: string;
    teamId: string;
    operation: "assign" | "unassign";
  },
): Promise<void> {
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_checklist",
    aggregateId: input.checklistId,
    eventType:
      input.operation === "assign"
        ? "checklist.block_team_assigned"
        : "checklist.block_team_unassigned",
    actor: ctx.actor,
    payload: {
      projectId: input.projectId,
      checklistId: input.checklistId,
      blockId: input.blockId,
      teamId: input.teamId,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "checklist.write",
    resource: "project_checklist_block",
    allowed: true,
    details: {
      projectId: input.projectId,
      checklistId: input.checklistId,
      blockId: input.blockId,
      teamId: input.teamId,
      operation: input.operation,
    },
  });
}

export async function assignChecklistBlockTeam(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SetChecklistBlockTeamCommand,
): Promise<ProjectChecklistDto> {
  requireWrite(ctx);
  const parsed = setChecklistBlockTeamCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  await lockChecklistBlock(tx, ctx, command.projectId, command.checklistId, command.blockId);
  await requireActiveTeam(tx, ctx, command.teamId);
  try {
    await tx.execute(sql`
      insert into project_checklist_block_assignment (
        workspace_id, checklist_id, block_id, team_id, assigned_by
      ) values (
        ${ctx.workspaceId}::uuid, ${command.checklistId}::uuid,
        ${command.blockId}::uuid, ${command.teamId}::uuid, ${ctx.actor}::uuid
      )
      on conflict (
        workspace_id, checklist_id, block_id, team_id
      ) do nothing
    `);
  } catch (error) {
    throwCapsuleError(error, ctx, command.projectId, "checklist.write");
  }
  await emitBlockTeamEvidence(tx, ctx, { ...command, operation: "assign" });
  const row = await readChecklistById(tx, ctx, command.projectId, command.checklistId);
  if (!row) throw new ChecklistNotFoundError(command.projectId);
  return toDto(row, command.projectId, ctx);
}

export async function unassignChecklistBlockTeam(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SetChecklistBlockTeamCommand,
): Promise<ProjectChecklistDto> {
  requireWrite(ctx);
  const parsed = setChecklistBlockTeamCommandSchema.safeParse(input);
  if (!parsed.success) throw new ChecklistValidationError();
  const command = parsed.data;
  await lockChecklistBlock(tx, ctx, command.projectId, command.checklistId, command.blockId);
  let removed = false;
  try {
    const deleted = await tx.execute<{ id: string }>(sql`
      delete from project_checklist_block_assignment
       where workspace_id = ${ctx.workspaceId}::uuid
         and checklist_id = ${command.checklistId}::uuid
         and block_id = ${command.blockId}::uuid
         and team_id = ${command.teamId}::uuid
       returning id
    `);
    removed = deleted.rows.length > 0;
  } catch (error) {
    throwCapsuleError(error, ctx, command.projectId, "checklist.write");
  }
  // Leeres Entfernen ist stiller Erfolg — aber ohne Evidenzrauschen.
  if (removed) {
    await emitBlockTeamEvidence(tx, ctx, { ...command, operation: "unassign" });
  }
  const row = await readChecklistById(tx, ctx, command.projectId, command.checklistId);
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
