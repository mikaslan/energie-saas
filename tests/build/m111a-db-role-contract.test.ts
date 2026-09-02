import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const ROLE_CONTRACT = "scripts/db-role-contract.mts";
const MIGRATION = "drizzle/0039_m1_11a_project_outcome.sql";
const M111B_MIGRATION = "drizzle/0040_m1_11b_cannot_fulfill.sql";

const RUNTIME_ROUTINES = [
  "_m111a_actor_can_manage_loss_reasons(uuid)",
  "_m111a_actor_can_read_loss_reasons(uuid)",
  "_m111a_actor_role(uuid)",
] as const;

const PRIVATE_ROUTINES = [
  "_m111a_erasure_scrub_allowed(uuid,uuid)",
  "_m111a_guard_loss_reason()",
  "_m111b_guard_outcome_evidence_insert()",
  "_m111b_guard_project_outcome()",
  "_m111b_record_project_outcome()",
] as const;

function compactSql(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),;])\s*/gu, "$1")
    .trim();
}

function outcomeApplySection(source: string): string {
  const start = source.indexOf("const hasProjectOutcomes = await hasAtomicPublicRelationSet(");
  const end = source.indexOf("const hasCustomerNotification = await hasAtomicPublicRelationSet(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function functionBody(migration: string, name: string): string {
  const functionStart = migration.indexOf(`CREATE FUNCTION public.${name}`);
  expect(functionStart).toBeGreaterThanOrEqual(0);
  const match = migration.slice(functionStart).match(/AS \$(\w+)\$([\s\S]*?)\$\1\$/u);
  expect(match).not.toBeNull();
  return match?.[2] ?? "";
}

async function functionBodyAcrossMigrations(name: string): Promise<string> {
  const sources = await Promise.all([
    readFile(MIGRATION, "utf8"),
    readFile(M111B_MIGRATION, "utf8"),
  ]);
  const source = sources.find((candidate) => candidate.includes(`CREATE FUNCTION public.${name}`));
  if (!source) throw new Error(`${name} fehlt in 0039 und 0040`);
  return functionBody(source, name);
}

describe("M1-11a DB-Rollenmanifest", () => {
  it("behandelt die Verlustgrund-Taxonomie als optionale atomare Einheit", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    expect(source).toContain('const PROJECT_OUTCOME_RELATIONS = ["project_loss_reason"]');
    expect(source).toContain("Rollen-ACL-Manifest: M1-11a-Projektergebnis");
    expect(source).toContain("Rollenvertrag: M1-11a-Projektergebnis");
    expect(source).toContain("PROJECT_OUTCOME_RELATIONS.map(");
    expect(source).toContain("project_loss_reason:tenant_isolation:");
    expect(source).toContain("project_loss_reason_mutation_guard:31:O");
    expect(source).toContain("project_loss_reason_no_truncate:34:O");
  });

  it("entzieht dem Worker jede direkte Project-Lesesicht", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");
    const compactSource = compactSql(source);

    expect(compactSource).toContain(
      "revoke all privileges on public.project from app_worker;",
    );
    expect(compactSource).not.toContain(
      "grant select on public.workspace,public.membership,public.site,public.project,",
    );
    expect(source).not.toContain("app_worker:project:SELECT:app_owner:false");
    expect(source).toContain("has_table_privilege(");
    expect(source).toContain("has_column_privilege(");
    expect(source).toContain("app_worker darf keine Project-Spalte lesen");
  });

  it("erteilt nur Runtime-Helfern EXECUTE und hält Triggerfunktionen privat", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");
    const applySection = compactSql(outcomeApplySection(source));

    expect(applySection).toContain(
      "grant select,insert,update on public.project_loss_reason to app_runtime;",
    );
    expect(applySection).not.toMatch(/\bto app_worker\b/iu);
    for (const routine of RUNTIME_ROUTINES) {
      expect(compactSql(source)).toContain(routine);
    }
    expect(applySection).toContain("...PROJECT_OUTCOME_PRIVATE_ROUTINES");
    for (const routine of PRIVATE_ROUTINES) {
      expect(source).toContain(`public.${routine}`);
      expect(source).not.toContain(`app_runtime:${routine}:EXECUTE`);
    }
  });

  it("pinnt alle acht aktuellen 0039/0040-Funktionskörper per SHA-256", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    for (const signature of [...RUNTIME_ROUTINES, ...PRIVATE_ROUTINES]) {
      const name = signature.slice(0, signature.indexOf("("));
      const hash = createHash("sha256")
        .update(await functionBodyAcrossMigrations(name))
        .digest("hex");
      expect(source, `${name} ist nicht im Rollenvertrag gepinnt`).toContain(hash);
    }
  });

  it("pinnt Transition-, Insert- und Evidenz-Provenienztrigger", async () => {
    const source = await readFile(ROLE_CONTRACT, "utf8");

    expect(source).toContain("pg_get_triggerdef(trigger.oid, false)");
    expect(source).toContain("project_outcome_evidence:17:O");
    expect(source).toContain("project_outcome_insert_guard:7:O");
    expect(source).toContain("project_outcome_mutation_guard:19:O");
    expect(source).toContain("domain_events_project_outcome_insert_guard:7:O");
    expect(source).toContain("audit_log_project_outcome_insert_guard:7:O");
    expect(source).toContain("old.outcome_revision IS DISTINCT FROM new.outcome_revision");
    expect(source).toContain("old.loss_reason_text IS DISTINCT FROM new.loss_reason_text");
  });
});
