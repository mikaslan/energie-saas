// F13-03/F13-05 Förderakte: reiner Client-/Server-Vertrag (Statusworte,
// Labels, Programme, Folgezustände, Aktivierungs-Outcome, DTO-Form —
// keine Imports, kein I/O).
// Muster lib/file-request.ts: Sektion (Client) und Service (Server)
// teilen sich diese Datei, ohne die Modul-Barrel mit Server-Code
// (F13-05: portal/service.ts via transition-Nebeneffekt, server-only)
// ins Client-Bundle zu ziehen.
export const subsidyCaseStatuses = [
  "vorbereitung",
  "bza_eingereicht",
  "korrektur",
  "bza_bewilligt",
  "bnd_eingereicht",
  "abgeschlossen",
  "storniert",
] as const;
export type SubsidyCaseStatus = (typeof subsidyCaseStatuses)[number];

export const SUBSIDY_CASE_STATUS_LABEL: Record<SubsidyCaseStatus, string> = {
  vorbereitung: "In Vorbereitung",
  bza_eingereicht: "BzA eingereicht",
  korrektur: "Korrektur",
  bza_bewilligt: "BzA bewilligt",
  bnd_eingereicht: "BnD eingereicht",
  abgeschlossen: "Abgeschlossen",
  storniert: "Storniert",
};

export const subsidyCasePrograms = ["kfw", "bafa", "sonstige"] as const;
export type SubsidyCaseProgram = (typeof subsidyCasePrograms)[number];

export const SUBSIDY_CASE_PROGRAM_LABEL: Record<SubsidyCaseProgram, string> = {
  kfw: "KfW",
  bafa: "BAFA",
  sonstige: "Sonstige",
};

const allowedTransitions: Record<SubsidyCaseStatus, SubsidyCaseStatus[]> = {
  vorbereitung: ["bza_eingereicht", "storniert"],
  bza_eingereicht: ["bza_bewilligt", "korrektur", "storniert"],
  korrektur: ["bza_eingereicht", "bnd_eingereicht", "storniert"],
  bza_bewilligt: ["bnd_eingereicht", "storniert"],
  bnd_eingereicht: ["abgeschlossen", "korrektur", "storniert"],
  abgeschlossen: [],
  storniert: [],
};

export function nextSubsidyCaseStatuses(from: SubsidyCaseStatus): SubsidyCaseStatus[] {
  return allowedTransitions[from];
}

// F13-07: Beleg-Phasen der Akte (vor/nach BnD-Versand; Nachreichung
// bleibt möglich). Reine UI-/Action-Politik, kein Service-Gate.
export const subsidyCaseBelegStates: SubsidyCaseStatus[] = ["bza_bewilligt", "bnd_eingereicht"];

export function isSubsidyCaseBelegState(status: SubsidyCaseStatus): boolean {
  return subsidyCaseBelegStates.includes(status);
}

export function isAllowedSubsidyCaseTransition(from: SubsidyCaseStatus, to: SubsidyCaseStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export type SubsidyCasePortalActivationOutcome =
  | "created"
  | "already_active"
  | "not_permitted"
  | "not_applicable";

export type SubsidyCasePortalActivation = {
  outcome: SubsidyCasePortalActivationOutcome;
  // Nur bei outcome "created" gesetzt: einmaliges Token, nie persistiert.
  token: string | null;
};

// F13-05-Entscheidung, rein und unit-testbar: ein active-Invite zählt nur
// mit künftigem Ablauf als Bestand. Abgelaufene active-Zeilen entstehen
// allein durch Zeitablauf ohne Besuch (der F10-01-Guard verbietet ihren
// Insert und das expires_at-Update) und werden atomar abgelöst statt als
// toter Link gemeldet. Fehlform fail-closed (nie Bestand).
export function isPortalInviteUsable(
  active: { expiresAt: string } | null,
  nowMs: number = Date.now(),
): boolean {
  if (active === null) return false;
  const expiresMs = Date.parse(active.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

export type SubsidyCaseDto = {
  id: string;
  projectId: string;
  status: SubsidyCaseStatus;
  program: SubsidyCaseProgram | null;
  bzaNumber: string | null;
  bzaSubmittedAt: string | null;
  bzaApprovedAt: string | null;
  bndSubmittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
  portalActivation: SubsidyCasePortalActivation;
};
