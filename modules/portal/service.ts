import "server-only";

import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  generatePortalToken,
  hashPortalToken,
  parsePortalPublicView,
  portalInviteCreateV1Schema,
  portalInviteWithdrawV1Schema,
  PORTAL_INVITE_STATUS,
  PORTAL_WITHDRAW_REASON,
  type PortalInviteStatus,
  type PortalPublicViewV1,
  type PortalWithdrawReason,
} from "@/lib/integrations/portal/portal-contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const instantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value) => new Date(value).toISOString());

export const PORTAL_CONFLICT_CODES = [
  "invalid_ttl",
  "invalid_binding",
  "race_detected",
] as const;

const createResultSchema = z.strictObject({
  status: z.literal("active"),
  inviteId: uuidSchema,
  projectId: uuidSchema,
  expiresAt: instantSchema,
  replayed: z.boolean(),
});

const conflictResultSchema = z.strictObject({
  status: z.literal("conflict"),
  code: z.string(),
});

const notFoundResultSchema = z.strictObject({ status: z.literal("not_found") });

export class PortalValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("portal invite command is invalid");
    this.name = "PortalValidationError";
  }
}

export class PortalNotFoundError extends Error {
  constructor() {
    super("portal invite was not found");
    this.name = "PortalNotFoundError";
  }
}

export class PortalConflictError extends Error {
  constructor(public readonly code: string) {
    super("portal invite state changed");
    this.name = "PortalConflictError";
  }
}

export class PortalIntegrityError extends Error {
  constructor() {
    super("stored portal invite failed integrity validation");
    this.name = "PortalIntegrityError";
  }
}

export class PortalPersistenceError extends Error {
  constructor() {
    super("portal invite persistence failed");
    this.name = "PortalPersistenceError";
  }
}

export type PortalCreateResult = {
  inviteId: string;
  projectId: string;
  token: string;
  expiresAt: string;
};

export type PortalStatusResult = {
  active: {
    inviteId: string;
    expiresAt: string;
    viewCount: number;
  } | null;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0
      ? "/"
      : `/${issue.path.map((part) => String(part)).join("/")}`
  )))].slice(0, 20);
}

function parseCommand<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PortalValidationError(issuePaths(parsed.error));
  return parsed.data;
}

function requireInternalAccess(ctx: ServiceCtx, action: Action, resource: string): void {
  if (!can(ctx, action)) {
    throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(action, resource, "external_only_without_assignment", ctx.actor);
  }
}

function requireSameWorkspace(ctx: ServiceCtx, workspaceId: string): void {
  if (ctx.workspaceId !== workspaceId) throw new PortalNotFoundError();
}

async function executeFunction(tx: TenantTx, statement: ReturnType<typeof sql>): Promise<unknown> {
  let rows: unknown[];
  try {
    rows = (await tx.execute(statement)).rows;
  } catch {
    throw new PortalPersistenceError();
  }
  if (rows.length === 0) throw new PortalPersistenceError();
  if (rows.length !== 1) throw new PortalIntegrityError();
  const row = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!row.success) throw new PortalIntegrityError();
  return row.data.result;
}

function mapNonSuccess(raw: unknown): never {
  // Echter Race (partieller Unique-Index) -> Conflict. invalid_ttl/
  // invalid_binding sind bei gueltigem Contract unerreichbar (Zod zuerst,
  // generatePortalToken liefert immer 32 Byte) -> Integritaetsfehler,
  // damit echte Bugs nicht als „Stand geaendert" fehlalarmieren.
  const conflict = conflictResultSchema.safeParse(raw);
  if (conflict.success && conflict.data.code === "race_detected") {
    throw new PortalConflictError("race_detected");
  }
  if (conflict.success) throw new PortalIntegrityError();
  throw new PortalNotFoundError();
}

async function recordSuccess(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { action: Action; eventType: string; projectId: string; details: Record<string, unknown> },
): Promise<void> {
  try {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project",
      aggregateId: input.projectId,
      eventType: input.eventType,
      actor: ctx.actor,
      payload: input.details,
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: input.action,
      resource: "portal_invite",
      allowed: true,
      details: input.details,
    });
  } catch {
    throw new PortalPersistenceError();
  }
}

export async function createPortalInvite(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<PortalCreateResult> {
  requireInternalAccess(ctx, "project.write", "portal_invite");
  const command = parseCommand(portalInviteCreateV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  const { token, tokenHash } = generatePortalToken();
  const raw = await executeFunction(tx, sql`
    select public.create_portal_invite(
      ${command.workspaceId}::uuid,
      ${command.projectId}::uuid,
      ${command.ttlDays}::integer,
      ${tokenHash}
    ) as result
  `);
  const parsed = createResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (result.projectId !== command.projectId) throw new PortalIntegrityError();
  await recordSuccess(tx, ctx, {
    action: "project.write",
    eventType: "portal.invite_created",
    projectId: result.projectId,
    details: {
      inviteId: result.inviteId,
      projectId: result.projectId,
      expiresAt: result.expiresAt,
    },
  });
  return {
    inviteId: result.inviteId,
    projectId: result.projectId,
    token,
    expiresAt: result.expiresAt,
  };
}

export async function withdrawPortalInvite(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<{ inviteId: string; projectId: string; status: "withdrawn"; reason: PortalWithdrawReason }> {
  requireInternalAccess(ctx, "project.write", "portal_invite");
  const command = parseCommand(portalInviteWithdrawV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      update public.portal_invite
         set status = 'withdrawn',
             withdrawn_by = ${ctx.actor}::uuid,
             withdraw_reason = ${command.reason}::text,
             withdrawn_at = pg_catalog.statement_timestamp()
       where workspace_id = ${command.workspaceId}::uuid
         and id = ${command.inviteId}::uuid
         and status = 'active'
       returning id, project_id, withdraw_reason
    `)).rows;
  } catch {
    throw new PortalPersistenceError();
  }
  // Kein Treffer: nicht vorhanden, fremd, bereits entzogen/abgelaufen —
  // bewusst eine NotFound-Union (kein Orakel, kein Conflict-Leak).
  if (rows.length !== 1) throw new PortalNotFoundError();
  const row = z.strictObject({
    id: uuidSchema,
    project_id: uuidSchema,
    withdraw_reason: z.enum(PORTAL_WITHDRAW_REASON),
  }).safeParse(rows[0]);
  if (!row.success) throw new PortalIntegrityError();
  await recordSuccess(tx, ctx, {
    action: "project.write",
    eventType: "portal.invite_withdrawn",
    projectId: row.data.project_id,
    details: { inviteId: row.data.id, projectId: row.data.project_id, reason: row.data.withdraw_reason },
  });
  return {
    inviteId: row.data.id,
    projectId: row.data.project_id,
    status: "withdrawn",
    reason: row.data.withdraw_reason,
  };
}

export async function getPortalStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<PortalStatusResult> {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "portal_invite", undefined, ctx.actor);
  }
  const command = parseCommand(
    z.strictObject({
      workspaceId: uuidSchema,
      projectId: uuidSchema,
    }),
    value,
  );
  requireSameWorkspace(ctx, command.workspaceId);
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select invite.id, invite.expires_at,
        (select count(*)::integer from public.portal_view_log as view_record
          where view_record.workspace_id = invite.workspace_id
            and view_record.portal_invite_id = invite.id) as view_count
        from public.portal_invite as invite
       where invite.workspace_id = ${command.workspaceId}::uuid
         and invite.project_id = ${command.projectId}::uuid
         and invite.status = 'active'
       limit 1
    `)).rows;
  } catch {
    throw new PortalPersistenceError();
  }
  if (rows.length === 0) return { active: null };
  if (rows.length !== 1) throw new PortalIntegrityError();
  const row = z.strictObject({
    id: uuidSchema,
    expires_at: instantSchema,
    view_count: z.int().safe().min(0),
  }).safeParse(rows[0]);
  if (!row.success) throw new PortalIntegrityError();
  return {
    active: { inviteId: row.data.id, expiresAt: row.data.expires_at, viewCount: row.data.view_count },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Öffentlicher Token-Pfad (rollenlos, bewusst capability-frei). Nimmt einen
// rohen Pool entgegen, da der Aufrufer keinen Mandantenkontext besitzt; die
// Autorisierung ist allein das hoch-entropische Token (SECURITY DEFINER).
// Deformiert/unbekannt/entzogen/abgelaufen -> PortalNotFoundError ohne
// Unterscheidung (kein Orakel).
// ═══════════════════════════════════════════════════════════════════════

async function poolRows(pool: Pool, text: string, values: unknown[]): Promise<unknown[]> {
  try {
    const result = await pool.query(text, values);
    return result.rows;
  } catch {
    throw new PortalPersistenceError();
  }
}

export async function resolvePortalByToken(
  pool: Pool,
  value: unknown,
): Promise<PortalPublicViewV1> {
  const command = parseCommand(z.strictObject({ token: z.string().min(1) }), value);
  const tokenHash = hashPortalToken(command.token);
  if (tokenHash === null) throw new PortalNotFoundError();
  const rows = await poolRows(pool, `select public.resolve_portal_public_view($1::bytea) as result`, [tokenHash]);
  if (rows.length !== 1) throw new PortalIntegrityError();
  const raw = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!raw.success) throw new PortalIntegrityError();
  if (notFoundResultSchema.safeParse(raw.data.result).success) throw new PortalNotFoundError();
  const view = parsePortalPublicView(raw.data.result);
  if (view === null) throw new PortalIntegrityError();
  return view;
}

export type { PortalInviteStatus, PortalWithdrawReason };
export { PORTAL_INVITE_STATUS };
