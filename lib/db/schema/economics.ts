import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";

// F4.6 Workspace-Simulationsdefaults (Modulkatalog F4.6): Singleton je
// Workspace mit CAS-Revision (M3-00-Klon-Vertrag, ADR 0024-Muster).
// Preisfelder starten leer (UNK-F4-03: keine erfundenen Zahlen) —
// „leere Felder → Länderreferenz" ist nullable-Semantik + DTO-Marker.
export const workspaceEconomicsSettings = pgTable(
  "workspace_economics_settings",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").primaryKey(),
    electricityPriceNetCentsPerKwh: bigint("electricity_price_net_cents_per_kwh", {
      mode: "number",
    }),
    escalationRateBps: integer("escalation_rate_bps"),
    oilPriceNetCentsPerLiter: bigint("oil_price_net_cents_per_liter", {
      mode: "number",
    }),
    gasPriceNetCentsPerKwh: bigint("gas_price_net_cents_per_kwh", {
      mode: "number",
    }),
    cashflowHorizonYears: integer("cashflow_horizon_years").notNull().default(20),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workspace_economics_settings_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "workspace_economics_settings_workspace_id_fk",
    }),
    check(
      "workspace_economics_settings_prices_ck",
      sql`(${t.electricityPriceNetCentsPerKwh} is null
           or ${t.electricityPriceNetCentsPerKwh} between 0 and 1000000)
         and (${t.oilPriceNetCentsPerLiter} is null
           or ${t.oilPriceNetCentsPerLiter} between 0 and 1000000)
         and (${t.gasPriceNetCentsPerKwh} is null
           or ${t.gasPriceNetCentsPerKwh} between 0 and 1000000)`,
    ),
    check(
      "workspace_economics_settings_escalation_ck",
      sql`${t.escalationRateBps} is null or ${t.escalationRateBps} between 0 and 2000`,
    ),
    check(
      "workspace_economics_settings_horizon_ck",
      sql`${t.cashflowHorizonYears} between 1 and 50`,
    ),
    check(
      "workspace_economics_settings_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "workspace_economics_settings_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
        and isfinite(${t.createdAt})
        and isfinite(${t.updatedAt})`,
    ),
  ],
);
