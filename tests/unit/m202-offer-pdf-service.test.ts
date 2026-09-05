import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  sealOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import {
  OFFER_PDF_DRAFT_INPUT_VERSION,
  OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  OFFER_PDF_DRAFT_TEMPLATE_VERSION,
  buildOfferPdfDraftInput,
  hashOfferPdfDraftInput,
} from "@/lib/integrations/offers/pdf-contract";
import { calculateOfferPricing } from "@/lib/integrations/offers/money";
import type { ServiceCtx } from "@/lib/permissions";
import {
  OfferPdfDraftConflictError,
  OfferPdfDraftDispatchError,
  OfferPdfDraftIntegrityError,
  OfferPdfDraftNotFoundError,
  getOfferPdfDraftStatus,
  listOfferPdfDrafts,
  readOfferPdfDraftArtifact,
  requestOfferPdfDraft,
} from "@/modules/offers/pdf-service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID = "33333333-3333-4333-8333-333333333333";
const VARIANT_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const REVISION_ID = "66666666-6666-4666-8666-666666666666";
const JOB_ID = "77777777-7777-4777-8777-777777777777";
const OFFER_NUMBER = "ANG-2026-000042";
const PREPARED_AT = "2026-08-30T11:22:33.000Z";
const SHA = (digit: string) => digit.repeat(64);

type InsertValue = Record<string, unknown>;

function snapshotFixture() {
  const sectionId = "88888888-8888-4888-8888-888888888888";
  const lineId = "99999999-9999-4999-8999-999999999999";
  const pricing = calculateOfferPricing({
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: sectionId,
      position: 1,
      discountBps: 0,
      lines: [{
        lineDomainId: lineId,
        position: 1,
        unit: "piece",
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        salesUnitNetCents: 12_345,
        purchaseUnitNetCents: 7_777,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
      }],
    }],
  });
  const computed = pricing.lines[0]!;
  const decision = {
    treatment: "standard_19" as const,
    rateBps: 1_900 as const,
    selectedBy: ACTOR_ID,
    selectedAt: "2026-08-30T10:00:00.000Z",
  };
  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    variantId: VARIANT_ID,
    revision: 7,
    variantName: "Komfort",
    description: "Interner Entwurf",
    contactContext: {
      displayName: "Mia Muster",
      emailPrimary: "private-pdf-sentinel@example.test",
      phoneE164: "+491701234567",
    },
    installationSiteContext: {
      addressRevision: 2,
      formattedAddress: "Solstraße 8, 10115 Berlin",
      street: "Solstraße",
      houseNumber: "8",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    sourceBindings: {
      projectId: PROJECT_ID,
      contactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      siteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      inboundReceiptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      inboundPayloadSha256: SHA("1"),
      requirementId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      requirementRevision: 1,
      calculationRevisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      calculationRevision: 1,
      calculationInputSha256: SHA("2"),
      calculationResultSha256: SHA("3"),
      resolutionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      resolutionRevision: 1,
      resolutionSha256: SHA("4"),
    },
    priceAudienceDecision: {
      audience: "b2c",
      confirmationCode: "b2c_operator_confirmed",
      confirmedBy: ACTOR_ID,
      confirmedAt: "2026-08-30T10:00:00.000Z",
    },
    taxDecision: decision,
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: sectionId,
      position: 1,
      category: "other",
      title: "Leistungsumfang",
      discountBps: 0,
      lines: [{
        lineDomainId: lineId,
        position: 1,
        componentCategory: "other",
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        product: {
          kind: "custom",
          displayName: "Montage",
          description: "Sichere Beschreibung",
          unit: "piece",
        },
        source: {
          kind: "custom",
          enteredBy: ACTOR_ID,
          enteredAt: "2026-08-30T10:00:00.000Z",
        },
        salesPricing: {
          originalUnitNetCents: 12_345,
          effectiveUnitNetCents: 12_345,
          provenance: {
            kind: "custom",
            enteredBy: ACTOR_ID,
            enteredAt: "2026-08-30T10:00:00.000Z",
          },
        },
        purchasePricing: {
          originalUnitNetCents: 7_777,
          effectiveUnitNetCents: 7_777,
          provenance: {
            kind: "custom",
            enteredBy: ACTOR_ID,
            enteredAt: "2026-08-30T10:00:00.000Z",
          },
        },
        lineDiscountBps: 0,
        taxTreatment: "standard_19",
        taxRateBps: 1_900,
        taxDecision: decision,
        computed: {
          lineBaseNetCents: computed.lineBaseNetCents,
          lineDiscountedNetCents: computed.lineDiscountedNetCents,
          sectionDiscountedNetCents: computed.sectionDiscountedNetCents,
          finalSalesNetCents: computed.finalSalesNetCents,
          salesTaxCents: computed.salesTaxCents,
          salesGrossCents: computed.salesGrossCents,
          purchaseNetCents: computed.purchaseNetCents,
        },
      }],
    }],
    totals: pricing.totals,
    createdBy: ACTOR_ID,
    createdAt: "2026-08-30T10:00:00.000Z",
  });
}

function transaction(responses: Array<{ rows: unknown[] }>) {
  let index = 0;
  const inserts: InsertValue[] = [];
  const execute = vi.fn(async () => responses[index++] ?? { rows: [] });
  const tx = {
    execute,
    insert: vi.fn(() => ({
      values: async (entry: InsertValue) => {
        inserts.push(entry);
      },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts };
}

function requestResponses(snapshot = snapshotFixture()) {
  return [
    { rows: [{ project_id: PROJECT_ID }] },
    { rows: [{ id: PROJECT_ID }] },
    { rows: [{ id: OFFER_ID, project_id: PROJECT_ID, offer_number: OFFER_NUMBER }] },
    { rows: [{ id: VARIANT_ID, current_revision: 7 }] },
    { rows: [{
      id: REVISION_ID,
      project_id: PROJECT_ID,
      revision: 7,
      revision_snapshot: snapshot,
      snapshot_sha256_hex: snapshot.snapshotSha256,
    }] },
  ];
}

function reservationKeyHex(snapshotSha256: string): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: "offer-pdf-draft-reservation.v1",
    workspaceId: WORKSPACE_ID,
    variantId: VARIANT_ID,
    variantRevision: 7,
    variantSnapshotSha256: snapshotSha256,
    inputVersion: OFFER_PDF_DRAFT_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  }), "utf8").digest("hex");
}

function insertedDraftResponse(snapshot = snapshotFixture()) {
  const input = buildOfferPdfDraftInput({
    offerNumber: OFFER_NUMBER,
    preparedAt: PREPARED_AT,
    variantSnapshot: snapshot,
  });
  return {
    rows: [{
      input_snapshot: input,
      input_sha256_hex: hashOfferPdfDraftInput(input),
      reservation_key_hex: reservationKeyHex(snapshot.snapshotSha256),
      created_at: PREPARED_AT,
    }],
  };
}

function context(role: ServiceCtx["role"] = "editor"): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role,
    capabilities: {},
    featureFlags: {},
  };
}

describe("M2-02 offer PDF app service boundary", () => {
  it("rejects request access before parsing or SQL", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;

    for (const denied of [
      {
        ...context("viewer"),
        capabilities: { edit_prices: true, discounts: true },
        featureFlags: { offer_pdf_draft: true, invoicing: true },
      },
      { ...context("admin"), capabilities: { external_only: true } },
    ]) {
      await expect(requestOfferPdfDraft(tx, denied, {
        workspaceId: WORKSPACE_ID,
        offerId: OFFER_ID,
        variantId: VARIANT_ID,
        expectedVariantRevision: 1,
      })).rejects.toMatchObject({ name: "PermissionDeniedError" });
    }

    expect(execute).not.toHaveBeenCalled();
  });

  it("binds a request to the exact current variant revision before reading its snapshot", async () => {
    const harness = transaction([
      { rows: [{ project_id: PROJECT_ID }] },
      { rows: [{ id: PROJECT_ID }] },
      { rows: [{ id: OFFER_ID, project_id: PROJECT_ID, offer_number: OFFER_NUMBER }] },
      { rows: [{ id: VARIANT_ID, current_revision: 8 }] },
    ]);

    await expect(requestOfferPdfDraft(harness.tx, context(), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      expectedVariantRevision: 7,
    })).rejects.toMatchObject({
      name: "OfferPdfDraftConflictError",
      currentRevision: 8,
    });

    expect(harness.execute).toHaveBeenCalledTimes(4);
    expect(harness.inserts).toEqual([]);
    expect(new OfferPdfDraftConflictError(8).currentRevision).toBe(8);
  });

  it("seals a minimized snapshot and atomically dispatches one new request", async () => {
    const snapshot = snapshotFixture();
    const harness = transaction([
      ...requestResponses(snapshot),
      { rows: [] },
      { rows: [{ db_now: PREPARED_AT }] },
      insertedDraftResponse(snapshot),
      { rows: [{
        dispatch_signature: "pgboss.enqueue_offer_pdf_draft(uuid,uuid)",
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
      { rows: [{ enqueue_offer_pdf_draft: "boss-id" }] },
      { rows: [] },
    ]);

    const result = await requestOfferPdfDraft(harness.tx, context(), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      expectedVariantRevision: 7,
    });

    expect(result).toMatchObject({
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      state: "queued",
      replayed: false,
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(harness.execute).toHaveBeenCalledTimes(11);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("offer-pdf-draft-input.v1");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_pdf_draft");
    expect(sqlArguments).not.toContain("private-pdf-sentinel");
    expect(sqlArguments).not.toContain("+491701234567");
    expect(sqlArguments).not.toContain("purchasePricing");
    expect(sqlArguments).not.toContain("purchaseNetCents");
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain(result.jobId);
    expect(metadata).toContain("queued");
    expect(metadata).not.toContain(snapshot.snapshotSha256);
    expect(metadata).not.toContain("12345");
    expect(metadata).not.toContain("Mia Muster");
  });

  it("fails before dispatch when the DB-derived input contract drifts", async () => {
    const snapshot = snapshotFixture();
    const baseline = insertedDraftResponse(snapshot).rows[0]!;
    const driftedInputs = [
      {
        ...baseline,
        input_snapshot: {
          ...baseline.input_snapshot,
          recipient: { displayName: "Abweichende Empfaengerin" },
        },
      },
      { ...baseline, input_sha256_hex: "00".repeat(32) },
      { ...baseline, reservation_key_hex: "00".repeat(32) },
      { ...baseline, created_at: "2026-08-30T11:22:34.000Z" },
    ];

    for (const drifted of driftedInputs) {
      const harness = transaction([
        ...requestResponses(snapshot),
        { rows: [] },
        { rows: [{ db_now: PREPARED_AT }] },
        { rows: [drifted] },
      ]);
      await expect(requestOfferPdfDraft(harness.tx, context(), {
        workspaceId: WORKSPACE_ID,
        offerId: OFFER_ID,
        variantId: VARIANT_ID,
        expectedVariantRevision: 7,
      })).rejects.toBeInstanceOf(OfferPdfDraftIntegrityError);
      expect(JSON.stringify(harness.execute.mock.calls)).not.toContain(
        "pgboss.enqueue_offer_pdf_draft",
      );
    }
  });

  it("replays the same sealed job and repairs dispatch for every nonterminal state", async () => {
    const snapshot = snapshotFixture();
    const sealedInput = buildOfferPdfDraftInput({
      offerNumber: OFFER_NUMBER,
      preparedAt: PREPARED_AT,
      variantSnapshot: snapshot,
    });
    const stored = {
      id: JOB_ID,
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      offer_id: OFFER_ID,
      variant_id: VARIANT_ID,
      variant_revision_id: REVISION_ID,
      variant_revision: 7,
      variant_snapshot_sha256_hex: snapshot.snapshotSha256,
      input_version: OFFER_PDF_DRAFT_INPUT_VERSION,
      canonicalization_version: OFFER_CANONICALIZATION_VERSION,
      template_version: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      renderer_recipe_version: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
      reservation_key_hex: "",
      input_snapshot: sealedInput,
      input_sha256_hex: hashOfferPdfDraftInput(sealedInput),
      state: "queued",
      attempt_count: 0,
      next_attempt_at: PREPARED_AT,
      created_at: PREPARED_AT,
      started_at: null,
      finished_at: null,
      error_code: null,
    };
    stored.reservation_key_hex = reservationKeyHex(snapshot.snapshotSha256);

    for (const state of ["queued", "running", "retry_wait"] as const) {
      const harness = transaction([
        ...requestResponses(snapshot),
        { rows: [{ ...stored, state }] },
        { rows: [{
          dispatch_signature: "pgboss.enqueue_offer_pdf_draft(uuid,uuid)",
          current_role: "app_runtime",
          session_role: "app_runtime",
          database_name: "energie_saas",
        }] },
        { rows: [{}] },
        { rows: [] },
      ]);

      await expect(requestOfferPdfDraft(harness.tx, context(), {
        workspaceId: WORKSPACE_ID,
        offerId: OFFER_ID,
        variantId: VARIANT_ID,
        expectedVariantRevision: 7,
      })).resolves.toEqual({
        jobId: JOB_ID,
        offerId: OFFER_ID,
        variantId: VARIANT_ID,
        variantRevision: 7,
        state,
        replayed: true,
      });

      expect(harness.execute).toHaveBeenCalledTimes(9);
      expect(harness.inserts).toEqual([]);
      const replaySql = JSON.stringify(harness.execute.mock.calls);
      expect(replaySql).not.toContain("insert into offer_pdf_draft");
      expect(replaySql).toContain("pgboss.enqueue_offer_pdf_draft");
      expect(replaySql).toContain("set updated_at = pg_catalog.transaction_timestamp()");
    }
  });

  it("fails closed when the atomic pg-boss dispatch boundary is unavailable", async () => {
    const snapshot = snapshotFixture();
    const harness = transaction([
      ...requestResponses(snapshot),
      { rows: [] },
      { rows: [{ db_now: PREPARED_AT }] },
      insertedDraftResponse(snapshot),
      { rows: [{
        dispatch_signature: null,
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
    ]);

    await expect(requestOfferPdfDraft(harness.tx, context(), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      expectedVariantRevision: 7,
    })).rejects.toBeInstanceOf(OfferPdfDraftDispatchError);

    expect(harness.inserts).toEqual([]);
    expect(JSON.stringify(harness.execute.mock.calls)).not.toContain("set updated_at");
  });

  it("keeps an existing offer with no jobs distinguishable from a hidden offer", async () => {
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: OFFER_ID }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as TenantTx;

    await expect(listOfferPdfDrafts(tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
    })).resolves.toEqual([]);

    const missing = { execute: vi.fn(async () => ({ rows: [] })) } as unknown as TenantTx;
    await expect(listOfferPdfDrafts(missing, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
    })).rejects.toBeInstanceOf(OfferPdfDraftNotFoundError);
  });

  it("projects list/status DTOs without input, artifact bytes, hashes, or actor IDs", async () => {
    const row = {
      id: JOB_ID,
      offer_id: OFFER_ID,
      variant_id: VARIANT_ID,
      variant_revision: 7,
      state: "retry_wait",
      attempt_count: 1,
      next_attempt_at: "2026-08-30T11:23:03.000Z",
      created_at: PREPARED_AT,
      started_at: PREPARED_AT,
      finished_at: null,
      error_code: "browser_unavailable",
      input_snapshot: { recipient: { displayName: "PRIVATE" } },
      artifact_bytes: Buffer.from("PRIVATE"),
      artifact_sha256_hex: SHA("a"),
      created_by: ACTOR_ID,
    };
    const listHarness = transaction([
      { rows: [{ id: OFFER_ID }] },
      { rows: [row] },
    ]);
    const listed = await listOfferPdfDrafts(listHarness.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
    });
    const statusHarness = transaction([{ rows: [row] }]);
    const status = await getOfferPdfDraftStatus(statusHarness.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      jobId: JOB_ID,
    });

    expect(listed).toEqual([status]);
    expect(status).toEqual({
      jobId: JOB_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      state: "retry_wait",
      attemptCount: 1,
      nextAttemptAt: "2026-08-30T11:23:03.000Z",
      createdAt: PREPARED_AT,
      startedAt: PREPARED_AT,
      finishedAt: null,
      errorCode: "browser_unavailable",
      canDownload: false,
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE");
    expect(JSON.stringify(status)).not.toContain(SHA("a"));
    expect(JSON.stringify(status)).not.toContain(ACTOR_ID);
  });

  it("reauthenticates and verifies exact artifact SHA/size before returning a safe filename", async () => {
    const bytes = Buffer.alloc(256, 0x61);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactRow = {
      id: JOB_ID,
      offer_id: OFFER_ID,
      variant_id: VARIANT_ID,
      variant_revision: 7,
      offer_number: OFFER_NUMBER,
      state: "succeeded",
      artifact_mime_type: "application/pdf",
      artifact_sha256_hex: sha256,
      artifact_size_bytes: bytes.length,
      artifact_bytes: bytes,
    };
    const harness = transaction([{ rows: [artifactRow] }]);
    const artifact = await readOfferPdfDraftArtifact(harness.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      jobId: JOB_ID,
    });

    expect(artifact).toMatchObject({
      jobId: JOB_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      filename: "ANG-2026-000042-Variante-R7.pdf",
      mimeType: "application/pdf",
      sha256,
      sizeBytes: 256,
    });
    expect(artifact.bytes).not.toBe(bytes);
    expect(artifact.bytes.equals(bytes)).toBe(true);

    const tampered = transaction([{ rows: [{
      ...artifactRow,
      artifact_sha256_hex: SHA("0"),
    }] }]);
    await expect(readOfferPdfDraftArtifact(tampered.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      jobId: JOB_ID,
    })).rejects.toBeInstanceOf(OfferPdfDraftIntegrityError);
  });
});
