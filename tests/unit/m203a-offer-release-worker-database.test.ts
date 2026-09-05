import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import { OFFER_CANONICALIZATION_VERSION } from "@/lib/integrations/offers/contract";
import {
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "@/lib/integrations/offers/release-contract";
import {
  OFFER_RELEASE_CANDIDATE_LEASE_MS,
  OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS,
  OFFER_RELEASE_CANDIDATE_MAX_BACKOFF_MS,
  OfferReleaseCandidateWorkerError,
  claimOfferReleaseCandidate,
  finalizeOfferReleaseCandidateFailure,
  finalizeOfferReleaseCandidateSuccess,
  requeueDueOfferReleaseCandidates,
} from "@/worker/offer-release-candidate-database";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OFFER_ID = "33333333-3333-4333-8333-333333333333";
const VARIANT_ID = "44444444-4444-4444-8444-444444444444";
const CANDIDATE_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const LEASE_TOKEN = "77777777-7777-4777-8777-777777777777";
const ARTIFACT_VERSION = "88888888-8888-4888-8888-888888888888";
const DB_NOW = "2026-08-30T12:00:00.000Z";

type InsertValue = Record<string, unknown>;
type ExecuteResponse = { rows: unknown[] } | Error;

function inputFixture(): OfferReleaseCandidateInputV1 {
  return {
    schemaVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    documentStatus: "not_issued",
    preparedAt: "2026-08-30T11:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-000042",
    profile: { name: "Synthetisches Angebotsprofil", revision: 4 },
    sender: {
      legalName: "Beispiel Energie GmbH",
      tradingName: "Beispiel Energie",
      representedBy: "Erika Beispiel",
      address: {
        street: "Sonnenstrasse",
        houseNumber: "12",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      },
      contactEmail: "angebot@beispiel.invalid",
      contactPhone: "+49301234567",
      website: "https://angebot.beispiel.invalid",
      registerCourt: "Beispielregistergericht",
      registerNumber: "HRB 123456 B",
      vatId: "DE123456789",
    },
    recipient: {
      displayName: "Synthetische Kundin",
      company: "Beispiel Kundin GmbH",
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "7",
        postalCode: "10117",
        city: "Berlin",
        country: "DE",
        formattedAddress: "Rechnungsweg 7, 10117 Berlin",
      },
    },
    installationSite: { formattedAddress: "Solarweg 8, 10115 Berlin" },
    variant: { name: "Synthetische Variante", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Synthetischer Leistungsumfang",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Testmontage",
        description: "Synthetische Testposition",
        quantityMilli: 1_000,
        unit: "set",
        positionType: "required",
        salesUnitNetCents: 100_000,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
        finalNetCents: 100_000,
        taxCents: 19_000,
        grossCents: 119_000,
      }],
    }],
    totals: {
      basisNetCents: 100_000,
      basisTaxCents: 19_000,
      basisGrossCents: 119_000,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    legalDocuments: {
      terms: { title: "Testbedingungen", plainText: "Nur synthetischer Testtext." },
      withdrawalInformation: {
        title: "Test-Widerrufsinformation",
        plainText: "Nur synthetischer Testtext.",
      },
      privacyNotice: {
        title: "Test-Datenschutzhinweis",
        plainText: "Nur synthetischer Testtext.",
      },
    },
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  const input = inputFixture();
  return {
    id: CANDIDATE_ID,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    offer_id: OFFER_ID,
    variant_id: VARIANT_ID,
    variant_revision: 7,
    input_version: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
    canonicalization_version: OFFER_CANONICALIZATION_VERSION,
    template_version: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
    renderer_recipe_version: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    input_snapshot: input,
    input_sha256_hex: hashOfferReleaseCandidateInput(input),
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
    artifact_version: null,
    created_by: ACTOR_ID,
    db_now: DB_NOW,
    ...overrides,
  };
}

function stateTrace(overrides: Record<string, unknown> = {}) {
  return {
    id: CANDIDATE_ID,
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

function transaction(responses: ExecuteResponse[]) {
  let index = 0;
  const inserts: InsertValue[] = [];
  const execute = vi.fn(async () => {
    const response = responses[index++] ?? { rows: [] };
    if (response instanceof Error) throw response;
    return response;
  });
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
      dispatch_signature: "pgboss.enqueue_offer_release_candidate(uuid,uuid)",
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

function safeMetadata(inserts: InsertValue[]): string {
  return JSON.stringify(inserts.map((entry) => entry.payload ?? entry.details));
}

describe("M2-03a offer release candidate worker database", () => {
  it("pins a three-attempt budget, two-minute lease and bounded backoff", () => {
    expect(OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS).toBe(3);
    expect(OFFER_RELEASE_CANDIDATE_LEASE_MS).toBe(2 * 60_000);
    expect(OFFER_RELEASE_CANDIDATE_MAX_BACKOFF_MS).toBe(15 * 60_000);
  });

  it("claims a due candidate with DB-time CAS and an ID-only recovery dispatch", async () => {
    const claimed = candidateRow({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [candidateRow()] },
      { rows: [claimed] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    const result = await claimOfferReleaseCandidate(harness.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
    });

    expect(result).toMatchObject({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      inputSha256: claimed.input_sha256_hex,
      input: claimed.input_snapshot,
    });
    expect(result?.input).not.toBe(claimed.input_snapshot);
    expect(harness.execute).toHaveBeenCalledTimes(4);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    const claimUpdateSql = JSON.stringify(harness.execute.mock.calls[1]);
    expect(sqlArguments).toContain("clock_timestamp");
    expect(sqlArguments).toContain(String(OFFER_RELEASE_CANDIDATE_LEASE_MS));
    expect(sqlArguments).toContain("attempt_count <");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_release_candidate");
    expect(sqlArguments).not.toContain("input_snapshot:");
    expect(claimUpdateSql).toContain(
      "artifact_size_bytes, artifact_bytes, artifact_version, created_by",
    );
    expect(harness.inserts).toHaveLength(2);
    const metadata = safeMetadata(harness.inserts);
    expect(metadata).toContain("running");
    expect(metadata).not.toContain(claimed.input_sha256_hex);
    expect(metadata).not.toContain("Synthetische Kundin");
    expect(metadata).not.toContain(LEASE_TOKEN);
    expect(metadata).not.toContain("100000");
  });

  it("replays the same live lease without UPDATE, dispatch, event or audit", async () => {
    const running = candidateRow({
      state: "running",
      attempt_count: 3,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([{ rows: [running] }]);

    await expect(claimOfferReleaseCandidate(harness.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
    })).resolves.toMatchObject({ attemptCount: 3, leaseToken: LEASE_TOKEN });

    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.inserts).toEqual([]);
  });

  it("turns a corrupt claimed input into one sanitized final integrity failure", async () => {
    const privateSentinel = "private-recipient@beispiel.invalid";
    const corruptInput = {
      ...inputFixture(),
      privateNote: privateSentinel,
    };
    const queued = candidateRow({ input_snapshot: corruptInput });
    const running = candidateRow({
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
      { rows: [stateTrace()] },
    ]);

    await expect(claimOfferReleaseCandidate(harness.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
    })).resolves.toBeNull();

    expect(harness.execute).toHaveBeenCalledTimes(3);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("set state = 'running'");
    expect(sqlArguments).toContain("set state = 'failed_final'");
    expect(sqlArguments).not.toContain("pgboss.enqueue_offer_release_candidate");
    expect(harness.inserts).toHaveLength(2);
    const metadata = safeMetadata(harness.inserts);
    expect(metadata).toContain("invalid_input");
    expect(metadata).not.toContain(privateSentinel);
    expect(metadata).not.toContain("100000");
  });

  it("fails an expired third lease without ever issuing a fourth attempt", async () => {
    const expired = candidateRow({
      state: "running",
      attempt_count: 3,
      lease_token: "88888888-8888-4888-8888-888888888888",
      lease_expires_at: "2026-08-30T11:59:59.000Z",
      started_at: "2026-08-30T11:50:00.000Z",
    });
    const harness = transaction([
      { rows: [expired] },
      { rows: [stateTrace({ attempt_count: 3 })] },
    ]);

    await expect(claimOfferReleaseCandidate(harness.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
    })).resolves.toBeNull();

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("lease_expired");
    expect(sqlArguments).not.toContain("attempt_count + 1");
    expect(sqlArguments).not.toContain("enqueue_offer_release_candidate");
    expect(safeMetadata(harness.inserts)).toContain("failed_final");
    expect(safeMetadata(harness.inserts)).toContain("lease_expired");
  });

  it("moves retryable failures to retry_wait using DB-time backoff and dispatch", async () => {
    const running = candidateRow({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const harness = transaction([
      { rows: [running] },
      { rows: [{ ...stateTrace(), next_attempt_at: "2026-08-30T12:00:30.000Z" }] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    await expect(finalizeOfferReleaseCandidateFailure(harness.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "browser_unavailable",
      retryable: true,
    })).resolves.toEqual({
      state: "retry_wait",
      attemptCount: 1,
      nextAttemptAt: new Date("2026-08-30T12:00:30.000Z"),
    });

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("30000");
    expect(sqlArguments).toContain("lease_expires_at >");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_release_candidate");
    expect(safeMetadata(harness.inserts)).toContain("browser_unavailable");
    expect(safeMetadata(harness.inserts)).not.toContain(LEASE_TOKEN);
  });

  it("fails the last retry, rejects forged retryability and rejects stale completion", async () => {
    const thirdAttempt = candidateRow({
      state: "running",
      attempt_count: 3,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const final = transaction([
      { rows: [thirdAttempt] },
      { rows: [{
        ...stateTrace({ attempt_count: 3 }),
        next_attempt_at: DB_NOW,
      }] },
    ]);
    await expect(finalizeOfferReleaseCandidateFailure(final.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 3,
      errorCode: "browser_unavailable",
      retryable: true,
    })).resolves.toMatchObject({ state: "failed_final", attemptCount: 3 });
    expect(JSON.stringify(final.execute.mock.calls)).not.toContain(
      "pgboss.enqueue_offer_release_candidate",
    );

    const forged = transaction([]);
    await expect(finalizeOfferReleaseCandidateFailure(forged.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "invalid_pdf",
      retryable: true,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(forged.execute).not.toHaveBeenCalled();

    const staleLease = candidateRow({
      state: "running",
      attempt_count: 1,
      lease_token: "99999999-9999-4999-8999-999999999999",
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const stale = transaction([{ rows: [staleLease] }]);
    await expect(finalizeOfferReleaseCandidateFailure(stale.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "invalid_pdf",
      retryable: false,
    })).rejects.toMatchObject({ code: "stale" });
  });

  it("atomically stores only a verified PDF and keeps bytes/hash out of event metadata", async () => {
    const running = candidateRow({
      state: "running",
      attempt_count: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: "2026-08-30T12:02:00.000Z",
      started_at: DB_NOW,
    });
    const rendered = artifact();
    const harness = transaction([
      { rows: [running] },
      { rows: [stateTrace()] },
    ]);

    await expect(finalizeOfferReleaseCandidateSuccess(harness.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: rendered,
    })).resolves.toEqual({
      state: "ready_for_approval",
      attemptCount: 1,
      replayed: false,
    });

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("artifact_bytes");
    expect(sqlArguments).toContain("artifact_version = pg_catalog.gen_random_uuid()");
    expect(sqlArguments).toContain(rendered.sha256);
    expect(sqlArguments).toContain("lease_expires_at >");
    expect(sqlArguments).not.toContain("update offer\"");
    expect(sqlArguments).not.toContain("update project");
    const metadata = safeMetadata(harness.inserts);
    expect(metadata).toContain("ready_for_approval");
    expect(metadata).not.toContain(rendered.sha256);
    expect(metadata).not.toContain("%PDF");
    expect(metadata).not.toContain("100000");
  });

  it("rejects malformed artifact MIME, size, bytes, magic, EOF and SHA before SQL", async () => {
    const baseline = artifact();
    const noEofBytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "latin1"),
      Buffer.alloc(128, 0x61),
    ]);
    const invalidArtifacts: unknown[] = [
      { ...baseline, mimeType: "text/html" },
      { ...baseline, sizeBytes: 99 },
      { ...baseline, bytes: new Uint8Array(baseline.bytes) },
      { ...baseline, bytes: Buffer.alloc(baseline.bytes.length), sha256: "0".repeat(64) },
      { ...baseline, sha256: "0".repeat(64) },
      {
        ...baseline,
        bytes: noEofBytes,
        sizeBytes: noEofBytes.length,
        sha256: createHash("sha256").update(noEofBytes).digest("hex"),
      },
      { ...baseline, privateField: "private-value" },
    ];

    for (const invalidArtifact of invalidArtifacts) {
      const harness = transaction([]);
      await expect(finalizeOfferReleaseCandidateSuccess(harness.tx, {
        workspaceId: WORKSPACE_ID,
        candidateId: CANDIDATE_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
        artifact: invalidArtifact,
      })).rejects.toMatchObject({ code: "invalid_pdf" });
      expect(harness.execute).not.toHaveBeenCalled();
      expect(harness.inserts).toEqual([]);
    }
  });

  it("accepts a byte-identical ready replay and flags all other artifact replays", async () => {
    const first = artifact();
    const ready = candidateRow({
      state: "ready_for_approval",
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
      artifact_version: ARTIFACT_VERSION,
    });

    const replay = transaction([{ rows: [ready] }]);
    await expect(finalizeOfferReleaseCandidateSuccess(replay.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: first,
    })).resolves.toEqual({
      state: "ready_for_approval",
      attemptCount: 1,
      replayed: true,
    });
    expect(replay.execute).toHaveBeenCalledTimes(1);
    expect(replay.inserts).toEqual([]);

    const nondeterministic = transaction([{ rows: [ready] }]);
    await expect(finalizeOfferReleaseCandidateSuccess(nondeterministic.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: artifact(0x62),
    })).rejects.toMatchObject({ code: "renderer_nondeterministic" });
    expect(nondeterministic.inserts).toEqual([]);

    const missingVersion = transaction([{ rows: [{
      ...ready,
      artifact_version: null,
    }] }]);
    await expect(finalizeOfferReleaseCandidateSuccess(missingVersion.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: first,
    })).rejects.toMatchObject({ code: "retry_conflict" });

    const wrongAttempt = transaction([{ rows: [ready] }]);
    await expect(finalizeOfferReleaseCandidateSuccess(wrongAttempt.tx, {
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 2,
      artifact: first,
    })).rejects.toMatchObject({ code: "retry_conflict" });
  });

  it("requeues due retries with SKIP LOCKED and repairs every ID-only dispatch", async () => {
    const secondCandidateId = "88888888-8888-4888-8888-888888888888";
    const harness = transaction([
      { rows: [
        stateTrace({ id: secondCandidateId, recovery_state: "retry_wait" }),
        stateTrace({ recovery_state: "retry_wait" }),
      ] },
      dispatchGate(),
      { rows: [{}] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    await expect(requeueDueOfferReleaseCandidates(harness.tx, {
      workspaceId: WORKSPACE_ID,
      limit: 10,
    })).resolves.toEqual([CANDIDATE_ID, secondCandidateId]);

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("for update skip locked");
    expect(sqlArguments.match(/enqueue_offer_release_candidate/gu)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(sqlArguments).not.toContain("input_snapshot");
    expect(harness.inserts).toHaveLength(4);
    const metadata = safeMetadata(harness.inserts);
    expect(metadata).toContain("queued");
    expect(metadata).not.toContain("Synthetische Kundin");
    expect(metadata).not.toContain("100000");
  });

  it("redelivers an expired running lease without mutating it or extending user activity", async () => {
    const harness = transaction([
      { rows: [stateTrace({ recovery_state: "running" })] },
      dispatchGate(),
      { rows: [{}] },
    ]);

    await expect(requeueDueOfferReleaseCandidates(harness.tx, {
      workspaceId: WORKSPACE_ID,
      limit: 1,
    })).resolves.toEqual([CANDIDATE_ID]);

    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("lease_expires_at <=");
    expect(sqlArguments).toContain("due.recovery_state = 'retry_wait'");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_release_candidate");
    expect(sqlArguments).not.toContain("update offer set updated_at");
    expect(harness.inserts).toEqual([]);
  });

  it("keeps queue discovery ID-only, tenant-scoped and independent of app services", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../../worker/offer-release-candidate-database.ts",
    ), "utf8");

    expect(source).toContain('servicePoolConfig(connectionString, "app_worker", max)');
    expect(source.match(/withTenantOn\(pool, input\.workspaceId/gu)).toHaveLength(4);
    expect(source).toContain("from pgboss.job");
    expect(source).toContain("withTenantOn(pool, workspaceId");
    expect(source).toContain("from workspace");
    expect(source).toContain("job.data = pg_catalog.jsonb_build_object");
    expect(source).toContain("'schemaVersion'");
    expect(source).toContain("'workspaceId'");
    expect(source).toContain("'candidateId'");
    expect(source).not.toContain("row_security = off");
    expect(source).not.toContain("bypassrls");
    expect(source).not.toContain("modules/offers/release-service");
    expect(source).not.toContain('import "server-only"');
    expect(source).not.toContain("inputSnapshot");
  });

  it("uses closed worker errors without customer or raw database details", () => {
    expect(new OfferReleaseCandidateWorkerError("stale")).toMatchObject({
      name: "OfferReleaseCandidateWorkerError",
      code: "stale",
      message: "offer release candidate worker database operation failed",
    });
  });
});
