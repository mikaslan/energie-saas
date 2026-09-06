import "server-only";

import { sql } from "drizzle-orm";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  PLANNING_MODE_DEFAULT_LOCK_VERSION,
  PLANNING_MODE_DEFAULT,
  WORKSPACE_PLANNING_SETTINGS_VERSION,
  planningModeSchema,
  planningSettingsCommandV1Schema,
  planningSettingsV1Schema,
  type PlanningMode,
  type PlanningSettingsCommandV1,
  type PlanningSettingsV1,
} from "@/lib/integrations/planning/contract";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PlanningSettingsConflictError,
  PlanningSettingsIntegrityError,
  PlanningSettingsValidationError,
} from "./errors";

const RESOURCE = "workspace_planning_settings";

type SettingsRow = {
  revision: number;
  default_planning_mode: string;
  [key: string]: unknown;
};

function requirePlanningRead(ctx: ServiceCtx): void {
  if (!can(ctx, "planning.settings.read")) {
    throw new PermissionDeniedError(
      "planning.settings.read",
      RESOURCE,
      undefined,
      ctx.actor,
    );
  }
}

function requirePlanningWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "settings.manage")) {
    throw new PermissionDeniedError("settings.manage", RESOURCE, undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function settingsDto(
  row: SettingsRow | undefined,
  canWrite: boolean,
): PlanningSettingsV1 {
  const parsed = planningSettingsV1Schema.safeParse({
    schemaVersion: WORKSPACE_PLANNING_SETTINGS_VERSION,
    revision: row === undefined ? 0 : Number(row.revision),
    defaultPlanningMode: row?.default_planning_mode ?? PLANNING_MODE_DEFAULT,
    permissions: { canWrite },
  });
  if (!parsed.success) throw new PlanningSettingsIntegrityError();
  return parsed.data;
}

async function lockPlanningModeDefault(
  tx: TenantTx,
  workspaceId: string,
): Promise<void> {
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${`${PLANNING_MODE_DEFAULT_LOCK_VERSION}:${workspaceId}`},
        0::bigint
      )
    )
  `);
}

async function readSettingsRow(
  tx: TenantTx,
  workspaceId: string,
): Promise<SettingsRow | undefined> {
  const result = await tx.execute<SettingsRow>(sql`
    select revision, default_planning_mode
      from workspace_planning_settings
     where workspace_id = ${workspaceId}::uuid
     limit 1
  `);
  return result.rows[0];
}

export async function getPlanningSettings(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<PlanningSettingsV1> {
  requirePlanningRead(ctx);
  return settingsDto(
    await readSettingsRow(tx, ctx.workspaceId),
    can(ctx, "settings.manage"),
  );
}

/**
 * Offer creation and settings writes take the same transaction-scoped lock.
 * The subsequent SELECT therefore observes the default whose transaction has
 * committed before this variant-creation transaction can continue.
 */
export async function getPlanningModeDefaultForVariantCreation(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<PlanningMode> {
  requirePlanningRead(ctx);
  await lockPlanningModeDefault(tx, ctx.workspaceId);
  const row = await readSettingsRow(tx, ctx.workspaceId);
  if (row === undefined) return PLANNING_MODE_DEFAULT;
  const parsed = planningModeSchema.safeParse(row.default_planning_mode);
  if (!parsed.success) throw new PlanningSettingsIntegrityError();
  return parsed.data;
}

export async function upsertPlanningSettings(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: PlanningSettingsCommandV1,
): Promise<PlanningSettingsV1> {
  requirePlanningWrite(ctx);
  const parsed = planningSettingsCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new PlanningSettingsValidationError();
  const command = parsed.data;

  await lockPlanningModeDefault(tx, ctx.workspaceId);

  if (command.baseRevision === 0) {
    try {
      await tx.execute(sql`
        insert into workspace_planning_settings (
          workspace_id, default_planning_mode, revision, updated_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.defaultPlanningMode}, 1,
          ${ctx.actor}::uuid
        )
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "23505") throw new PlanningSettingsConflictError();
      if (code === "23503" || code === "23514") {
        throw new PlanningSettingsValidationError();
      }
      throw error;
    }
  } else {
    let updated;
    try {
      updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
        update workspace_planning_settings
           set default_planning_mode = ${command.defaultPlanningMode},
               revision = revision + 1,
               updated_by = ${ctx.actor}::uuid,
               updated_at = statement_timestamp()
         where workspace_id = ${ctx.workspaceId}::uuid
           and revision = ${command.baseRevision}
         returning revision
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "23503" || code === "23514") {
        throw new PlanningSettingsValidationError();
      }
      throw error;
    }
    if (updated.rows.length === 0) {
      const current = await readSettingsRow(tx, ctx.workspaceId);
      throw new PlanningSettingsConflictError(current?.revision ?? 0);
    }
  }

  const stored = await readSettingsRow(tx, ctx.workspaceId);
  if (stored === undefined) throw new PlanningSettingsIntegrityError();
  const result = settingsDto(stored, true);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: ctx.workspaceId,
    eventType: "workspace_planning_settings.upserted",
    actor: ctx.actor,
    payload: {
      defaultPlanningMode: result.defaultPlanningMode,
      revision: result.revision,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "settings.manage",
    resource: RESOURCE,
    allowed: true,
    details: {
      baseRevision: command.baseRevision,
      defaultPlanningMode: result.defaultPlanningMode,
      revision: result.revision,
    },
  });

  return result;
}
