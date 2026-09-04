import type { Role } from "./db/schema/core";

export type Capability =
  | "see_purchase_prices" | "edit_prices" | "discounts" | "invoicing"
  | "economics"
  | "convert_phase" | "assign_projects" | "manage_catalog" | "manage_settings"
  | "prepare_offer_documents" | "approve_offer_documents" | "offer_signature"
  | "external_only";

export type Action =
  | "project.read" | "project.write" | "project.assign" | "project.outcome.write"
  | "project.activity.read"
  | "task.read" | "task.write" | "phase.convert"
  | "note.read" | "note.write"
  | "contact.read" | "contact.write"
  | "lead_source.read" | "lead_source.write"
  | "time.read" | "time.write"
  | "checklist.read" | "checklist.write"
  | "appointment.read" | "appointment.write"
  | "invoicing.read" | "invoicing.write" | "invoicing.issuing_details.write"
  | "economics.read" | "economics.write"
  | "price.read_purchase" | "price.edit" | "discount.apply"
  | "invoice.issue" | "offer.release.prepare" | "offer.release.approve"
  | "offer.issue.prepare" | "offer.issue.approve" | "offer.issue.withdraw"
  | "offer.signature.read" | "offer.signature.create"
  | "offer.signature.withdraw" | "offer.signature.upload_analog"
  | "catalog.read" | "catalog.manage" | "settings.manage";

export type PermissionCtx = {
  role: Role;
  capabilities: Partial<Record<Capability, boolean>>;
  featureFlags: Record<string, boolean>;
};

// Der autorisierte Mandantenkontext: PermissionCtx + Workspace + Actor. Wird
// AUSSCHLIESSLICH aus DB-Werten gebaut (lib/db/tenant.ts#withAuthorizedTenant),
// nie vom Aufrufer frei konstruiert — sonst ließe sich die Opfer-Workspace-UUID
// mit einer fremden Adminrolle kombinieren (Codex-Review #2). Kanonischer Ort
// ist diese Datei; modules/sites re-exportiert den Typ nur.
export type ServiceCtx = PermissionCtx & { workspaceId: string; actor: string };

// Ablehnungen ohne konkrete Action (fehlende Membership) laufen unter dieser
// Pseudo-Action — sie ist bewusst KEIN Eintrag in ACTION_REQUIREMENTS.
export const WORKSPACE_ACCESS = "workspace.access" as const;
export type DeniedAction = Action | typeof WORKSPACE_ACCESS;

export class PermissionDeniedError extends Error {
  constructor(
    public readonly action: DeniedAction,
    public readonly resource: string,
    public readonly reason?: string,
    public readonly actor?: string,
  ) {
    super(
      reason
        ? `permission denied: ${action} on ${resource} (${reason})`
        : `permission denied: ${action} on ${resource}`,
    );
    this.name = "PermissionDeniedError";
  }
}

// Schicht 1: Workspace-Feature · Schicht 2: Mindestrolle · Schicht 3: Einzelrecht
export const ACTION_REQUIREMENTS: Record<Action, {
  minRole: Role;
  capability?: Capability;
  feature?: string;
  internalOnly?: true;
}> = {
  "project.read":        { minRole: "viewer" },
  "project.write":       { minRole: "editor" },
  "project.assign":      { minRole: "editor", capability: "assign_projects", internalOnly: true },
  "project.outcome.write": { minRole: "editor", internalOnly: true },
  "project.activity.read": { minRole: "viewer", internalOnly: true },
  "task.read":           { minRole: "viewer", internalOnly: true },
  "task.write":          { minRole: "editor", internalOnly: true },
  "note.read":           { minRole: "viewer", internalOnly: true },
  "note.write":          { minRole: "editor", internalOnly: true },
  "contact.read":        { minRole: "viewer", internalOnly: true },
  "contact.write":       { minRole: "editor", internalOnly: true },
  "lead_source.read":    { minRole: "viewer", internalOnly: true },
  "lead_source.write":   { minRole: "editor", internalOnly: true },
  "time.read":           { minRole: "viewer", internalOnly: true },
  "time.write":          { minRole: "editor", internalOnly: true },
  "checklist.read":      { minRole: "viewer", internalOnly: true },
  "checklist.write":     { minRole: "editor", internalOnly: true },
  "appointment.read":    { minRole: "viewer", internalOnly: true },
  "appointment.write":   { minRole: "editor", internalOnly: true },
  "invoicing.read":      { minRole: "viewer", internalOnly: true },
  "economics.read":      { minRole: "viewer", internalOnly: true },
  "invoicing.write":     { minRole: "editor", capability: "invoicing", internalOnly: true },
  "economics.write":     { minRole: "editor", capability: "economics", internalOnly: true },
  "invoicing.issuing_details.write": { minRole: "editor", capability: "invoicing", internalOnly: true },
  "phase.convert":       { minRole: "editor", capability: "convert_phase" },
  "price.read_purchase": { minRole: "editor", capability: "see_purchase_prices" },
  "price.edit":          { minRole: "editor", capability: "edit_prices" },
  "discount.apply":      { minRole: "editor", capability: "discounts" },
  "invoice.issue":       { minRole: "editor", capability: "invoicing", feature: "invoicing" },
  "offer.release.prepare": { minRole: "editor", capability: "prepare_offer_documents", internalOnly: true },
  "offer.release.approve": { minRole: "editor", capability: "approve_offer_documents", internalOnly: true },
  "offer.issue.prepare": { minRole: "editor", capability: "prepare_offer_documents", internalOnly: true },
  "offer.issue.approve": { minRole: "editor", capability: "approve_offer_documents", internalOnly: true },
  "offer.issue.withdraw": { minRole: "editor", capability: "approve_offer_documents", internalOnly: true },
  "offer.signature.read": { minRole: "viewer", internalOnly: true },
  "offer.signature.create": { minRole: "editor", capability: "offer_signature", internalOnly: true },
  "offer.signature.withdraw": { minRole: "editor", capability: "offer_signature", internalOnly: true },
  "offer.signature.upload_analog": { minRole: "editor", capability: "offer_signature", internalOnly: true },
  "catalog.read":        { minRole: "viewer" },
  "catalog.manage":      { minRole: "editor", capability: "manage_catalog" },
  "settings.manage":     { minRole: "admin" },
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

// Laufzeit-Wahrheit über die erlaubten Rollen. membership.role ist in der DB
// `text` mit CHECK-Constraint (drizzle/0009_membership_role_check.sql); der
// TypeScript-Typ Role ist nur eine Behauptung über jsonb-/text-Werte, die aus
// der DB kommen. Deshalb wird hier ZUSÄTZLICH zur Laufzeit validiert.
const VALID_ROLES: ReadonlySet<string> = new Set<Role>(["viewer", "editor", "admin"]);

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && VALID_ROLES.has(value);
}

// Fail-closed (Codex-Review #22): jede Unklarheit endet in `false`.
//  - unbekannte Rolle ("owner", "", null) → sofort false. Ohne diese explizite
//    Validierung wäre RANK["owner"] === undefined, und `undefined < 1` ist
//    false — der Rollen-Check hätte die Aktion also DURCHGELASSEN.
//  - Capabilities/Feature-Flags kommen aus jsonb und sind zur Laufzeit
//    beliebig ("false", 0, {}). Nur exakt `true` zählt.
export function can(ctx: PermissionCtx, action: Action): boolean {
  const req = ACTION_REQUIREMENTS[action];
  if (!req) return false; // unbekannte Action (Laufzeit-String)
  if (!isRole(ctx.role)) return false;
  if (req.feature && ctx.featureFlags?.[req.feature] !== true) return false;
  if (req.internalOnly && isExternalOnly(ctx)) return false;
  if (RANK[ctx.role] < RANK[req.minRole]) return false;
  if (req.capability && ctx.role !== "admin" && ctx.capabilities?.[req.capability] !== true) return false;
  return true;
}

// `external_only` is a negative security flag: malformed legacy/imported JSON
// must never turn it off. Absence or the literal boolean false means internal;
// every other present value is treated as external until an assignment model
// can authorize a narrower scope.
export function isExternalOnly(ctx: Pick<PermissionCtx, "capabilities">): boolean {
  const capabilities: unknown = ctx.capabilities;
  if (
    capabilities === null
    || typeof capabilities !== "object"
    || Array.isArray(capabilities)
  ) return true;
  return Object.prototype.hasOwnProperty.call(capabilities, "external_only")
    && (capabilities as Record<string, unknown>).external_only !== false;
}
