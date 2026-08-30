import { readFileSync } from "node:fs";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  offerRecipient,
  offerRecipientRevision,
  offerPdfDraft,
  offerReleaseCandidate,
  offerReleaseCandidateApproval,
  offerReleaseProfile,
  offerReleaseProfileActivation,
  offerReleaseProfileRevision,
  type OfferReleaseCandidateState,
  type OfferReleasePublicationStatus,
} from "@/lib/db/schema";
import type {
  OfferRecipientSnapshotV1,
  OfferReleaseApprovalCommandV1,
  OfferReleaseCandidateInputV1,
  OfferReleaseProfileSnapshotV1,
} from "@/lib/integrations/offers/release-contract";
import { describe, expect, expectTypeOf, it } from "vitest";

const dialect = new PgDialect();
const tables = [
  offerReleaseProfile,
  offerReleaseProfileRevision,
  offerReleaseProfileActivation,
  offerRecipient,
  offerRecipientRevision,
  offerReleaseCandidate,
  offerReleaseCandidateApproval,
] as const;

type SnapshotTable = {
  columns: Record<string, { name: string; type: string; notNull: boolean }>;
  uniqueConstraints: Record<string, { columns: string[] }>;
};

type DrizzleSnapshot = {
  tables: Record<string, SnapshotTable>;
};

function checkSql(table: PgTable, name: string): string {
  const item = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Check ${name} fehlt.`);
  return dialect.sqlToQuery(item.value).sql.replaceAll('"', "");
}

function foreignKeyColumns(table: PgTable, name: string): [string[], string[]] {
  const item = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (!item) throw new Error(`Foreign Key ${name} fehlt.`);
  const reference = item.reference();
  return [
    reference.columns.map((column) => column.name),
    reference.foreignColumns.map((column) => column.name),
  ];
}

describe("M2-03a declarative offer-release schema", () => {
  it("deklariert exakt sieben tenantgebundene Relationen", () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      "offer_release_profile",
      "offer_release_profile_revision",
      "offer_release_profile_activation",
      "offer_recipient",
      "offer_recipient_revision",
      "offer_release_candidate",
      "offer_release_candidate_approval",
    ]);

    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["id", "workspace_id"]),
      );
      expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
        `${config.name}_workspace_id_fk`,
      );
      expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
        `${config.name}_ws_id_uq`,
      );
    }
  });

  it("modelliert stabile Heads und separat append-only Revision/Aktivierung", () => {
    expect(Object.keys(offerReleaseProfile)).toEqual(expect.arrayContaining([
      "currentRevision",
      "activeActivationId",
    ]));
    expect(Object.keys(offerReleaseProfileRevision)).toEqual(expect.arrayContaining([
      "profileId",
      "revision",
      "snapshot",
      "snapshotSha256",
    ]));
    expect(Object.keys(offerReleaseProfileActivation)).toEqual(expect.arrayContaining([
      "profileId",
      "profileRevisionId",
      "profileRevision",
      "profileSnapshotSha256",
      "reviewState",
    ]));
    expect(Object.keys(offerRecipient)).toEqual(expect.arrayContaining([
      "offerId",
      "currentRevision",
    ]));
    expect(Object.keys(offerRecipientRevision)).toEqual(expect.arrayContaining([
      "recipientId",
      "offerId",
      "revision",
      "snapshot",
      "snapshotSha256",
    ]));

    expect(offerReleaseProfile.currentRevision.default).toBe(0);
    expect(offerRecipient.currentRevision.default).toBe(0);
    expect(checkSql(offerReleaseProfile, "offer_release_profile_revision_ck"))
      .toContain("current_revision >= 0");
    expect(checkSql(offerRecipient, "offer_recipient_revision_ck"))
      .toContain("current_revision >= 0");
    const profileWorkspaceConstraint = getTableConfig(offerReleaseProfile)
      .uniqueConstraints.find((constraint) => (
        constraint.name === "offer_release_profile_workspace_uq"
      ));
    expect(profileWorkspaceConstraint?.columns.map((column) => column.name))
      .toEqual(["workspace_id"]);

    expect(foreignKeyColumns(
      offerReleaseProfileActivation,
      "offer_release_profile_activation_revision_fk",
    )).toEqual([
      [
        "workspace_id",
        "profile_revision_id",
        "profile_id",
        "profile_revision",
        "profile_snapshot_sha256",
      ],
      ["workspace_id", "id", "profile_id", "revision", "snapshot_sha256"],
    ]);
    expect(foreignKeyColumns(
      offerRecipientRevision,
      "offer_recipient_revision_head_fk",
    )).toEqual([
      ["workspace_id", "offer_id", "recipient_id"],
      ["workspace_id", "offer_id", "id"],
    ]);
  });

  it("bindet den Candidate an die exakten kommerziellen, Profil- und Empfaengerquellen", () => {
    expect(foreignKeyColumns(
      offerReleaseCandidate,
      "offer_release_candidate_variant_revision_fk",
    )[0]).toEqual([
      "workspace_id",
      "variant_revision_id",
      "offer_id",
      "variant_id",
      "project_id",
      "variant_revision",
      "variant_snapshot_sha256",
    ]);
    expect(foreignKeyColumns(
      offerReleaseCandidate,
      "offer_release_candidate_source_draft_fk",
    )).toEqual([
      [
        "workspace_id", "source_pdf_draft_id", "project_id", "offer_id",
        "variant_id", "variant_revision_id", "variant_revision",
        "variant_snapshot_sha256", "source_pdf_draft_state",
        "source_pdf_draft_input_sha256", "source_pdf_draft_mime_type",
        "source_pdf_draft_artifact_sha256", "source_pdf_draft_size_bytes",
      ],
      [
        "workspace_id", "id", "project_id", "offer_id", "variant_id",
        "variant_revision_id", "variant_revision", "variant_snapshot_sha256",
        "state", "input_sha256", "artifact_mime_type", "artifact_sha256",
        "artifact_size_bytes",
      ],
    ]);
    expect(getTableConfig(offerPdfDraft).uniqueConstraints.map((item) => item.name))
      .toContain("offer_pdf_draft_ws_release_source_uq");
    expect(foreignKeyColumns(
      offerReleaseCandidate,
      "offer_release_candidate_profile_activation_fk",
    )[0]).toEqual([
      "workspace_id",
      "profile_activation_id",
      "profile_id",
      "profile_revision_id",
      "profile_revision",
      "profile_snapshot_sha256",
    ]);
    expect(foreignKeyColumns(
      offerReleaseCandidate,
      "offer_release_candidate_recipient_revision_fk",
    )[0]).toEqual([
      "workspace_id",
      "recipient_revision_id",
      "recipient_id",
      "offer_id",
      "recipient_revision",
      "recipient_snapshot_sha256",
    ]);

    expect(Object.keys(offerReleaseCandidate)).toEqual(expect.arrayContaining([
      "sourcePdfDraftInputSha256",
      "sourcePdfDraftState",
      "sourcePdfDraftMimeType",
      "sourcePdfDraftArtifactSha256",
      "sourcePdfDraftSizeBytes",
      "reservationKey",
      "inputSnapshot",
      "inputSha256",
      "artifactSha256",
      "artifactBytes",
      "artifactVersion",
    ]));
  });

  it("haelt die opaque Artefaktversion im 0034-Snapshot am Candidate statt am PDF-Entwurf", () => {
    const snapshot = JSON.parse(
      readFileSync("drizzle/meta/0034_snapshot.json", "utf8"),
    ) as DrizzleSnapshot;
    const sourceDraft = snapshot.tables["public.offer_pdf_draft"];
    const candidate = snapshot.tables["public.offer_release_candidate"];
    if (!sourceDraft || !candidate) throw new Error("M2-03a Snapshot-Tabellen fehlen.");

    expect(sourceDraft.columns).not.toHaveProperty("artifact_version");
    expect(
      sourceDraft.uniqueConstraints.offer_pdf_draft_ws_release_source_uq?.columns,
    ).not.toContain("artifact_version");
    expect(candidate.columns.artifact_version).toMatchObject({
      name: "artifact_version",
      type: "uuid",
      notNull: false,
    });
    expect(
      candidate.uniqueConstraints.offer_release_candidate_ws_approval_binding_uq?.columns,
    ).toContain("artifact_version");
  });

  it("haelt Zustand, Publication und Artefakt fail-closed", () => {
    expect(checkSql(offerReleaseCandidate, "offer_release_candidate_state_ck"))
      .toMatch(/queued[\s\S]*running[\s\S]*retry_wait[\s\S]*ready_for_approval[\s\S]*failed_final/u);
    expect(checkSql(offerReleaseCandidate, "offer_release_candidate_publication_ck"))
      .toContain("not_issued");
    expect(checkSql(offerReleaseCandidate, "offer_release_candidate_artifact_ck"))
      .toMatch(/application\/pdf[\s\S]*8388608[\s\S]*sha256[\s\S]*artifact_version is not null/u);
    expect(checkSql(offerReleaseCandidate, "offer_release_candidate_shape_ck"))
      .toMatch(/ready_for_approval[\s\S]*artifact_bytes is not null[\s\S]*artifact_version is not null/u);

    expectTypeOf<OfferReleaseCandidateState>().toEqualTypeOf<
      "queued" | "running" | "retry_wait" | "ready_for_approval" | "failed_final"
    >();
    expectTypeOf<OfferReleasePublicationStatus>().toEqualTypeOf<"not_issued">();

    const forbidden = [
      "issuedAt",
      "sentAt",
      "signedAt",
      "wormObjectKey",
      "retentionUntil",
      "storageVersionId",
    ];
    expect(Object.keys(offerReleaseCandidate)).not.toEqual(expect.arrayContaining(forbidden));
  });

  it("spiegelt versionierte JSON-Vertraege und deren kanonische Hashes", () => {
    expectTypeOf<(typeof offerReleaseProfileRevision.$inferSelect)["snapshot"]>()
      .toEqualTypeOf<OfferReleaseProfileSnapshotV1>();
    expectTypeOf<(typeof offerRecipientRevision.$inferSelect)["snapshot"]>()
      .toEqualTypeOf<OfferRecipientSnapshotV1>();
    expectTypeOf<(typeof offerReleaseCandidate.$inferSelect)["inputSnapshot"]>()
      .toEqualTypeOf<OfferReleaseCandidateInputV1>();
    expectTypeOf<(typeof offerReleaseCandidateApproval.$inferSelect)["approvalCommand"]>()
      .toEqualTypeOf<OfferReleaseApprovalCommandV1>();

    expect(checkSql(
      offerReleaseProfileRevision,
      "offer_release_profile_revision_json_ck",
    )).toMatch(/profileRevisionId[\s\S]*profile_id[\s\S]*snapshotSha256/u);
    expect(checkSql(
      offerRecipientRevision,
      "offer_recipient_revision_json_ck",
    )).toMatch(/recipientRevisionId[\s\S]*offerId[\s\S]*snapshotSha256/u);
    const inputMirror = checkSql(
      offerReleaseCandidate,
      "offer_release_candidate_input_ck",
    );
    expect(inputMirror).toMatch(
      /schemaVersion[\s\S]*documentStatus[\s\S]*publication_status[\s\S]*validThrough/u,
    );
    expect(inputMirror).not.toMatch(/candidateId|candidate_id/u);
    expect(checkSql(
      offerReleaseCandidate,
      "offer_release_candidate_input_hash_ck",
    )).toMatch(/canonicalize_offer_json_v1[\s\S]*input_snapshot/u);
  });

  it("bindet Approval einmalig an Candidate-Input und tatsaechliche PDF-Bytes", () => {
    const approvalConfig = getTableConfig(offerReleaseCandidateApproval);
    expect(approvalConfig.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "offer_release_candidate_approval_ws_candidate_uq",
    );
    expect(foreignKeyColumns(
      offerReleaseCandidateApproval,
      "offer_release_candidate_approval_candidate_fk",
    )[0]).toEqual(expect.arrayContaining([
      "workspace_id",
      "candidate_id",
      "input_sha256",
      "artifact_sha256",
      "artifact_version",
      "variant_snapshot_sha256",
      "profile_snapshot_sha256",
      "recipient_snapshot_sha256",
      "template_version",
      "renderer_recipe_version",
    ]));
    expect(checkSql(
      offerReleaseCandidateApproval,
      "offer_release_candidate_approval_ack_ck",
    )).toMatch(/recipient_billing_reviewed[\s\S]*commercial_content_reviewed[\s\S]*active_profile_reviewed[\s\S]*not_issued_status_understood/u);
    expect(checkSql(
      offerReleaseCandidateApproval,
      "offer_release_candidate_approval_zero_tax_ck",
    )).toMatch(/has_zero_tax_treatment[\s\S]*zero_tax_treatment_reviewed/u);
    expect(checkSql(
      offerReleaseCandidateApproval,
      "offer_release_candidate_approval_json_ck",
    )).toMatch(/expectedArtifactVersion[\s\S]*artifact_version/u);

    expect(Object.keys(offerReleaseCandidateApproval)).not.toEqual(expect.arrayContaining([
      "issuedAt",
      "sentAt",
      "wormObjectKey",
    ]));
  });
});
