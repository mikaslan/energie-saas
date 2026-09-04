import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getOfferPreviewHtml,
  OfferPdfDraftConflictError,
  OfferPdfDraftNotFoundError,
} from "@/modules/offers";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type Binding = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
};

async function prepareBinding(): Promise<Binding> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name) values (${workspaceId}::uuid, 'F16.2 Vorschau')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f162.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f162.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f162.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    const factory = tenantFixtures.offer;
    if (!factory) throw new Error("Offer-Tenant-Fixture fehlt.");
    await factory(tx, workspaceId);
  });
  const found = await withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ offerId: string; variantId: string; variantRevision: number }>(sql`
      select offer_record.id as "offerId", variant.id as "variantId",
             variant.current_revision as "variantRevision"
        from offer offer_record
        join offer_variant variant
          on variant.workspace_id = offer_record.workspace_id
         and variant.offer_id = offer_record.id
       where offer_record.workspace_id = ${workspaceId}::uuid
       order by variant.ordinal
       limit 1
    `);
    return result.rows[0];
  });
  if (!found) throw new Error("F16.2 Offer-Bindung fehlt.");
  return { workspaceId, editorId, viewerId, externalId, ...found };
}

async function countRows(
  workspaceId: string,
  table: "offer_pdf_draft" | "domain_events" | "audit_log",
  offerId: string,
): Promise<number> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = table === "audit_log"
      ? await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit_log
          where workspace_id = ${workspaceId}::uuid and details->>'offerId' = ${offerId}
        `)
      : table === "domain_events"
        ? await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from domain_events
            where workspace_id = ${workspaceId}::uuid and aggregate_id = ${offerId}::uuid
          `)
        : await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from offer_pdf_draft
            where workspace_id = ${workspaceId}::uuid and offer_id = ${offerId}::uuid
          `);
    return result.rows[0]?.n ?? 0;
  });
}

describe("F16.2 zustandslose PDF-Vorschau (PostgreSQL)", () => {
  let binding: Binding;

  beforeEach(async () => {
    binding = await prepareBinding();
  });

  it("F162-DB-01: rendert versiegelten Stand ohne einen einzigen Write", async () => {
    const stamps = await withTenantOn(testPool, binding.workspaceId, async (tx) => {
      const result = await tx.execute<{ stamp: string }>(sql`
        select updated_at::text as stamp from offer
        where workspace_id = ${binding.workspaceId}::uuid and id = ${binding.offerId}::uuid
        union all
        select updated_at::text from offer_variant
        where workspace_id = ${binding.workspaceId}::uuid and id = ${binding.variantId}::uuid
        union all
        select created_at::text from offer_variant_revision
        where workspace_id = ${binding.workspaceId}::uuid
          and offer_id = ${binding.offerId}::uuid
          and variant_id = ${binding.variantId}::uuid
          and revision = ${binding.variantRevision}
      `);
      return result.rows.map((row) => row.stamp);
    });
    const before = {
      drafts: await countRows(binding.workspaceId, "offer_pdf_draft", binding.offerId),
      events: await countRows(binding.workspaceId, "domain_events", binding.offerId),
      audit: await countRows(binding.workspaceId, "audit_log", binding.offerId),
    };
    const preview = await withAuthorizedTenantOn(
      testPool, binding.editorId, binding.workspaceId,
      (tx, ctx) => getOfferPreviewHtml(tx, ctx, {
        workspaceId: binding.workspaceId,
        offerId: binding.offerId,
        variantId: binding.variantId,
        expectedVariantRevision: binding.variantRevision,
      }),
    );
    expect(preview.offerId).toBe(binding.offerId);
    expect(preview.variantRevision).toBe(binding.variantRevision);
    expect(preview.html).toContain("Interner Angebotsentwurf");
    expect(await countRows(binding.workspaceId, "offer_pdf_draft", binding.offerId)).toBe(before.drafts);
    expect(await countRows(binding.workspaceId, "domain_events", binding.offerId)).toBe(before.events);
    expect(await countRows(binding.workspaceId, "audit_log", binding.offerId)).toBe(before.audit);
    const after = await withTenantOn(testPool, binding.workspaceId, async (tx) => {
      const result = await tx.execute<{ stamp: string }>(sql`
        select updated_at::text as stamp from offer
        where workspace_id = ${binding.workspaceId}::uuid and id = ${binding.offerId}::uuid
        union all
        select updated_at::text from offer_variant
        where workspace_id = ${binding.workspaceId}::uuid and id = ${binding.variantId}::uuid
        union all
        select created_at::text from offer_variant_revision
        where workspace_id = ${binding.workspaceId}::uuid
          and offer_id = ${binding.offerId}::uuid
          and variant_id = ${binding.variantId}::uuid
          and revision = ${binding.variantRevision}
      `);
      return result.rows.map((row) => row.stamp);
    });
    expect(after).toEqual(stamps);
  });

  it("F162-DB-02: stale Revision -> Conflict, fremde Variante -> NotFound", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, binding.editorId, binding.workspaceId,
      (tx, ctx) => getOfferPreviewHtml(tx, ctx, {
        workspaceId: binding.workspaceId,
        offerId: binding.offerId,
        variantId: binding.variantId,
        expectedVariantRevision: binding.variantRevision + 1,
      }),
    )).rejects.toBeInstanceOf(OfferPdfDraftConflictError);

    await expect(withAuthorizedTenantOn(
      testPool, binding.editorId, binding.workspaceId,
      (tx, ctx) => getOfferPreviewHtml(tx, ctx, {
        workspaceId: binding.workspaceId,
        offerId: binding.offerId,
        variantId: randomUUID(),
        expectedVariantRevision: 1,
      }),
    )).rejects.toBeInstanceOf(OfferPdfDraftNotFoundError);
  });

  it("F162-DB-03: Reader ok, Externe blockiert (project.read minRole viewer)", async () => {
    const input = {
      workspaceId: binding.workspaceId,
      offerId: binding.offerId,
      variantId: binding.variantId,
      expectedVariantRevision: binding.variantRevision,
    };
    const viewerPreview = await withAuthorizedTenantOn(
      testPool, binding.viewerId, binding.workspaceId,
      (tx, ctx) => getOfferPreviewHtml(tx, ctx, input),
    );
    expect(viewerPreview.html.length).toBeGreaterThan(0);

    await expect(withAuthorizedTenantOn(
      testPool, binding.externalId, binding.workspaceId,
      (tx, ctx) => getOfferPreviewHtml(tx, ctx, input),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
