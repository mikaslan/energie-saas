import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_RECIPIENT_REVISE_COMMAND_VERSION,
  OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
  OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
  buildOfferRecipientSnapshot,
  buildOfferReleaseProfileSnapshot,
} from "@/lib/integrations/offers/release-contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  OfferReleaseProfileConflictError,
  OfferReleaseProfileIntegrityError,
  OfferReleaseProfileNotFoundError,
  OfferReleaseProfilePersistenceError,
  OfferReleaseProfileValidationError,
  activateOfferReleaseProfile,
  readCurrentOfferRecipient,
  readCurrentOfferReleaseProfile,
  reviseOfferRecipient,
  reviseOfferReleaseProfile,
} from "@/modules/offers/release-profile-service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "21111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_REVISION_ID = "44444444-4444-4444-8444-444444444444";
const NEXT_PROFILE_REVISION_ID = "45444444-4444-4444-8444-444444444444";
const ACTIVATION_ID = "55555555-5555-4555-8555-555555555555";
const OFFER_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_OFFER_ID = "67666666-6666-4666-8666-666666666666";
const RECIPIENT_ID = "77777777-7777-4777-8777-777777777777";
const RECIPIENT_REVISION_ID = "88888888-8888-4888-8888-888888888888";
const CREATED_AT = "2026-08-30T10:11:12.000Z";
const NEXT_CREATED_AT = "2026-08-30T11:12:13.000Z";

type InsertValue = Record<string, unknown>;

function context(
  role: ServiceCtx["role"] = "admin",
  capabilities: ServiceCtx["capabilities"] = {},
): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role,
    capabilities,
    featureFlags: {},
  };
}

function transaction(responses: Array<{ rows: unknown[] } | Error>) {
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

function profileCommand(expectedCurrentRevision = 0) {
  return {
    schemaVersion: OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
    workspaceId: WORKSPACE_ID,
    expectedCurrentRevision,
    profileName: "Synthetisches Angebotsprofil",
    sender: {
      legalName: "Testenergie GmbH",
      tradingName: "Testenergie",
      representedBy: "Mara Muster",
      address: {
        street: "Sonnenallee",
        houseNumber: "17",
        postalCode: "10115",
        city: "Berlin",
        country: "DE" as const,
      },
      email: "office@release.invalid",
      phoneE164: "+49301234567",
      websiteHttpsUrl: "https://release.invalid",
      registerCourt: "Amtsgericht Berlin",
      registerNumber: "HRB 12345",
      vatId: "DE123456789",
    },
    legalDocuments: {
      terms: { title: "Angebotsbedingungen", plainText: "PRIVATE_TERMS_SENTINEL" },
      withdrawalInformation: {
        title: "Widerrufsinformation",
        plainText: "PRIVATE_WITHDRAWAL_SENTINEL",
      },
      privacyNotice: {
        title: "Datenschutzhinweis",
        plainText: "PRIVATE_PRIVACY_SENTINEL",
      },
    },
  };
}

function profileSnapshot(
  revision = 1,
  profileRevisionId = PROFILE_REVISION_ID,
  createdAt = CREATED_AT,
) {
  const command = profileCommand(revision - 1);
  return buildOfferReleaseProfileSnapshot({
    profileId: PROFILE_ID,
    profileRevisionId,
    workspaceId: WORKSPACE_ID,
    revision,
    profileName: command.profileName,
    sender: command.sender,
    legalDocuments: command.legalDocuments,
    createdBy: ACTOR_ID,
    createdAt,
  });
}

function recipientCommand(expectedCurrentRevision = 0) {
  return {
    schemaVersion: OFFER_RECIPIENT_REVISE_COMMAND_VERSION,
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    expectedCurrentRevision,
    displayName: "Ria Rechnung",
    company: "PRIVATE_RECIPIENT_COMPANY",
    email: "recipient@release.invalid",
    billingAddress: {
      street: "Rechnungsweg",
      houseNumber: "8a",
      postalCode: "10999",
      city: "Berlin",
      country: "DE" as const,
    },
    billingDetailsConfirmed: true as const,
  };
}

function recipientSnapshot() {
  const command = recipientCommand();
  return buildOfferRecipientSnapshot({
    recipientRevisionId: RECIPIENT_REVISION_ID,
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    revision: 1,
    displayName: command.displayName,
    company: command.company,
    email: command.email,
    billingAddress: command.billingAddress,
    confirmationCode: "recipient_billing_operator_confirmed",
    confirmedBy: ACTOR_ID,
    confirmedAt: CREATED_AT,
    createdBy: ACTOR_ID,
    createdAt: CREATED_AT,
  });
}

function revisedProfileEnvelope(snapshot = profileSnapshot()) {
  return {
    result: {
      status: "revised",
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      profileRevisionId: snapshot.profileRevisionId,
      revision: snapshot.revision,
      snapshot,
      snapshotSha256: snapshot.snapshotSha256,
      createdBy: ACTOR_ID,
      createdAt: snapshot.createdAt,
    },
  };
}

function revisedRecipientEnvelope(snapshot = recipientSnapshot()) {
  return {
    result: {
      status: "revised",
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      recipientId: RECIPIENT_ID,
      recipientRevisionId: snapshot.recipientRevisionId,
      revision: snapshot.revision,
      snapshot,
      snapshotSha256: snapshot.snapshotSha256,
      createdBy: ACTOR_ID,
      createdAt: snapshot.createdAt,
    },
  };
}

describe("M2-03a offer release profile and recipient service", () => {
  it("authorizes every boundary before parsing or SQL and always blocks external-only actors", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;

    await expect(reviseOfferReleaseProfile(tx, context("editor"), {}))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "settings.manage" });
    await expect(activateOfferReleaseProfile(
      tx,
      context("admin", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(readCurrentOfferReleaseProfile(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError", action: "project.read" });
    await expect(reviseOfferRecipient(tx, context("viewer"), {}))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "offer.release.prepare" });
    await expect(readCurrentOfferRecipient(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError", action: "project.read" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown command fields and cross-workspace keys without touching SQL", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;

    await expect(reviseOfferReleaseProfile(tx, context(), {
      ...profileCommand(),
      actorId: ACTOR_ID,
    })).rejects.toBeInstanceOf(OfferReleaseProfileValidationError);
    await expect(readCurrentOfferReleaseProfile(tx, context("viewer"), {
      workspaceId: OTHER_WORKSPACE_ID,
    })).rejects.toBeInstanceOf(OfferReleaseProfileNotFoundError);
    await expect(readCurrentOfferRecipient(tx, context("viewer"), {
      workspaceId: OTHER_WORKSPACE_ID,
      offerId: OFFER_ID,
    })).rejects.toBeInstanceOf(OfferReleaseProfileNotFoundError);

    expect(execute).not.toHaveBeenCalled();
  });

  it("revises a profile only through the narrow DB function and validates DB-derived metadata", async () => {
    const snapshot = profileSnapshot();
    const harness = transaction([{ rows: [revisedProfileEnvelope(snapshot)] }]);

    await expect(reviseOfferReleaseProfile(
      harness.tx,
      context(),
      profileCommand(),
    )).resolves.toEqual({
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      revision: 1,
      snapshot,
    });

    expect(harness.execute).toHaveBeenCalledTimes(1);
    const sqlCall = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCall).toContain("revise_offer_release_profile");
    expect(sqlCall).not.toContain(ACTOR_ID);
    expect(sqlCall).not.toContain(PROFILE_ID);
    expect(sqlCall).not.toContain(PROFILE_REVISION_ID);
    expect(sqlCall).not.toContain(CREATED_AT);
    expect(sqlCall).not.toContain(snapshot.snapshotSha256);
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("offer.release_profile_revised");
    expect(metadata).toContain(PROFILE_REVISION_ID);
    expect(metadata).toContain("revised");
    expect(metadata).not.toContain("PRIVATE_");
    expect(metadata).not.toContain("Testenergie GmbH");
    expect(metadata).not.toContain(snapshot.snapshotSha256);
  });

  it("maps a stale profile revision to one conflict shape and does not audit it as success", async () => {
    const harness = transaction([{ rows: [{ result: {
      status: "conflict",
      currentRevision: 4,
    } }] }]);

    await expect(reviseOfferReleaseProfile(
      harness.tx,
      context(),
      profileCommand(3),
    )).rejects.toMatchObject({
      name: "OfferReleaseProfileConflictError",
      currentRevision: 4,
    });
    expect(new OfferReleaseProfileConflictError(4).currentRevision).toBe(4);
    expect(harness.inserts).toEqual([]);
  });

  it("activates only the exact operator-reviewed profile revision", async () => {
    const snapshot = profileSnapshot();
    const harness = transaction([{ rows: [{ result: {
      status: "activated",
      workspaceId: WORKSPACE_ID,
      activationId: ACTIVATION_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      profileRevision: 1,
      profileSnapshotSha256: snapshot.snapshotSha256,
      reviewState: "operator_reviewed",
      reviewedBy: ACTOR_ID,
      reviewedAt: CREATED_AT,
      snapshot,
    } }] }]);

    await expect(activateOfferReleaseProfile(harness.tx, context(), {
      schemaVersion: OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      expectedProfileRevision: 1,
    })).resolves.toEqual({
      activationId: ACTIVATION_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      profileRevision: 1,
      reviewState: "operator_reviewed",
      reviewedAt: CREATED_AT,
      snapshot,
    });

    expect(JSON.stringify(harness.execute.mock.calls)).toContain(
      "activate_offer_release_profile",
    );
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("offer.release_profile_activated");
    expect(metadata).toContain("operator_reviewed");
    expect(metadata).not.toContain(snapshot.snapshotSha256);
    expect(metadata).not.toContain("PRIVATE_");
  });

  it("fails closed when an activation row drifts across actor, workspace, IDs, revision, or hash", async () => {
    const snapshot = profileSnapshot();
    const base = {
      status: "activated",
      workspaceId: WORKSPACE_ID,
      activationId: ACTIVATION_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      profileRevision: 1,
      profileSnapshotSha256: snapshot.snapshotSha256,
      reviewState: "operator_reviewed",
      reviewedBy: ACTOR_ID,
      reviewedAt: CREATED_AT,
      snapshot,
    };
    const drifts = [
      { ...base, workspaceId: OTHER_WORKSPACE_ID },
      { ...base, reviewedBy: "92222222-2222-4222-8222-222222222222" },
      { ...base, profileRevision: 2 },
      { ...base, profileSnapshotSha256: "0".repeat(64) },
      { ...base, extra: "unexpected" },
    ];

    for (const result of drifts) {
      const harness = transaction([{ rows: [{ result }] }]);
      await expect(activateOfferReleaseProfile(harness.tx, context(), {
        schemaVersion: OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        expectedProfileRevision: 1,
      })).rejects.toBeInstanceOf(OfferReleaseProfileIntegrityError);
      expect(harness.inserts).toEqual([]);
    }
  });

  it("reads current and separately active profile snapshots with exact bindings", async () => {
    const activeSnapshot = profileSnapshot();
    const currentSnapshot = profileSnapshot(2, NEXT_PROFILE_REVISION_ID, NEXT_CREATED_AT);
    const harness = transaction([{ rows: [{
      workspace_id: WORKSPACE_ID,
      profile_id: PROFILE_ID,
      current_profile_revision_id: NEXT_PROFILE_REVISION_ID,
      current_revision: 2,
      current_snapshot: currentSnapshot,
      current_snapshot_sha256_hex: currentSnapshot.snapshotSha256,
      active_activation_id: ACTIVATION_ID,
      active_profile_revision_id: PROFILE_REVISION_ID,
      active_profile_revision: 1,
      active_snapshot: activeSnapshot,
      active_snapshot_sha256_hex: activeSnapshot.snapshotSha256,
      active_review_state: "operator_reviewed",
      active_reviewed_at: CREATED_AT,
    }] }]);

    await expect(readCurrentOfferReleaseProfile(harness.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
    })).resolves.toEqual({
      profileId: PROFILE_ID,
      currentRevision: 2,
      current: currentSnapshot,
      active: {
        activationId: ACTIVATION_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        profileRevision: 1,
        reviewState: "operator_reviewed",
        reviewedAt: CREATED_AT,
        snapshot: activeSnapshot,
      },
    });
  });

  it("uses one not-found shape for missing profiles, activations and offer recipients", async () => {
    const missingProfile = transaction([{ rows: [] }]);
    await expect(readCurrentOfferReleaseProfile(missingProfile.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
    })).rejects.toBeInstanceOf(OfferReleaseProfileNotFoundError);

    const missingActivation = transaction([{ rows: [{ result: {
      status: "not_found",
    } }] }]);
    await expect(activateOfferReleaseProfile(missingActivation.tx, context(), {
      schemaVersion: OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      expectedProfileRevision: 1,
    })).rejects.toBeInstanceOf(OfferReleaseProfileNotFoundError);

    const missingRecipient = transaction([{ rows: [] }]);
    await expect(readCurrentOfferRecipient(missingRecipient.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
    })).rejects.toBeInstanceOf(OfferReleaseProfileNotFoundError);
  });

  it("revises an offer-local recipient without actor, ID, time, hash, or site fallback input", async () => {
    const snapshot = recipientSnapshot();
    const harness = transaction([{ rows: [revisedRecipientEnvelope(snapshot)] }]);
    const editor = context("editor", { prepare_offer_documents: true });

    await expect(reviseOfferRecipient(
      harness.tx,
      editor,
      recipientCommand(),
    )).resolves.toEqual({
      recipientId: RECIPIENT_ID,
      recipientRevisionId: RECIPIENT_REVISION_ID,
      revision: 1,
      snapshot,
    });

    const sqlCall = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCall).toContain("revise_offer_recipient");
    expect(sqlCall).toContain("Rechnungsweg");
    expect(sqlCall).not.toContain("installation");
    expect(sqlCall).not.toContain(ACTOR_ID);
    expect(sqlCall).not.toContain(RECIPIENT_ID);
    expect(sqlCall).not.toContain(RECIPIENT_REVISION_ID);
    expect(sqlCall).not.toContain(CREATED_AT);
    expect(sqlCall).not.toContain(snapshot.snapshotSha256);
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("offer.recipient_revised");
    expect(metadata).toContain(RECIPIENT_REVISION_ID);
    expect(metadata).not.toContain("Ria Rechnung");
    expect(metadata).not.toContain("PRIVATE_RECIPIENT_COMPANY");
    expect(metadata).not.toContain("recipient@release.invalid");
    expect(metadata).not.toContain(snapshot.snapshotSha256);
  });

  it("validates recipient ownership, revision, actor, timestamp and canonical snapshot", async () => {
    const snapshot = recipientSnapshot();
    const base = revisedRecipientEnvelope(snapshot).result;
    const drifts = [
      { ...base, offerId: OTHER_OFFER_ID },
      { ...base, revision: 2 },
      { ...base, createdBy: "92222222-2222-4222-8222-222222222222" },
      { ...base, createdAt: NEXT_CREATED_AT },
      { ...base, snapshotSha256: "f".repeat(64) },
      { ...base, snapshot: { ...snapshot, displayName: "Manipuliert" } },
    ];

    for (const result of drifts) {
      const harness = transaction([{ rows: [{ result }] }]);
      await expect(reviseOfferRecipient(
        harness.tx,
        context("editor", { prepare_offer_documents: true }),
        recipientCommand(),
      )).rejects.toBeInstanceOf(OfferReleaseProfileIntegrityError);
      expect(harness.inserts).toEqual([]);
    }
  });

  it("reads only the current recipient revision and rejects a cross-bound snapshot", async () => {
    const snapshot = recipientSnapshot();
    const harness = transaction([{ rows: [{
      workspace_id: WORKSPACE_ID,
      offer_id: OFFER_ID,
      recipient_id: RECIPIENT_ID,
      recipient_revision_id: RECIPIENT_REVISION_ID,
      revision: 1,
      snapshot,
      snapshot_sha256_hex: snapshot.snapshotSha256,
    }] }]);

    await expect(readCurrentOfferRecipient(harness.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
    })).resolves.toEqual({
      recipientId: RECIPIENT_ID,
      recipientRevisionId: RECIPIENT_REVISION_ID,
      revision: 1,
      snapshot,
    });

    const crossBound = transaction([{ rows: [{
      workspace_id: WORKSPACE_ID,
      offer_id: OTHER_OFFER_ID,
      recipient_id: RECIPIENT_ID,
      recipient_revision_id: RECIPIENT_REVISION_ID,
      revision: 1,
      snapshot,
      snapshot_sha256_hex: snapshot.snapshotSha256,
    }] }]);
    await expect(readCurrentOfferRecipient(crossBound.tx, context("viewer"), {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
    })).rejects.toBeInstanceOf(OfferReleaseProfileIntegrityError);
  });

  it("maps malformed function envelopes to integrity and execution failures to persistence", async () => {
    const malformed = transaction([{ rows: [{
      ...revisedProfileEnvelope(),
      unexpected: true,
    }] }]);
    await expect(reviseOfferReleaseProfile(
      malformed.tx,
      context(),
      profileCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseProfileIntegrityError);

    const failed = transaction([new Error("PRIVATE_DATABASE_DIAGNOSTIC")]);
    await expect(reviseOfferReleaseProfile(
      failed.tx,
      context(),
      profileCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseProfilePersistenceError);

    const empty = transaction([{ rows: [] }]);
    await expect(reviseOfferReleaseProfile(
      empty.tx,
      context(),
      profileCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseProfilePersistenceError);
  });
});
