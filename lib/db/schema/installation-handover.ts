import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { installation } from "./installation";

// F7-14 Abnahme-Historie (Katalog F7.5): append-only Verlauf je
// Abnahme (Wer/Notiz/Zeit). Der Kopf (installation.handover_*)
// bleibt die aktuelle Abnahme; jede recordHandover-Anlage ergänzt
// genau EINE Historienzeile in derselben Transaktion. Kein Update-/
// Delete-Pfad (DSGVO-Schwärzung bleibt Folge-Slice).
export const installationHandover = pgTable(
  "installation_handover",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    byName: text("by_name").notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("installation_handover_ws_id_uq").on(t.workspaceId, t.id),
    index("installation_handover_ws_installation_idx").on(
      t.workspaceId,
      t.installationId,
      t.recordedAt,
      t.id,
    ),
    check(
      "installation_handover_by_name_ck",
      sql`pg_catalog.length(pg_catalog.btrim(${t.byName})) between 1 and 160 and ${t.byName} = pg_catalog.btrim(${t.byName})`,
    ),
    check(
      "installation_handover_note_ck",
      sql`${t.note} is null or (pg_catalog.length(${t.note}) between 1 and 500 and ${t.note} = pg_catalog.btrim(${t.note}))`,
    ),
    check(
      "installation_handover_recorded_ck",
      sql`pg_catalog.isfinite(${t.recordedAt})`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "installation_handover_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.installationId],
      foreignColumns: [installation.workspaceId, installation.id],
      name: "installation_handover_installation_fk",
    }),
  ],
);
