import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  calculatorSnapshot,
  contact,
  inboundReceipt,
  kanbanBoard,
  kanbanColumn,
  project,
  projectRequirement,
  site,
  type RechnerProjectRequirementsV1,
} from "@/lib/db/schema";
import { contactNameSplitV1 } from "@/lib/db/schema/contact-name-split";
import type { TenantTx } from "@/lib/db/types";
import {
  ADDRESS_FINGERPRINT_VERSION,
  addressFingerprint,
} from "@/lib/address-fingerprint";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import { validateRechnerIntake } from "@/lib/integrations/rechner/contract";
import {
  RechnerIdempotencyConflictError,
  RechnerInvalidRequestError,
  RechnerRateLimitError,
} from "@/lib/integrations/rechner/errors";
import type { VerifiedRechnerIdentity } from "@/lib/integrations/rechner/signature";
import {
  RECHNER_SOURCE_KEY,
  type RechnerCalculationSnapshotV1,
  type RechnerIntakeMeta,
  type RechnerIntakeReceiptV1,
  type RechnerIntakeV1,
} from "@/lib/integrations/rechner/types";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_RECEIPTS = 120;

type ContactCandidate = {
  id: string;
  emailNormalized: string | null;
  phoneRaw: string | null;
  phoneE164: string | null;
  dedupeReviewRequired: boolean;
};

type ContactDecision = {
  contactId: string;
  resolution: "created" | "email_match" | "phone_match" | "review_created";
  emailMatchContactId: string | null;
  phoneMatchContactId: string | null;
  existing: ContactCandidate | null;
  reviewRequired: boolean;
};

type ExistingReceipt = {
  id: string;
  submissionId: string;
  bodySha256: Buffer;
};

async function resolveDefaultRequestLane(
  tx: TenantTx,
  workspaceId: string,
): Promise<{ boardId: string; columnId: string }> {
  const rows = await tx
    .select({ boardId: kanbanBoard.id, columnId: kanbanColumn.id })
    .from(kanbanBoard)
    .innerJoin(
      kanbanColumn,
      and(
        eq(kanbanColumn.workspaceId, kanbanBoard.workspaceId),
        eq(kanbanColumn.boardId, kanbanBoard.id),
      ),
    )
    .where(and(
      eq(kanbanBoard.workspaceId, workspaceId),
      eq(kanbanBoard.scope, "residential"),
      eq(kanbanBoard.isDefault, true),
      isNull(kanbanBoard.archivedAt),
      eq(kanbanColumn.isIntake, true),
      eq(kanbanColumn.columnType, "lead"),
      isNull(kanbanColumn.archivedAt),
    ))
    .limit(2);
  if (rows.length !== 1) {
    throw new Error("default residential intake lane is missing or ambiguous");
  }
  return rows[0];
}

function normalizedRequiredText(value: string, minLength: number, maxLength: number): string {
  const normalized = value.normalize("NFKC").trim();
  // JSON Schema maxLength und PostgreSQL length() zählen Unicode-Codepoints,
  // nicht UTF-16-Codeunits wie JavaScripts string.length.
  const length = Array.from(normalized).length;
  if (length < minLength || length > maxLength) {
    throw new RechnerInvalidRequestError();
  }
  return normalized;
}

export function normalizeRechnerPhone(value: string): string | null {
  const trimmed = value.normalize("NFKC").trim();
  if (!/^[+0-9\s()./\-]+$/.test(trimmed)) return null;

  let compact = trimmed.replace(/[\s()./\-]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  else if (compact.startsWith("0")) compact = `+49${compact.slice(1)}`;
  if (!/^\+[1-9][0-9]{1,14}$/.test(compact)) return null;
  return compact;
}

function selectedAddressFingerprint(payload: RechnerIntakeV1): Buffer | null {
  if (payload.site.addressMode !== "selected") return null;
  const { street, houseNumber, postalCode, city, countryCode } = payload.site;
  if (!street || !houseNumber || !postalCode || !city) throw new RechnerInvalidRequestError();

  return addressFingerprint({
    countryCode,
    postalCode,
    city,
    street,
    houseNumber,
  });
}

function requestHash(meta: RechnerIntakeMeta): Buffer {
  if (!/^[0-9a-f]{64}$/.test(meta.payloadSha256)) throw new RechnerInvalidRequestError();
  if (
    !Number.isFinite(meta.receivedAt.getTime())
    || !Number.isFinite(meta.signedAt.getTime())
  ) {
    throw new RechnerInvalidRequestError();
  }
  return Buffer.from(meta.payloadSha256, "hex");
}

function contractDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RechnerInvalidRequestError();
  return parsed;
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function receiptResponse(row: ExistingReceipt, duplicate: boolean): RechnerIntakeReceiptV1 {
  return {
    contractVersion: "rechner-intake-receipt.v1",
    receiptId: row.id,
    submissionId: row.submissionId,
    status: "processed",
    duplicate,
  };
}

async function findReceipt(
  tx: TenantTx,
  workspaceId: string,
  submissionId: string,
): Promise<ExistingReceipt | null> {
  const [row] = await tx
    .select({
      id: inboundReceipt.id,
      submissionId: inboundReceipt.submissionId,
      bodySha256: inboundReceipt.bodySha256,
    })
    .from(inboundReceipt)
    .where(and(
      eq(inboundReceipt.workspaceId, workspaceId),
      eq(inboundReceipt.sourceKey, RECHNER_SOURCE_KEY),
      eq(inboundReceipt.submissionId, submissionId),
    ))
    .limit(1);
  return row ?? null;
}

function replayOrConflict(row: ExistingReceipt, hash: Buffer): RechnerIntakeReceiptV1 {
  if (!sameHash(row.bodySha256, hash)) throw new RechnerIdempotencyConflictError();
  return receiptResponse(row, true);
}

async function advisoryLock(tx: TenantTx, token: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${token}, 0))`);
}

async function enforceRateLimit(
  tx: TenantTx,
  ctx: VerifiedRechnerIdentity,
  receivedAt: Date,
): Promise<void> {
  await advisoryLock(tx, `rechner-rate:v1:${ctx.workspaceId}:${ctx.keyId}`);
  const windowStart = new Date(receivedAt.getTime() - RATE_LIMIT_WINDOW_MS);
  const result = await tx.execute<{ n: number; oldest: Date | null; [key: string]: unknown }>(sql`
    select count(*)::int as n, min(received_at) as oldest
    from inbound_receipt
    where workspace_id = ${ctx.workspaceId}::uuid
      and auth_key_id = ${ctx.keyId}
      and received_at >= ${windowStart}
  `);
  const row = result.rows[0];
  if (!row || row.n < RATE_LIMIT_MAX_RECEIPTS) return;

  const oldest = row.oldest instanceof Date ? row.oldest : new Date(String(row.oldest));
  const retryAt = oldest.getTime() + RATE_LIMIT_WINDOW_MS;
  const retryAfterSeconds = Number.isFinite(retryAt)
    ? Math.max(1, Math.ceil((retryAt - receivedAt.getTime()) / 1000))
    : 60;
  throw new RechnerRateLimitError(retryAfterSeconds);
}

async function lockContactIdentities(
  tx: TenantTx,
  workspaceId: string,
  email: string,
  phoneE164: string | null,
): Promise<void> {
  const tokens = [
    `rechner-contact:v1:${workspaceId}:email:${email}`,
    ...(phoneE164 ? [`rechner-contact:v1:${workspaceId}:phone:${phoneE164}`] : []),
  ].sort();
  for (const token of tokens) await advisoryLock(tx, token);
}

async function contactCandidates(
  tx: TenantTx,
  workspaceId: string,
  email: string,
  phoneE164: string | null,
): Promise<ContactCandidate[]> {
  const identity = phoneE164
    ? or(eq(contact.emailNormalized, email), eq(contact.phoneE164, phoneE164))
    : eq(contact.emailNormalized, email);
  return tx
    .select({
      id: contact.id,
      emailNormalized: contact.emailNormalized,
      phoneRaw: contact.phoneRaw,
      phoneE164: contact.phoneE164,
      dedupeReviewRequired: contact.dedupeReviewRequired,
    })
    .from(contact)
    .where(and(
      eq(contact.workspaceId, workspaceId),
      isNull(contact.deletedAt),
      identity,
    ))
    .orderBy(asc(contact.createdAt), asc(contact.id))
    .for("update");
}

function decideContact(
  candidates: ContactCandidate[],
  email: string,
  phoneE164: string | null,
): ContactDecision {
  const emailMatches = candidates.filter((row) => row.emailNormalized === email);
  const phoneMatches = phoneE164
    ? candidates.filter((row) => row.phoneE164 === phoneE164)
    : [];
  const emailMatchContactId = emailMatches.length === 1 ? emailMatches[0].id : null;
  const phoneMatchContactId = phoneMatches.length === 1 ? phoneMatches[0].id : null;

  if (emailMatches.length === 0 && phoneMatches.length === 0) {
    return {
      contactId: randomUUID(),
      resolution: "created",
      emailMatchContactId,
      phoneMatchContactId,
      existing: null,
      reviewRequired: false,
    };
  }

  if (emailMatches.length === 1 && phoneMatches.length <= 1) {
    const candidate = emailMatches[0];
    const samePhoneCandidate = phoneMatches.length === 1 && phoneMatches[0].id === candidate.id;
    const storedRawPhone = candidate.phoneRaw ? normalizeRechnerPhone(candidate.phoneRaw) : null;
    const phoneCompatible = phoneE164 === null
      || samePhoneCandidate
      || (phoneMatches.length === 0
        && candidate.phoneE164 === null
        && (candidate.phoneRaw === null || storedRawPhone === phoneE164));
    if (phoneCompatible) {
      return {
        contactId: candidate.id,
        resolution: "email_match",
        emailMatchContactId,
        phoneMatchContactId,
        existing: candidate,
        reviewRequired: candidate.dedupeReviewRequired,
      };
    }
  }

  if (
    emailMatches.length === 0
    && phoneMatches.length === 1
    && phoneMatches[0].emailNormalized === null
  ) {
    return {
      contactId: phoneMatches[0].id,
      resolution: "phone_match",
      emailMatchContactId,
      phoneMatchContactId,
      existing: phoneMatches[0],
      reviewRequired: phoneMatches[0].dedupeReviewRequired,
    };
  }

  return {
    contactId: randomUUID(),
    resolution: "review_created",
    emailMatchContactId,
    phoneMatchContactId,
    existing: null,
    reviewRequired: true,
  };
}

async function persistContact(
  tx: TenantTx,
  ctx: VerifiedRechnerIdentity,
  decision: ContactDecision,
  payload: RechnerIntakeV1,
  displayName: string,
  emailPrimary: string,
  email: string,
  phoneE164: string | null,
  now: Date,
): Promise<void> {
  const phoneRaw = payload.customer.phoneRaw;
  if (!decision.existing) {
    const nameSplit = contactNameSplitV1(displayName);
    await tx.insert(contact).values({
      id: decision.contactId,
      workspaceId: ctx.workspaceId,
      displayName,
      firstName: nameSplit.firstName,
      lastName: nameSplit.lastName,
      emailPrimary,
      emailNormalized: email,
      phoneRaw,
      phoneE164,
      utmSource: payload.acquisition.utm.source ?? null,
      utmMedium: payload.acquisition.utm.medium ?? null,
      utmCampaign: payload.acquisition.utm.campaign ?? null,
      utmTerm: payload.acquisition.utm.term ?? null,
      utmContent: payload.acquisition.utm.content ?? null,
      marketingConsent: false,
      dedupeReviewRequired: decision.reviewRequired,
      createdAt: now,
      updatedAt: now,
    });
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "contact",
      aggregateId: decision.contactId,
      eventType: "contact.created",
      actor: ctx.actor,
      payload: { contactId: decision.contactId },
    });
    return;
  }

  const update: {
    emailPrimary?: string;
    emailNormalized?: string;
    phoneRaw?: string;
    phoneE164?: string;
    updatedAt?: Date;
  } = {};
  if (decision.existing.emailNormalized === null) {
    update.emailPrimary = emailPrimary;
    update.emailNormalized = email;
  }
  if (decision.existing.phoneRaw === null) update.phoneRaw = phoneRaw;
  if (phoneE164 && decision.existing.phoneE164 === null) update.phoneE164 = phoneE164;
  if (Object.keys(update).length === 0) return;

  update.updatedAt = now;
  await tx
    .update(contact)
    .set(update)
    .where(and(eq(contact.workspaceId, ctx.workspaceId), eq(contact.id, decision.contactId)));
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "contact",
    aggregateId: decision.contactId,
    eventType: "contact.enriched",
    actor: ctx.actor,
    payload: { contactId: decision.contactId },
  });
}

async function selectOrAllocateSite(
  tx: TenantTx,
  workspaceId: string,
  contactId: string,
  payload: RechnerIntakeV1,
  fingerprint: Buffer | null,
): Promise<{ siteId: string; existing: boolean }> {
  if (payload.site.addressMode === "selected" && fingerprint) {
    const [existing] = await tx
      .select({ id: site.id })
      .from(site)
      .where(and(
        eq(site.workspaceId, workspaceId),
        eq(site.contactId, contactId),
        eq(site.addressFingerprintVersion, ADDRESS_FINGERPRINT_VERSION),
        eq(site.addressFingerprint, fingerprint),
      ))
      .limit(1);
    if (existing) return { siteId: existing.id, existing: true };
  }
  return { siteId: randomUUID(), existing: false };
}

async function persistSite(
  tx: TenantTx,
  ctx: VerifiedRechnerIdentity,
  selected: { siteId: string; existing: boolean },
  contactId: string,
  payload: RechnerIntakeV1,
  fingerprint: Buffer | null,
  now: Date,
): Promise<void> {
  if (selected.existing) return;
  const exact = payload.site.addressMode === "selected";
  await tx.insert(site).values({
    id: selected.siteId,
    workspaceId: ctx.workspaceId,
    contactId,
    label: "Rechner-Standort",
    formattedAddress: payload.site.formattedAddress,
    addressFingerprint: fingerprint,
    addressFingerprintVersion: exact ? ADDRESS_FINGERPRINT_VERSION : null,
    addressMode: payload.site.addressMode,
    street: exact ? payload.site.street : null,
    houseNumber: exact ? payload.site.houseNumber : null,
    postalCode: exact ? payload.site.postalCode : null,
    city: exact ? payload.site.city : null,
    country: payload.site.countryCode,
    lat: payload.site.latitude,
    lng: payload.site.longitude,
    geocodeSource: payload.site.geocodeSource,
    geocodePrecision: payload.site.precision,
    addressFollowUpRequired: !exact,
    pinConfirmed: false,
    createdAt: now,
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: selected.siteId,
    eventType: "site.created",
    actor: ctx.actor,
    payload: { siteId: selected.siteId },
  });
}

function calculationOnly(payload: RechnerIntakeV1): RechnerCalculationSnapshotV1 {
  const value = payload.calculation;
  if (!value) throw new RechnerInvalidRequestError();
  return {
    schemaVersion: value.schemaVersion,
    calculatedAt: value.calculatedAt,
    branch: value.branch,
    questionnaireVariant: value.questionnaireVariant,
    resultIntegrity: value.resultIntegrity,
    inputs: value.inputs,
    provenance: value.provenance,
    result: value.result,
  };
}

function requirementsOnly(payload: RechnerIntakeV1): RechnerProjectRequirementsV1 {
  const calculation = payload.calculation;
  if (!calculation) throw new RechnerInvalidRequestError();
  const requested = calculation.inputs.requestedProducts;
  return {
    schemaVersion: "project-requirements.rechner.v1",
    source: RECHNER_SOURCE_KEY,
    branch: calculation.branch,
    requestedProducts: {
      targetStorageKwh: requested.targetStorageKwh,
      wallbox: requested.wallbox,
      bidirectionalCharging: requested.bidirectionalCharging,
      backupPower: requested.backupPower,
    },
  };
}

export async function processRechnerIntake(
  tx: TenantTx,
  ctx: VerifiedRechnerIdentity,
  payload: RechnerIntakeV1,
  meta: RechnerIntakeMeta,
): Promise<RechnerIntakeReceiptV1> {
  // Der Modulrand bleibt auch bei einem spaeteren zweiten Aufrufer strikt.
  // Dadurch kann nur ein vollstaendiger calculation-only Vertrag persistieren.
  if (!validateRechnerIntake(payload).ok) throw new RechnerInvalidRequestError();
  const hash = requestHash(meta);

  const firstReplay = await findReceipt(tx, ctx.workspaceId, payload.submissionId);
  if (firstReplay) return replayOrConflict(firstReplay, hash);

  // Key-Rotation darf Exact-Replays nicht in zwei getrennte Rate-Lanes
  // aufspalten. Der Receipt-Namespace wird deshalb vor jedem Fachlimit und
  // jeder Dedupe-Sperre serialisiert, danach wird der persistierte Hash erneut
  // gelesen.
  await advisoryLock(
    tx,
    `rechner-receipt:v1:${ctx.workspaceId}:${RECHNER_SOURCE_KEY}:${payload.submissionId}`,
  );
  const replayAfterReceiptLock = await findReceipt(tx, ctx.workspaceId, payload.submissionId);
  if (replayAfterReceiptLock) return replayOrConflict(replayAfterReceiptLock, hash);

  await enforceRateLimit(tx, ctx, meta.receivedAt);
  const replayAfterRateLock = await findReceipt(tx, ctx.workspaceId, payload.submissionId);
  if (replayAfterRateLock) return replayOrConflict(replayAfterRateLock, hash);

  // Vor der ersten Fachmutation normalisieren und erneut begrenzen: NFKC kann
  // einzelne schema-gueltige Unicode-Zeichen in mehrere Zeichen expandieren.
  const displayName = normalizedRequiredText(payload.customer.displayName, 1, 200);
  const emailPrimary = normalizedRequiredText(payload.customer.email, 3, 254);
  const email = emailPrimary.toLowerCase();
  const phoneE164 = normalizeRechnerPhone(payload.customer.phoneRaw);
  await lockContactIdentities(tx, ctx.workspaceId, email, phoneE164);

  // Ein anderer Rotations-Key kann denselben Request waehrend unseres
  // Rate-Locks verarbeitet haben. Noch einmal pruefen, bevor Dedupe liest.
  const replayAfterIdentityLock = await findReceipt(tx, ctx.workspaceId, payload.submissionId);
  if (replayAfterIdentityLock) return replayOrConflict(replayAfterIdentityLock, hash);

  const candidates = await contactCandidates(tx, ctx.workspaceId, email, phoneE164);
  const contactDecision = decideContact(candidates, email, phoneE164);
  const fingerprint = selectedAddressFingerprint(payload);
  const selectedSite = await selectOrAllocateSite(
    tx,
    ctx.workspaceId,
    contactDecision.contactId,
    payload,
    fingerprint,
  );

  const receiptId = randomUUID();
  const projectId = randomUUID();
  const snapshotId = randomUUID();
  const requirementId = randomUUID();
  const [claimed] = await tx
    .insert(inboundReceipt)
    .values({
      id: receiptId,
      workspaceId: ctx.workspaceId,
      sourceKey: RECHNER_SOURCE_KEY,
      submissionId: payload.submissionId,
      contractVersion: payload.contractVersion,
      bodySha256: hash,
      authKeyId: ctx.keyId,
      signedAt: meta.signedAt,
      submittedAt: contractDate(payload.submittedAt),
      receivedAt: meta.receivedAt,
      producerApplication: payload.producer.application,
      producerGitRevision: payload.producer.gitRevision,
      producerEnvironment: payload.producer.environment,
      producerDeploymentId: payload.producer.deploymentId,
      calculatorEngine: payload.producer.calculatorEngine,
      acquisition: payload.acquisition,
      privacyPurpose: payload.privacy.purpose,
      privacyLegalBasis: payload.privacy.legalBasis,
      privacyNoticeVersion: payload.privacy.noticeVersion,
      privacyNoticeUrl: payload.privacy.noticeUrl,
      contactResolution: contactDecision.resolution,
      contactId: contactDecision.contactId,
      emailMatchContactId: contactDecision.emailMatchContactId,
      phoneMatchContactId: contactDecision.phoneMatchContactId,
      siteId: selectedSite.siteId,
      projectId,
    })
    .onConflictDoNothing({
      target: [
        inboundReceipt.workspaceId,
        inboundReceipt.sourceKey,
        inboundReceipt.submissionId,
      ],
    })
    .returning({ id: inboundReceipt.id });

  if (!claimed) {
    const replay = await findReceipt(tx, ctx.workspaceId, payload.submissionId);
    if (!replay) throw new RechnerIdempotencyConflictError();
    return replayOrConflict(replay, hash);
  }

  const requestLane = await resolveDefaultRequestLane(tx, ctx.workspaceId);

  await persistContact(
    tx,
    ctx,
    contactDecision,
    payload,
    displayName,
    emailPrimary,
    email,
    phoneE164,
    meta.receivedAt,
  );
  await persistSite(
    tx,
    ctx,
    selectedSite,
    contactDecision.contactId,
    payload,
    fingerprint,
    meta.receivedAt,
  );

  await tx.insert(project).values({
    id: projectId,
    workspaceId: ctx.workspaceId,
    contactId: contactDecision.contactId,
    siteId: selectedSite.siteId,
    kanbanBoardId: requestLane.boardId,
    kanbanColumnId: requestLane.columnId,
    name: "Rechner-Anfrage",
    phase: "request",
    outcome: "open",
    sourceKey: RECHNER_SOURCE_KEY,
    dedupeReviewRequired: contactDecision.reviewRequired,
    catalogResolutionStatus: "pending",
    createdAt: meta.receivedAt,
    updatedAt: meta.receivedAt,
  });

  // v5-Lead-only-Fan-out (Producer wmee-rechner-v5): Kontaktformular-Leads
  // kommen ohne Berechnungs-Snapshot — das Board zeigt dann eine
  // unqualifizierte Anfrage ohne Kalkulations-Snapshot/Anforderungen.
  // v3 bleibt strikt (Schema: calculation Pflicht für wmee-rechner-v3).
  if (payload.calculation) {
    const snapshot = calculationOnly(payload);
    await tx.insert(calculatorSnapshot).values({
      id: snapshotId,
      workspaceId: ctx.workspaceId,
      receiptId,
      projectId,
      schemaVersion: snapshot.schemaVersion,
      calculatorEngine: payload.producer.calculatorEngine,
      resultIntegrity: snapshot.resultIntegrity,
      investmentSource: snapshot.provenance.investment,
      calculatedAt: contractDate(snapshot.calculatedAt),
      snapshot,
      createdAt: meta.receivedAt,
    });

    await tx.insert(projectRequirement).values({
      id: requirementId,
      workspaceId: ctx.workspaceId,
      projectId,
      revision: 1,
      schemaVersion: "project-requirements.rechner.v1",
      sourceSnapshotId: snapshotId,
      requirements: requirementsOnly(payload),
      createdAt: meta.receivedAt,
    });
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: projectId,
    eventType: "project.requested_from_rechner",
    actor: ctx.actor,
    payload: { projectId, contactId: contactDecision.contactId, siteId: selectedSite.siteId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "rechner.intake.write",
    resource: "project",
    allowed: true,
    details: {
      receiptId,
      projectId,
      contactId: contactDecision.contactId,
      siteId: selectedSite.siteId,
      snapshotId: payload.calculation ? snapshotId : null,
      requirementId: payload.calculation ? requirementId : null,
    },
  });

  return receiptResponse({ id: receiptId, submissionId: payload.submissionId, bodySha256: hash }, false);
}
