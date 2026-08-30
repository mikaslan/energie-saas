import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  offerIssuance,
  offerIssuanceApproval,
  offerIssuanceWithdrawal,
  type OfferIssuanceRenderState,
  type OfferIssuanceWithdrawalReason,
} from "@/lib/db/schema";
import { describe, expect, expectTypeOf, it } from "vitest";

const dialect = new PgDialect();
const tables = [offerIssuance, offerIssuanceApproval, offerIssuanceWithdrawal] as const;

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

describe("M2-03b1 declarative offer-issuance schema", () => {
  it("deklariert exakt drei tenantgebundene Relationen", () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      "offer_issuance",
      "offer_issuance_approval",
      "offer_issuance_withdrawal",
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

  it("bindet die neue Fassung tenantgleich an Candidate und dessen Approval", () => {
    expect(foreignKeyColumns(
      offerIssuance,
      "offer_issuance_candidate_fk",
    )).toEqual([
      ["workspace_id", "candidate_id"],
      ["workspace_id", "id"],
    ]);
    expect(foreignKeyColumns(
      offerIssuance,
      "offer_issuance_candidate_approval_fk",
    )).toEqual([
      ["workspace_id", "candidate_approval_id"],
      ["workspace_id", "id"],
    ]);
    for (const name of [
      "candidateApprovedBy",
      "candidateInputSha256",
      "candidateArtifactSha256",
      "candidateArtifactVersion",
      "variantSnapshotSha256",
      "profileSnapshotSha256",
      "recipientSnapshotSha256",
      "reservationKey",
      "inputSnapshot",
      "inputSha256",
    ]) {
      expect(Object.keys(offerIssuance)).toContain(name);
    }
  });

  it("modelliert nur den Renderzustand und niemals einen Issued-/Archivpfad", () => {
    expect(checkSql(offerIssuance, "offer_issuance_state_ck")).toMatch(
      /queued[\s\S]*running[\s\S]*retry_wait[\s\S]*ready_for_approval[\s\S]*failed_final/u,
    );
    expect(checkSql(offerIssuance, "offer_issuance_intent_ck"))
      .toContain("offer_issuance_final");
    expect(checkSql(offerIssuance, "offer_issuance_artifact_ck")).toMatch(
      /application\/pdf[\s\S]*8388608[\s\S]*sha256[\s\S]*artifact_sha256 <> offer_issuance\.candidate_artifact_sha256[\s\S]*artifact_version is not null/u,
    );
    expectTypeOf<OfferIssuanceRenderState>().toEqualTypeOf<
      "queued" | "running" | "retry_wait" | "ready_for_approval" | "failed_final"
    >();

    const forbidden = [
      "issued",
      "issuedAt",
      "archiveState",
      "archiveObjectKey",
      "storageVersionId",
      "retentionUntil",
      "sentAt",
      "signedAt",
    ];
    for (const table of tables) {
      expect(Object.keys(table)).not.toEqual(expect.arrayContaining(forbidden));
    }
  });

  it("bindet Freigaben bytegenau und erlaubt hoechstens eine je Actor", () => {
    const config = getTableConfig(offerIssuanceApproval);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "offer_issuance_approval_ws_issuance_actor_uq",
    );
    expect(foreignKeyColumns(
      offerIssuanceApproval,
      "offer_issuance_approval_issuance_fk",
    )[0]).toEqual(expect.arrayContaining([
      "workspace_id",
      "issuance_id",
      "input_sha256",
      "artifact_sha256",
      "artifact_version",
      "candidate_approval_id",
      "candidate_approved_by",
    ]));
    expect(checkSql(offerIssuanceApproval, "offer_issuance_approval_ack_ck"))
      .toMatch(/recipient_and_scope_reviewed[\s\S]*commercial_totals_reviewed[\s\S]*legal_profile_reviewed[\s\S]*final_pdf_for_archive_understood/u);
    expect(checkSql(
      offerIssuanceApproval,
      "offer_issuance_approval_zero_tax_ck",
    )).toMatch(/has_zero_tax_treatment[\s\S]*zero_tax_treatment_reviewed/u);
  });

  it("modelliert Withdrawal einmalig, strukturiert und append-only-faehig", () => {
    const config = getTableConfig(offerIssuanceWithdrawal);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "offer_issuance_withdrawal_ws_issuance_uq",
    );
    expect(checkSql(offerIssuanceWithdrawal, "offer_issuance_withdrawal_reason_ck"))
      .toMatch(/content_error[\s\S]*recipient_error[\s\S]*legal_text_error[\s\S]*commercial_error[\s\S]*other/u);
    expectTypeOf<OfferIssuanceWithdrawalReason>().toEqualTypeOf<
      "content_error" | "recipient_error" | "legal_text_error" |
      "commercial_error" | "other"
    >();
    expect(Object.keys(offerIssuanceWithdrawal)).not.toContain("freeText");
  });
});
