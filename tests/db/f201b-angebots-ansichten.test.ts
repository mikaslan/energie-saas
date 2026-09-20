import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  OFFER_CREATE_COMMAND_VERSION,
  type CreateOfferCommandV1,
} from "@/lib/integrations/offers/contract";
import { createOfferFromRequest } from "@/modules/offers";
import {
  getProjectPageDetail,
  type ProjectPageDetail,
  type ProjectTriageDetail,
} from "@/modules/projects";
import { seedM201ReadyProject } from "../e2e/m2-01-fixture";
import { testPool } from "../setup/test-db";

type Members = { workspaceId: string; operatorId: string };

// RED-Vertrag: Der Projektakt-Read (getProjectPageDetail, interne Audience)
// liefert ein boolesches `hasOffer` aus Offer-Existenz
// (EXISTS offer WHERE workspace_id + project_id), nicht aus project.phase.
// Spec: docs/spec/F2-01b-angebots-ansichten.md (Badge-Datenquelle, Akte-only).
type HasOfferRecord = ProjectTriageDetail & { hasOffer: boolean };

function readHasOffer(detail: ProjectPageDetail): unknown {
  if (detail.audience !== "internal") {
    throw new Error("F2-01b erwartet die interne Projektakte.");
  }
  return (detail.record as Partial<HasOfferRecord>).hasOffer;
}

async function createMembers(name: string): Promise<Members> {
  const members = { workspaceId: randomUUID(), operatorId: randomUUID() };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, ${name})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${members.operatorId}::uuid, ${`${members.operatorId}@f201b.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (
        ${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
        '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
           "discounts":true,"see_purchase_prices":true}'::jsonb
      )
    `);
  });
  return members;
}

async function seedReadyProject(members: Members): Promise<string> {
  const databaseUrl = process.env.POSTGRES_URL_TEST;
  if (!databaseUrl) throw new Error("POSTGRES_URL_TEST fehlt.");
  const seed = await seedM201ReadyProject(databaseUrl, {
    workspaceId: members.workspaceId,
    editorIdentityId: members.operatorId,
    skuSuffix: `F201B-${randomUUID().slice(0, 8)}`,
  });
  return seed.projectId;
}

function offerCommand(projectId: string): CreateOfferCommandV1 {
  return {
    schemaVersion: OFFER_CREATE_COMMAND_VERSION,
    projectId,
    expectedRequirementRevision: 1,
    expectedCalculationRevision: 1,
    expectedResolutionRevision: 1,
    forecastValueNetCents: null,
    priceAudience: "b2c",
    priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
    taxTreatment: "standard_19",
  };
}

async function readAkteHasOffer(
  members: Members,
  projectId: string,
): Promise<{ hasOffer: unknown; phase: string }> {
  const detail = await withAuthorizedTenantOn(
    testPool,
    members.operatorId,
    members.workspaceId,
    (tx, ctx) => getProjectPageDetail(tx, ctx, projectId),
  );
  if (detail === null || detail.audience !== "internal") {
    throw new Error("F2-01b erwartet eine lesbare interne Projektakte.");
  }
  return { hasOffer: readHasOffer(detail), phase: detail.record.project.phase };
}

describe("F2-01b Angebots-Ansichten: Badge-Datenquelle (PostgreSQL)", () => {
  it("F201B-1: Akte ohne Offer meldet hasOffer=false, mit Offer hasOffer=true", async () => {
    const members = await createMembers("F2-01b Badge-Datenquelle");
    const projectId = await seedReadyProject(members);

    const before = await readAkteHasOffer(members, projectId);
    expect(before.phase).toBe("request");
    expect(before.hasOffer).toBe(false);

    await withAuthorizedTenantOn(
      testPool,
      members.operatorId,
      members.workspaceId,
      (tx, ctx) => createOfferFromRequest(tx, ctx, offerCommand(projectId)),
    );

    const after = await readAkteHasOffer(members, projectId);
    expect(after.phase).toBe("offer");
    expect(after.hasOffer).toBe(true);
  });

  it("F201B-2: Tombstone (phase=offer ohne Offer) meldet hasOffer=false", async () => {
    const members = await createMembers("F2-01b Tombstone");
    const projectId = await seedReadyProject(members);

    // Tombstone-Lesestand nach DSGVO-Erasure: phase=offer bleibt,
    // die Offer-Zeile ist weg (M2-01) — kein Badge aus Phase allein.
    await withTenantOn(testPool, members.workspaceId, (tx) => tx.execute(sql`
      update project set phase = 'offer'
      where workspace_id = ${members.workspaceId}::uuid
        and id = ${projectId}::uuid
    `));

    const tombstone = await readAkteHasOffer(members, projectId);
    expect(tombstone.phase).toBe("offer");
    expect(tombstone.hasOffer).toBe(false);
  });

  it("F201B-3: Cross-Tenant — fremdes Offer erzeugt kein Badge", async () => {
    const tenantA = await createMembers("F2-01b Tenant A");
    const tenantB = await createMembers("F2-01b Tenant B");
    const projectA = await seedReadyProject(tenantA);
    const projectB = await seedReadyProject(tenantB);

    await withAuthorizedTenantOn(
      testPool,
      tenantB.operatorId,
      tenantB.workspaceId,
      (tx, ctx) => createOfferFromRequest(tx, ctx, offerCommand(projectB)),
    );

    const foreign = await readAkteHasOffer(tenantA, projectA);
    expect(foreign.hasOffer).toBe(false);

    const own = await readAkteHasOffer(tenantB, projectB);
    expect(own.hasOffer).toBe(true);
  });
});
