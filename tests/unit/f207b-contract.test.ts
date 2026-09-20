// F2-07b Freigabe-Ansichten — RED: F207B-CONTRACT-01 + F207B-PRIVACY-01.
// Spec: docs/spec/F2-07b-freigabe-ansichten.md (§Tests, Datenmodell).
// RED via fehlende Reader-Module: `@/modules/offers/release-views`
// existiert noch nicht (neue Reader je Ansicht, Muster listOfferIssuances).
import { describe, expect, it } from "vitest";

import {
  listApprovalLedger,
  listCandidateApprovalHistory,
  listReleaseChronik,
  listWithdrawalHistory,
} from "@/modules/offers/release-views";

const OFFER_ID = "20000000-0000-4000-8000-000000000002";

const FORBIDDEN_KEYS = [
  "approved_by",
  "approvedBy",
  "candidate_approved_by",
  "withdrawn_by",
  "withdrawnBy",
  "actor",
  "payload",
  "approval_command",
  "approvalCommand",
  "withdrawal_command",
  "artifact_sha256",
  "artifact_bytes",
  "approval_artifact_sha256",
] as const;

const LEDGER_WHITELIST = [
  "issuanceId",
  "issuanceReference",
  "ordinal",
  "approvedAt",
  "hasZeroTaxTreatment",
  "approvalVersion",
] as const;

const CANDIDATE_HISTORY_WHITELIST = [
  "candidateId",
  "candidateReference",
  "variantRevision",
  "profileRevision",
  "recipientRevision",
  "hasZeroTaxTreatment",
  "approvedAt",
] as const;

const WITHDRAWAL_WHITELIST = [
  "issuanceId",
  "issuanceReference",
  "reasonCode",
  "reasonLabel",
  "withdrawnAt",
] as const;

const CHRONIK_WHITELIST = [
  "eventType",
  "occurredAt",
  "issuanceReference",
  "candidateReference",
] as const;

function keysOf(value: unknown): string[] {
  expect(value).toBeTypeOf("object");
  return Object.keys(value as Record<string, unknown>).sort();
}

describe("F207B-CONTRACT-01: DTO-Whitelist je Reader", () => {
  it("D4-02 Ledger: nur Whitelist-Spalten, kein approved_by/Hash/Artifact", async () => {
    const rows = await listApprovalLedger(OFFER_ID);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(keysOf(row)).toEqual([...LEDGER_WHITELIST].sort());
      for (const key of FORBIDDEN_KEYS) {
        expect(row as Record<string, unknown>).not.toHaveProperty(key);
      }
    }
  });

  it("D4-01 Candidate-Historie: Revisionsbindung ohne approved_by/Snapshots", async () => {
    const rows = await listCandidateApprovalHistory(OFFER_ID);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(keysOf(row)).toEqual([...CANDIDATE_HISTORY_WHITELIST].sort());
      for (const key of FORBIDDEN_KEYS) {
        expect(row as Record<string, unknown>).not.toHaveProperty(key);
      }
    }
  });

  it("D4-03 Withdraw-Historie: reason_code + Zeitpunkt, kein withdrawn_by", async () => {
    const rows = await listWithdrawalHistory(OFFER_ID);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(keysOf(row)).toEqual([...WITHDRAWAL_WHITELIST].sort());
      for (const key of FORBIDDEN_KEYS) {
        expect(row as Record<string, unknown>).not.toHaveProperty(key);
      }
    }
  });

  it("D4-07 Chronik: kein actor, kein Roh-payload", async () => {
    const rows = await listReleaseChronik(OFFER_ID);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(keysOf(row)).toEqual([...CHRONIK_WHITELIST].sort());
      for (const key of FORBIDDEN_KEYS) {
        expect(row as Record<string, unknown>).not.toHaveProperty(key);
      }
    }
  });
});

describe("F207B-PRIVACY-01 (adversarial): PII-/Hash-/Preis-/Adress-Freiheit", () => {
  it("kein DTO enthält Identität, Hash, Preis, Adresse oder Rechtstext", async () => {
    const dtos = [
      ...(await listApprovalLedger(OFFER_ID)),
      ...(await listCandidateApprovalHistory(OFFER_ID)),
      ...(await listWithdrawalHistory(OFFER_ID)),
      ...(await listReleaseChronik(OFFER_ID)),
    ];
    const serialized = JSON.stringify(dtos);
    expect(serialized).not.toMatch(/@/); // keine E-Mail
    expect(serialized).not.toMatch(/[a-f0-9]{64}/i); // kein sha256-Hash
    expect(serialized).not.toMatch(/straße|strasse|hausnummer|postleitzahl/i);
    expect(serialized).not.toMatch(/approved_by|withdrawn_by|actor/i);
    expect(serialized).not.toMatch(/payload|approval_command|withdrawal_command/i);
    expect(serialized).not.toMatch(/artifact_/i);
  });

  it("Ledger nutzt Ordinale statt Identität (Erste/Zweite Freigabe)", async () => {
    const rows = await listApprovalLedger(OFFER_ID);
    for (const row of rows) {
      expect([1, 2]).toContain(row.ordinal);
      expect(row).not.toHaveProperty("approvedBy");
    }
  });
});
