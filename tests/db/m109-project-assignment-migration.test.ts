import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MIGRATION = "drizzle/0037_m1_09_project_assignment.sql";

describe("M1-09 Migration und RLS-Vertrag", () => {
  it("modelliert tenantgebundene Assignments und eine konfliktfähige Project-Revision", async () => {
    const [migration, projectSchema, assignmentSchema] = await Promise.all([
      readFile(MIGRATION, "utf8"),
      readFile("lib/db/schema/project.ts", "utf8"),
      readFile("lib/db/schema/project-assignment.ts", "utf8"),
    ]);

    expect(projectSchema).toContain('assignmentRevision: integer("assignment_revision")');
    expect(migration).toContain('ADD COLUMN "assignment_revision" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain("project_assignment_revision_ck");
    expect(assignmentSchema).toMatch(/pgTable\(\s*"project_assignment"/u);
    expect(assignmentSchema).toContain('assignmentRole: text("assignment_role")');
    expect(migration).toContain("project_assignment_project_fk");
    expect(migration).toContain("project_assignment_membership_fk");
    expect(migration).toMatch(
      /UNIQUE\("workspace_id",\s*"project_id",\s*"membership_id"\)/u,
    );
    expect(migration).toContain("project_assignment_one_key_account_uidx");
    expect(migration).toMatch(/WHERE\s+(?:"project_assignment"\.)?"?assignment_role"?\s*=\s*'key_account'/u);
  });

  it("verwendet genau eine permissive Tenant-Policy und nur restriktive Actor-Policies", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    expect(migration).toContain("ALTER TABLE public.project_assignment ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE public.project_assignment FORCE ROW LEVEL SECURITY");
    expect(migration.match(/CREATE POLICY tenant_isolation ON public\.project_assignment/g)).toHaveLength(1);
    expect(migration).toContain("CREATE POLICY project_assignment_actor_select");
    expect(migration).toContain("AS RESTRICTIVE FOR SELECT");
    expect(migration).toMatch(/AS RESTRICTIVE FOR SELECT TO %s/u);
    expect(migration).toContain("to_regrole('app_runtime')");
    expect(migration).toContain("CREATE POLICY project_external_select_scope");
    expect(migration).toContain("CREATE POLICY project_external_insert_guard");
    expect(migration).toContain("CREATE POLICY project_external_update_guard");
    expect(migration).toContain("CREATE POLICY project_external_delete_guard");
    const actorPolicies = migration.match(
      /CREATE POLICY project_(?:assignment_actor|external)_[\s\S]+?;/gu,
    ) ?? [];
    expect(actorPolicies).toHaveLength(8);
    for (const policy of actorPolicies) {
      expect(policy).toContain("AS RESTRICTIVE");
    }
  });

  it("spiegelt external_only fail-closed und gewährt dem Worker nichts", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    expect(migration).toContain("app_actor_is_external_only");
    expect(migration).toContain("jsonb_typeof");
    expect(migration).toContain("assignment_role IN ('key_account', 'user')");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_assignment TO app_runtime");
    expect(migration).toContain("REVOKE ALL ON public.project_assignment FROM app_worker");
    expect(migration).not.toMatch(/GRANT[^;]+project_assignment[^;]+app_worker/iu);
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.app_actor_(?:membership_id|is_external_only)\(uuid\) TO app_worker/iu,
    );
  });

  it("kaskadiert Project-Löschung, blockiert aber stilles Membership-Offboarding", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    expect(migration).toMatch(/project_assignment_project_fk[\s\S]+ON DELETE CASCADE/iu);
    expect(migration).toMatch(/project_assignment_membership_fk[\s\S]+ON DELETE (?:NO ACTION|RESTRICT)/iu);
  });
});
