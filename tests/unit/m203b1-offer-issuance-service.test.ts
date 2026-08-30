import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
  OFFER_ISSUANCE_REQUEST_VERSION,
  OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION,
} from "@/lib/integrations/offers/issuance-contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  M203B1_IDS,
  m203b1Sha,
} from "@/tests/helpers/m203b1-offer-issuance-fixture";
import {
  OfferIssuanceDispatchError,
  OfferIssuanceIntegrityError,
  OfferIssuanceNotFoundError,
  OfferIssuancePersistenceError,
  OfferIssuanceValidationError,
  approveOfferIssuance,
  getOfferIssuanceStatus,
  listOfferIssuances,
  readOfferIssuanceArtifact,
  requestOfferIssuance,
  withdrawOfferIssuance,
} from "@/modules/offers/issuance-service";

const CREATED_AT = "2026-08-30T10:31:00.000Z";
const STARTED_AT = "2026-08-30T10:31:10.000Z";
const FINISHED_AT = "2026-08-30T10:31:20.000Z";
const APPROVED_AT = "2026-08-30T10:32:00.000Z";
const WITHDRAWN_AT = "2026-08-30T10:33:00.000Z";

type InsertValue = Record<string, unknown>;
type ExecuteResponse = { rows: unknown[] } | Error;

function context(
  role: ServiceCtx["role"] = "editor",
  capabilities: ServiceCtx["capabilities"] = {
    prepare_offer_documents: true,
    approve_offer_documents: true,
  },
): ServiceCtx {
  return {
    workspaceId: M203B1_IDS.workspace,
    actor: M203B1_IDS.actor,
    role,
    capabilities,
    featureFlags: {},
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
      values: async (entry: InsertValue) => { inserts.push(entry); },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts };
}

function requestCommand(workspaceId: string = M203B1_IDS.workspace) {
  return {
    schemaVersion: OFFER_ISSUANCE_REQUEST_VERSION,
    workspaceId,
    offerId: M203B1_IDS.offer,
    candidateId: M203B1_IDS.candidate,
  };
}

function approvalCommand() {
  return {
    schemaVersion: OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
    issuanceId: M203B1_IDS.issuance,
    recipientAndScopeReviewed: true as const,
    commercialTotalsReviewed: true as const,
    legalProfileReviewed: true as const,
    finalPdfForArchiveUnderstood: true as const,
  };
}

function withdrawalCommand() {
  return {
    schemaVersion: OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION,
    issuanceId: M203B1_IDS.issuance,
    reasonCode: "legal_text_error" as const,
  };
}

function preparedEnvelope(overrides: Record<string, unknown> = {}) {
  return { result: {
    status: "prepared",
    workspaceId: M203B1_IDS.workspace,
    issuanceId: M203B1_IDS.issuance,
    projectId: M203B1_IDS.project,
    offerId: M203B1_IDS.offer,
    candidateId: M203B1_IDS.candidate,
    state: "queued",
    approvalCount: 0,
    derivedState: "queued",
    attemptCount: 0,
    nextAttemptAt: CREATED_AT,
    createdAt: CREATED_AT,
    replayed: false,
    ...overrides,
  } };
}

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: M203B1_IDS.workspace,
    id: M203B1_IDS.issuance,
    offer_id: M203B1_IDS.offer,
    candidate_id: M203B1_IDS.candidate,
    artifact_intent: "offer_issuance_final",
    has_zero_tax_treatment: false,
    state: "ready_for_approval",
    attempt_count: 1,
    next_attempt_at: CREATED_AT,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    error_code: null,
    approval_count: 0,
    viewer_has_approved: false,
    can_current_actor_approve: true,
    derived_state: "ready_for_approval",
    withdrawal_id: null,
    withdrawal_reason_code: null,
    withdrawn_at: null,
    approval_artifact_version: M203B1_IDS.artifactVersion,
    ...overrides,
  };
}

describe("M2-03b1 offer issuance app service", () => {
  it("authorizes every boundary before parsing/SQL and rejects external-only actors", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;

    await expect(requestOfferIssuance(tx, context("viewer"), {}))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "offer.issue.prepare" });
    await expect(approveOfferIssuance(
      tx,
      context("editor", { prepare_offer_documents: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError", action: "offer.issue.approve" });
    await expect(withdrawOfferIssuance(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(listOfferIssuances(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts only ID/fixed-command contracts and hides cross-workspace existence", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;
    await expect(requestOfferIssuance(tx, context(), {
      ...requestCommand(),
      recipientName: "PRIVATE_RECIPIENT_SENTINEL",
    })).rejects.toBeInstanceOf(OfferIssuanceValidationError);
    await expect(approveOfferIssuance(tx, context(), {
      ...approvalCommand(),
      commercialTotalsReviewed: false,
    })).rejects.toBeInstanceOf(OfferIssuanceValidationError);
    await expect(withdrawOfferIssuance(tx, context(), {
      ...withdrawalCommand(),
      note: "PRIVATE_TERMS_SENTINEL",
    })).rejects.toBeInstanceOf(OfferIssuanceValidationError);
    await expect(requestOfferIssuance(
      tx,
      context(),
      requestCommand(M203B1_IDS.otherWorkspace),
    )).rejects.toBeInstanceOf(OfferIssuanceNotFoundError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requests/replays through an ID-only dispatch and emits only safe metadata", async () => {
    const harness = transaction([
      { rows: [preparedEnvelope()] },
      { rows: [{
        dispatch_signature: "pgboss.enqueue_offer_issuance(uuid,uuid)",
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
      { rows: [{}] },
    ]);
    await expect(requestOfferIssuance(
      harness.tx,
      context(),
      requestCommand(),
    )).resolves.toEqual({
      issuanceId: M203B1_IDS.issuance,
      offerId: M203B1_IDS.offer,
      candidateId: M203B1_IDS.candidate,
      state: "queued",
      approvalCount: 0,
      publicationStatus: "not_issued",
      replayed: false,
    });
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("prepare_offer_issuance");
    expect(sqlCalls).toContain("enqueue_offer_issuance");
    expect(sqlCalls).not.toContain("PRIVATE_");
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain(M203B1_IDS.issuance);
    expect(metadata).toContain('"approvalCount":0');
    expect(metadata).not.toContain("PRIVATE_");
    expect(metadata).not.toContain(m203b1Sha("1"));

    const replay = transaction([{ rows: [preparedEnvelope({
      state: "ready_for_approval",
      approvalCount: 2,
      derivedState: "approved_for_archive_not_issued",
      attemptCount: 1,
      replayed: true,
    })] }]);
    await expect(requestOfferIssuance(replay.tx, context(), requestCommand()))
      .resolves.toMatchObject({
        state: "approved_for_archive_not_issued",
        approvalCount: 2,
        replayed: true,
      });
    expect(JSON.stringify(replay.execute.mock.calls)).not.toContain("enqueue_offer_issuance");

    for (const state of ["queued", "running", "retry_wait"] as const) {
      const withdrawnReplay = transaction([{ rows: [preparedEnvelope({
        state,
        approvalCount: 1,
        derivedState: "withdrawn_before_archive",
        attemptCount: 1,
        replayed: true,
      })] }]);
      await expect(requestOfferIssuance(
        withdrawnReplay.tx,
        context(),
        requestCommand(),
      )).resolves.toMatchObject({
        state: "withdrawn_before_archive",
        approvalCount: 1,
        replayed: true,
      });
      expect(withdrawnReplay.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(withdrawnReplay.execute.mock.calls))
        .not.toContain("enqueue_offer_issuance");
    }
  });

  it("fails closed for conflict, malformed, persistence and unavailable dispatch", async () => {
    const conflict = transaction([{ rows: [{ result: {
      status: "conflict",
      code: "candidate_source_changed",
    } }] }]);
    await expect(requestOfferIssuance(conflict.tx, context(), requestCommand()))
      .rejects.toMatchObject({
        name: "OfferIssuanceConflictError",
        code: "candidate_source_changed",
      });
    const malformed = transaction([{ rows: [preparedEnvelope({
      derivedState: "issued",
    })] }]);
    await expect(requestOfferIssuance(malformed.tx, context(), requestCommand()))
      .rejects.toBeInstanceOf(OfferIssuanceIntegrityError);
    const persistence = transaction([new Error("PRIVATE_DATABASE")]);
    await expect(requestOfferIssuance(persistence.tx, context(), requestCommand()))
      .rejects.toBeInstanceOf(OfferIssuancePersistenceError);
    const dispatch = transaction([
      { rows: [preparedEnvelope()] },
      { rows: [{
        dispatch_signature: null,
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
    ]);
    await expect(requestOfferIssuance(dispatch.tx, context(), requestCommand()))
      .rejects.toBeInstanceOf(OfferIssuanceDispatchError);
    expect(dispatch.inserts).toEqual([]);
  });

  it("records first/second byte-bound approvals and never exposes hashes/PII", async () => {
    for (const [approvalCount, derivedState] of [
      [1, "approval_pending"],
      [2, "approved_for_archive_not_issued"],
    ] as const) {
      const harness = transaction([{ rows: [{ result: {
        status: "approved",
        workspaceId: M203B1_IDS.workspace,
        issuanceId: M203B1_IDS.issuance,
        offerId: M203B1_IDS.offer,
        approvalId: M203B1_IDS.approval,
        approvalCount,
        derivedState,
        approvedBy: M203B1_IDS.actor,
        approvedAt: APPROVED_AT,
        replayed: false,
      } }] }]);
      await expect(approveOfferIssuance(harness.tx, context(), approvalCommand()))
        .resolves.toMatchObject({
          issuanceId: M203B1_IDS.issuance,
          state: derivedState,
          approvalCount,
          publicationStatus: "not_issued",
        });
      const sqlCalls = JSON.stringify(harness.execute.mock.calls);
      expect(sqlCalls).toContain("approve_offer_issuance");
      expect(sqlCalls).not.toContain("PRIVATE_");
      expect(sqlCalls).not.toContain(m203b1Sha("1"));
      const metadata = JSON.stringify(harness.inserts);
      expect(metadata).toContain(`"approvalCount":${approvalCount}`);
      expect(metadata).not.toContain("PRIVATE_");
    }
  });

  it("withdraws with one fixed reason and returns the atomic approval count", async () => {
    const harness = transaction([{ rows: [{ result: {
      status: "withdrawn",
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      offerId: M203B1_IDS.offer,
      withdrawalId: M203B1_IDS.withdrawal,
      reasonCode: "legal_text_error",
      approvalCount: 1,
      derivedState: "withdrawn_before_archive",
      withdrawnBy: M203B1_IDS.actor,
      withdrawnAt: WITHDRAWN_AT,
      replayed: false,
    } }] }]);
    await expect(withdrawOfferIssuance(harness.tx, context(), withdrawalCommand()))
      .resolves.toEqual({
        issuanceId: M203B1_IDS.issuance,
        offerId: M203B1_IDS.offer,
        withdrawalId: M203B1_IDS.withdrawal,
        state: "withdrawn_before_archive",
        approvalCount: 1,
        publicationStatus: "not_issued",
        reasonCode: "legal_text_error",
        withdrawnAt: WITHDRAWN_AT,
        replayed: false,
      });
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("legal_text_error");
    expect(metadata).not.toContain("PRIVATE_");
  });

  it("derives 0/2, 1/2, 2/2 and terminal withdrawal without returning actor/hash", async () => {
    const rows = [
      statusRow(),
      statusRow({
        approval_count: 1,
        viewer_has_approved: true,
        can_current_actor_approve: false,
        derived_state: "approval_pending",
      }),
      statusRow({
        approval_count: 2,
        viewer_has_approved: true,
        can_current_actor_approve: false,
        derived_state: "approved_for_archive_not_issued",
        approval_artifact_version: null,
      }),
      statusRow({
        approval_count: 1,
        viewer_has_approved: false,
        can_current_actor_approve: false,
        derived_state: "withdrawn_before_archive",
        withdrawal_id: M203B1_IDS.withdrawal,
        withdrawal_reason_code: "content_error",
        withdrawn_at: WITHDRAWN_AT,
        approval_artifact_version: null,
      }),
    ];
    for (const row of rows) {
      const harness = transaction([{ rows: [row] }]);
      const result = await getOfferIssuanceStatus(harness.tx, context(), {
        workspaceId: M203B1_IDS.workspace,
        offerId: M203B1_IDS.offer,
        issuanceId: M203B1_IDS.issuance,
      });
      expect(result.state).toBe(row.derived_state);
      expect(result.approvalCount).toBe(row.approval_count);
      expect(result.viewerHasApproved).toBe(row.viewer_has_approved);
      expect(result.canCurrentActorApprove).toBe(row.can_current_actor_approve);
      expect(JSON.stringify(result)).not.toContain(M203B1_IDS.actor);
      expect(JSON.stringify(result)).not.toContain(m203b1Sha("1"));
      expect(result.canDownload).toBe(row.derived_state !== "withdrawn_before_archive");
    }

    const list = transaction([
      { rows: [{ id: M203B1_IDS.offer }] },
      { rows: [{
        ...rows[2],
        viewer_has_approved: false,
        can_current_actor_approve: false,
      }] },
    ]);
    await expect(listOfferIssuances(list.tx, context("viewer", {}), {
      workspaceId: M203B1_IDS.workspace,
      offerId: M203B1_IDS.offer,
    })).resolves.toMatchObject([{ state: "approved_for_archive_not_issued" }]);
  });

  it("rejects contradictory actor-specific approval flags without exposing an actor ID", async () => {
    for (const row of [
      statusRow({ viewer_has_approved: true, approval_count: 0 }),
      statusRow({ can_current_actor_approve: false }),
      statusRow({
        approval_count: 1,
        derived_state: "approval_pending",
        viewer_has_approved: true,
        can_current_actor_approve: true,
      }),
    ]) {
      const harness = transaction([{ rows: [row] }]);
      await expect(getOfferIssuanceStatus(harness.tx, context(), {
        workspaceId: M203B1_IDS.workspace,
        offerId: M203B1_IDS.offer,
        issuanceId: M203B1_IDS.issuance,
      })).rejects.toBeInstanceOf(OfferIssuanceIntegrityError);
    }
  });

  it("rehashes exact artifact bytes and gates unfinished bytes to approvers", async () => {
    const bytes = Buffer.alloc(512, 0x61);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ready = statusRow();
    const artifact = {
      ...ready,
      offer_number: "ANG-2026-000042",
      artifact_mime_type: "application/pdf",
      artifact_sha256_hex: sha256,
      artifact_size_bytes: bytes.length,
      artifact_bytes: bytes,
    };
    const approver = transaction([{ rows: [ready] }, { rows: [artifact] }]);
    const result = await readOfferIssuanceArtifact(approver.tx, context(), {
      workspaceId: M203B1_IDS.workspace,
      offerId: M203B1_IDS.offer,
      issuanceId: M203B1_IDS.issuance,
    });
    expect(result).toMatchObject({
      filename: "ANG-2026-000042-NICHT-AUSGESTELLT-Ausstellungsfassung.pdf",
      state: "ready_for_approval",
      approvalCount: 0,
      publicationStatus: "not_issued",
      sha256,
    });
    expect(result.bytes).not.toBe(bytes);
    expect(result.bytes.equals(bytes)).toBe(true);

    const viewer = transaction([{ rows: [{
      ...ready,
      can_current_actor_approve: false,
      approval_artifact_version: null,
    }] }]);
    await expect(readOfferIssuanceArtifact(viewer.tx, context("viewer", {}), {
      workspaceId: M203B1_IDS.workspace,
      offerId: M203B1_IDS.offer,
      issuanceId: M203B1_IDS.issuance,
    })).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "offer.issue.approve",
    });

    const corrupt = transaction([
      { rows: [ready] },
      { rows: [{ ...artifact, artifact_sha256_hex: "0".repeat(64) }] },
    ]);
    await expect(readOfferIssuanceArtifact(corrupt.tx, context(), {
      workspaceId: M203B1_IDS.workspace,
      offerId: M203B1_IDS.offer,
      issuanceId: M203B1_IDS.issuance,
    })).rejects.toBeInstanceOf(OfferIssuanceIntegrityError);
  });
});
