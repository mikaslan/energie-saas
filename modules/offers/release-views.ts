// F2-07b Freigabe-Ansichten — lesende Reader, DTOs strikt PII-frei.
// Spec: docs/spec/F2-07b-freigabe-ansichten.md (§Datenmodell Whitelists).
// Muster: listOfferIssuances (modules/offers/issuance-service.ts) —
// Signatur (tx, ctx, key), Leserecht `project.read`, `external_only` blockiert.
//
// SERVER-FREI: kein `server-only` in der Kette (Unit-Test importiert direkt),
// kein Top-Level-Pool — DB-Zugriff nur via übergebenem Tx-Parameter.
// Ohne Tx (reine offerId-Form) gibt es keine DB-Abfrage: leere Liste.
import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { TenantTx } from "@/lib/db/types";
import { requireAuthSecret } from "@/lib/env";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import { OfferIntegrityError, OfferNotFoundError } from "./errors";

export class OfferReleaseViewsPersistenceError extends Error {
  constructor() {
    super("release views could not be read");
    this.name = "OfferReleaseViewsPersistenceError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const databaseInstantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value, context) => {
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      context.addIssue({ code: "custom", message: "invalid database instant" });
      return z.NEVER;
    }
    return parsed.toISOString();
  });

const offerKeySchema = z.strictObject({
  workspaceId: uuidSchema,
  offerId: uuidSchema,
});

const issuanceKeySchema = offerKeySchema.extend({
  issuanceId: uuidSchema,
});

export type OfferReleaseViewsKey = z.infer<typeof offerKeySchema>;
export type OfferReleaseViewsIssuanceKey = z.infer<typeof issuanceKeySchema>;

// --- DTOs: exakte Unit-Whitelists (tests/unit/f207b-contract.test.ts) --------

export type ApprovalLedgerEntry = {
  issuanceId: string;
  issuanceReference: string;
  ordinal: number;
  ordinalLabel: string;
  total: number;
  approvedAt: string;
  hasZeroTaxTreatment: boolean;
  approvalVersion: string;
};

export type CandidateApprovalHistoryEntry = {
  candidateId: string;
  candidateReference: string;
  variantRevision: number;
  profileRevision: number;
  recipientRevision: number;
  hasZeroTaxTreatment: boolean;
  approvedAt: string;
};

export type WithdrawalReasonCode =
  | "content_error"
  | "recipient_error"
  | "legal_text_error"
  | "commercial_error"
  | "other";

export type WithdrawalHistoryEntry = {
  issuanceId: string;
  issuanceReference: string;
  reasonCode: WithdrawalReasonCode;
  reasonLabel: string;
  withdrawnAt: string;
};

export type ReleaseChronikEntry = {
  eventType: string;
  occurredAt: string;
  issuanceReference: string | null;
  candidateReference: string | null;
};

export type Pruefpunkt = { key: string; label: string; checked: boolean };

export type PruefpunkteProtokollEntry = {
  scope: "candidate" | "issuance";
  scopeId: string;
  hasZeroTaxTreatment: boolean;
  points: Pruefpunkt[];
};

// --- Guards (listOfferIssuances-Muster) ---------------------------------------

function requireReadable(ctx: ServiceCtx, resource: string): void {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", resource, undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.read",
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function requireSameWorkspace(ctx: ServiceCtx, workspaceId: string): void {
  if (ctx.workspaceId !== workspaceId) throw new OfferNotFoundError();
}

async function readRows(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown[]> {
  try {
    return (await tx.execute(statement)).rows;
  } catch {
    throw new OfferReleaseViewsPersistenceError();
  }
}

async function assertOfferExists(
  tx: TenantTx,
  key: OfferReleaseViewsKey,
): Promise<void> {
  const rows = await readRows(tx, sql`
    select id
      from public.offer
     where workspace_id = ${key.workspaceId}::uuid
       and id = ${key.offerId}::uuid
     limit 1
  `);
  if (rows.length !== 1) throw new OfferNotFoundError();
}

// Kapseln (0330, SECURITY DEFINER) lesen app.actor_id aus der Session;
// withTenantOn neutralisiert ihn (''→NULL) → aus ctx nachsetzen (Muster
// lib/db/tenant.ts withAuthorizedTenant). Guards laufen vorher (fail-closed).
async function setCapsuleActor(tx: TenantTx, ctx: ServiceCtx): Promise<void> {
  await readRows(tx, sql`select set_config('app.actor_id', ${ctx.actor}, true)`);
}

function parseOrThrow<T>(schema: z.ZodType<T>, row: unknown): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new OfferIntegrityError();
  return parsed.data;
}

// --- Referenzlabels (PII-frei, stabil, nicht umkehrbar) -----------------------
// Kanonische Ableitung: lokale Kopie von offerSurfaceReference aus
// app/w/[workspaceId]/angebote/[offerId]/page.tsx (dort nicht importierbar;
// in issuance-/release-service existiert kein solcher Helper). Byte-identisch,
// inkl. Test-Fallbackschlüssel.
function surfaceReference(
  workspaceId: string,
  kind: "issuance" | "release_candidate",
  id: string,
): string {
  const key = requireAuthSecret() || "offer-surface-reference-test-only";
  const digest = createHmac("sha256", key)
    .update(`offer-surface-reference:v1:${workspaceId}:${kind}:${id}`, "utf8")
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `${kind === "issuance" ? "AF" : "FK"}-${digest}`;
}

// Grundlabels aus dem Issuance-Panel (offer-issuance-panel.tsx), nicht neu.
const WITHDRAWAL_REASON_LABELS: Record<WithdrawalReasonCode, string> = {
  content_error: "Inhaltlicher Fehler",
  recipient_error: "Empfängerfehler",
  legal_text_error: "Fehler in Rechtstexten",
  commercial_error: "Kaufmännischer Fehler",
  other: "Sonstiger strukturierter Grund",
};

// Prüfpunkt-Labels aus den bestehenden Panels (Microcopy-konsistent).
const CANDIDATE_POINT_LABELS = {
  recipientBillingReviewed:
    "Empfänger und Rechnungsadresse stimmen mit dem geprüften Kundenstand überein.",
  commercialContentReviewed:
    "Leistungsumfang, Preise, Rabatte, Steuern und Summen wurden am erzeugten PDF geprüft.",
  activeProfileReviewed:
    "Ausstellerangaben und Rechtstexte entsprechen dem intern geprüften aktiven Profil.",
  notIssuedStatusUnderstood:
    "Ich verstehe, dass dieser Kandidat nicht ausgestellt und nicht versendet ist.",
  zeroTaxTreatmentReviewed:
    "Die Behandlung aller Positionen mit 0 % Umsatzsteuer wurde ausdrücklich geprüft.",
} as const;

const ISSUANCE_POINT_LABELS = {
  recipientAndScopeReviewed:
    "Empfänger, Rechnungsadresse, Anlagenstandort und Leistungsumfang geprüft",
  commercialTotalsReviewed:
    "Positionen, Rabatte, Steuern und Summen geprüft",
  legalProfileReviewed:
    "Aktive Angebotsbedingungen und Rechtshinweise geprüft",
  finalPdfForArchiveUnderstood:
    "Verstanden: Genau diese finale PDF-Datei ist für das spätere Archiv bestimmt",
  zeroTaxTreatmentReviewed:
    "Die Voraussetzungen und Nachweise für die 0-%-Steuerbehandlung wurden geprüft.",
} as const;

const CHRONIK_EVENT_TYPES = [
  "offer.release_candidate_requested",
  "offer.release_candidate_approved_not_issued",
  "offer.issuance_requested",
  "offer.issuance_first_approval_recorded",
  "offer.issuance_approved_for_archive_not_issued",
  "offer.issuance_withdrawn_before_archive",
] as const;

// --- D4-02 4-Augen-Ledger -----------------------------------------------------

// Nenner 1/2, 2/2: konstante 4-Augen-Zielzahl (M2-03b1), kein Count.
const APPROVAL_LEDGER_TOTAL = 2;

const ledgerRowSchema = z.strictObject({
  issuance_id: uuidSchema,
  approved_at: databaseInstantSchema,
  has_zero_tax_treatment: z.boolean(),
  approval_version: z.string().min(1),
});

export async function listApprovalLedger(offerId: string): Promise<ApprovalLedgerEntry[]>;
export async function listApprovalLedger(
  tx: TenantTx,
  ctx: ServiceCtx,
  key: OfferReleaseViewsKey & { issuanceId?: string },
): Promise<ApprovalLedgerEntry[]>;
export async function listApprovalLedger(
  txOrOfferId: TenantTx | string,
  ctx?: ServiceCtx,
  key?: OfferReleaseViewsKey & { issuanceId?: string },
): Promise<ApprovalLedgerEntry[]> {
  if (typeof txOrOfferId === "string") return [];
  const tx = txOrOfferId as TenantTx;
  const context = ctx as ServiceCtx;
  requireReadable(context, "offer_issuance_approval");
  const parsedKey = key?.issuanceId !== undefined
    ? issuanceKeySchema.parse(key)
    : offerKeySchema.parse(key);
  requireSameWorkspace(context, parsedKey.workspaceId);
  await assertOfferExists(tx, parsedKey);
  await setCapsuleActor(tx, context);
  const rows = (await readRows(tx, sql`
    select ledger.issuance_id, ledger.approved_at,
           ledger.has_zero_tax_treatment, ledger.approval_version
      from public.read_offer_approval_ledger(
        ${parsedKey.workspaceId}::uuid,
        ${parsedKey.offerId}::uuid,
        ${"issuanceId" in parsedKey ? sql`${parsedKey.issuanceId}::uuid` : sql`null::uuid`}
      ) as ledger
     order by ledger.approved_at, ledger.issuance_id
  `)).map((row) => parseOrThrow(ledgerRowSchema, row));
  const ordinalByIssuance = new Map<string, number>();
  return rows.map((row) => {
    const ordinal = (ordinalByIssuance.get(row.issuance_id) ?? 0) + 1;
    ordinalByIssuance.set(row.issuance_id, ordinal);
    return {
      issuanceId: row.issuance_id,
      issuanceReference: surfaceReference(parsedKey.workspaceId, "issuance", row.issuance_id),
      ordinal,
      ordinalLabel: ordinal === 1 ? "Erste Freigabe" : "Zweite Freigabe",
      total: APPROVAL_LEDGER_TOTAL,
      approvedAt: row.approved_at,
      hasZeroTaxTreatment: row.has_zero_tax_treatment,
      approvalVersion: row.approval_version,
    };
  });
}

// --- D4-01 Candidate-Approval-Historie ----------------------------------------

const candidateHistoryRowSchema = z.strictObject({
  candidate_id: uuidSchema,
  variant_revision: z.number().int(),
  profile_revision: z.number().int(),
  recipient_revision: z.number().int(),
  has_zero_tax_treatment: z.boolean(),
  approved_at: databaseInstantSchema,
});

export async function listCandidateApprovalHistory(
  offerId: string,
): Promise<CandidateApprovalHistoryEntry[]>;
export async function listCandidateApprovalHistory(
  tx: TenantTx,
  ctx: ServiceCtx,
  key: OfferReleaseViewsKey,
): Promise<CandidateApprovalHistoryEntry[]>;
export async function listCandidateApprovalHistory(
  txOrOfferId: TenantTx | string,
  ctx?: ServiceCtx,
  key?: OfferReleaseViewsKey,
): Promise<CandidateApprovalHistoryEntry[]> {
  if (typeof txOrOfferId === "string") return [];
  const tx = txOrOfferId as TenantTx;
  const context = ctx as ServiceCtx;
  requireReadable(context, "offer_release_candidate_approval");
  const parsedKey = offerKeySchema.parse(key);
  requireSameWorkspace(context, parsedKey.workspaceId);
  await assertOfferExists(tx, parsedKey);
  await setCapsuleActor(tx, context);
  const rows = (await readRows(tx, sql`
    select hist.candidate_id, hist.variant_revision, hist.profile_revision,
           hist.recipient_revision, hist.has_zero_tax_treatment, hist.approved_at
      from public.read_offer_candidate_history(
        ${parsedKey.workspaceId}::uuid,
        ${parsedKey.offerId}::uuid,
        null::uuid
      ) as hist
     order by hist.approved_at desc, hist.candidate_id desc
  `)).map((row) => parseOrThrow(candidateHistoryRowSchema, row));
  return rows.map((row) => ({
    candidateId: row.candidate_id,
    candidateReference: surfaceReference(parsedKey.workspaceId, "release_candidate", row.candidate_id),
    variantRevision: row.variant_revision,
    profileRevision: row.profile_revision,
    recipientRevision: row.recipient_revision,
    hasZeroTaxTreatment: row.has_zero_tax_treatment,
    approvedAt: row.approved_at,
  }));
}

// --- D4-03 Withdraw-Historie --------------------------------------------------

const withdrawalRowSchema = z.strictObject({
  issuance_id: uuidSchema,
  reason_code: z.enum([
    "content_error",
    "recipient_error",
    "legal_text_error",
    "commercial_error",
    "other",
  ]),
  withdrawn_at: databaseInstantSchema,
});

export async function listWithdrawalHistory(offerId: string): Promise<WithdrawalHistoryEntry[]>;
export async function listWithdrawalHistory(
  tx: TenantTx,
  ctx: ServiceCtx,
  key: OfferReleaseViewsKey,
): Promise<WithdrawalHistoryEntry[]>;
export async function listWithdrawalHistory(
  txOrOfferId: TenantTx | string,
  ctx?: ServiceCtx,
  key?: OfferReleaseViewsKey,
): Promise<WithdrawalHistoryEntry[]> {
  if (typeof txOrOfferId === "string") return [];
  const tx = txOrOfferId as TenantTx;
  const context = ctx as ServiceCtx;
  requireReadable(context, "offer_issuance_withdrawal");
  const parsedKey = offerKeySchema.parse(key);
  requireSameWorkspace(context, parsedKey.workspaceId);
  await assertOfferExists(tx, parsedKey);
  await setCapsuleActor(tx, context);
  const rows = (await readRows(tx, sql`
    select hist.issuance_id, hist.reason_code, hist.withdrawn_at
      from public.read_offer_withdraw_history(
        ${parsedKey.workspaceId}::uuid,
        ${parsedKey.offerId}::uuid
      ) as hist
     order by hist.withdrawn_at desc, hist.issuance_id desc
  `)).map((row) => parseOrThrow(withdrawalRowSchema, row));
  return rows.map((row) => ({
    issuanceId: row.issuance_id,
    issuanceReference: surfaceReference(parsedKey.workspaceId, "issuance", row.issuance_id),
    reasonCode: row.reason_code,
    reasonLabel: WITHDRAWAL_REASON_LABELS[row.reason_code],
    withdrawnAt: row.withdrawn_at,
  }));
}

// --- D4-07 Offer-weite Chronik ------------------------------------------------

const chronikRowSchema = z.strictObject({
  event_type: z.enum(CHRONIK_EVENT_TYPES),
  payload: z.unknown(),
  occurred_at: databaseInstantSchema,
});

function payloadReferenceId(payload: unknown, field: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;
  return z.uuid().safeParse(value).success ? value.toLowerCase() : null;
}

export async function listReleaseChronik(offerId: string): Promise<ReleaseChronikEntry[]>;
export async function listReleaseChronik(
  tx: TenantTx,
  ctx: ServiceCtx,
  key: OfferReleaseViewsKey,
): Promise<ReleaseChronikEntry[]>;
export async function listReleaseChronik(
  txOrOfferId: TenantTx | string,
  ctx?: ServiceCtx,
  key?: OfferReleaseViewsKey,
): Promise<ReleaseChronikEntry[]> {
  if (typeof txOrOfferId === "string") return [];
  const tx = txOrOfferId as TenantTx;
  const context = ctx as ServiceCtx;
  requireReadable(context, "domain_events");
  const parsedKey = offerKeySchema.parse(key);
  requireSameWorkspace(context, parsedKey.workspaceId);
  await assertOfferExists(tx, parsedKey);
  const rows = (await readRows(tx, sql`
    select event_type, payload, occurred_at
      from public.domain_events
     where workspace_id = ${parsedKey.workspaceId}::uuid
       and aggregate_type = 'offer'
       and aggregate_id = ${parsedKey.offerId}::uuid
       and event_type in (
         'offer.release_candidate_requested',
         'offer.release_candidate_approved_not_issued',
         'offer.issuance_requested',
         'offer.issuance_first_approval_recorded',
         'offer.issuance_approved_for_archive_not_issued',
         'offer.issuance_withdrawn_before_archive'
       )
     order by occurred_at asc, id asc
  `)).map((row) => parseOrThrow(chronikRowSchema, row));
  return rows.map((row) => {
    const issuanceId = payloadReferenceId(row.payload, "issuanceId");
    const candidateId = payloadReferenceId(row.payload, "candidateId");
    return {
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      issuanceReference: issuanceId === null
        ? null
        : surfaceReference(parsedKey.workspaceId, "issuance", issuanceId),
      candidateReference: candidateId === null
        ? null
        : surfaceReference(parsedKey.workspaceId, "release_candidate", candidateId),
    };
  });
}

// --- D4-04 Prüfpunkte-Protokoll (readonly) ------------------------------------

const candidatePointsRowSchema = z.strictObject({
  candidate_id: uuidSchema,
  has_zero_tax_treatment: z.boolean(),
  recipient_billing_reviewed: z.boolean(),
  commercial_content_reviewed: z.boolean(),
  active_profile_reviewed: z.boolean(),
  not_issued_status_understood: z.boolean(),
});

const issuancePointsRowSchema = z.strictObject({
  issuance_id: uuidSchema,
  has_zero_tax_treatment: z.boolean(),
  recipient_and_scope_reviewed: z.boolean(),
  commercial_totals_reviewed: z.boolean(),
  legal_profile_reviewed: z.boolean(),
  final_pdf_for_archive_understood: z.boolean(),
  zero_tax_treatment_reviewed: z.boolean().nullable(),
});

export async function listPruefpunkteProtokoll(
  offerId: string,
): Promise<PruefpunkteProtokollEntry[]>;
export async function listPruefpunkteProtokoll(
  tx: TenantTx,
  ctx: ServiceCtx,
  key: OfferReleaseViewsKey,
): Promise<PruefpunkteProtokollEntry[]>;
export async function listPruefpunkteProtokoll(
  txOrOfferId: TenantTx | string,
  ctx?: ServiceCtx,
  key?: OfferReleaseViewsKey,
): Promise<PruefpunkteProtokollEntry[]> {
  if (typeof txOrOfferId === "string") return [];
  const tx = txOrOfferId as TenantTx;
  const context = ctx as ServiceCtx;
  requireReadable(context, "offer_release_approval_checkpoints");
  const parsedKey = offerKeySchema.parse(key);
  requireSameWorkspace(context, parsedKey.workspaceId);
  await assertOfferExists(tx, parsedKey);
  await setCapsuleActor(tx, context);
  // Rein aus K2 (kein Direkt-JOIN: app_runtime hat kein SELECT auf der
  // Approval-Tabelle). K2 liefert weder Approval-id noch Zero-Flag:
  // scopeId = candidate_id; Zero-checked ≡ has_zero_tax_treatment per
  // offer_release_candidate_approval_zero_tax_ck (DB-Invariant).
  const candidateRows = (await readRows(tx, sql`
    select cap.candidate_id, cap.has_zero_tax_treatment,
           cap.recipient_billing_reviewed, cap.commercial_content_reviewed,
           cap.active_profile_reviewed, cap.not_issued_status_understood
      from public.read_offer_candidate_history(
        ${parsedKey.workspaceId}::uuid,
        ${parsedKey.offerId}::uuid,
        null::uuid
      ) as cap
     order by cap.approved_at desc, cap.candidate_id desc
  `)).map((row) => parseOrThrow(candidatePointsRowSchema, row));
  const issuanceRows = (await readRows(tx, sql`
    select cap.issuance_id, cap.has_zero_tax_treatment,
           cap.recipient_and_scope_reviewed, cap.commercial_totals_reviewed,
           cap.legal_profile_reviewed, cap.final_pdf_for_archive_understood,
           cap.zero_tax_treatment_reviewed
      from public.read_offer_approval_ledger(
        ${parsedKey.workspaceId}::uuid,
        ${parsedKey.offerId}::uuid,
        null::uuid
      ) as cap
     order by cap.approved_at, cap.issuance_id
  `)).map((row) => parseOrThrow(issuancePointsRowSchema, row));
  const entries: PruefpunkteProtokollEntry[] = candidateRows.map((row) => {
    const points: Pruefpunkt[] = [
      {
        key: "recipientBillingReviewed",
        label: CANDIDATE_POINT_LABELS.recipientBillingReviewed,
        checked: row.recipient_billing_reviewed,
      },
      {
        key: "commercialContentReviewed",
        label: CANDIDATE_POINT_LABELS.commercialContentReviewed,
        checked: row.commercial_content_reviewed,
      },
      {
        key: "activeProfileReviewed",
        label: CANDIDATE_POINT_LABELS.activeProfileReviewed,
        checked: row.active_profile_reviewed,
      },
      {
        key: "notIssuedStatusUnderstood",
        label: CANDIDATE_POINT_LABELS.notIssuedStatusUnderstood,
        checked: row.not_issued_status_understood,
      },
    ];
    if (row.has_zero_tax_treatment) {
      points.push({
        key: "zeroTaxTreatmentReviewed",
        label: CANDIDATE_POINT_LABELS.zeroTaxTreatmentReviewed,
        checked: row.has_zero_tax_treatment,
      });
    }
    return {
      scope: "candidate",
      scopeId: row.candidate_id,
      hasZeroTaxTreatment: row.has_zero_tax_treatment,
      points,
    };
  });
  for (const row of issuanceRows) {
    const points: Pruefpunkt[] = [
      {
        key: "recipientAndScopeReviewed",
        label: ISSUANCE_POINT_LABELS.recipientAndScopeReviewed,
        checked: row.recipient_and_scope_reviewed,
      },
      {
        key: "commercialTotalsReviewed",
        label: ISSUANCE_POINT_LABELS.commercialTotalsReviewed,
        checked: row.commercial_totals_reviewed,
      },
      {
        key: "legalProfileReviewed",
        label: ISSUANCE_POINT_LABELS.legalProfileReviewed,
        checked: row.legal_profile_reviewed,
      },
      {
        key: "finalPdfForArchiveUnderstood",
        label: ISSUANCE_POINT_LABELS.finalPdfForArchiveUnderstood,
        checked: row.final_pdf_for_archive_understood,
      },
    ];
    if (row.has_zero_tax_treatment) {
      points.push({
        key: "zeroTaxTreatmentReviewed",
        label: ISSUANCE_POINT_LABELS.zeroTaxTreatmentReviewed,
        checked: row.zero_tax_treatment_reviewed ?? false,
      });
    }
    entries.push({
      scope: "issuance",
      scopeId: row.issuance_id,
      hasZeroTaxTreatment: row.has_zero_tax_treatment,
      points,
    });
  }
  return entries;
}

// --- Aliase im DB-Test-Namensstil (F2-07b DB-Anteile) -------------------------

export const listOfferApprovalLedger = listApprovalLedger;
export const listOfferCandidateApprovalHistory = listCandidateApprovalHistory;
export const listOfferIssuanceWithdrawals = listWithdrawalHistory;
export const listOfferReleaseChronik = listReleaseChronik;
export const listOfferPruefpunkteProtokoll = listPruefpunkteProtokoll;
