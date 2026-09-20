import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_PAYMENT_OPTION_COMMAND_VERSION,
  OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
  OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
  OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
  OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
  OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
  type CreateOfferCommandV1,
  type CreatePaymentOptionCommand,
} from "@/lib/integrations/offers/contract";
import {
  SIGNATURE_REQUEST_CREATE_VERSION,
  SIGNATURE_REQUEST_SIGN_VERSION,
} from "@/lib/integrations/offers/signature-contract";
import type { ServiceCtx } from "@/lib/permissions";
import type { TenantTx } from "@/lib/db/types";
import {
  archivePaymentOption,
  createOfferFromRequest,
  createPaymentOption,
  duplicateOfferVariant,
  OfferBlockedError,
  OfferNotFoundError,
  requestOfferPdfDraft,
  setOptionalBundles,
  setPrimaryVariant,
  setTotalPriceOverride,
  setVariantPaymentOption,
} from "@/modules/offers";
import {
  createSignatureRequest,
  revokeSignatureByCustomer,
  signSignatureByToken,
} from "@/modules/signatures";
import { seedM201ReadyProject } from "../e2e/m2-01-fixture";
import { testPool } from "../setup/test-db";

/**
 * F2-02b Varianten-Rest — RED-first (Spec: docs/spec/F2-02b-varianten-rest.md).
 * F202B-DB-01..06 muessen am Alt-Code FAILEN (Duplikat-Kopie + Lock-Guards
 * fehlen); F202B-DB-07 ist ein Regression-PIN und erwartet GRUEN.
 */

type Members = { workspaceId: string; operatorId: string };

type OfferFixture = {
  members: Members;
  projectId: string;
  offerId: string;
  basisVariantId: string;
  secondVariantId: string;
};

type LockTarget = "pending" | "signed" | "revoked";

const LOCK_CODES: Record<LockTarget, string> = {
  pending: "variant_signature_pending",
  signed: "variant_signed",
  revoked: "variant_revoked_by_customer",
};

async function createMembers(): Promise<Members> {
  const members = { workspaceId: randomUUID(), operatorId: randomUUID() };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F2-02b Varianten-Rest')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${members.operatorId}::uuid, ${`${members.operatorId}@f202b.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (
        ${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
        '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
           "discounts":true,"see_purchase_prices":true}'::jsonb
      )
    `);
  });
  return members;
}

async function createTwoVariantOffer(): Promise<OfferFixture> {
  const members = await createMembers();
  const databaseUrl = process.env.POSTGRES_URL_TEST;
  if (!databaseUrl) throw new Error("POSTGRES_URL_TEST fehlt.");
  const seed = await seedM201ReadyProject(databaseUrl, {
    workspaceId: members.workspaceId,
    editorIdentityId: members.operatorId,
    skuSuffix: `F202B-${randomUUID().slice(0, 8)}`,
  });
  const command: CreateOfferCommandV1 = {
    schemaVersion: OFFER_CREATE_COMMAND_VERSION,
    projectId: seed.projectId,
    expectedRequirementRevision: 1,
    expectedCalculationRevision: 1,
    expectedResolutionRevision: 1,
    forecastValueNetCents: 1_250_000,
    priceAudience: "b2c",
    priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
    taxTreatment: "standard_19",
  };
  const created = await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => createOfferFromRequest(tx, ctx, command),
  );
  const second = await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => duplicateOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
      offerId: created.offerId,
      sourceVariantId: created.variantId,
      expectedSourceRevision: 1,
      name: "F202B zweite Variante",
    }),
  );
  return {
    members,
    projectId: seed.projectId,
    offerId: created.offerId,
    basisVariantId: created.variantId,
    secondVariantId: second.variantId,
  };
}

async function duplicateOnce(fx: OfferFixture, name: string): Promise<string> {
  const dup = await withAuthorizedTenantOn(
    testPool, fx.members.operatorId, fx.members.workspaceId,
    (tx, ctx) => duplicateOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
      offerId: fx.offerId,
      sourceVariantId: fx.basisVariantId,
      expectedSourceRevision: 1,
      name,
    }),
  );
  return dup.variantId;
}

function asOperator<T>(
  fx: OfferFixture,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return withAuthorizedTenantOn(
    testPool, fx.members.operatorId, fx.members.workspaceId, fn,
  );
}

async function createPurchaseOption(
  fx: OfferFixture,
): Promise<{ id: string }> {
  const command: CreatePaymentOptionCommand = {
    schemaVersion: OFFER_PAYMENT_OPTION_COMMAND_VERSION,
    key: "purchase",
    label: "Kauf",
  };
  return asOperator(fx, (tx, ctx) => createPaymentOption(tx, ctx, command));
}

type VariantRow = {
  id: string;
  is_primary: boolean;
  optional_bundles: unknown;
  payment_option_id: string | null;
  updated_at: Date | string;
  [key: string]: unknown;
};

// pg liefert timestamptz ueber den Raw-SQL-Pfad als String, nicht als Date —
// Timestamps daher als String normalisieren und vergleichen.
function stamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function readVariantRow(
  workspaceId: string,
  variantId: string,
): Promise<VariantRow> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<VariantRow>(sql`
      select id, is_primary, optional_bundles, payment_option_id, updated_at
        from offer_variant
       where workspace_id = ${workspaceId}::uuid
         and id = ${variantId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F202B: Variante fehlt.");
    return row;
  });
}

async function readOfferOverride(
  workspaceId: string,
  offerId: string,
): Promise<{ override: number | null; updatedAt: string }> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{
      total_price_override_net_cents: string | null;
      updated_at: Date | string;
      [key: string]: unknown;
    }>(sql`
      select total_price_override_net_cents, updated_at
        from offer
       where workspace_id = ${workspaceId}::uuid
         and id = ${offerId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F202B: Offer fehlt.");
    return {
      override: row.total_price_override_net_cents === null
        ? null
        : Number(row.total_price_override_net_cents),
      updatedAt: stamp(row.updated_at),
    };
  });
}

async function countOfferEvents(
  workspaceId: string,
  offerId: string,
): Promise<number> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from domain_events
      where workspace_id = ${workspaceId}::uuid
        and aggregate_id = ${offerId}::uuid
    `);
    return result.rows[0]?.n ?? 0;
  });
}

async function countOfferAudits(
  workspaceId: string,
  offerId: string,
): Promise<number> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
      where workspace_id = ${workspaceId}::uuid
        and resource = 'offer'
        and details->>'offerId' = ${offerId}
    `);
    return result.rows[0]?.n ?? 0;
  });
}

async function readLatestPayload(
  workspaceId: string,
  offerId: string,
  eventType: string,
): Promise<Record<string, unknown>> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ payload: Record<string, unknown> }>(sql`
      select payload from domain_events
      where workspace_id = ${workspaceId}::uuid
        and aggregate_id = ${offerId}::uuid
        and event_type = ${eventType}
      order by occurred_at desc, id desc
      limit 1
    `);
    return result.rows[0]?.payload ?? {};
  });
}

async function readPrimaryFlags(
  workspaceId: string,
  offerId: string,
): Promise<Array<{ id: string; is_primary: boolean }>> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ id: string; is_primary: boolean }>(sql`
      select id, is_primary from offer_variant
      where workspace_id = ${workspaceId}::uuid and offer_id = ${offerId}::uuid
      order by ordinal, id
    `);
    return result.rows;
  });
}

async function expectBlocked(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(OfferBlockedError);
  expect((outcome as OfferBlockedError).code).toBe(code);
}

// Einmal je Workspace: Freigabe-Voraussetzungen (Muster F1614 sealVariantWithLock:
// Profil/Empfaenger-Revisionen sind nicht idempotent, daher Guard per Map).
type PrereqState = {
  secondActorId: string;
  profile: { profile_id: string; profile_revision_id: string; profile_revision: number };
  recipient: { recipient_revision_id: string; recipient_revision: number };
};
const prereqByWorkspace = new Map<string, PrereqState>();

async function ensureReleasePrereqs(fx: OfferFixture): Promise<PrereqState> {
  const { workspaceId, operatorId } = fx.members;
  const cached = prereqByWorkspace.get(workspaceId);
  if (cached) return cached;
  const secondActorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      update project set phase = 'offer'
       where workspace_id = ${workspaceId}::uuid
         and id = ${fx.projectId}::uuid
    `);
    await tx.execute(sql`
      update membership set role = 'admin', capabilities = '{}'::jsonb
       where workspace_id = ${workspaceId}::uuid
         and user_id = ${operatorId}::uuid
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${secondActorId}::uuid, ${`f202b-${secondActorId}@example.invalid`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${workspaceId}::uuid, ${secondActorId}::uuid, 'admin', '{}'::jsonb)
    `);
  });

  const sender = {
    legalName: "F202B Energie GmbH",
    tradingName: "F202B",
    representedBy: "F202B Vertretung",
    address: {
      street: "Testweg",
      houseNumber: "1",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    email: "office@f202b.invalid",
    phoneE164: "+493000000000",
    websiteHttpsUrl: "https://f202b.invalid",
    registerCourt: "F202B Registergericht",
    registerNumber: "HRB F202B 1",
    vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
    privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
  };
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.revise_offer_release_profile(
        ${workspaceId}::uuid, 0, 'F202B Profil',
        ${JSON.stringify(sender)}::jsonb, ${JSON.stringify(legalDocuments)}::jsonb
      )
    `);
  });
  const profile = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{
      profile_id: string;
      profile_revision_id: string;
      profile_revision: number;
    }>(sql`
      select profile.id as profile_id,
             revision.id as profile_revision_id,
             revision.revision as profile_revision
        from offer_release_profile as profile
        join offer_release_profile_revision as revision
          on revision.workspace_id = profile.workspace_id
         and revision.profile_id = profile.id
         and revision.revision = profile.current_revision
       where profile.workspace_id = ${workspaceId}::uuid
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F202B: Release-Profil fehlt.");
    return row;
  });
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.activate_offer_release_profile(
        ${workspaceId}::uuid, ${profile.profile_id}::uuid,
        ${profile.profile_revision_id}::uuid, ${profile.profile_revision}::integer
      )
    `);
  });
  const billingAddress = {
    street: "Rechnungsweg",
    houseNumber: "8a",
    postalCode: "10999",
    city: "Berlin",
    country: "DE",
  };
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.revise_offer_recipient(
        ${workspaceId}::uuid, ${fx.offerId}::uuid, 0,
        'F202B Rechnungsempfaenger', 'F202B Kundin GmbH',
        'rechnung@f202b.invalid', ${JSON.stringify(billingAddress)}::jsonb, true
      )
    `);
  });
  const recipient = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{
      recipient_revision_id: string;
      recipient_revision: number;
    }>(sql`
      select revision.id as recipient_revision_id,
             revision.revision as recipient_revision
        from offer_recipient as recipient
        join offer_recipient_revision as revision
          on revision.workspace_id = recipient.workspace_id
         and revision.recipient_id = recipient.id
         and revision.revision = recipient.current_revision
       where recipient.workspace_id = ${workspaceId}::uuid
         and recipient.offer_id = ${fx.offerId}::uuid
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F202B: Empfaenger fehlt.");
    return row;
  });
  const state: PrereqState = { secondActorId, profile, recipient };
  prereqByWorkspace.set(workspaceId, state);
  return state;
}

// Versiegelt eine Variante bis zum pending Signatur-Request (Muster F1614:
// PDF-Draft → Candidate → Issuance → createSignatureRequest). Gibt den
// Token-Plaintext fuer sign/revoke zurueck.
async function sealVariantToPending(
  fx: OfferFixture,
  variantId: string,
): Promise<{ requestId: string; token: string }> {
  const { workspaceId, operatorId } = fx.members;
  const { profile, recipient, secondActorId } = await ensureReleasePrereqs(fx);

  const draft = await withAuthorizedTenantOn(
    testPool, operatorId, workspaceId,
    (tx, ctx) => requestOfferPdfDraft(tx, ctx, {
      workspaceId,
      offerId: fx.offerId,
      variantId,
      expectedVariantRevision: 1,
    }),
  );
  const draftArtifact = Buffer.from(
    `%PDF-1.7\n${"f202b-release-source".repeat(8)}\n%%EOF`,
    "utf8",
  );
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      update offer_pdf_draft
         set state = 'running', attempt_count = 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + interval '5 minutes',
             started_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${draft.jobId}::uuid
         and state = 'queued'
    `);
    await tx.execute(sql`
      update offer_pdf_draft
         set state = 'succeeded', lease_token = null, lease_expires_at = null,
             artifact_mime_type = 'application/pdf',
             artifact_bytes = ${draftArtifact},
             artifact_sha256 = sha256(${draftArtifact}),
             artifact_size_bytes = octet_length(${draftArtifact}),
             finished_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${draft.jobId}::uuid
         and state = 'running'
    `);
  });

  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.prepare_offer_release_candidate(
        ${workspaceId}::uuid, ${fx.offerId}::uuid, ${variantId}::uuid, 1,
        ${draft.jobId}::uuid, ${profile.profile_id}::uuid,
        ${profile.profile_revision_id}::uuid, ${profile.profile_revision}::integer,
        ${recipient.recipient_revision_id}::uuid, ${recipient.recipient_revision}::integer,
        ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date
      )
    `);
  });
  const candidateId = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{ candidate_id: string }>(sql`
      select id as candidate_id
        from offer_release_candidate
       where workspace_id = ${workspaceId}::uuid
         and offer_id = ${fx.offerId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F202B: Release-Kandidat fehlt.");
    return row.candidate_id;
  });
  const candidateArtifact = Buffer.from(
    `%PDF-1.7\n${"f202b-release-candidate".repeat(8)}\n%%EOF`,
    "utf8",
  );
  const artifactVersion = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      update offer_release_candidate
         set state = 'running', attempt_count = 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + interval '5 minutes',
             started_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${candidateId}::uuid
         and state = 'queued'
    `);
    await tx.execute(sql`
      update offer_release_candidate
         set state = 'ready_for_approval', lease_token = null,
             lease_expires_at = null, artifact_mime_type = 'application/pdf',
             artifact_bytes = ${candidateArtifact},
             artifact_sha256 = sha256(${candidateArtifact}),
             artifact_size_bytes = octet_length(${candidateArtifact}),
             artifact_version = ${artifactVersion}::uuid,
             finished_at = clock_timestamp(), updated_at = clock_timestamp()
       where workspace_id = ${workspaceId}::uuid
         and id = ${candidateId}::uuid
         and state = 'running'
    `);
  });
  await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.approve_offer_release_candidate(
        ${workspaceId}::uuid, ${fx.offerId}::uuid, ${candidateId}::uuid,
        ${artifactVersion}::uuid, true, true, true, true, null
      )
    `);
  });

  const issuanceId = await withAuthorizedTenantOn(testPool, operatorId, workspaceId, async (tx) => {
    const result = await tx.execute<{ result: { issuanceId?: unknown } }>(sql`
      select public.prepare_offer_issuance(
        ${workspaceId}::uuid, ${fx.offerId}::uuid, ${candidateId}::uuid
      ) as result
    `);
    const id = result.rows[0]?.result.issuanceId;
    if (typeof id !== "string") throw new Error("F202B: Issuance-Reservation fehlt.");
    return id;
  });
  const lease = randomUUID();
  const issuanceArtifact = Buffer.from(
    `%PDF-1.7\n${"f202b-final-issuance".repeat(8)}\n%%EOF`,
    "utf8",
  );
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      select public.claim_offer_issuance_render(
        ${workspaceId}::uuid, ${issuanceId}::uuid, ${lease}::uuid, 120
      ) as result
    `);
    await tx.execute(sql`
      select public.finalize_offer_issuance_render_success(
        ${workspaceId}::uuid, ${issuanceId}::uuid, ${lease}::uuid, 1, ${issuanceArtifact}
      ) as result
    `);
  });
  for (const actorId of [operatorId, secondActorId]) {
    const approval = await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx) => {
      const result = await tx.execute<{ result: { status?: unknown } }>(sql`
        select public.approve_offer_issuance(
          ${workspaceId}::uuid, ${issuanceId}::uuid, true, true, true, true, null
        ) as result
      `);
      return result.rows[0]?.result;
    });
    if (approval?.status !== "approved") throw new Error("F202B: Issuance-Freigabe fehlt.");
  }

  const created = await withAuthorizedTenantOn(
    testPool, operatorId, workspaceId,
    (tx, ctx) => createSignatureRequest(tx, ctx, {
      schemaVersion: SIGNATURE_REQUEST_CREATE_VERSION,
      workspaceId,
      offerId: fx.offerId,
      variantId,
      ttlDays: 14,
    }),
  );
  expect(created.status).toBe("pending");
  return { requestId: created.requestId, token: created.token };
}

async function signSealed(token: string): Promise<void> {
  const signed = await signSignatureByToken(testPool, {
    schemaVersion: SIGNATURE_REQUEST_SIGN_VERSION,
    token,
    mode: "click",
    artifactMimeType: null,
    artifactBytes: null,
  });
  expect(signed.status).toBe("signed");
}

async function revokeSealed(token: string): Promise<void> {
  const revoked = await revokeSignatureByCustomer(testPool, { token });
  expect(revoked.status).toBe("revoked_by_customer");
}

async function createSealedOffer(target: LockTarget): Promise<OfferFixture> {
  const fx = await createTwoVariantOffer();
  const sealed = await sealVariantToPending(fx, fx.secondVariantId);
  if (target !== "pending") await signSealed(sealed.token);
  if (target === "revoked") await revokeSealed(sealed.token);
  return fx;
}

type BlockSnapshot = {
  bundlesJson: string;
  paymentId: string | null;
  primary: boolean;
  variantUpdated: string;
  override: number | null;
  offerUpdated: string;
  events: number;
  audits: number;
};

async function snapshotBlocked(
  fx: OfferFixture,
  variantId: string,
): Promise<BlockSnapshot> {
  const { workspaceId } = fx.members;
  const variant = await readVariantRow(workspaceId, variantId);
  const offer = await readOfferOverride(workspaceId, fx.offerId);
  return {
    bundlesJson: JSON.stringify(variant.optional_bundles),
    paymentId: variant.payment_option_id,
    primary: variant.is_primary,
    variantUpdated: stamp(variant.updated_at),
    override: offer.override,
    offerUpdated: offer.updatedAt,
    events: await countOfferEvents(workspaceId, fx.offerId),
    audits: await countOfferAudits(workspaceId, fx.offerId),
  };
}

async function expectBlockedUnchanged(
  fx: OfferFixture,
  variantId: string,
  before: BlockSnapshot,
): Promise<void> {
  const { workspaceId } = fx.members;
  const variant = await readVariantRow(workspaceId, variantId);
  const offer = await readOfferOverride(workspaceId, fx.offerId);
  expect(JSON.stringify(variant.optional_bundles)).toBe(before.bundlesJson);
  expect(variant.payment_option_id).toBe(before.paymentId);
  expect(variant.is_primary).toBe(before.primary);
  expect(stamp(variant.updated_at)).toBe(before.variantUpdated);
  expect(offer.override).toBe(before.override);
  expect(offer.updatedAt).toBe(before.offerUpdated);
  expect(await countOfferEvents(workspaceId, fx.offerId)).toBe(before.events);
  expect(await countOfferAudits(workspaceId, fx.offerId)).toBe(before.audits);
}

describe("F2-02b Varianten-Rest (RED)", () => {
  it("F202B-DB-01: Duplikat uebernimmt Bundles + Zahlart als Deep-Copy, nie Primary", async () => {
    const fx = await createTwoVariantOffer();
    const option = await createPurchaseOption(fx);
    const bundles = [
      { name: "Wallbox-Paket", position: 0 },
      { name: "Notstrom-Paket", position: 1 },
    ];
    await asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      bundles,
    }));
    await asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      paymentOptionId: option.id,
    }));
    const copyId = await duplicateOnce(fx, "F202B Kopie");
    const copy = await readVariantRow(fx.members.workspaceId, copyId);
    expect(copy.is_primary).toBe(false);
    expect(copy.payment_option_id).toBe(option.id);
    expect(copy.optional_bundles).toEqual(bundles);
    await asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      bundles: [{ name: "Geaendert", position: 0 }],
    }));
    const reread = await readVariantRow(fx.members.workspaceId, copyId);
    expect(reread.optional_bundles).toEqual(bundles);
  });

  it("F202B-DB-02: Duplikat behaelt archivierte Zahlart ohne Validierungsfehler", async () => {
    const fx = await createTwoVariantOffer();
    const option = await createPurchaseOption(fx);
    await asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      paymentOptionId: option.id,
    }));
    await asOperator(fx, (tx, ctx) => archivePaymentOption(tx, ctx, option.id));
    const copyId = await duplicateOnce(fx, "F202B Archiv-Kopie");
    const copy = await readVariantRow(fx.members.workspaceId, copyId);
    expect(copy.payment_option_id).toBe(option.id);
  });

  it("F202B-DB-03: alle vier Setter blocken bei pending-Lock ohne Write/Event/Audit", async () => {
    const fx = await createSealedOffer("pending");
    const option = await createPurchaseOption(fx);
    const before = await snapshotBlocked(fx, fx.secondVariantId);
    const code = LOCK_CODES.pending;
    await expectBlocked(asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      bundles: [{ name: "Block-Paket", position: 0 }],
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      paymentOptionId: option.id,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 555_000,
    })), code);
    await expectBlockedUnchanged(fx, fx.secondVariantId, before);
  });

  it("F202B-DB-03: alle vier Setter blocken bei signed-Lock ohne Write/Event/Audit", async () => {
    const fx = await createSealedOffer("signed");
    const option = await createPurchaseOption(fx);
    const before = await snapshotBlocked(fx, fx.secondVariantId);
    const code = LOCK_CODES.signed;
    await expectBlocked(asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      bundles: [{ name: "Block-Paket", position: 0 }],
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      paymentOptionId: option.id,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 555_000,
    })), code);
    await expectBlockedUnchanged(fx, fx.secondVariantId, before);
  });

  it("F202B-DB-03: alle vier Setter blocken bei revoked-Lock ohne Write/Event/Audit", async () => {
    const fx = await createSealedOffer("revoked");
    const option = await createPurchaseOption(fx);
    const before = await snapshotBlocked(fx, fx.secondVariantId);
    const code = LOCK_CODES.revoked;
    await expectBlocked(asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      bundles: [{ name: "Block-Paket", position: 0 }],
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      paymentOptionId: option.id,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 555_000,
    })), code);
    await expectBlockedUnchanged(fx, fx.secondVariantId, before);
  });

  it("F202B-DB-04: Lock prueft vor No-op — wertgleiche Calls auf gelockter Variante werfen", async () => {
    const fx = await createTwoVariantOffer();
    const option = await createPurchaseOption(fx);
    const bundles = [{ name: "Noop-Paket", position: 0 }];
    await asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      bundles,
    }));
    await asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      paymentOptionId: option.id,
    }));
    await asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    }));
    await asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 999_000,
    }));
    const sealed = await sealVariantToPending(fx, fx.secondVariantId);
    expect(sealed.requestId).toBeTruthy();
    const code = LOCK_CODES.pending;
    await expectBlocked(asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      bundles,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
      paymentOptionId: option.id,
    })), code);
    await expectBlocked(asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 999_000,
    })), code);
  });

  it("F202B-DB-05: gelockte bisherige Primary blockt Promote; ungelockt switcht ok", async () => {
    const fx = await createTwoVariantOffer();
    await sealVariantToPending(fx, fx.basisVariantId);
    await expectBlocked(asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    })), LOCK_CODES.pending);

    const open = await createTwoVariantOffer();
    const switched = await asOperator(open, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: open.offerId,
      variantId: open.secondVariantId,
    }));
    expect(switched.alreadyPrimary).toBe(false);
    const flags = await readPrimaryFlags(open.members.workspaceId, open.offerId);
    expect(flags.filter((row) => row.is_primary).map((row) => row.id)).toEqual([
      open.secondVariantId,
    ]);
  });

  it("F202B-DB-06: Lock auf Nicht-Primary blockt Override; ohne Locks Set/Clear ok", async () => {
    const fx = await createSealedOffer("pending");
    await expectBlocked(asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 123_000,
    })), LOCK_CODES.pending);

    const open = await createTwoVariantOffer();
    const set = await asOperator(open, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: open.offerId,
      totalPriceOverrideNetCents: 888_000,
    }));
    expect(set.changed).toBe(true);
    expect((await readOfferOverride(open.members.workspaceId, open.offerId)).override)
      .toBe(888_000);
    const cleared = await asOperator(open, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: open.offerId,
      totalPriceOverrideNetCents: null,
    }));
    expect(cleared.changed).toBe(true);
    expect((await readOfferOverride(open.members.workspaceId, open.offerId)).override)
      .toBeNull();
  });

  it("F202B-DB-06: Override-Code-Prioritaet revoked > signed > pending", async () => {
    const triple = await createTwoVariantOffer();
    const thirdId = await duplicateOnce(triple, "F202B dritte Variante");
    const sealPending = await sealVariantToPending(triple, triple.basisVariantId);
    const sealSigned = await sealVariantToPending(triple, triple.secondVariantId);
    const sealRevoked = await sealVariantToPending(triple, thirdId);
    expect(sealPending.requestId).toBeTruthy();
    await signSealed(sealSigned.token);
    await signSealed(sealRevoked.token);
    await revokeSealed(sealRevoked.token);
    await expectBlocked(asOperator(triple, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: triple.offerId,
      totalPriceOverrideNetCents: 111_000,
    })), LOCK_CODES.revoked);

    const duo = await createTwoVariantOffer();
    const duoPending = await sealVariantToPending(duo, duo.basisVariantId);
    const duoSigned = await sealVariantToPending(duo, duo.secondVariantId);
    expect(duoPending.requestId).toBeTruthy();
    await signSealed(duoSigned.token);
    await expectBlocked(asOperator(duo, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: duo.offerId,
      totalPriceOverrideNetCents: 222_000,
    })), LOCK_CODES.signed);
  });

  it("F202B-DB-07 (PIN, erwartet GRUEN): ungelockte No-ops ohne Event", async () => {
    const fx = await createTwoVariantOffer();
    const option = await createPurchaseOption(fx);
    const { workspaceId } = fx.members;

    const primaryEvents = await countOfferEvents(workspaceId, fx.offerId);
    const already = await asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
    }));
    expect(already.alreadyPrimary).toBe(true);
    expect(await countOfferEvents(workspaceId, fx.offerId)).toBe(primaryEvents);

    await asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 777_000,
    }));
    const overrideEvents = await countOfferEvents(workspaceId, fx.offerId);
    const overrideAgain = await asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 777_000,
    }));
    expect(overrideAgain.changed).toBe(false);
    expect(await countOfferEvents(workspaceId, fx.offerId)).toBe(overrideEvents);

    const bundles = [{ name: "Pin-Paket", position: 0 }];
    await asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      bundles,
    }));
    const bundleEvents = await countOfferEvents(workspaceId, fx.offerId);
    const bundlesAgain = await asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      bundles,
    }));
    expect(bundlesAgain.changed).toBe(false);
    expect(await countOfferEvents(workspaceId, fx.offerId)).toBe(bundleEvents);

    await asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      paymentOptionId: option.id,
    }));
    const paymentEvents = await countOfferEvents(workspaceId, fx.offerId);
    const paymentAgain = await asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      paymentOptionId: option.id,
    }));
    expect(paymentAgain.changed).toBe(false);
    expect(await countOfferEvents(workspaceId, fx.offerId)).toBe(paymentEvents);
  });

  it("F202B-DB-07 (PIN, erwartet GRUEN): ungelockte Writes emittieren Events mit Payload", async () => {
    const fx = await createTwoVariantOffer();
    const option = await createPurchaseOption(fx);
    const { workspaceId } = fx.members;

    await asOperator(fx, (tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    }));
    expect(await readLatestPayload(workspaceId, fx.offerId, "offer.primary_switched"))
      .toMatchObject({
        offerId: fx.offerId,
        variantId: fx.secondVariantId,
        previousPrimaryVariantId: fx.basisVariantId,
      });

    await asOperator(fx, (tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 321_000,
    }));
    expect(await readLatestPayload(workspaceId, fx.offerId, "offer.total_override_set"))
      .toMatchObject({ offerId: fx.offerId, valueNetCents: 321_000 });

    const bundles = [{ name: "Payload-Paket", position: 0 }];
    await asOperator(fx, (tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      bundles,
    }));
    expect(await readLatestPayload(workspaceId, fx.offerId, "offer.variant_bundles_set"))
      .toMatchObject({ offerId: fx.offerId, variantId: fx.basisVariantId, bundles });

    await asOperator(fx, (tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      paymentOptionId: option.id,
    }));
    expect(await readLatestPayload(workspaceId, fx.offerId, "offer.variant_payment_option_set"))
      .toMatchObject({
        offerId: fx.offerId,
        variantId: fx.basisVariantId,
        paymentOptionId: option.id,
      });
  });

  it("F202B-DB-07 (PIN, erwartet GRUEN): Cross-Tenant wirft OfferNotFoundError", async () => {
    const fx = await createTwoVariantOffer();
    const foreign = await createTwoVariantOffer();
    const runAsForeign = <T>(
      fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
    ): Promise<T> => withAuthorizedTenantOn(
      testPool, foreign.members.operatorId, foreign.members.workspaceId, fn,
    );
    await expect(runAsForeign((tx, ctx) => setPrimaryVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.secondVariantId,
    }))).rejects.toBeInstanceOf(OfferNotFoundError);
    await expect(runAsForeign((tx, ctx) => setOptionalBundles(tx, ctx, {
      schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      bundles: [],
    }))).rejects.toBeInstanceOf(OfferNotFoundError);
    await expect(runAsForeign((tx, ctx) => setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: fx.offerId,
      variantId: fx.basisVariantId,
      paymentOptionId: randomUUID(),
    }))).rejects.toBeInstanceOf(OfferNotFoundError);
    await expect(runAsForeign((tx, ctx) => setTotalPriceOverride(tx, ctx, {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId: fx.offerId,
      totalPriceOverrideNetCents: 1,
    }))).rejects.toBeInstanceOf(OfferNotFoundError);
  });
});
