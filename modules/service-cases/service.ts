// F13-01 Serviceauftrag: Filing-Objekt je Projekt mit kleiner
// Statusmaschine (open → in_progress → done, cancelled aus open/
// in_progress; done/cancelled terminal). Berechtigung: Wiederverwendung
// installation.read/write (KEINE neuen Permission-Keys — Mandat).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class ServiceCaseNotFoundError extends Error {
  constructor(public readonly caseId: string) {
    super(`service case not found: ${caseId}`);
    this.name = "ServiceCaseNotFoundError";
  }
}

export class ServiceCaseValidationError extends Error {
  constructor(message = "service case validation failed") {
    super(message);
    this.name = "ServiceCaseValidationError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const serviceCaseStatuses = ["open", "in_progress", "done", "cancelled"] as const;
export type ServiceCaseStatus = (typeof serviceCaseStatuses)[number];

const createServiceCaseCommandSchema = z.strictObject({
  projectId: uuidSchema,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
});

const setServiceCaseStatusCommandSchema = z.strictObject({
  id: uuidSchema,
  status: z.enum(serviceCaseStatuses),
});

export type ServiceCaseDto = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: ServiceCaseStatus;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

type ServiceCaseRow = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

function toDto(row: ServiceCaseRow, canWrite: boolean): ServiceCaseDto {
  if (!serviceCaseStatuses.includes(row.status as ServiceCaseStatus)) {
    throw new ServiceCaseValidationError();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as ServiceCaseStatus,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  };
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "service_case", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "service_case", undefined, ctx.actor);
  }
}

const ROW_COLUMNS = sql`id, project_id, title, description, status, due_date, completed_at, created_at, updated_at`;

export async function createServiceCase(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; title: string; description?: string | null; dueDate?: string | null },
): Promise<ServiceCaseDto> {
  requireWrite(ctx);
  const parsed = createServiceCaseCommandSchema.safeParse({
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? null,
    dueDate: input.dueDate ?? null,
  });
  if (!parsed.success) throw new ServiceCaseValidationError();
  const command = parsed.data;

  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new ServiceCaseNotFoundError(command.projectId);

  const inserted = await tx.execute<ServiceCaseRow>(sql`
    insert into service_case (
      workspace_id, project_id, title, description, due_date, created_by
    ) values (
      ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
      ${command.title}, ${command.description},
      ${command.dueDate}, ${ctx.actor}::uuid
    )
    returning ${ROW_COLUMNS}
  `);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "service_case",
    aggregateId: inserted.rows[0]!.id,
    eventType: "service_case.created",
    actor: ctx.actor,
    payload: { projectId: command.projectId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "service_case.create",
    resource: "service_case",
    allowed: true,
    details: { projectId: command.projectId },
  });

  return toDto(inserted.rows[0]!, true);
}

export async function listServiceCases(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<ServiceCaseDto[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new ServiceCaseValidationError();
  const result = await tx.execute<ServiceCaseRow>(sql`
    select ${ROW_COLUMNS} from service_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     order by created_at desc, id desc
  `);
  const canWrite = can(ctx, "installation.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

const allowedTransitions: Record<ServiceCaseStatus, readonly ServiceCaseStatus[]> = {
  open: ["in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export async function setServiceCaseStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; status: ServiceCaseStatus },
): Promise<ServiceCaseDto> {
  requireWrite(ctx);
  const parsed = setServiceCaseStatusCommandSchema.safeParse(input);
  if (!parsed.success) throw new ServiceCaseValidationError();
  const command = parsed.data;

  const current = await tx.execute<ServiceCaseRow>(sql`
    select ${ROW_COLUMNS} from service_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new ServiceCaseNotFoundError(command.id);
  const from = row.status as ServiceCaseStatus;
  if (!allowedTransitions[from].includes(command.status)) {
    throw new ServiceCaseValidationError(`illegal transition ${from} -> ${command.status}`);
  }

  const updated = await tx.execute<ServiceCaseRow>(sql`
    update service_case
       set status = ${command.status},
           completed_at = case when ${command.status} = 'done' then statement_timestamp() else null end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
    returning ${ROW_COLUMNS}
  `);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "service_case",
    aggregateId: command.id,
    eventType: "service_case.status_changed",
    actor: ctx.actor,
    payload: { from, to: command.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "service_case.status",
    resource: "service_case",
    allowed: true,
    details: { id: command.id, from, to: command.status },
  });

  return toDto(updated.rows[0]!, true);
}
