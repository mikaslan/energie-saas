import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  OFFER_PAYMENT_OPTION_COMMAND_VERSION,
  OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
  PAYMENT_OPTION_SCHEMA_VERSION,
  type CreatePaymentOptionCommand,
} from "@/lib/integrations/offers/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OfferNotFoundError,
  OfferValidationError,
  setVariantPaymentOption,
} from "@/modules/offers";
import {
  archivePaymentOption,
  createPaymentOption,
  listPaymentOptions,
  PaymentOptionConflictError,
  PaymentOptionNotFoundError,
  PaymentOptionValidationError,
  restorePaymentOption,
  updatePaymentOption,
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
      values (${editorId}::uuid, ${`editor-${editorId}@f205.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f205.test`})
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

describe("F2.5 Zahlarten (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F2.5 Zahlarten");
  });

  it("F205-DB-01: create/list/update happy path, Schlüssel→Art, DTO-Permissions", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand()),
    );
    expect(created.key).toBe("purchase");
    expect(created.kind).toBe("purchase");
    expect(created.label).toBe("Kauf");
    expect(created.archivedAt).toBeNull();
    expect(created.permissions.canWrite).toBe(true);

    const financing = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({
        key: "financing_classic",
        label: "  Finanzierung Classic  ",
      })),
    );
    expect(financing.kind).toBe("financing");
    expect(financing.label).toBe("Finanzierung Classic");

    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listPaymentOptions(tx, ctx),
    );
    expect(list).toHaveLength(2);
    expect(list[0]!.permissions.canWrite).toBe(false);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updatePaymentOption(tx, ctx, {
        schemaVersion: OFFER_PAYMENT_OPTION_COMMAND_VERSION,
        id: created.id,
        label: "Kauf (Vorkasse)",
      }),
    );
    expect(updated.label).toBe("Kauf (Vorkasse)");
    expect(updated.key).toBe("purchase");
  });

  it("F205-DB-02: Schlüsselkollision → Conflict; nach Archivierung frei", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ key: "leasing", label: "Leasing" })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ key: "leasing", label: "Leasing neu" })),
    )).rejects.toBeInstanceOf(PaymentOptionConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archivePaymentOption(tx, ctx, created.id),
    );
    const recreated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ key: "leasing", label: "Leasing neu" })),
    );
    expect(recreated.key).toBe("leasing");
  });

  it("F205-DB-03: archive/restore, Archiv-Liste, Restore-Konflikt, NotFound", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand()),
    );
    const archived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archivePaymentOption(tx, ctx, created.id),
    );
    expect(archived.archivedAt).not.toBeNull();

    const active = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listPaymentOptions(tx, ctx),
    );
    expect(active).toHaveLength(0);
    const all = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listPaymentOptions(tx, ctx, { includeArchived: true }),
    );
    expect(all).toHaveLength(1);

    // Schlüssel zwischenzeitlich neu vergeben → Restore kollidiert.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ label: "Kauf neu" })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restorePaymentOption(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(PaymentOptionConflictError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archivePaymentOption(tx, ctx, randomUUID()),
    )).rejects.toBeInstanceOf(PaymentOptionNotFoundError);
  });

  it("F205-DB-04: Cross-Workspace-Isolation + Viewer-Schreibsperre", async () => {
    const other = await seedWorkspace("F2.5 Nachbar");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand()),
    );
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => listPaymentOptions(tx, ctx),
    );
    expect(foreign).toHaveLength(0);
    // Gleicher Schlüssel im Fremd-Workspace ist eigenständig.
    const recreated = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand()),
    );
    expect(recreated.key).toBe("purchase");

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ key: "leasing", label: "Leasing" })),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => updatePaymentOption(tx, ctx, {
        schemaVersion: OFFER_PAYMENT_OPTION_COMMAND_VERSION,
        id: randomUUID(),
        label: "X",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F205-DB-05: Auswahl Scope-Miss → NotFound; Validierung; Viewer-Sperre", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
        offerId: randomUUID(),
        variantId: randomUUID(),
        paymentOptionId: null,
      }),
    )).rejects.toBeInstanceOf(OfferNotFoundError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: "falsch",
        offerId: randomUUID(),
        variantId: randomUUID(),
        paymentOptionId: null,
      }),
    )).rejects.toBeInstanceOf(OfferValidationError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
        offerId: randomUUID(),
        variantId: randomUUID(),
        paymentOptionId: null,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F205-DB-06: Schema-Version und Validierungsgrenzen", async () => {
    expect(PAYMENT_OPTION_SCHEMA_VERSION).toBe(1);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ key: "ratenkauf" as never })),
    )).rejects.toBeInstanceOf(PaymentOptionValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPaymentOption(tx, ctx, createCommand({ label: "   " })),
    )).rejects.toBeInstanceOf(PaymentOptionValidationError);
  });

  it("F205-DB-07: archivierte Zahlart bleibt nur auf ihrer aktuellen Variante idempotent", async () => {
    const { offerId, variantId } = await seedOfferVariant(fixture.workspaceId);
    const options = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => ({
        current: await createPaymentOption(tx, ctx, createCommand()),
        other: await createPaymentOption(tx, ctx, createCommand({
          key: "leasing",
          label: "Leasing",
        })),
      }),
    );

    const assigned = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
        offerId,
        variantId,
        paymentOptionId: options.current.id,
      }),
    );
    expect(assigned.changed).toBe(true);

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        await archivePaymentOption(tx, ctx, options.current.id);
        await archivePaymentOption(tx, ctx, options.other.id);
      },
    );

    const unchanged = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
        offerId,
        variantId,
        paymentOptionId: options.current.id,
      }),
    );
    expect(unchanged).toEqual({ offerId, variantId, changed: false });

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => setVariantPaymentOption(tx, ctx, {
        schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
        offerId,
        variantId,
        paymentOptionId: options.other.id,
      }),
    )).rejects.toBeInstanceOf(OfferValidationError);

    const stored = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ paymentOptionId: string | null }>(sql`
        select payment_option_id as "paymentOptionId"
          from offer_variant
         where workspace_id = ${fixture.workspaceId}::uuid
           and offer_id = ${offerId}::uuid
           and id = ${variantId}::uuid
      `));
    expect(stored.rows).toEqual([{ paymentOptionId: options.current.id }]);
  });
});
