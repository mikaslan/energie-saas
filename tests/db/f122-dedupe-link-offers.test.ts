import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { DedupeConflictError } from "@/modules/dedupe/errors";
import { linkDedupeProject } from "@/modules/dedupe/service";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  projectWithOffer: string;
  canonicalContact: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const canonicalContact = randomUUID();
  let projectWithOffer = "";
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-22 Link mit Angebot')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values (${editorId}::uuid, ${`editor-${editorId}@f122.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    // Voller legaler Offer-Graph (Receipt/Requirement/Calculation/
    // Resolution/Angebot) aus der geteilten Tenant-Fixture.
    await tenantFixtures.offer(tx, workspaceId);
    const offer = await tx.execute<{ project_id: string; [key: string]: unknown }>(sql`
      select project_id from offer where workspace_id = ${workspaceId}::uuid limit 1
    `);
    projectWithOffer = offer.rows[0]?.project_id ?? "";
    if (!projectWithOffer) throw new Error("Offer-Fixture hat kein Angebot angelegt.");
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      )
      values (
        ${canonicalContact}::uuid, ${workspaceId}::uuid, 'Greta Kanon', 'Greta', 'Kanon',
        'greta.kanon@f122.test', 'greta.kanon@f122.test'
      )
    `);
    await tx.execute(sql`
      update project set dedupe_review_required = true
       where workspace_id = ${workspaceId}::uuid and id = ${projectWithOffer}::uuid
    `);
  });
  return { workspaceId, editorId, projectWithOffer, canonicalContact };
}

describe("F1-22 Projekt-Verknüpfen mit Angebot (PostgreSQL)", () => {
  it("F122-DB-17: Link unter bestehendem Angebot scheitert fail-closed", async () => {
    const fx = await seedFixture();
    const offers = await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const result = await tx.execute<{ count: string; [key: string]: unknown }>(sql`
        select count(*)::text as count from offer
         where workspace_id = ${fx.workspaceId}::uuid and project_id = ${fx.projectWithOffer}::uuid
      `);
      return result.rows[0]?.count ?? "0";
    });
    expect(offers).toBe("1");

    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        linkDedupeProject(tx as never, ctx as never, {
          projectId: fx.projectWithOffer,
          canonicalContactId: fx.canonicalContact,
        }) as Promise<unknown>),
    ).rejects.toThrow(DedupeConflictError);
  });
});
