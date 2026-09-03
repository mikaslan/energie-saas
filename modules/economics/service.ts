import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  CASHFLOW_HORIZON_DEFAULT_YEARS,
  WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
  WORKSPACE_ECONOMICS_SETTINGS_VERSION,
  economicsSettingsCommandV1Schema,
  economicsSettingsV1Schema,
  type EconomicsSettingsCommandV1,
  type EconomicsSettingsV1,
} from "@/lib/integrations/economics/contract";
import {
  EconomicsConflictError,
  EconomicsNotFoundError,
  EconomicsValidationError,
} from "./errors";

function requireEconomicsRead(ctx: ServiceCtx): void {
  if (!can(ctx, "economics.read")) {
    throw new PermissionDeniedError("economics.read", "workspace_economics_settings", undefined, ctx.actor);
  }
}

function requireEconomicsWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "economics.write")) {
    throw new PermissionDeniedError("economics.write", "workspace_economics_settings", undefined, ctx.actor);
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

type SettingsRow = {
  revision: number;
  electricity_price_net_cents_per_kwh: number | null;
  escalation_rate_bps: number | null;
  oil_price_net_cents_per_liter: number | null;
  gas_price_net_cents_per_kwh: number | null;
  cashflow_horizon_years: number;
  [key: string]: unknown;
};

function toDto(row: SettingsRow | undefined, canWrite: boolean): EconomicsSettingsV1 {
  const revision = row?.revision ?? 0;
  const electricity = row?.electricity_price_net_cents_per_kwh ?? null;
  const escalation = row?.escalation_rate_bps ?? null;
  const oil = row?.oil_price_net_cents_per_liter ?? null;
  const gas = row?.gas_price_net_cents_per_kwh ?? null;
  return economicsSettingsV1Schema.parse({
    schemaVersion: WORKSPACE_ECONOMICS_SETTINGS_VERSION,
    revision,
    electricityPriceNetCentsPerKwh: electricity === null ? null : Number(electricity),
    escalationRateBps: escalation === null ? null : Number(escalation),
    oilPriceNetCentsPerLiter: oil === null ? null : Number(oil),
    gasPriceNetCentsPerKwh: gas === null ? null : Number(gas),
    cashflowHorizonYears: row?.cashflow_horizon_years ?? CASHFLOW_HORIZON_DEFAULT_YEARS,
    hasAnyDefaults: electricity !== null || escalation !== null || oil !== null || gas !== null,
    permissions: { canWrite },
  });
}

// Read-Semantik (Kimi-P1-1): keine Zeile → DTO mit revision 0, alle
// nullable Felder null, hasAnyDefaults false — KEIN not_found.
export async function getEconomicsSettings(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<EconomicsSettingsV1> {
  requireEconomicsRead(ctx);
  const result = await tx.execute<SettingsRow>(sql`
    select revision, electricity_price_net_cents_per_kwh, escalation_rate_bps,
           oil_price_net_cents_per_liter, gas_price_net_cents_per_kwh,
           cashflow_horizon_years
      from workspace_economics_settings
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  return toDto(result.rows[0], can(ctx, "economics.write"));
}

export async function upsertEconomicsSettings(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: EconomicsSettingsCommandV1,
): Promise<EconomicsSettingsV1> {
  requireEconomicsWrite(ctx);
  const parsed = economicsSettingsCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new EconomicsValidationError();
  const command = parsed.data;
  const values = command.input;

  if (command.baseRevision === 0) {
    try {
      await tx.execute(sql`
        insert into workspace_economics_settings (
          id, workspace_id, electricity_price_net_cents_per_kwh,
          escalation_rate_bps, oil_price_net_cents_per_liter,
          gas_price_net_cents_per_kwh, cashflow_horizon_years,
          revision, created_by
        ) values (
          ${randomUUID()}::uuid, ${ctx.workspaceId}::uuid,
          ${values.electricityPriceNetCentsPerKwh},
          ${values.escalationRateBps},
          ${values.oilPriceNetCentsPerLiter},
          ${values.gasPriceNetCentsPerKwh},
          ${values.cashflowHorizonYears},
          1, ${ctx.actor}::uuid
        )
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "23505") throw new EconomicsConflictError();
      if (code === "23514") throw new EconomicsValidationError();
      throw error;
    }
  } else {
    const updated = await tx.execute(sql`
      update workspace_economics_settings
         set electricity_price_net_cents_per_kwh = ${values.electricityPriceNetCentsPerKwh},
             escalation_rate_bps = ${values.escalationRateBps},
             oil_price_net_cents_per_liter = ${values.oilPriceNetCentsPerLiter},
             gas_price_net_cents_per_kwh = ${values.gasPriceNetCentsPerKwh},
             cashflow_horizon_years = ${values.cashflowHorizonYears},
             revision = revision + 1,
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and revision = ${command.baseRevision}
       returning id
    `);
    if (updated.rows.length === 0) {
      const current = await tx.execute<{ revision: number }>(sql`
        select revision from workspace_economics_settings
         where workspace_id = ${ctx.workspaceId}::uuid
         limit 1
      `);
      if (!current.rows[0]) throw new EconomicsNotFoundError();
      throw new EconomicsConflictError(Number(current.rows[0].revision));
    }
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "workspace_economics_settings",
    aggregateId: ctx.workspaceId,
    eventType: "workspace_economics_settings.upserted",
    actor: ctx.actor,
    payload: {
      electricityPriceNetCentsPerKwh: values.electricityPriceNetCentsPerKwh,
      escalationRateBps: values.escalationRateBps,
      oilPriceNetCentsPerLiter: values.oilPriceNetCentsPerLiter,
      gasPriceNetCentsPerKwh: values.gasPriceNetCentsPerKwh,
      cashflowHorizonYears: values.cashflowHorizonYears,
    },
  });
  // Kimi-P2-1: eigener Audit-Namespace — kein invoicing.*-Event.
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "economics.settings.write",
    resource: "workspace_economics_settings",
    allowed: true,
    details: {
      baseRevision: command.baseRevision,
      cashflowHorizonYears: values.cashflowHorizonYears,
    },
  });

  const result = await tx.execute<SettingsRow>(sql`
    select revision, electricity_price_net_cents_per_kwh, escalation_rate_bps,
           oil_price_net_cents_per_liter, gas_price_net_cents_per_kwh,
           cashflow_horizon_years
      from workspace_economics_settings
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  if (!result.rows[0]) throw new EconomicsNotFoundError();
  return toDto(result.rows[0], true);
}
