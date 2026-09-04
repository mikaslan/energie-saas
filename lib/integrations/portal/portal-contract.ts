import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const PORTAL_INVITE_CREATE_VERSION = "portal-invite-create.v1" as const;
export const PORTAL_INVITE_WITHDRAW_VERSION = "portal-invite-withdraw.v1" as const;
export const PORTAL_PUBLIC_VIEW_VERSION = "portal-public-view.v1" as const;

export const PORTAL_TTL_DAYS_MIN = 1;
export const PORTAL_TTL_DAYS_MAX = 60;
export const PORTAL_TTL_DAYS_DEFAULT = 14;

export const PORTAL_INVITE_STATUS = ["active", "withdrawn", "expired"] as const;

export const PORTAL_WITHDRAW_REASON = [
  "user_request",
  "superseded",
  "project_closed",
  "other",
] as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const ttlDaysSchema = z.int().safe().min(PORTAL_TTL_DAYS_MIN).max(PORTAL_TTL_DAYS_MAX);

export const portalInviteCreateV1Schema = z.strictObject({
  schemaVersion: z.literal(PORTAL_INVITE_CREATE_VERSION),
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  ttlDays: ttlDaysSchema,
});

export type PortalInviteCreateV1 = z.infer<typeof portalInviteCreateV1Schema>;

export const portalInviteWithdrawV1Schema = z.strictObject({
  schemaVersion: z.literal(PORTAL_INVITE_WITHDRAW_VERSION),
  workspaceId: uuidSchema,
  inviteId: uuidSchema,
  reason: z.enum(PORTAL_WITHDRAW_REASON),
});

export type PortalInviteWithdrawV1 = z.infer<typeof portalInviteWithdrawV1Schema>;

export type PortalInviteStatus = (typeof PORTAL_INVITE_STATUS)[number];
export type PortalWithdrawReason = (typeof PORTAL_WITHDRAW_REASON)[number];

// Token: 32 Byte hoch-entropisch (base64url); in der DB liegt ausschließlich
// unsalted SHA-256(raw) — O(1)-Lookup, kein Salt noetig (Spiegel M2-04).
export function generatePortalToken(): {
  token: string;
  tokenHash: Buffer;
} {
  const raw = randomBytes(32);
  return {
    token: raw.toString("base64url"),
    tokenHash: createHash("sha256").update(raw).digest(),
  };
}

// Deformiertes Token (kein base64url oder dekodiert != 32 Byte) -> null.
// Der Aufrufer mappt null auf die not_found-Union (kein Throw, kein Orakel;
// schliesst den M2-04-TODO fuer den Portal-Pfad von Tag 1).
export function hashPortalToken(token: string): Buffer | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(token, "base64url");
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  // Re-Encode-Roundtrip: verwirft Nicht-Kanonisches (z.B. falsches Padding).
  if (raw.toString("base64url") !== token) return null;
  return createHash("sha256").update(raw).digest();
}

export const PORTAL_PHASE_NEXT_STEP: Record<string, string> = {
  request: "Anfrage in Prüfung",
  offer: "Angebot liegt vor",
  installation: "Installation läuft",
};

// Abgeleiteter Next-Step-Text (rein darstellend, nicht gespeichert):
// Outcome schlaegt Phase (won/lost/cannot_fulfil sind terminal).
export function derivePortalNextStep(phase: string, outcome: string): string {
  if (outcome === "won") return "Auftrag bestätigt";
  if (outcome === "lost") return "Vorgang abgeschlossen";
  if (outcome === "cannot_fulfill") return "Vorgang abgeschlossen";
  return PORTAL_PHASE_NEXT_STEP[phase] ?? "Stand in Klärung";
}

const portalDocumentSchema = z.strictObject({
  id: z.uuid(),
  offerNumber: z.string(),
  documentDate: z.string(),
  issuedAt: z.iso.datetime({ offset: true }),
});

const portalProjectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  phase: z.string(),
  outcome: z.string(),
});

export const portalPublicViewV1Schema = z.strictObject({
  schemaVersion: z.literal(PORTAL_PUBLIC_VIEW_VERSION),
  inviteId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  viewCount: z.int().safe().min(0),
  project: portalProjectSchema,
  documents: z.array(portalDocumentSchema),
});

export type PortalPublicViewV1 = z.infer<typeof portalPublicViewV1Schema>;

const portalResolveOkSchema = z.strictObject({
  status: z.literal("ok"),
  inviteId: z.uuid(),
  expiresAt: z.unknown(),
  viewCount: z.unknown(),
  project: z.strictObject({
    id: z.uuid(),
    name: z.string(),
    phase: z.string(),
    outcome: z.string(),
  }),
  documents: z.array(z.strictObject({
    id: z.uuid(),
    offerNumber: z.string(),
    documentDate: z.string(),
    issuedAt: z.unknown(),
  })),
});

// Parst das DEFINER-Resultat; 'not_found' (unbekannt/deformiert/entzogen/
// abgelaufen) -> null ohne Unterscheidung (kein Orakel).
export function parsePortalPublicView(value: unknown): PortalPublicViewV1 | null {
  if (
    typeof value !== "object" || value === null
    || (value as { status?: unknown }).status !== "ok"
  ) return null;
  const parsed = portalResolveOkSchema.safeParse(value);
  if (!parsed.success) return null;
  const toInstant = (raw: unknown): string | null => {
    if (typeof raw === "string") {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
      return null;
    }
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString();
    return null;
  };
  const expiresAt = toInstant(parsed.data.expiresAt);
  if (expiresAt === null) return null;
  const viewCount = typeof parsed.data.viewCount === "number"
    && Number.isInteger(parsed.data.viewCount) && parsed.data.viewCount >= 0
    ? parsed.data.viewCount
    : null;
  if (viewCount === null) return null;
  const documents: PortalPublicViewV1["documents"] = [];
  for (const doc of parsed.data.documents) {
    const issuedAt = toInstant(doc.issuedAt);
    if (issuedAt === null) return null;
    documents.push({
      id: doc.id, offerNumber: doc.offerNumber,
      documentDate: doc.documentDate, issuedAt,
    });
  }
  return {
    schemaVersion: PORTAL_PUBLIC_VIEW_VERSION,
    inviteId: parsed.data.inviteId,
    expiresAt,
    viewCount,
    project: parsed.data.project,
    documents,
  };
}
