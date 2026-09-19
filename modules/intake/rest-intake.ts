import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  contact,
  inboundRestReceipt,
  kanbanBoard,
  kanbanColumn,
  project,
  site,
} from "@/lib/db/schema";
import { contactNameSplitV1 } from "@/lib/db/schema/contact-name-split";
import type { TenantTx } from "@/lib/db/types";
import {
  ADDRESS_FINGERPRINT_VERSION,
  addressFingerprint,
} from "@/lib/address-fingerprint";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import { validateRestIntake } from "@/lib/integrations/rest/contract";
import {
  RestIdempotencyConflictError,
  RestInvalidRequestError,
  RestRateLimitError,
} from "@/lib/integrations/rest/errors";
import type { VerifiedRestIdentity } from "@/lib/integrations/rest/signature";
import {
  REST_SOURCE_KEY,
  type RestIntakeMeta,
  type RestIntakeReceiptV1,
  type RestIntakeV1,
} from "@/lib/integrations/rest/types";
import { resolveLeadSourceForProducer } from "@/modules/lead-sources";
import { normalizeRechnerPhone } from "./service";

// F1-18 Generische REST-Lead-Aufnahme. Spiegel des Broker-Flows mit eigener
// Dedupe-Domäne (Workspace, Client-Record-ID) OHNE Key-ID: Rotation erzeugt
// keine Duplikate. Kontakt-Entscheidung, Site-Vergabe und Default-Lane sind
// bewusst dieselbe Semantik wie Rechner/Broker; die Helfer sind hier lokal,
// weil service.ts einer fremden Lane-Partition gehört (kein Import-Schutt,
// keine zirkulären Abhängigkeiten).

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

type ExistingRestReceipt = {
  id: string;
  clientRecordId: string;
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

function restNormalizedRequiredText(value: string, minLength: number, maxLength: number): string {
  const normalized = value.normalize("NFKC").trim();
  // JSON Schema maxLength und PostgreSQL length() zählen Unicode-Codepoints,
  // nicht UTF-16-Codeunits wie JavaScripts string.length.
  const length = Array.from(normalized).length;
  if (length < minLength || length > maxLength) {
    throw new RestInvalidRequestError();
  }
  return normalized;
}

function restNormalizedOptionalText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  return restNormalizedRequiredText(value, 1, maxLength);
}

function restRequestHash(meta: RestIntakeMeta): Buffer {
  if (!/^[0-9a-f]{64}$/.test(meta.payloadSha256)) throw new RestInvalidRequestError();
  if (
    !Number.isFinite(meta.receivedAt.getTime())
    || !Number.isFinite(meta.signedAt.getTime())
  ) {
    throw new RestInvalidRequestError();
  }
  return Buffer.from(meta.payloadSha256, "hex");
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function restReceiptResponse(row: ExistingRestReceipt, duplicate: boolean): RestIntakeReceiptV1 {
  return {
    contractVersion: "rest-intake-receipt.v1",
    receiptId: row.id,
    clientRecordId: row.clientRecordId,
    status: "processed",
    duplicate,
  };
}

async function findRestReceipt(
  tx: TenantTx,
  workspaceId: string,
  clientRecordId: string,
): Promise<ExistingRestReceipt | null> {
  const [row] = await tx
    .select({
      id: inboundRestReceipt.id,
      clientRecordId: inboundRestReceipt.clientRecordId,
      bodySha256: inboundRestReceipt.bodySha256,
    })
    .from(inboundRestReceipt)
    .where(and(
      eq(inboundRestReceipt.workspaceId, workspaceId),
      eq(inboundRestReceipt.clientRecordId, clientRecordId),
    ))
    .limit(1);
  return row ?? null;
}

function restReplayOrConflict(row: ExistingRestReceipt, hash: Buffer): RestIntakeReceiptV1 {
  if (!sameHash(row.bodySha256, hash)) throw new RestIdempotencyConflictError();
  return restReceiptResponse(row, true);
}

async function advisoryLock(tx: TenantTx, token: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${token}, 0))`);
}

async function enforceRestRateLimit(
  tx: TenantTx,
  ctx: VerifiedRestIdentity,
  receivedAt: Date,
): Promise<void> {
  await advisoryLock(tx, `rest-rate:v1:${ctx.workspaceId}:${ctx.keyId}`);
  const windowStart = new Date(receivedAt.getTime() - RATE_LIMIT_WINDOW_MS);
  const result = await tx.execute<{ n: number; oldest: Date | null; [key: string]: unknown }>(sql`
    select count(*)::int as n, min(received_at) as oldest
    from inbound_rest_receipt
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
  throw new RestRateLimitError(retryAfterSeconds);
}

async function lockContactIdentities(
  tx: TenantTx,
  workspaceId: string,
  email: string,
  phoneE164: string | null,
): Promise<void> {
  // Bewusst derselbe Advisory-Namespace wie Rechner/Broker:
  // Kontakt-Identitäten werden pfadübergreifend serialisiert.
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

async function persistRestContact(
  tx: TenantTx,
  ctx: VerifiedRestIdentity,
  decision: ContactDecision,
  phoneRaw: string | null,
  displayName: string,
  emailPrimary: string,
  email: string,
  phoneE164: string | null,
  now: Date,
): Promise<void> {
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
  if (decision.existing.phoneRaw === null && phoneRaw !== null) update.phoneRaw = phoneRaw;
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

function restSelectedAddressFingerprint(payload: RestIntakeV1): Buffer | null {
  if (payload.site.addressMode !== "selected") return null;
  const { street, houseNumber, postalCode, city, countryCode } = payload.site;
  if (!street || !houseNumber || !postalCode || !city) throw new RestInvalidRequestError();

  return addressFingerprint({
    countryCode,
    postalCode,
    city,
    street,
    houseNumber,
  });
}

async function restSelectOrAllocateSite(
  tx: TenantTx,
  workspaceId: string,
  contactId: string,
  addressMode: string,
  fingerprint: Buffer | null,
): Promise<{ siteId: string; existing: boolean }> {
  // Rechner-/Broker-Parität: gleiche selected-Adresse desselben Kontakts
  // wird wiederverwendet, sonst verletzt der zweite Record das
  // Partial-Unique site_ws_contact_address_fingerprint_uq mit rohem 500.
  if (addressMode === "selected" && fingerprint) {
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

async function persistRestSite(
  tx: TenantTx,
  ctx: VerifiedRestIdentity,
  selected: { siteId: string; existing: boolean },
  contactId: string,
  payload: RestIntakeV1,
  fingerprint: Buffer | null,
  now: Date,
): Promise<void> {
  if (selected.existing) return;
  const siteId = selected.siteId;
  const exact = payload.site.addressMode === "selected";
  await tx.insert(site).values({
    id: siteId,
    workspaceId: ctx.workspaceId,
    contactId,
    label: "REST-Standort",
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
    aggregateId: siteId,
    eventType: "site.created",
    actor: ctx.actor,
    payload: { siteId },
  });
}

export async function processRestIntake(
  tx: TenantTx,
  ctx: VerifiedRestIdentity,
  payload: RestIntakeV1,
  meta: RestIntakeMeta,
): Promise<RestIntakeReceiptV1> {
  // Der Modulrand bleibt auch bei einem spaeteren zweiten Aufrufer strikt.
  if (!validateRestIntake(payload).ok) throw new RestInvalidRequestError();
  // Kanonische Record-ID (NFKC-Trim): Padding erzeugt keine eigenen
  // Dedupe-Zeilen; Lock, Lookup, Receipt und Response nutzen dieselbe Form.
  const clientRecordId = restNormalizedRequiredText(payload.clientRecordId, 1, 128);
  // sourceName ist NUR F1.8-Auflösung und Receipt-Notiz, niemals Dedupe.
  const sourceName = restNormalizedOptionalText(payload.sourceName, 100);
  const hash = restRequestHash(meta);

  const firstReplay = await findRestReceipt(tx, ctx.workspaceId, clientRecordId);
  if (firstReplay) return restReplayOrConflict(firstReplay, hash);

  // Wie Rechner/Broker: Receipt-Namespace OHNE Key-ID vor Fachlimit und
  // Dedupe-Sperre serialisieren, danach den persistierten Hash erneut lesen.
  // Key-Rotation spaltet Exact-Replays dadurch nicht in zwei Lanes auf.
  await advisoryLock(
    tx,
    `rest-receipt:v1:${ctx.workspaceId}:${clientRecordId}`,
  );
  const replayAfterReceiptLock = await findRestReceipt(tx, ctx.workspaceId, clientRecordId);
  if (replayAfterReceiptLock) return restReplayOrConflict(replayAfterReceiptLock, hash);

  await enforceRestRateLimit(tx, ctx, meta.receivedAt);
  const replayAfterRateLock = await findRestReceipt(tx, ctx.workspaceId, clientRecordId);
  if (replayAfterRateLock) return restReplayOrConflict(replayAfterRateLock, hash);

  const displayName = restNormalizedRequiredText(payload.customer.displayName, 1, 200);
  const emailPrimary = restNormalizedRequiredText(payload.customer.email, 3, 254);
  const email = emailPrimary.toLowerCase();
  const phoneE164 = payload.customer.phoneRaw ? normalizeRechnerPhone(payload.customer.phoneRaw) : null;
  await lockContactIdentities(tx, ctx.workspaceId, email, phoneE164);

  const replayAfterIdentityLock = await findRestReceipt(tx, ctx.workspaceId, clientRecordId);
  if (replayAfterIdentityLock) return restReplayOrConflict(replayAfterIdentityLock, hash);

  const candidates = await contactCandidates(tx, ctx.workspaceId, email, phoneE164);
  const contactDecision = decideContact(candidates, email, phoneE164);
  const fingerprint = restSelectedAddressFingerprint(payload);
  const selectedSite = await restSelectOrAllocateSite(
    tx,
    ctx.workspaceId,
    contactDecision.contactId,
    payload.site.addressMode,
    fingerprint,
  );

  const receiptId = randomUUID();
  const projectId = randomUUID();
  const [claimed] = await tx
    .insert(inboundRestReceipt)
    .values({
      id: receiptId,
      workspaceId: ctx.workspaceId,
      clientRecordId,
      sourceName,
      contractVersion: payload.contractVersion,
      bodySha256: hash,
      authKeyId: ctx.keyId,
      signedAt: meta.signedAt,
      receivedAt: meta.receivedAt,
      contactResolution: contactDecision.resolution,
      contactId: contactDecision.contactId,
      emailMatchContactId: contactDecision.emailMatchContactId,
      phoneMatchContactId: contactDecision.phoneMatchContactId,
      siteId: selectedSite.siteId,
      projectId,
      note: payload.note,
    })
    .onConflictDoNothing({
      target: [
        inboundRestReceipt.workspaceId,
        inboundRestReceipt.clientRecordId,
      ],
    })
    .returning({ id: inboundRestReceipt.id });

  if (!claimed) {
    const replay = await findRestReceipt(tx, ctx.workspaceId, clientRecordId);
    if (!replay) throw new RestIdempotencyConflictError();
    return restReplayOrConflict(replay, hash);
  }

  const requestLane = await resolveDefaultRequestLane(tx, ctx.workspaceId);

  await persistRestContact(
    tx,
    ctx,
    contactDecision,
    payload.customer.phoneRaw,
    displayName,
    emailPrimary,
    email,
    phoneE164,
    meta.receivedAt,
  );
  await persistRestSite(
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
    name: "REST-Anfrage",
    phase: "request",
    outcome: "open",
    sourceKey: REST_SOURCE_KEY,
    // F1.8: aktive Lead-Quelle mit sourceName zuordnen; ohne Namen oder ohne
    // Treffer bleibt die Quelle ehrlich leer (keine implizite Anlage).
    // KEIN Auto-Routing: revision bleibt 0.
    leadSourceId: sourceName
      ? await resolveLeadSourceForProducer(tx, ctx, sourceName)
      : null,
    dedupeReviewRequired: contactDecision.reviewRequired,
    catalogResolutionStatus: "pending",
    createdAt: meta.receivedAt,
    updatedAt: meta.receivedAt,
  });

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: projectId,
    eventType: "project.requested_from_rest",
    actor: ctx.actor,
    payload: { projectId, contactId: contactDecision.contactId, siteId: selectedSite.siteId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "rest.intake.write",
    resource: "project",
    allowed: true,
    details: {
      receiptId,
      projectId,
      contactId: contactDecision.contactId,
      siteId: selectedSite.siteId,
      clientRecordId,
      sourceName,
    },
  });

  return restReceiptResponse(
    { id: receiptId, clientRecordId, bodySha256: hash },
    false,
  );
}
