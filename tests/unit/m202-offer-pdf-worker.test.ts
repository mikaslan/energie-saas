import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import { testPool } from "@/tests/setup/test-db";
import {
  OFFER_PDF_DRAFT_INPUT_VERSION,
  OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  OFFER_PDF_DRAFT_TEMPLATE_VERSION,
  hashOfferPdfDraftInput,
  offerPdfDraftInputV1Schema,
} from "@/lib/integrations/offers/pdf-contract";
import {
  OFFER_PDF_LEASE_MS,
  OFFER_PDF_MAX_ATTEMPTS,
  OfferPdfDraftWorkerError,
  claimOfferPdfDraftJob,
  createOfferPdfDatabaseGateway,
  finalizeOfferPdfDraftFailure,
  finalizeOfferPdfDraftSuccess,
  requeueDueOfferPdfDraftJobs,
} from "@/worker/offer-pdf-database";
import {
  OfferPdfIntegrityIncidentError,
  OfferPdfRecoverySweepError,
  createOfferPdfRenderHandler,
  parseOfferPdfDispatchPayload,
  startOfferPdfRecoverySweep,
  type OfferPdfClaim,
} from "@/worker/offer-pdf";
import { OfferPdfRenderError } from "@/worker/offer-pdf-renderer";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID = "33333333-3333-4333-8333-333333333333";
const VARIANT_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const LEASE_TOKEN = "77777777-7777-4777-8777-777777777777";
const DB_NOW = "2026-08-30T12:00:00.000Z";

type InsertValue = Record<string, unknown>;

function inputFixture() {
  return offerPdfDraftInputV1Schema.parse({
    schemaVersion: OFFER_PDF_DRAFT_INPUT_VERSION,
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T11:22:33.000Z",
    recipient: { displayName: "Mia Muster" },
    installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
    variant: { name: "Komfort", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalDiscountCapCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Leistungsumfang",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Montage",
        description: null,
        quantityMilli: 1_000,
        unit: "piece",
        positionType: "required",
        isHidden: false,
        salesUnitNetCents: 100,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
        finalNetCents: 100,
        taxCents: 19,
        grossCents: 119,
      }],
    }],
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
  });
}

function row(overrides: Record<string, unknown> = {}) {
  const input = inputFixture();
  return {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    offer_id: OFFER_ID,
    variant_id: VARIANT_ID,
    variant_revision: 7,
    input_version: OFFER_PDF_DRAFT_INPUT_VERSION,
    canonicalization_version: "offer-jcs.v1",
    template_version: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    renderer_recipe_version: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
    input_snapshot: input,
    input_sha256_hex: hashOfferPdfDraftInput(input),
    state: "queued",
    attempt_count: 0,
    next_attempt_at: DB_NOW,
    lease_token: null,
    lease_expires_at: null,
    started_at: null,
    finished_at: null,
    error_code: null,
    error_retryable: null,
    artifact_mime_type: null,
    artifact_sha256_hex: null,
    artifact_size_bytes: null,
    artifact_bytes: null,
    created_by: ACTOR_ID,
    db_now: DB_NOW,
    ...overrides,
  };
}

function trace(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    offer_id: OFFER_ID,
    variant_id: VARIANT_ID,
    variant_revision: 7,
    attempt_count: 1,
    created_by: ACTOR_ID,
    ...overrides,
  };
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

function dispatchGate() {
  return {
    rows: [{
      dispatch_signature: "pgboss.enqueue_offer_pdf_draft(uuid,uuid)",
      current_role: "app_worker",
      session_role: "app_worker",
      database_name: "energie_saas",
    }],
  };
}

function artifact(fill = 0x61) {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(128, fill),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    mimeType: "application/pdf" as const,
  };
}

describe("M2-02 offer PDF worker database contract", () => {
  it("pins the business lease and attempt budget", () => {
    expect(OFFER_PDF_MAX_ATTEMPTS).toBe(3);
    expect(OFFER_PDF_LEASE_MS).toBe(2 * 60_000);
  });

  it("claims a due job using DB time, attempt CAS, a two-minute lease, and a recovery dispatch", async () => {
    const claimed = row({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [row()] },
      { rows: [claimed] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    const result = await claimOfferPdfDraftJob(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    });

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      inputSha256: claimed.input_sha256_hex,
      input: claimed.input_snapshot,
    });
    expect(harness.execute).toHaveBeenCalledTimes(4);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("clock_timestamp");
    expect(sqlArguments).toContain(String(OFFER_PDF_LEASE_MS));
    expect(sqlArguments).toContain("attempt_count <");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_pdf_draft");
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("running");
    expect(metadata).not.toContain(claimed.input_sha256_hex);
    expect(metadata).not.toContain("Mia Muster");
    expect(metadata).not.toContain(LEASE_TOKEN);
  });

  it("replays the same live lease without another UPDATE, dispatch, event, or audit", async () => {
    const running = row({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([{ rows: [running] }]);

    await expect(claimOfferPdfDraftJob(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    })).resolves.toMatchObject({ attemptCount: 1, leaseToken: LEASE_TOKEN });

    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.inserts).toEqual([]);
  });

  it("claims corrupt due input and then records a final sanitized integrity failure", async () => {
    const privateSentinel = "customer-private@example.test";
    const corruptInput = {
      ...inputFixture(),
      recipient: { displayName: privateSentinel },
      email: privateSentinel,
    };
    const queued = row({ input_snapshot: corruptInput });
    const running = row({
      input_snapshot: corruptInput,
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [queued] },
      { rows: [running] },
      { rows: [trace()] },
    ]);

    await expect(claimOfferPdfDraftJob(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    })).resolves.toBeNull();

    expect(harness.execute).toHaveBeenCalledTimes(3);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("set state = 'running'");
    expect(sqlArguments).toContain("set state = 'failed_final'");
    expect(harness.inserts).toHaveLength(2);
    expect(JSON.stringify(harness.inserts)).toContain("invalid_input");
    expect(JSON.stringify(harness.inserts)).not.toContain(privateSentinel);
  });

  it("finalizes an expired third lease without issuing a fourth attempt", async () => {
    const expired = row({
      state: "running",
      attempt_count: 3,
      lease_token: "88888888-8888-4888-8888-888888888888",
      lease_expires_at: "2026-08-30T11:59:59.000Z",
      started_at: "2026-08-30T11:50:00.000Z",
    });
    const harness = transaction([
      { rows: [expired] },
      { rows: [trace({ attempt_count: 3 })] },
    ]);

    await expect(claimOfferPdfDraftJob(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    })).resolves.toBeNull();

    expect(harness.execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(harness.execute.mock.calls)).toContain("lease_expired");
    expect(JSON.stringify(harness.execute.mock.calls)).not.toContain("attempt_count + 1");
    expect(JSON.stringify(harness.inserts)).toContain("failed_final");
    expect(JSON.stringify(harness.inserts)).toContain("lease_expired");
  });

  it("moves a retryable failure to retry_wait with exponential DB-time backoff and dispatch", async () => {
    const running = row({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [running] },
      { rows: [{ ...trace(), next_attempt_at: "2026-08-30T12:00:30.000Z" }] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    const result = await finalizeOfferPdfDraftFailure(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "browser_unavailable",
      retryable: true,
    });

    expect(result).toEqual({
      state: "retry_wait",
      attemptCount: 1,
      nextAttemptAt: new Date("2026-08-30T12:00:30.000Z"),
    });
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("clock_timestamp");
    expect(sqlArguments).toContain("30000");
    expect(sqlArguments).toContain("lease_token =");
    expect(harness.inserts).toHaveLength(2);
    expect(JSON.stringify(harness.inserts)).toContain("browser_unavailable");
  });

  it("rejects a stale completion token and a forged retryability classification", async () => {
    const running = row({
      state: "running",
      attempt_count: 1,
      lease_token: "88888888-8888-4888-8888-888888888888",
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const staleHarness = transaction([{ rows: [running] }]);
    await expect(finalizeOfferPdfDraftFailure(staleHarness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "browser_unavailable",
      retryable: true,
    })).rejects.toMatchObject({ code: "stale" });

    const forged = transaction([]);
    await expect(finalizeOfferPdfDraftFailure(forged.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "invalid_pdf",
      retryable: true,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(forged.execute).not.toHaveBeenCalled();
  });

  it("atomically commits verified PDF bytes without touching Offer/Project or leaking hash/bytes to metadata", async () => {
    const running = row({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const rendered = artifact();
    const harness = transaction([
      { rows: [running] },
      { rows: [trace()] },
    ]);

    await expect(finalizeOfferPdfDraftSuccess(harness.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: rendered,
    })).resolves.toEqual({ state: "succeeded", attemptCount: 1, replayed: false });

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("artifact_bytes");
    expect(sqlArguments).toContain(rendered.sha256);
    expect(sqlArguments).not.toContain("update offer\"");
    expect(sqlArguments).not.toContain("update project");
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("succeeded");
    expect(metadata).not.toContain(rendered.sha256);
    expect(metadata).not.toContain("%PDF");
  });

  it("accepts a byte-identical success replay but rejects renderer nondeterminism", async () => {
    const first = artifact();
    const succeeded = row({
      state: "succeeded",
      attempt_count: 1,
      next_attempt_at: DB_NOW,
      lease_token: null,
      lease_expires_at: null,
      started_at: DB_NOW,
      finished_at: "2026-08-30T12:00:10.000Z",
      artifact_mime_type: first.mimeType,
      artifact_sha256_hex: first.sha256,
      artifact_size_bytes: first.sizeBytes,
      artifact_bytes: first.bytes,
    });
    const replay = transaction([{ rows: [succeeded] }]);
    await expect(finalizeOfferPdfDraftSuccess(replay.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: first,
    })).resolves.toEqual({ state: "succeeded", attemptCount: 1, replayed: true });
    expect(replay.execute).toHaveBeenCalledTimes(1);
    expect(replay.inserts).toEqual([]);

    const nondeterministic = transaction([{ rows: [succeeded] }]);
    await expect(finalizeOfferPdfDraftSuccess(nondeterministic.tx, {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: artifact(0x62),
    })).rejects.toMatchObject({ code: "renderer_nondeterministic" });
  });

  it("requeues due retry jobs with SKIP LOCKED and repairs each dispatch", async () => {
    const secondJobId = "88888888-8888-4888-8888-888888888888";
    const harness = transaction([
      {
        rows: [
          trace({ id: secondJobId, recovery_state: "retry_wait" }),
          trace({ recovery_state: "retry_wait" }),
        ],
      },
      dispatchGate(),
      { rows: [{}] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    await expect(requeueDueOfferPdfDraftJobs(harness.tx, {
      workspaceId: WORKSPACE_ID,
      limit: 10,
    })).resolves.toEqual([JOB_ID, secondJobId]);

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("for update skip locked");
    expect(sqlArguments.match(/enqueue_offer_pdf_draft/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(harness.inserts).toHaveLength(4);
    expect(JSON.stringify(harness.inserts)).not.toContain("inputSha256");
  });

  it("repairs the planned N+1 dispatch after pg-boss exhausts technical retries while the domain lease is expired", async () => {
    const harness = transaction([
      { rows: [trace({ recovery_state: "running" })] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    await expect(requeueDueOfferPdfDraftJobs(harness.tx, {
      workspaceId: WORKSPACE_ID,
      limit: 1,
    })).resolves.toEqual([JOB_ID]);

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("lease_expires_at <=");
    expect(sqlArguments).toContain("for update skip locked");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_pdf_draft");
    // Das expired-running-Artefakt bleibt unangetastet; der neu zugestellte
    // N+1-Handler führt den vorhandenen Claim-/Max-Attempt-Automaten aus.
    expect(sqlArguments).toContain("due.recovery_state = 'retry_wait'");
    expect(harness.inserts).toEqual([]);
  });

  it("keeps the gateway on a dedicated app_worker tenant pool without importing server-only app services", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../../worker/offer-pdf-database.ts",
    ), "utf8");

    expect(source).toContain('servicePoolConfig(connectionString, "app_worker", max)');
    expect(source.match(/withTenantOn\(pool, input\.workspaceId/gu)).toHaveLength(4);
    expect(source).toContain("from pgboss.job");
    expect(source).toContain("withTenantOn(pool, workspaceId");
    expect(source).toContain("from workspace");
    expect(source).not.toContain("row_security = off");
    expect(source).not.toContain("bypassrls");
    const queueDiscovery = source.slice(
      source.indexOf("with dispatch as materialized"),
      source.indexOf("), integrity as"),
    );
    expect(queueDiscovery).not.toContain("job.state");
    expect(source).not.toContain("modules/offers/pdf-service");
    expect(source).not.toContain('import "server-only"');
  });

  it("executes the bounded queue-discovery and tenant-recovery SQL against the migrated pg-boss schema", async () => {
    const connectionString = process.env.POSTGRES_URL_TEST;
    if (!connectionString) throw new Error("POSTGRES_URL_TEST fehlt.");
    const existing = await testPool.query<{
      namespace_name: string | null;
      relation_name: string | null;
    }>(`
      select pg_catalog.to_regnamespace('pgboss')::text as namespace_name,
             pg_catalog.to_regclass('pgboss.job')::text as relation_name
    `);
    const createdTestSchema = existing.rows[0]?.namespace_name === null;
    const createdTestRelation = existing.rows[0]?.relation_name === null;
    if (createdTestRelation) {
      await testPool.query("create schema if not exists pgboss");
      await testPool.query(`
        create table pgboss.job (
          name text not null,
          data jsonb,
          state text not null
        )
      `);
      await testPool.query(`
        insert into pgboss.job (name, data, state)
        values ('pdf.render', $1::jsonb, 'failed')
      `, [JSON.stringify({
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      })]);
    }
    const poolErrors: Error[] = [];
    const gateway = createOfferPdfDatabaseGateway(
      connectionString,
      (error) => { poolErrors.push(error); },
      1,
    );
    const finalCursor = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    try {
      if (createdTestRelation) {
        // Auch die nach zehn technischen Retries historisch `failed` Zeile
        // liefert den ID-only Kandidaten. Ohne existierenden tenant-scoped
        // workspace unter FORCE RLS wird sie aber nicht zum Sweep-Ziel.
        await expect(gateway.listRecoveryWorkspaces({
          afterWorkspaceId: null,
          limit: 1,
        })).resolves.toEqual({
          workspaceIds: [],
          nextAfterWorkspaceId: WORKSPACE_ID,
        });
      } else {
        await expect(gateway.listRecoveryWorkspaces({
          afterWorkspaceId: finalCursor,
          limit: 1,
        })).resolves.toEqual({ workspaceIds: [], nextAfterWorkspaceId: null });
      }
      await expect(gateway.requeueDue({
        workspaceId: finalCursor,
        limit: 1,
      })).resolves.toEqual([]);
      expect(poolErrors).toEqual([]);
    } finally {
      await gateway.close();
      if (createdTestRelation) await testPool.query("drop table pgboss.job");
      if (createdTestSchema) await testPool.query("drop schema pgboss");
    }
  });

  it("uses closed worker errors without customer or raw database details", () => {
    const error = new OfferPdfDraftWorkerError("stale");
    expect(error).toMatchObject({
      name: "OfferPdfDraftWorkerError",
      code: "stale",
      message: "offer PDF worker database operation failed",
    });
  });
});

describe("M2-02 pdf.render orchestration", () => {
  function handlerHarness(options: {
    claim?: OfferPdfClaim | null;
    renderError?: unknown;
    successError?: unknown;
  } = {}) {
    const input = inputFixture();
    const claim = options.claim === undefined ? {
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      inputVersion: OFFER_PDF_DRAFT_INPUT_VERSION,
      templateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
      rendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
      inputSha256: hashOfferPdfDraftInput(input),
      input,
    } : options.claim;
    const rendered = artifact();
    const database = {
      claim: vi.fn(async () => claim),
      finalizeSuccess: vi.fn(async () => {
        if (options.successError !== undefined) throw options.successError;
        return { state: "succeeded" };
      }),
      finalizeFailure: vi.fn(async () => ({ state: "failed_final" })),
    };
    const renderer = {
      render: vi.fn(async () => {
        if (options.renderError !== undefined) throw options.renderError;
        return rendered;
      }),
    };
    const onIntegrityIncident = vi.fn();
    return {
      database,
      renderer,
      rendered,
      onIntegrityIncident,
      handler: createOfferPdfRenderHandler({
        database,
        renderer,
        createLeaseToken: () => LEASE_TOKEN,
        onIntegrityIncident,
      }),
    };
  }

  it("accepts only the strict ID-only dispatch before touching the database", async () => {
    expect(parseOfferPdfDispatchPayload({
      schemaVersion: "offer-pdf-draft-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    })).toEqual({
      schemaVersion: "offer-pdf-draft-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    });
    const harness = handlerHarness();
    await expect(harness.handler([{
      data: {
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        recipient: { displayName: "PRIVATE" },
      },
    }])).rejects.toMatchObject({ name: "OfferPdfDispatchError" });
    expect(harness.database.claim).not.toHaveBeenCalled();
    expect(harness.renderer.render).not.toHaveBeenCalled();
  });

  it("renders only the reloaded sealed claim and finalizes with lease/attempt CAS", async () => {
    const harness = handlerHarness();
    await harness.handler([{
      id: "pg-boss-metadata-is-ignored",
      data: {
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
      customer: "must-not-cross",
    }]);

    expect(harness.database.claim).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
    });
    expect(harness.renderer.render).toHaveBeenCalledWith(inputFixture());
    expect(harness.database.finalizeSuccess).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: harness.rendered,
    });
    expect(JSON.stringify([
      harness.database.claim.mock.calls,
      harness.database.finalizeSuccess.mock.calls,
      harness.database.finalizeFailure.mock.calls,
    ])).not.toContain("must-not-cross");
    expect(harness.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("maps renderer errors to closed retry/final classifications without raw details", async () => {
    const secret = "customer@example.test https://private.invalid";
    const harness = handlerHarness({
      renderError: Object.assign(
        new OfferPdfRenderError("network_attempted", false),
        { raw: secret },
      ),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(harness.handler([{
      data: {
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
    }])).resolves.toBeUndefined();

    expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "network_attempted",
      retryable: false,
    });
    expect(JSON.stringify(harness.database.finalizeFailure.mock.calls)).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps a pinned-runtime browser failure retryable through the handler contract", async () => {
    const harness = handlerHarness({
      renderError: new OfferPdfRenderError("browser_unavailable", true),
    });

    await expect(harness.handler([{
      data: {
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
    }])).resolves.toBeUndefined();

    expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "browser_unavailable",
      retryable: true,
    });
  });

  it("persists an invalid PDF as a final sanitized domain failure", async () => {
    const harness = handlerHarness({
      successError: new OfferPdfDraftWorkerError("invalid_pdf"),
    });

    await expect(harness.handler([{
      data: {
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
    }])).resolves.toBeUndefined();

    expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "invalid_pdf",
      retryable: false,
    });
    expect(harness.onIntegrityIncident).not.toHaveBeenCalled();
  });

  it("propagates renderer nondeterminism as a sanitized fatal integrity incident without mutating the succeeded artifact", async () => {
    const privateSentinel = "customer@example.test https://private.invalid/token";
    const databaseError = Object.assign(
      new OfferPdfDraftWorkerError("renderer_nondeterministic"),
      { raw: privateSentinel },
    );
    const harness = handlerHarness({ successError: databaseError });

    const result = harness.handler([{
      data: {
        schemaVersion: "offer-pdf-draft-dispatch.v1",
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
      },
    }]);

    await expect(result).rejects.toMatchObject({
      name: "OfferPdfIntegrityIncidentError",
      code: "offer_pdf_renderer_nondeterministic",
      message: "offer PDF renderer integrity incident",
    });
    expect(harness.database.finalizeFailure).not.toHaveBeenCalled();
    expect(harness.onIntegrityIncident).toHaveBeenCalledTimes(1);
    const incident = harness.onIntegrityIncident.mock.calls[0]?.[0];
    expect(incident).toBeInstanceOf(OfferPdfIntegrityIncidentError);
    expect(JSON.stringify(incident)).not.toContain(privateSentinel);
    expect(String(incident)).not.toContain(privateSentinel);
  });

  it("wires renderer integrity incidents and recovery failures into the worker fatal path", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../worker/index.ts"), "utf8");

    expect(source).toContain("onIntegrityIncident:");
    expect(source).toContain('reportFatalWorkerError("offer-pdf-integrity"');
    expect(source).toContain("startOfferPdfRecoverySweep({");
    expect(source).toContain('reportFatalWorkerError("offer-pdf-recovery"');
    expect(source).toContain("offerPdfRecovery?.stop()");
  });
});

describe("M2-02 offer PDF recovery sweep", () => {
  const SECOND_WORKSPACE_ID = "88888888-8888-4888-8888-888888888888";

  it("runs bounded tenant pages serially and advances its opaque workspace cursor", async () => {
    vi.useFakeTimers();
    try {
      const listRecoveryWorkspaces = vi.fn()
        .mockResolvedValueOnce({
          workspaceIds: [WORKSPACE_ID, SECOND_WORKSPACE_ID],
          nextAfterWorkspaceId: SECOND_WORKSPACE_ID,
        })
        .mockResolvedValueOnce({
          workspaceIds: [],
          nextAfterWorkspaceId: null,
        });
      const requeueDue = vi.fn(async () => [] as string[]);
      const onFatal = vi.fn();
      const recovery = startOfferPdfRecoverySweep({
        database: { listRecoveryWorkspaces, requeueDue },
        onFatal,
      }, {
        intervalMs: 1_000,
        workspaceLimit: 2,
        jobsPerWorkspaceLimit: 3,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(listRecoveryWorkspaces).toHaveBeenNthCalledWith(1, {
        afterWorkspaceId: null,
        limit: 2,
      });
      expect(requeueDue.mock.calls).toEqual([
        [{ workspaceId: WORKSPACE_ID, limit: 3 }],
        [{ workspaceId: SECOND_WORKSPACE_ID, limit: 3 }],
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(listRecoveryWorkspaces).toHaveBeenNthCalledWith(2, {
        afterWorkspaceId: SECOND_WORKSPACE_ID,
        limit: 2,
      });
      expect(onFatal).not.toHaveBeenCalled();
      await recovery.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overlaps sweeps and stop waits for the active tenant operation", async () => {
    vi.useFakeTimers();
    try {
      let releasePage: ((value: {
        workspaceIds: string[];
        nextAfterWorkspaceId: null;
      }) => void) | undefined;
      const pendingPage = new Promise<{
        workspaceIds: string[];
        nextAfterWorkspaceId: null;
      }>((resolvePage) => { releasePage = resolvePage; });
      const listRecoveryWorkspaces = vi.fn(() => pendingPage);
      const recovery = startOfferPdfRecoverySweep({
        database: {
          listRecoveryWorkspaces,
          requeueDue: vi.fn(async () => []),
        },
        onFatal: vi.fn(),
      }, { intervalMs: 1_000 });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(listRecoveryWorkspaces).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = recovery.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      releasePage?.({ workspaceIds: [], nextAfterWorkspaceId: null });
      await stopping;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(listRecoveryWorkspaces).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after one sanitized fatal recovery failure without leaking the database error", async () => {
    vi.useFakeTimers();
    try {
      const privateSentinel = "postgres://worker:secret@private.invalid/customer";
      const listRecoveryWorkspaces = vi.fn(async () => {
        throw new Error(privateSentinel);
      });
      const onFatal = vi.fn();
      const recovery = startOfferPdfRecoverySweep({
        database: {
          listRecoveryWorkspaces,
          requeueDue: vi.fn(async () => []),
        },
        onFatal,
      }, { intervalMs: 1_000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(onFatal).toHaveBeenCalledTimes(1);
      const failure = onFatal.mock.calls[0]?.[0];
      expect(failure).toBeInstanceOf(OfferPdfRecoverySweepError);
      expect(failure).toMatchObject({
        code: "offer_pdf_recovery_failed",
        message: "offer PDF recovery sweep failed",
      });
      expect(JSON.stringify(failure)).not.toContain(privateSentinel);
      expect(String(failure)).not.toContain(privateSentinel);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(listRecoveryWorkspaces).toHaveBeenCalledTimes(1);
      await recovery.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
