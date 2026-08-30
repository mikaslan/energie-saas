import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const ROLE_CONTRACT = "scripts/db-role-contract.mts";

const ISSUANCE_RELATIONS = [
  "offer_issuance",
  "offer_issuance_approval",
  "offer_issuance_withdrawal",
] as const;

const RUNTIME_FUNCTIONS = [
  "prepare_offer_issuance(uuid,uuid,uuid)",
  "approve_offer_issuance(uuid,uuid,boolean,boolean,boolean,boolean,boolean)",
  "withdraw_offer_issuance(uuid,uuid,text)",
  "read_offer_issuance_status(uuid,uuid,uuid)",
  "read_offer_issuance_artifact(uuid,uuid,uuid)",
] as const;

const WORKER_FUNCTIONS = [
  "claim_offer_issuance_render(uuid,uuid,uuid,integer)",
  "finalize_offer_issuance_render_success(uuid,uuid,uuid,integer,bytea)",
  "finalize_offer_issuance_render_failure(uuid,uuid,uuid,integer,text,boolean)",
  "recover_offer_issuance_renders(uuid,integer)",
  "list_offer_issuance_recovery_workspaces(uuid,integer)",
  "_m203b1_offer_issuance_dispatch_state(uuid,uuid)",
] as const;

function compactSql(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

function issuanceApplySection(source: string): string {
  const start = source.indexOf("// M2-03b1 ist eine atomare Dreier-Einheit.");
  const end = source.indexOf("// pg-boss bleibt vollstaendig worker-owned.", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("M2-03b1 DB-Rollenmanifest", () => {
  it("behandelt alle drei Issuance-Tabellen als atomare optionale Einheit", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    expect(source).toContain("OFFER_ISSUANCE_RELATIONS");
    expect(source).toContain("Rollenvertrag: M2-03b1-Issuance-Relationen");
    expect(source).toContain("Rollen-ACL-Manifest: M2-03b1-Issuance-Relationen");
    for (const relation of ISSUANCE_RELATIONS) {
      expect(source).toContain(`"${relation}"`);
      expect(source).toContain(`public.${relation}`);
    }
  });

  it("belässt Tabellenzugriff hinter getrennten Definer-Grenzen", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");
    const section = compactSql(issuanceApplySection(source));

    expect(section).toContain(
      "revoke all privileges on public.offer_issuance,public.offer_issuance_approval," +
        "public.offer_issuance_withdrawal from public,app_migrator,app_runtime,app_system," +
        "app_auth,app_worker,app_erasure,app_membership_writer,identity_reconciler",
    );
    expect(section).not.toMatch(
      /grant (?:select|insert|update|delete|truncate)\b[^;]*\bto (?:app_runtime|app_worker)/iu,
    );

    for (const signature of RUNTIME_FUNCTIONS) {
      expect(section).toContain(`public.${signature}`);
    }
    for (const signature of WORKER_FUNCTIONS) {
      expect(section).toContain(`public.${signature}`);
    }
  });

  it("pinnt RLS, effektive Funktions-ACLs und den ID-only-Dispatch", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    expect(source).toContain("hasOfferIssuance");
    expect(source).toContain("OFFER_ISSUANCE_RELATIONS.map(");
    for (const relation of ISSUANCE_RELATIONS) {
      expect(source).toContain(`${relation}:tenant_isolation:`);
    }
    for (const signature of [...RUNTIME_FUNCTIONS, ...WORKER_FUNCTIONS]) {
      expect(compactSql(source)).toContain(signature);
    }
    expect(compactSql(source)).toContain(
      "grant execute on function pgboss.enqueue_offer_issuance(uuid,uuid)to app_runtime",
    );
    expect(source).toContain("M2-03b1 effektive Funktions-ACLs");
  });
});
