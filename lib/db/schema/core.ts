import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type Role = "viewer" | "editor" | "admin";

export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  featureFlags: jsonb("feature_flags").$type<Record<string, boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userIdentity = pgTable(
  "user_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // E-Mail = unveränderlicher Schlüssel (Blaupause Querschnitt/Auth).
    // Eindeutig KANONISCH über lower(email) statt case-sensitiv (Codex-Review
    // #18): better-auth normalisiert E-Mails auf Kleinschreibung, ein Invite
    // für "Alice@Example.com" und der Login als "alice@example.com" hätten
    // sonst zwei getrennte Identitäten erzeugt.
    email: text("email").notNull(),
    // Kopplung an die better-auth-Identität (Codex-Review #17a). NULL, solange
    // eine Identität nur eingeladen, aber noch nie eingeloggt war; wird vom
    // Auth-Hook (lib/auth.ts) beim ersten Login nachgetragen. UNIQUE, damit
    // ein auth_user nie an zwei Identitäten hängt.
    authUserId: text("auth_user_id").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_identity_email_lower_uq").on(sql`lower(${t.email})`)],
);

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
  (t) => [
    uniqueIndex("membership_ws_user_uq").on(t.workspaceId, t.userId),
    // Normale Tenant-Entität: M1 referenziert Memberships für Zuweisungen
    // und Sichtbarkeit. Dafür braucht auch membership das tenantgebundene
    // FK-Ziel, nicht nur den fachlichen workspace/user-Schlüssel.
    uniqueIndex("membership_ws_id_uq").on(t.workspaceId, t.id),
  ],
);
