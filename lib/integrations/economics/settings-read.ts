/**
 * F4.5b Workspace-Settings-Read ohne `server-only`-Marker: reines SQL fuer
 * die Confirm-Kette (modules/energy/service laeuft auch unter tsx/E2E,
 * wo das Markerpaket absichtlich wirft). Die Berechtigung prueft der
 * Aufrufer explizit (economics.read steht jeder Rolle ab Viewer zu).
 */
import { sql } from "drizzle-orm";

import type { TenantTx } from "@/lib/db/types";

export type WorkspaceEconomicsRow = {
  revision: number;
  electricityPriceNetCentsPerKwh: number | null;
  escalationRateBps: number | null;
  cashflowHorizonYears: number;
};

type SettingsRow = {
  revision: string | number;
  electricity_price_net_cents_per_kwh: string | number | null;
  escalation_rate_bps: string | number | null;
  cashflow_horizon_years: string | number;
};

export async function readWorkspaceEconomicsRow(
  tx: TenantTx,
  workspaceId: string,
): Promise<WorkspaceEconomicsRow | null> {
  const result = await tx.execute<SettingsRow>(sql`
    select revision, electricity_price_net_cents_per_kwh, escalation_rate_bps,
           cashflow_horizon_years
      from workspace_economics_settings
     where workspace_id = ${workspaceId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  const price = row.electricity_price_net_cents_per_kwh;
  const escalation = row.escalation_rate_bps;
  return {
    revision: Number(row.revision),
    electricityPriceNetCentsPerKwh: price === null ? null : Number(price),
    escalationRateBps: escalation === null ? null : Number(escalation),
    cashflowHorizonYears: Number(row.cashflow_horizon_years),
  };
}
