import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  PROJECT_CLOSED_REQUEST_PAGE_LIMIT,
  projectClosedRequestCursorSchema,
  projectClosedRequestFilterSchema,
  projectLossReasonCommandV1Schema,
  projectOutcomeCommandV1Schema,
  type ProjectClosedRequestFilter,
  type ProjectLossReasonCommandV1,
  type ProjectOutcomeCommandV1,
} from "./outcome-contract";

export type RequestOutcome = "open" | "won" | "lost" | "cannot_fulfill";

export type ProjectLossReasonRecord = {
  id: string;
  label: string;
  position: number;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectOutcomeContext = {
  projectId: string;
  phase: string;
  outcome: RequestOutcome;
  outcomeRevision: number;
  closedAt: string | null;
  lossReason: { id: string; label: string; archived: boolean } | null;
  lossReasonText: string | null;
  activeLossReasons: Array<{ id: string; label: string }>;
  // Zustellstatus der Kundenmail OHNE PII (nur Status + Versuchsanzahl).
  notificationDelivery: { status: string; attemptCount: number } | null;
  permissions: {
    canChangeOutcome: boolean;
    canManageReasons: boolean;
  };
};

export type ProjectClosedRequestRecord = {
  projectId: string;
  projectName: string;
  contactName: string;
  locationLabel: string;
  outcome: "won" | "lost" | "cannot_fulfill";
  outcomeRevision: number;
  closedAt: string;
  lossReasonLabel: string | null;
};

export type ProjectClosedRequestPage = {
  filter: ProjectClosedRequestFilter;
  records: ProjectClosedRequestRecord[];
  nextCursor: string | null;
};

type OutcomeRow = {
  project_id: string;
  phase: string;
  outcome: RequestOutcome;
  outcome_revision: number;
  closed_at: Date | string | null;
  loss_reason_id: string | null;
  loss_reason_label: string | null;
  loss_reason_archived_at: Date | string | null;
  loss_reason_text: string | null;
  contact_deleted_at: Date | string | null;
  [key: string]: unknown;
};

type ReasonRow = {
  id: string;
  label: string;
  position: number;
  revision: number;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

type LockedOutcomeRow = {
  project_id: string;
  phase: string;
  outcome: RequestOutcome;
  outcome_revision: number;
  [key: string]: unknown;
};

type ClosedRequestRow = {
  project_id: string;
  project_name: string;
  contact_name: string;
  location_label: string | null;
  outcome: "won" | "lost" | "cannot_fulfill";
  outcome_revision: number;
  closed_at: Date | string;
  closed_at_cursor: string;
  loss_reason_label: string | null;
  [key: string]: unknown;
};

const closedCursorPayloadSchema = z.strictObject({
  v: z.literal(1),
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
  filter: projectClosedRequestFilterSchema,
  closedAt: z.iso.datetime({ offset: true }),
  id: z.uuid().transform((value) => value.toLowerCase()),
});

type ClosedCursorPayload = z.infer<typeof closedCursorPayloadSchema>;

export class ProjectOutcomeValidationError extends Error {
  readonly code = "invalid_project_outcome_command";

  constructor() {
    super("project outcome command is invalid");
    this.name = "ProjectOutcomeValidationError";
  }
}

export class ProjectOutcomeNotFoundError extends Error {
  readonly code = "project_not_found";

  constructor() {
    super("project outcome target was not found");
    this.name = "ProjectOutcomeNotFoundError";
  }
}

export class ProjectOutcomeConflictError extends Error {
  readonly code = "project_outcome_revision_conflict";

  constructor(public readonly currentRevision?: number) {
    super("project outcome revision is stale");
    this.name = "ProjectOutcomeConflictError";
  }
}

export class ProjectOutcomeIllegalTransitionError extends Error {
  readonly code = "project_outcome_illegal_transition";

  constructor() {
    super("project outcome transition is not permitted");
    this.name = "ProjectOutcomeIllegalTransitionError";
  }
}

export class ProjectOutcomeCannotFulfilLockedError extends Error {
  readonly code = "project_cannot_fulfil_locked";

  constructor() {
    super("project has a binding issuance and cannot be marked cannot_fulfill");
    this.name = "ProjectOutcomeCannotFulfilLockedError";
  }
}

export class ProjectLossReasonUnavailableError extends Error {
  readonly code = "project_loss_reason_unavailable";

  constructor() {
    super("project loss reason is missing, archived, or belongs to another workspace");
    this.name = "ProjectLossReasonUnavailableError";
  }
}

export class ProjectLossReasonValidationError extends Error {
  readonly code = "invalid_project_loss_reason_command";

  constructor() {
    super("project loss reason command is invalid");
    this.name = "ProjectLossReasonValidationError";
  }
}

export class ProjectLossReasonNotFoundError extends Error {
  readonly code = "project_loss_reason_not_found";

  constructor() {
    super("project loss reason was not found");
    this.name = "ProjectLossReasonNotFoundError";
  }
}

export class ProjectLossReasonConflictError extends Error {
  readonly code = "project_loss_reason_conflict";

  constructor(public readonly currentRevision?: number) {
    super("project loss reason conflicts with the current state");
    this.name = "ProjectLossReasonConflictError";
  }
}

function requireInternalProjectRead(ctx: ServiceCtx, resource: string): void {
  if (!can(ctx, "project.read") || isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.read",
      resource,
      isExternalOnly(ctx) ? "external_only_without_internal_outcome" : undefined,
      ctx.actor,
    );
  }
}

function requireOutcomeMutation(ctx: ServiceCtx): void {
  if (!can(ctx, "project.outcome.write") || isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.outcome.write",
      "project_outcome",
      isExternalOnly(ctx) ? "external_only" : undefined,
      ctx.actor,
    );
  }
}

function requireReasonManagement(ctx: ServiceCtx): void {
  if (!can(ctx, "settings.manage") || isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "settings.manage",
      "project_loss_reason",
      isExternalOnly(ctx) ? "external_only" : undefined,
      ctx.actor,
    );
  }
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new ProjectOutcomeValidationError();
  return parsed.toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function reasonFromRow(row: ReasonRow): ProjectLossReasonRecord {
  return {
    id: row.id,
    label: row.label,
    position: row.position,
    revision: row.revision,
    archivedAt: isoOrNull(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function decodeClosedCursor(
  token: string | null | undefined,
  workspaceId: string,
  filter: ProjectClosedRequestFilter,
): ClosedCursorPayload | null {
  if (token == null) return null;
  const tokenResult = projectClosedRequestCursorSchema.safeParse(token);
  if (!tokenResult.success) throw new ProjectOutcomeValidationError();
  try {
    const bytes = Buffer.from(tokenResult.data, "base64url");
    if (bytes.toString("base64url") !== tokenResult.data) {
      throw new ProjectOutcomeValidationError();
    }
    const parsed = closedCursorPayloadSchema.safeParse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    if (
      !parsed.success
      || parsed.data.workspaceId !== workspaceId.toLowerCase()
      || parsed.data.filter !== filter
    ) throw new ProjectOutcomeValidationError();
    return parsed.data;
  } catch (error) {
    if (error instanceof ProjectOutcomeValidationError) throw error;
    throw new ProjectOutcomeValidationError();
  }
}

function encodeClosedCursor(payload: ClosedCursorPayload | null): string | null {
  if (payload === null) return null;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export async function listProjectLossReasons(
  tx: TenantTx,
  ctx: ServiceCtx,
  options: { includeArchived?: boolean } = {},
): Promise<ProjectLossReasonRecord[]> {
  requireInternalProjectRead(ctx, "project_loss_reason");
  const includeArchived = options.includeArchived !== false;
  const rows = await tx.execute<ReasonRow>(sql`
    select id, label, position, revision, archived_at, created_at, updated_at
      from project_loss_reason
     where workspace_id = ${ctx.workspaceId}::uuid
       and (${includeArchived}::boolean or archived_at is null)
     order by position, id
  `);
  return rows.rows.map(reasonFromRow);
}

export async function listManagedProjectLossReasons(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<ProjectLossReasonRecord[]> {
  requireReasonManagement(ctx);
  return listProjectLossReasons(tx, ctx);
}

export async function getProjectOutcomeContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectOutcomeContext | null> {
  requireInternalProjectRead(ctx, "project_outcome");
  const result = await tx.execute<OutcomeRow>(sql`
    select project_record.id as project_id,
           project_record.phase,
           project_record.outcome,
           project_record.outcome_revision,
           project_record.closed_at,
           project_record.loss_reason_id,
           reason_record.label as loss_reason_label,
           reason_record.archived_at as loss_reason_archived_at,
           project_record.loss_reason_text,
           contact_record.deleted_at as contact_deleted_at
      from project project_record
      join contact contact_record
        on contact_record.workspace_id = project_record.workspace_id
       and contact_record.id = project_record.contact_id
      left join project_loss_reason reason_record
        on reason_record.workspace_id = project_record.workspace_id
       and reason_record.id = project_record.loss_reason_id
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  const canChangeOutcome = row.phase === "request"
    && row.outcome !== "cannot_fulfill"
    && row.contact_deleted_at === null
    && can(ctx, "project.outcome.write")
    && !isExternalOnly(ctx);
  const activeLossReasons = canChangeOutcome
    ? (await listProjectLossReasons(tx, ctx, { includeArchived: false }))
        .map(({ id, label }) => ({ id, label }))
    : [];
  const notificationResult = await tx.execute<{
    status: string;
    attempt_count: number;
  }>(sql`
    select delivery.status, delivery.attempt_count
      from public._m111b_read_notification_delivery(
        ${ctx.workspaceId}::uuid, ${projectId}::uuid
      ) as delivery
  `);
  const notificationRow = notificationResult.rows[0];
  return {
    projectId: row.project_id,
    phase: row.phase,
    outcome: row.outcome,
    outcomeRevision: row.outcome_revision,
    closedAt: isoOrNull(row.closed_at),
    lossReason: row.loss_reason_id === null || row.loss_reason_label === null
      ? null
      : {
          id: row.loss_reason_id,
          label: row.loss_reason_label,
          archived: row.loss_reason_archived_at !== null,
        },
    lossReasonText: row.loss_reason_text,
    activeLossReasons,
    notificationDelivery: notificationRow
      ? {
          status: notificationRow.status,
          attemptCount: notificationRow.attempt_count,
        }
      : null,
    permissions: {
      canChangeOutcome,
      canManageReasons: can(ctx, "settings.manage") && !isExternalOnly(ctx),
    },
  };
}

function transitionPermitted(
  current: RequestOutcome,
  command: ProjectOutcomeCommandV1,
): boolean {
  if (
    command.kind === "mark_won"
    || command.kind === "mark_lost"
    || command.kind === "mark_cannot_fulfill"
  ) {
    return current === "open";
  }
  return current === "won" || current === "lost";
}

export async function changeProjectOutcome(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectOutcomeCommandV1,
): Promise<ProjectOutcomeContext> {
  requireOutcomeMutation(ctx);
  const parsed = projectOutcomeCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new ProjectOutcomeValidationError();
  const command = parsed.data;

  const lockedResult = await tx.execute<LockedOutcomeRow>(sql`
    select id as project_id, phase, outcome, outcome_revision
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     for update
  `);
  const current = lockedResult.rows[0];
  if (!current) throw new ProjectOutcomeNotFoundError();

  // Absichtlich ein zweites READ-COMMITTED-Statement nach dem Project-Lock:
  // gewinnt die Erasure zuerst, wartet der Lock oben auf ihren Commit und nur
  // dieser frische Snapshot darf danach noch eine Outcome-Mutation zulassen.
  const activeSubject = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select project_record.id
      from project project_record
      join contact contact_record
        on contact_record.workspace_id = project_record.workspace_id
       and contact_record.id = project_record.contact_id
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${command.projectId}::uuid
       and contact_record.deleted_at is null
  `);
  if (!activeSubject.rows[0]) throw new ProjectOutcomeNotFoundError();
  if (current.outcome_revision !== command.expectedOutcomeRevision) {
    throw new ProjectOutcomeConflictError(current.outcome_revision);
  }
  if (current.phase !== "request" || !transitionPermitted(current.outcome, command)) {
    throw new ProjectOutcomeIllegalTransitionError();
  }

  if (command.kind === "mark_lost") {
    const reason = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id
        from project_loss_reason
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.lossReasonId}::uuid
         and archived_at is null
       for share
    `);
    if (!reason.rows[0]) throw new ProjectLossReasonUnavailableError();
  }

  // Ein verbindlich ausgestelltes Angebot (Approval ohne Withdrawal) blockiert
  // die Transition. Die schmale Definer-Kapsel liest die fuer app_runtime
  // unsichtbaren Issuance-Relationen; sie laeuft NACH dem Project-FOR-UPDATE-Lock,
  // damit der Freeze-Guard (FOR SHARE auf project) und diese Transition gegen
  // dieselbe Project-Zeile serialisieren (Review-Befund P0-1).
  if (command.kind === "mark_cannot_fulfill") {
    const binding = await tx.execute<{ has_binding: boolean }>(sql`
      select public._m111b_project_has_binding_issuance(
        ${ctx.workspaceId}::uuid, ${command.projectId}::uuid
      ) as has_binding
    `);
    if (binding.rows[0]?.has_binding) throw new ProjectOutcomeCannotFulfilLockedError();
  }

  const nextOutcome = command.kind === "reopen"
    ? "open"
    : command.kind === "mark_won" ? "won"
    : command.kind === "mark_lost" ? "lost"
    : "cannot_fulfill";
  const nextRevision = current.outcome_revision + 1;
  const lossReasonId = command.kind === "mark_lost" ? command.lossReasonId : null;
  const lossReasonText = command.kind === "mark_lost" ? command.lossReasonText : null;
  const closedAt = command.kind === "reopen" ? sql`null` : sql`transaction_timestamp()`;

  const updated = await tx.execute<OutcomeRow>(sql`
    update project
       set outcome = ${nextOutcome},
           outcome_revision = ${nextRevision},
           closed_at = ${closedAt},
           loss_reason_id = ${lossReasonId}::uuid,
           loss_reason_text = ${lossReasonText},
           updated_at = transaction_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
       and phase = 'request'
       and outcome = ${current.outcome}
       and outcome_revision = ${command.expectedOutcomeRevision}
     returning id as project_id, phase, outcome, outcome_revision, closed_at,
               loss_reason_id, loss_reason_text,
               null::text as loss_reason_label,
               null::timestamptz as loss_reason_archived_at
  `);
  if (!updated.rows[0]) throw new ProjectOutcomeConflictError();

  // Outbox-Insert + Dispatch in derselben Transaktion wie das Project-Update.
  // Keine PII: die Zeile traegt nur Projekt-/Idempotenzbezug.
  if (command.kind === "mark_cannot_fulfill") {
    // Kein RETURNING: app_runtime hat bewusst KEIN SELECT auf der Tabelle
    // (Kapsel-only). Der Dispatch haengt am Project; die Notification-ID wird
    // in enqueue_customer_notification Definer-seitig aufgeloest.
    await tx.execute(sql`
      insert into customer_notification (workspace_id, project_id, idempotency_key)
      values (${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
              ${`cannot-fulfil:${command.projectId}`})
    `);
    // Dispatch in derselben Transaktion wie Project-Update + Outbox-Insert.
    // In der Test-DB (ohne pgboss-Schema) existiert die Dispatch-Funktion nicht;
    // dann bleibt die Outbox-Zeile die Zustellwahrheit und der Sweeper reicht
    // nach (kein Fehler, keine abgebrochene Transaktion).
    const dispatchAvailable = await tx.execute<{ has_dispatch: boolean }>(sql`
      select pg_catalog.to_regprocedure(
        'pgboss.enqueue_customer_notification(uuid,uuid)'
      ) is not null as has_dispatch
    `);
    if (dispatchAvailable.rows[0]?.has_dispatch) {
      await tx.execute(sql`
        select pgboss.enqueue_customer_notification(
          ${ctx.workspaceId}::uuid, ${command.projectId}::uuid
        )
      `);
    }
  }

  const context = await getProjectOutcomeContext(tx, ctx, command.projectId);
  if (!context) throw new ProjectOutcomeNotFoundError();
  return context;
}

export async function changeProjectLossReason(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectLossReasonCommandV1,
): Promise<ProjectLossReasonRecord> {
  requireReasonManagement(ctx);
  const parsed = projectLossReasonCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new ProjectLossReasonValidationError();
  const command = parsed.data;

  if (command.kind === "create") {
    try {
      const created = await tx.execute<ReasonRow>(sql`
        insert into project_loss_reason (workspace_id, label, position)
        values (${ctx.workspaceId}::uuid, ${command.label}, 1)
        returning id, label, position, revision, archived_at, created_at, updated_at
      `);
      const record = reasonFromRow(created.rows[0]!);
      await writeAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        action: "settings.manage",
        resource: "project_loss_reason",
        allowed: true,
        details: { operation: "create", reasonId: record.id, revision: record.revision },
      });
      return record;
    } catch (error) {
      if (postgresCode(error) === "23505") throw new ProjectLossReasonConflictError();
      throw error;
    }
  }

  const locked = await tx.execute<ReasonRow>(sql`
    select id, label, position, revision, archived_at, created_at, updated_at
      from project_loss_reason
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.reasonId}::uuid
     for update
  `);
  const current = locked.rows[0];
  if (!current) throw new ProjectLossReasonNotFoundError();
  if (current.revision !== command.expectedRevision) {
    throw new ProjectLossReasonConflictError(current.revision);
  }
  const currentlyArchived = current.archived_at !== null;
  if (
    (command.kind === "archive" && currentlyArchived)
    || (command.kind === "reactivate" && !currentlyArchived)
  ) throw new ProjectLossReasonConflictError(current.revision);

  const archivedAt = command.kind === "archive" ? sql`transaction_timestamp()` : sql`null`;
  const updated = await tx.execute<ReasonRow>(sql`
    update project_loss_reason
       set archived_at = ${archivedAt},
           revision = revision + 1,
           updated_at = transaction_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.reasonId}::uuid
       and revision = ${command.expectedRevision}
     returning id, label, position, revision, archived_at, created_at, updated_at
  `);
  if (!updated.rows[0]) throw new ProjectLossReasonConflictError();
  const record = reasonFromRow(updated.rows[0]);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "settings.manage",
    resource: "project_loss_reason",
    allowed: true,
    details: {
      operation: command.kind,
      reasonId: record.id,
      revision: record.revision,
    },
  });
  return record;
}

export async function listClosedRequests(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { filter?: ProjectClosedRequestFilter; cursor?: string | null } = {},
): Promise<ProjectClosedRequestPage> {
  requireInternalProjectRead(ctx, "closed_request_list");
  const filterResult = projectClosedRequestFilterSchema.safeParse(input.filter ?? "all");
  if (!filterResult.success) throw new ProjectOutcomeValidationError();
  const filter = filterResult.data;
  const cursor = decodeClosedCursor(input.cursor, ctx.workspaceId, filter);
  const filterSql = filter === "all" ? sql`` : sql`and project_record.outcome = ${filter}`;
  const cursorSql = cursor === null
    ? sql``
    : sql`and (project_record.closed_at, project_record.id) < (
        ${cursor.closedAt}::timestamptz, ${cursor.id}::uuid
      )`;
  const result = await tx.execute<ClosedRequestRow>(sql`
    select project_record.id as project_id,
           project_record.name as project_name,
           contact_record.display_name as contact_name,
           site_record.formatted_address as location_label,
           project_record.outcome,
           project_record.outcome_revision,
           project_record.closed_at,
           to_char(
             project_record.closed_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) as closed_at_cursor,
           reason_record.label as loss_reason_label
      from project project_record
      join contact contact_record
        on contact_record.workspace_id = project_record.workspace_id
       and contact_record.id = project_record.contact_id
      join site site_record
        on site_record.workspace_id = project_record.workspace_id
       and site_record.id = project_record.site_id
      left join project_loss_reason reason_record
        on reason_record.workspace_id = project_record.workspace_id
       and reason_record.id = project_record.loss_reason_id
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.phase = 'request'
       and project_record.outcome in ('won', 'lost', 'cannot_fulfill')
       and project_record.closed_at is not null
       ${filterSql}
       ${cursorSql}
     order by project_record.closed_at desc, project_record.id desc
     limit ${PROJECT_CLOSED_REQUEST_PAGE_LIMIT + 1}
  `);
  const projected = result.rows.map((row): ProjectClosedRequestRecord => ({
    projectId: row.project_id,
    projectName: row.project_name,
    contactName: row.contact_name,
    locationLabel: row.location_label ?? "Adresse nicht verfügbar",
    outcome: row.outcome,
    outcomeRevision: row.outcome_revision,
    closedAt: iso(row.closed_at),
    lossReasonLabel: row.loss_reason_label,
  }));
  const hasMore = projected.length > PROJECT_CLOSED_REQUEST_PAGE_LIMIT;
  const records = projected.slice(0, PROJECT_CLOSED_REQUEST_PAGE_LIMIT);
  const last = hasMore ? result.rows[PROJECT_CLOSED_REQUEST_PAGE_LIMIT - 1] : undefined;
  return {
    filter,
    records,
    nextCursor: encodeClosedCursor(last
      ? {
          v: 1,
          workspaceId: ctx.workspaceId.toLowerCase(),
          filter,
          closedAt: last.closed_at_cursor,
          id: last.project_id,
        }
      : null),
  };
}
