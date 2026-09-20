import {
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";

// F13-13 §1 Workspace-Stammdatum „Förderservice-Preis" (Cent-Arithmetik,
// Muster F16.3): EIN Satz je Workspace (PK). KEIN DB-Default — ohne
// Zeile gilt der Service-Default 21000 (SUBSIDY_CASE_FEE_DEFAULT_CENTS).
// Die Akte snapshottet den Wert bei Anlage; spätere Stammdaten-Änderungen
// wirken nur auf neue Akten (Altschutz). KEINE Auto-F8-Rechnung.
export const subsidyCaseFeeSetting = pgTable(
  "subsidy_case_fee_setting",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    feeCents: integer("fee_cents").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "subsidy_case_fee_setting_workspace_id_fk",
    }),
    check("subsidy_case_fee_setting_fee_ck", sql`${t.feeCents} >= 0`),
  ],
);
