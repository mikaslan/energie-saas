import type { Role } from "./db/schema";

export type Capability =
  | "see_purchase_prices" | "edit_prices" | "discounts" | "invoicing"
  | "convert_phase" | "manage_catalog" | "manage_settings" | "external_only";

export type Action =
  | "project.read" | "project.write" | "phase.convert"
  | "price.read_purchase" | "price.edit" | "discount.apply"
  | "invoice.issue" | "catalog.manage" | "settings.manage";

export type PermissionCtx = {
  role: Role;
  capabilities: Partial<Record<Capability, boolean>>;
  featureFlags: Record<string, boolean>;
};

// Schicht 1: Workspace-Feature · Schicht 2: Mindestrolle · Schicht 3: Einzelrecht
export const ACTION_REQUIREMENTS: Record<Action, { minRole: Role; capability?: Capability; feature?: string }> = {
  "project.read":        { minRole: "viewer" },
  "project.write":       { minRole: "editor" },
  "phase.convert":       { minRole: "editor", capability: "convert_phase" },
  "price.read_purchase": { minRole: "editor", capability: "see_purchase_prices" },
  "price.edit":          { minRole: "editor", capability: "edit_prices" },
  "discount.apply":      { minRole: "editor", capability: "discounts" },
  "invoice.issue":       { minRole: "editor", capability: "invoicing", feature: "invoicing" },
  "catalog.manage":      { minRole: "editor", capability: "manage_catalog" },
  "settings.manage":     { minRole: "admin" },
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function can(ctx: PermissionCtx, action: Action): boolean {
  const req = ACTION_REQUIREMENTS[action];
  if (req.feature && !ctx.featureFlags[req.feature]) return false;
  if (RANK[ctx.role] < RANK[req.minRole]) return false;
  if (req.capability && ctx.role !== "admin" && !ctx.capabilities[req.capability]) return false;
  return true;
}
