import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const ROLE_CONTRACT = "scripts/db-role-contract.mts";

const RELEASE_RELATIONS = [
  "offer_recipient",
  "offer_recipient_revision",
  "offer_release_candidate",
  "offer_release_candidate_approval",
  "offer_release_profile",
  "offer_release_profile_activation",
  "offer_release_profile_revision",
] as const;

const RUNTIME_SELECT_RELATIONS = [
  "offer_recipient",
  "offer_recipient_revision",
  "offer_release_profile",
  "offer_release_profile_activation",
  "offer_release_profile_revision",
] as const;

const WORKER_UPDATE_COLUMNS = [
  "artifact_bytes",
  "artifact_mime_type",
  "artifact_sha256",
  "artifact_size_bytes",
  "artifact_version",
  "attempt_count",
  "error_code",
  "error_retryable",
  "finished_at",
  "lease_expires_at",
  "lease_token",
  "next_attempt_at",
  "started_at",
  "state",
  "updated_at",
] as const;

const RUNTIME_FUNCTIONS = [
  "revise_offer_release_profile(uuid,integer,text,jsonb,jsonb)",
  "activate_offer_release_profile(uuid,uuid,uuid,integer)",
  "revise_offer_recipient(uuid,uuid,integer,text,text,text,jsonb,boolean)",
  "prepare_offer_release_candidate(uuid,uuid,uuid,integer,uuid,uuid,uuid,integer,uuid,integer,date)",
  "approve_offer_release_candidate(uuid,uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean)",
  "read_offer_release_candidate_artifact(uuid,uuid,uuid)",
  "read_offer_release_candidate_status(uuid,uuid,uuid)",
] as const;

function compactSql(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

function releaseApplySection(source: string): string {
  const start = source.indexOf("// M2-03a ist eine atomare Siebener-Einheit.");
  const end = source.indexOf("// pg-boss bleibt vollstaendig worker-owned.", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("M2-03a DB-Rollenmanifest", () => {
  it("behandelt alle sieben Release-Tabellen als atomare optionale Einheit", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    expect(source).toContain("hasAtomicPublicRelationSet(");
    expect(source).toContain("Rollenvertrag: M2-03a-Release-Relationen");
    expect(source).toContain("Rollen-ACL-Manifest: M2-03a-Release-Relationen");
    for (const relation of RELEASE_RELATIONS) {
      expect(source).toContain(`"${relation}"`);
      expect(source).toContain(`public.${relation}`);
    }
  });

  it("gibt Runtime nur Quellen-SELECT und die sieben schmalen Definer-Grenzen", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");
    const section = releaseApplySection(source);
    const compactSection = compactSql(section);

    for (const relation of RELEASE_RELATIONS) {
      expect(section).toContain(`public.${relation}`);
    }
    for (const relation of RUNTIME_SELECT_RELATIONS) {
      expect(compactSection).toContain(`public.${relation}`);
    }
    expect(compactSection).not.toMatch(
      /grant select on[^;]*offer_release_candidate(?:_approval)?[^;]*to app_runtime;/u,
    );
    for (const signature of RUNTIME_FUNCTIONS) {
      expect(compactSection).toContain(`public.${signature}`);
    }
    expect(section).not.toMatch(
      /grant\s+(?:insert|update|delete|truncate)\b[^;]*\bto\s+app_runtime\s*;/iu,
    );
  });

  it("begrenzt den Worker auf Candidate-SELECT und exakt 15 UPDATE-Spalten", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");
    const section = releaseApplySection(source);
    const match = section.match(
      /grant update \(([\s\S]*?)\) on public\.offer_release_candidate to app_worker/iu,
    );
    expect(match).not.toBeNull();
    const columns = (match?.[1] ?? "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      .sort();

    expect(columns).toEqual([...WORKER_UPDATE_COLUMNS].sort());
    expect(section).toContain(
      "grant select on public.offer_release_candidate to app_worker",
    );
    for (const relation of RELEASE_RELATIONS.filter(
      (name) => name !== "offer_release_candidate",
    )) {
      expect(section).not.toMatch(
        new RegExp(`grant\\s+select\\s+on\\s+public\\.${relation}\\s+to\\s+app_worker`, "iu"),
      );
    }
  });

  it("pinnt Dispatch, effektive ACLs und alle Katalog-Snapshotklassen", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    expect(source).toContain(
      "grant execute on function pgboss.enqueue_offer_release_candidate(uuid, uuid)",
    );
    expect(source).toContain("M2-03a effektive Funktions-ACLs");
    expect(source).toContain("enqueue_offer_release_candidate(uuid, uuid):void:app_worker");
    expect(source).not.toContain("__M203A_");

    const conditionalSnapshots = source.match(/\.\.\.\(hasOfferRelease \?/gu) ?? [];
    expect(conditionalSnapshots.length).toBeGreaterThanOrEqual(10);
  });
});
