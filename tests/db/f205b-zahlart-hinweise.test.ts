import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  OFFER_PAYMENT_OPTION_COMMAND_VERSION,
  OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
  type CreatePaymentOptionCommand,
} from "@/lib/integrations/offers/contract";
import { getOfferDetail, setVariantPaymentOption } from "@/modules/offers";
import {
  createPaymentOption,
  listPaymentOptions,
} from "@/modules/offers/payment-options";
import { testPool } from "../setup/test-db";
import { tenantFixtures } from "../setup/tenant-fixtures";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f205b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f205b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

function createCommand(overrides: Partial<CreatePaymentOptionCommand> = {}): CreatePaymentOptionCommand {
  return {
    schemaVersion: OFFER_PAYMENT_OPTION_COMMAND_VERSION,
    key: "purchase",
    label: "Kauf",
    ...overrides,
  };
}

async function seedOfferVariant(workspaceId: string): Promise<{
  offerId: string;
  variantId: string;
}> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const factory = tenantFixtures.offer;
    if (!factory) throw new Error("F2.5-Offer-Fixture fehlt.");
    await factory(tx, workspaceId);

    const result = await tx.execute<{ offerId: string; variantId: string }>(sql`
      select offer.id as "offerId", variant.id as "variantId"
        from offer
        join offer_variant variant
          on variant.workspace_id = offer.workspace_id
         and variant.offer_id = offer.id
       where offer.workspace_id = ${workspaceId}::uuid
       order by variant.ordinal, variant.id
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F2.5-Offer-Variante fehlt.");
    return row;
  });
}

describe("F2-05b Zahlart-Hinweise (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F2-05b Zahlart-Hinweise");
  });

  it("F205B-DB-01: Detail-paymentOptionId + Liste lösen Label lesend, kein Write", async () => {
    const { offerId, variantId } = await seedOfferVariant(fixture.workspaceId);
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand()),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
        offerId,
        variantId,
        paymentOptionId: created.id,
      }),
    );

    // Variante ohne Zahlart → Null-Fall (eigener Workspace, keine Bindung).
    const nullFixture = await seedWorkspace("F2-05b Null-Fall");
    const nullSeed = await seedOfferVariant(nullFixture.workspaceId);

    async function snapshot(workspaceId: string, seed: { offerId: string; variantId: string }) {
      return withTenantOn(testPool, workspaceId, async (tx) => {
        const variant = await tx.execute<{
          paymentOptionId: string | null;
          updatedAt: string;
        }>(sql`
          select payment_option_id as "paymentOptionId", updated_at as "updatedAt"
            from offer_variant
           where workspace_id = ${workspaceId}::uuid
             and offer_id = ${seed.offerId}::uuid
             and id = ${seed.variantId}::uuid
        `);
        const options = await tx.execute<{ id: string; updatedAt: string }>(sql`
          select id, updated_at as "updatedAt"
            from payment_option
           where workspace_id = ${workspaceId}::uuid
           order by id
        `);
        return { variant: variant.rows, options: options.rows };
      });
    }

    const before = await snapshot(fixture.workspaceId, { offerId, variantId });
    const beforeNull = await snapshot(nullFixture.workspaceId, nullSeed);

    // PIN: lesender Panel-Datenfluss aus Spec §3 — nur bestehende Funktionen.
    const detail = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getOfferDetail(tx, ctx, { offerId, variantId }),
    );
    expect(detail).not.toBeNull();
    const active = detail!.variants.find((variant) => variant.id === variantId);
    expect(active?.paymentOptionId).toBe(created.id);

    const options = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listPaymentOptions(tx, ctx, { includeArchived: true }),
    );
    const resolved = options.find((option) => option.id === active!.paymentOptionId);
    expect(resolved?.label).toBe("Kauf");

    const nullDetail = await withAuthorizedTenantOn(
      testPool, nullFixture.editorId, nullFixture.workspaceId,
      (tx, ctx) => getOfferDetail(tx, ctx, { offerId: nullSeed.offerId, variantId: nullSeed.variantId }),
    );
    const nullActive = nullDetail!.variants.find((variant) => variant.id === nullSeed.variantId);
    expect(nullActive?.paymentOptionId).toBeNull();

    // Kein Write durch den Lesefluss: Varianten- und Stammdatenzeilen unverändert.
    const after = await snapshot(fixture.workspaceId, { offerId, variantId });
    const afterNull = await snapshot(nullFixture.workspaceId, nullSeed);
    expect(after).toEqual(before);
    expect(afterNull).toEqual(beforeNull);
  });
});
