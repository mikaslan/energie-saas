import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { installation } from "./installation";

// F7-12 Order Parts (Katalog F7.8, erste Hälfte): Nachbestellungen mit
// Message-Thread je Zeile. lineDomainId ist eine Text-Referenz auf eine
// Zeile des gebundenen Varianten-Snapshots (kein FK ins JSON — Existenz
// prüft der Service fail-closed). Fotodoku ist ein eigener Folgeslice.
export const orderPart = pgTable(
  "order_part",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    lineDomainId: text("line_domain_id").notNull(),
    quantityMilli: integer("quantity_milli").notNull(),
    note: text("note"),
    status: text("status").notNull().default("open"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("order_part_ws_id_uq").on(t.workspaceId, t.id),
    index("order_part_ws_installation_idx").on(t.workspaceId, t.installationId, t.status),
    check(
      "order_part_status_ck",
      sql`${t.status} in ('open', 'ordered', 'delivered', 'cancelled')`,
    ),
    check("order_part_quantity_ck", sql`${t.quantityMilli} >= 1000 and ${t.quantityMilli} % 1000 = 0`),
    check("order_part_note_ck", sql`${t.note} is null or (char_length(${t.note}) between 1 and 500)`),
    check("order_part_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "order_part_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.installationId],
      foreignColumns: [installation.workspaceId, installation.id],
      name: "order_part_installation_fk",
    }),
  ],
);

export const orderPartMessage = pgTable(
  "order_part_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    orderPartId: uuid("order_part_id").notNull(),
    authorId: uuid("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("order_part_message_ws_id_uq").on(t.workspaceId, t.id),
    index("order_part_message_ws_part_idx").on(t.workspaceId, t.orderPartId, t.createdAt, t.id),
    check("order_part_message_body_ck", sql`char_length(${t.body}) between 1 and 2000`),
    check("order_part_message_created_ck", sql`pg_catalog.isfinite(${t.createdAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "order_part_message_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.orderPartId],
      foreignColumns: [orderPart.workspaceId, orderPart.id],
      name: "order_part_message_part_fk",
    }),
  ],
);
