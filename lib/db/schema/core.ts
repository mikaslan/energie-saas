import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type Role = "viewer" | "editor" | "admin";

export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  featureFlags: jsonb("feature_flags").$type<Record<string, boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userIdentity = pgTable("user_identity", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(), // E-Mail = unveränderlicher Schlüssel (Blaupause Querschnitt/Auth)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membership = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    userId: uuid("user_id").notNull().references(() => userIdentity.id),
    role: text("role").$type<Role>().notNull().default("viewer"),
    // ~8 Einzelrechte lt. Architektur §5; Bereichs-Toggles/Teams später als ADDITIVE Spalten
    capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("membership_ws_user_uq").on(t.workspaceId, t.userId)],
);
