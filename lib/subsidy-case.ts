// F13-03/F13-05 Förderakte: reiner Client-/Server-Vertrag (Statusworte,
// Labels, Programme, Folgezustände, Aktivierungs-Outcome, DTO-Form —
// keine Imports, kein I/O).
// Muster lib/file-request.ts: Sektion (Client) und Service (Server)
// teilen sich diese Datei, ohne die Modul-Barrel mit Server-Code
// (F13-05: portal/service.ts via transition-Nebeneffekt, server-only)
// ins Client-Bundle zu ziehen.
export const subsidyCaseStatuses = [
  "draft",
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
  draft: "Entwurf",
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
  // F13-00 §1: jede Akte startet als Entwurf (vorbefüllt, unversandt,
  // unsichtbar für Externe); Einreichung in die Vorbereitung ist die
  // erste Transition (Submit-Freeze ab dort, §2).
  draft: ["vorbereitung", "storniert"],
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

// F13-00 §2 Submit-Freeze: Feld-Edits (set*Details) nur im Entwurf
// und im Korrektur-Pendant der jeweiligen Maschine (Förderakte:
// korrektur); nach Submit transition-only. Jede Änderung nach Freeze
// nur als Transition mit Pflicht-Event + Audit.
export const FILING_EDITABLE_SUBSIDY_STATUSES: SubsidyCaseStatus[] = [
  "draft",
  "korrektur",
];

export function canEditFilingDetails(status: SubsidyCaseStatus): boolean {
  return FILING_EDITABLE_SUBSIDY_STATUSES.includes(status);
}

// F13-00 §6 Übergangs-Events: `.transition` löst `.status_changed`
// ab (Naming-Doktrin); Payload `{from, to, caseId?}` (+ Portal-Outcome
// wo zutreffend). Details-Politik: nur IDs + Status, kein Kundenkontext.
export const SUBSIDY_CASE_TRANSITION_EVENT = "subsidy_case.transition" as const;

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

// F13-08 Programm-Vorschlag (ESTIMATE, reversibel): deterministische,
// versionierte Heuristik über Rechner-Signalen — KEINE Förderzusage,
// KEIN Ersatz für KfW/BAFA-Regelwerke (Mandat: Live-Regeln nie erfinden).
// Der Vorschlag begründet sich aus belegten Snapshot-Feldern; der Nutzer
// bestätigt das Programm manuell (setSubsidyCaseDetails). Ohne verwertbare
// Signale ehrlich no_basis statt geratenem Programm.
export const SUBSIDY_SUGGEST_RULES_VERSION = "f13-08-suggest.v1" as const;

export type SubsidyProgramSuggestionSignals = {
  branch: "new_installation" | "existing_installation" | null;
  answeredFieldIds: string[];
  requestedProducts: {
    targetStorageKwh: number;
    wallbox: boolean;
    bidirectionalCharging: boolean;
    backupPower: boolean;
  } | null;
};

export type SubsidyProgramSuggestion =
  | {
      outcome: "suggested";
      program: SubsidyCaseProgram;
      reasons: string[];
      rulesVersion: typeof SUBSIDY_SUGGEST_RULES_VERSION;
    }
  | {
      outcome: "no_basis";
      program: null;
      reasons: string[];
      rulesVersion: typeof SUBSIDY_SUGGEST_RULES_VERSION;
    };

export function suggestSubsidyProgram(signals: SubsidyProgramSuggestionSignals): SubsidyProgramSuggestion {
  const reasons: string[] = [];
  const answered = new Set(
    (Array.isArray(signals.answeredFieldIds) ? signals.answeredFieldIds : []).filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const products = signals.requestedProducts;
  if (products !== null) {
    if (products.wallbox || products.bidirectionalCharging) {
      reasons.push("Wallbox-Ladewunsch im Rechner angegeben");
    }
    if (Number.isFinite(products.targetStorageKwh) && products.targetStorageKwh > 0) {
      reasons.push("Speicherwunsch im Rechner angegeben");
    }
  }
  // R-WP: explizites Wärmepumpen-Signal schlägt den Anlagenkontext —
  // Heizungstausch läuft in der Heuristik über BAFA.
  if (answered.has("waermepumpe")) {
    return {
      outcome: "suggested",
      program: "bafa",
      reasons: ["Wärmepumpe im Rechner-Fragebogen angegeben", ...reasons],
      rulesVersion: SUBSIDY_SUGGEST_RULES_VERSION,
    };
  }
  if (signals.branch === "existing_installation") {
    return {
      outcome: "suggested",
      program: "bafa",
      reasons: ["Bestandsanlage im Rechner angegeben (Sanierungskontext prüfen)", ...reasons],
      rulesVersion: SUBSIDY_SUGGEST_RULES_VERSION,
    };
  }
  if (signals.branch === "new_installation") {
    return {
      outcome: "suggested",
      program: "kfw",
      reasons: ["Neuanlage im Rechner angegeben (KfW-Programm prüfen)", ...reasons],
      rulesVersion: SUBSIDY_SUGGEST_RULES_VERSION,
    };
  }
  return {
    outcome: "no_basis",
    program: null,
    reasons:
      reasons.length > 0
        ? [...reasons, "kein verwertbarer Anlagenkontext (neu/Bestand unbekannt)"]
        : ["keine auswertbaren Rechner-Angaben"],
    rulesVersion: SUBSIDY_SUGGEST_RULES_VERSION,
  };
}

// F13-13 Förder-Fristen-Preis (Katalog F13.2-Rest): Stammdatum-Preis
// (Cent-Arithmetik, Muster F16.3), AT-Fristen, Überfällig-/Vorab-Badges,
// Typenschild-Foto-Slot. Rein (keine Imports, kein I/O) — Sektion und
// Service teilen sich diese Datei wie bei F13-03/F13-05.
export const SUBSIDY_CASE_FEE_DEFAULT_CENTS = 21_000;
export const SUBSIDY_CASE_BZA_DUE_WORKDAYS = 3;
export const SUBSIDY_CASE_BND_DUE_WORKDAYS = 5;
export const SUBSIDY_CASE_NAMEPLATE_SLOT = "typenschild-foto" as const;

// Berlin-Kalendertag (YYYY-MM-DD) — Stichtag für Fälligkeitsrechnung
// und Überfällig-Vergleich (Spec §2: AT = Mo–Fr Europe/Berlin).
export function todayBerlinIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDateUtcMs(value: string): number {
  if (!ISO_DATE_PATTERN.test(value)) throw new Error(`invalid ISO date: ${value}`);
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`invalid ISO date: ${value}`);
  // Guard gegen Überlauf-Normalisierung (z. B. 2026-02-30 → 03-02).
  if (new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid ISO date: ${value}`);
  }
  return ms;
}

function formatIsoDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// AT-Rechnung (Spec §2, ESTIMATE-Näherung ~3/~5, keine Behördenzusage):
// Arbeitstage Mo–Fr ab Starttag (Starttag = Tag 0), Wochenenden und
// holidaysIso (ISO-Dates, Feiertagsquelle des Aufrufers — F13-13: Bund
// via lib/subsidy-holidays) übersprungen. Reine Kalenderrechnung auf
// UTC-Mitternacht; Berlin nur als Kalendertag-Konvention (kein DST).
export function addBusinessDaysBerlin(
  startIsoDate: string,
  days: number,
  holidaysIso: readonly string[] = [],
): string {
  if (!Number.isInteger(days)) throw new Error(`invalid business days: ${days}`);
  const holidays = new Set(holidaysIso);
  const stepMs = days < 0 ? -86_400_000 : 86_400_000;
  let cursor = parseIsoDateUtcMs(startIsoDate);
  let remaining = Math.abs(days);
  while (remaining > 0) {
    cursor += stepMs;
    const weekday = new Date(cursor).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (holidays.has(formatIsoDateUtc(cursor))) continue;
    remaining -= 1;
  }
  return formatIsoDateUtc(cursor);
}

// Überfällig-Badge (Spec §2, reine Anzeige): true genau dann, wenn ein
// Fälligkeitsdatum gesetzt ist, die Phase noch offen ist und heute
// (Berlin-Kalendertag, injizierbar für Tests) dahinter liegt.
export function isSubsidyCaseOverdue(input: {
  dueDate: string | null;
  todayIso?: string;
  phaseOpen: boolean;
}): boolean {
  if (input.dueDate === null || input.dueDate === undefined) return false;
  if (!input.phaseOpen) return false;
  const today = input.todayIso ?? todayBerlinIso();
  return today > input.dueDate;
}

// BzA-vor-Annahme-Badge (Spec §3, weich, keine Sperren): true, solange
// die Akte vor bza_bewilligt steht — inkl. korrektur (Wiedereinstieg,
// Maschine F13-03 unverändert).
const PRE_APPROVAL_STATUSES: readonly SubsidyCaseStatus[] = [
  "draft",
  "vorbereitung",
  "bza_eingereicht",
  "korrektur",
];

export function isSubsidyCasePreApproval(status: SubsidyCaseStatus): boolean {
  return PRE_APPROVAL_STATUSES.includes(status);
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
  // F13-13: Preis-Snapshot (Cent, bei Anlage), Fälligkeiten
  // (YYYY-MM-DD, ab Versand), Anzeige-Badges (rein lesend).
  feeCents: number;
  bzaDueDate: string | null;
  bndDueDate: string | null;
  overdue: boolean;
  preApproval: boolean;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
  portalActivation: SubsidyCasePortalActivation;
};
