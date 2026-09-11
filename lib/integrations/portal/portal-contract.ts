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

// F10.2 Slice B: Signatur-Status je Dokument (read-only, wörtlich aus
// signature_request; 'none' ohne Zeile; NIE signer_name/Token/Grund).
const portalSignatureStatusSchema = z.enum([
  "none",
  "pending",
  "signed",
  "expired",
  "withdrawn",
  "revoked_by_customer",
]);

const portalDocumentSchema = z.strictObject({
  id: z.uuid(),
  offerNumber: z.string(),
  documentDate: z.string(),
  issuedAt: z.iso.datetime({ offset: true }),
  signatureStatus: portalSignatureStatusSchema,
  signedAt: z.iso.datetime({ offset: true }).nullable(),
});

const portalProjectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  phase: z.string(),
  outcome: z.string(),
  // F10-03c: Bereich des Projekt-Boards (0098). Katalog F10.3: kein
  // Preis-/Signatur-Bereich im Commercial-Portal.
  scope: z.enum(["residential", "commercial"]),
});
export type PortalProjectScope = z.infer<typeof portalProjectSchema>["scope"];

// F10.2 Slice A: Projektermine ohne Freitext-Beschreibung (Privacy:
// description ist intern und wird nie projiziert).
const portalAppointmentSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  allDay: z.boolean(),
  appointmentType: z.string(),
  location: z.string().nullable(),
});
export type PortalAppointment = z.infer<typeof portalAppointmentSchema>;

// F10-04: Datei-Anfragen (nur Titel/Beschreibung/Stand/Zeiten/eigener
// Dateiname — nie Storage-Key/Prüfsumme/Größe; rein interne Belegdaten).
export const portalFileRequestSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(["offen", "hochgeladen"]),
  createdAt: z.iso.datetime({ offset: true }),
  uploadedAt: z.iso.datetime({ offset: true }).nullable(),
  originalFilename: z.string().nullable(),
});
export type PortalFileRequest = z.infer<typeof portalFileRequestSchema>;

// F10-03: Installationsstand (nur Stand + Daten, nie Namen/Notizen).
export const portalInstallationTimelineEntrySchema = z.strictObject({
  type: z.enum(["created", "completed", "handover_recorded"]),
  at: z.iso.datetime({ offset: true }),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});
export type PortalInstallationTimelineEntry = z.infer<typeof portalInstallationTimelineEntrySchema>;

const portalInstallationSchema = z.strictObject({
  status: z.enum(["active", "completed"]),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  handoverAt: z.iso.datetime({ offset: true }).nullable(),
  // F10-03b Status-Timeline (nur Allowlist-Typen, nie Payloads/Akteure).
  timeline: z.array(portalInstallationTimelineEntrySchema),
});
export type PortalInstallation = z.infer<typeof portalInstallationSchema>;

// F13-04: Förderstand (nur Stand/Programm/Phasen-Daten — nie
// BzA-Nummer/interne Akteure).
export const portalSubsidySchema = z.strictObject({
  status: z.enum([
    "vorbereitung",
    "bza_eingereicht",
    "korrektur",
    "bza_bewilligt",
    "bnd_eingereicht",
    "abgeschlossen",
    "storniert",
  ]),
  program: z.enum(["kfw", "bafa", "sonstige"]).nullable(),
  bzaSubmittedAt: z.iso.datetime({ offset: true }).nullable(),
  bzaApprovedAt: z.iso.datetime({ offset: true }).nullable(),
  bndSubmittedAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PortalSubsidy = z.infer<typeof portalSubsidySchema>;

export const portalPublicViewV1Schema = z.strictObject({
  schemaVersion: z.literal(PORTAL_PUBLIC_VIEW_VERSION),
  inviteId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  viewCount: z.int().safe().min(0),
  project: portalProjectSchema,
  documents: z.array(portalDocumentSchema),
  appointments: z.array(portalAppointmentSchema),
  installation: portalInstallationSchema.nullable(),
  fileRequests: z.array(portalFileRequestSchema),
  subsidy: portalSubsidySchema.nullable(),
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
    // F10-03c: wie portalProjectSchema (strikter Resolver-Parse).
    scope: z.enum(["residential", "commercial"]),
  }),
  documents: z.array(z.strictObject({
    id: z.uuid(),
    offerNumber: z.string(),
    documentDate: z.string(),
    issuedAt: z.unknown(),
    signatureStatus: z.unknown(),
    signedAt: z.unknown(),
  })),
  appointments: z.array(z.strictObject({
    id: z.uuid(),
    title: z.string(),
    startAt: z.unknown(),
    endAt: z.unknown(),
    allDay: z.unknown(),
    appointmentType: z.string(),
    location: z.unknown(),
  })),
  // F10-03: optional — alte Projektionen ohne Schlüssel parsen wie null.
  installation: z.unknown().optional(),
  // F10-04: optional — alte Projektionen ohne Schlüssel parsen wie leer.
  fileRequests: z.unknown().optional(),
  // F13-04: optional — alte Projektionen ohne Schlüssel parsen wie null.
  subsidy: z.unknown().optional(),
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
    // F10.2 Slice B: Status wörtlich (keine Übergänge erfunden);
    // signedAt null außer bei gesetztem Zeitstempel.
    if (typeof doc.signatureStatus !== "string") return null;
    const signatureStatus = portalSignatureStatusSchema.safeParse(doc.signatureStatus);
    if (!signatureStatus.success) return null;
    const signedAt = doc.signedAt === null ? null : toInstant(doc.signedAt);
    if (doc.signedAt !== null && signedAt === null) return null;
    documents.push({
      id: doc.id, offerNumber: doc.offerNumber,
      documentDate: doc.documentDate, issuedAt,
      signatureStatus: signatureStatus.data, signedAt,
    });
  }
  // F10.2 Slice A: Termine mit strikter Typprüfung (allDay/location wie
  // DEFINER: boolean / text-or-null, keine Description je).
  const appointments: PortalPublicViewV1["appointments"] = [];
  for (const appointment of parsed.data.appointments) {
    const startAt = toInstant(appointment.startAt);
    const endAt = toInstant(appointment.endAt);
    if (startAt === null || endAt === null) return null;
    if (typeof appointment.allDay !== "boolean") return null;
    if (appointment.location !== null && typeof appointment.location !== "string") return null;
    appointments.push({
      id: appointment.id,
      title: appointment.title,
      startAt,
      endAt,
      allDay: appointment.allDay,
      appointmentType: appointment.appointmentType,
      location: appointment.location,
    });
  }
  // F10-03: Installation null ohne Zeile; sonst strikter Stand
  // (Status-Wortschatz + Zeitstempel, keine Namen/Notizen je).
  let installation: PortalPublicViewV1["installation"] = null;
  // undefined = altes Projektionsformat ohne Schlüssel (wie null).
  if (parsed.data.installation !== null && parsed.data.installation !== undefined) {
    const raw = parsed.data.installation;
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    // Nur der DEFINER-Wortschatz; fremde Schlüssel = deformiert.
    for (const key of Object.keys(record)) {
      if (key !== "status" && key !== "completedAt" && key !== "handoverAt" && key !== "timeline") {
        return null;
      }
    }
    const status = portalInstallationSchema.shape.status.safeParse(record.status);
    if (!status.success) return null;
    const completedAt = record.completedAt === null ? null : toInstant(record.completedAt);
    if (record.completedAt !== null && completedAt === null) return null;
    const handoverAt = record.handoverAt === null ? null : toInstant(record.handoverAt);
    if (record.handoverAt !== null && handoverAt === null) return null;
    // Fehlend = Alt-Projektion (F10-03-undefined-Präzedenz) → ehrlich leer.
    const timeline = record.timeline === undefined
      ? []
      : portalInstallationSchema.shape.timeline.safeParse(record.timeline).success
        ? (record.timeline as PortalInstallationTimelineEntry[])
        : null;
    if (timeline === null) return null;
    installation = { status: status.data, completedAt, handoverAt, timeline };
  }
  // F10-03c: Katalog F10.3 — kein Preis-/Signatur-Bereich im
  // Commercial-Portal. Strip nach striktem Parse (deformierte Dokumente
  // brechen weiter fail-closed ab, auch bei scope commercial).
  const commercialScope = parsed.data.project.scope === "commercial";
  // F10-04: Datei-Anfragen — strikter Stand-Wortschatz, Zeiten wie oben;
  // fehlend = Alt-Projektion (F10-03-undefined-Präzedenz) → ehrlich leer.
  const fileRequests: PortalPublicViewV1["fileRequests"] = [];
  if (parsed.data.fileRequests !== undefined) {
    const raw = parsed.data.fileRequests;
    if (!Array.isArray(raw)) return null;
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) return null;
      const record = entry as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (
          key !== "id" && key !== "title" && key !== "description" &&
          key !== "status" && key !== "createdAt" && key !== "uploadedAt" &&
          key !== "originalFilename"
        ) {
          return null;
        }
      }
      const id = typeof record.id === "string" ? record.id : null;
      const title = typeof record.title === "string" ? record.title : null;
      if (id === null || title === null) return null;
      if (typeof record.description !== "string" && record.description !== null) return null;
      const status = portalFileRequestSchema.shape.status.safeParse(record.status);
      if (!status.success) return null;
      const createdAt = toInstant(record.createdAt);
      if (createdAt === null) return null;
      const uploadedAt = record.uploadedAt === null ? null : toInstant(record.uploadedAt);
      if (record.uploadedAt !== null && uploadedAt === null) return null;
      if (typeof record.originalFilename !== "string" && record.originalFilename !== null) return null;
      fileRequests.push({
        id,
        title,
        description: record.description as string | null,
        status: status.data,
        createdAt,
        uploadedAt,
        originalFilename: record.originalFilename as string | null,
      });
    }
  }
  // F13-04: Förderstand — Allowlist wie Installation (F10-03-Muster);
  // fehlend = Alt-Projektion → ehrlich null.
  let subsidy: PortalPublicViewV1["subsidy"] = null;
  if (parsed.data.subsidy !== undefined && parsed.data.subsidy !== null) {
    const raw = parsed.data.subsidy;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (
        key !== "status" && key !== "program" &&
        key !== "bzaSubmittedAt" && key !== "bzaApprovedAt" &&
        key !== "bndSubmittedAt" && key !== "completedAt"
      ) {
        return null;
      }
    }
    const status = portalSubsidySchema.shape.status.safeParse(record.status);
    if (!status.success) return null;
    if (record.program !== null) {
      const program = portalSubsidySchema.shape.program.safeParse(record.program);
      if (!program.success) return null;
    }
    const stamps: Record<string, string | null> = {};
    for (const key of ["bzaSubmittedAt", "bzaApprovedAt", "bndSubmittedAt", "completedAt"]) {
      const value = record[key];
      if (value === null) {
        stamps[key] = null;
        continue;
      }
      const instant = toInstant(value);
      if (instant === null) return null;
      stamps[key] = instant;
    }
    subsidy = {
      status: status.data,
      program: record.program as PortalSubsidy["program"],
      bzaSubmittedAt: stamps.bzaSubmittedAt,
      bzaApprovedAt: stamps.bzaApprovedAt,
      bndSubmittedAt: stamps.bndSubmittedAt,
      completedAt: stamps.completedAt,
    };
  }
  return {
    schemaVersion: PORTAL_PUBLIC_VIEW_VERSION,
    inviteId: parsed.data.inviteId,
    expiresAt,
    viewCount,
    project: parsed.data.project,
    documents: commercialScope ? [] : documents,
    appointments,
    installation,
    fileRequests,
    subsidy,
  };
}
