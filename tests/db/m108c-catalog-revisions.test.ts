import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenantOn } from "@/lib/db/tenant";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
} from "@/lib/integrations/catalog/contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  CatalogInputError,
  createCatalogComponent,
  listCatalogComponentRevisions,
  reviseCatalogComponentDetails,
  reviseCatalogComponentPricing,
} from "@/modules/catalog";
import { testPool } from "../setup/test-db";

type Members = {
  workspaceId: string;
  adminId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
};

async function createMembers(): Promise<Members> {
  const members = {
    workspaceId: randomUUID(),
    adminId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'M1-08c Revisionsverlauf')
    `);
    for (const userId of [
      members.adminId,
      members.editorId,
      members.viewerId,
      members.externalId,
    ]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@m108c-catalog.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.adminId}::uuid, 'admin', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.editorId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.externalId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"external_only":true}'::jsonb)
    `);
  });
  return members;
}

function ctx(
  members: Members,
  actor: keyof Pick<Members, "adminId" | "editorId" | "viewerId">,
): ServiceCtx {
  if (actor === "adminId") {
    return {
      workspaceId: members.workspaceId,
      actor: members.adminId,
      role: "admin",
      capabilities: {},
      featureFlags: {},
    };
  }
  if (actor === "editorId") {
    return {
      workspaceId: members.workspaceId,
      actor: members.editorId,
      role: "editor",
      capabilities: { manage_catalog: true, edit_prices: true },
      featureFlags: {},
    };
  }
  return {
    workspaceId: members.workspaceId,
    actor: members.viewerId,
    role: "viewer",
    capabilities: {},
    featureFlags: {},
  };
}

function pricedBattery(sku = "BAT-M108C-001"): CatalogComponentCreateCommandV1 {
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: sku,
    componentType: "battery",
    presentation: {
      displayName: "Synthetischer Verlaufsspeicher",
      manufacturer: "WMEE Testwerk",
      model: "M1-08c Fixture",
      unit: "piece",
      keyPoints: ["Keine realen Produktdaten"],
      image: null,
      datasheet: null,
    },
    technicalData: {
      schemaVersion: "battery.v1",
      nominalCapacityWh: 8_500,
      usableCapacityWh: 8_000,
      maxContinuousPowerWatts: 4_000,
      roundTripEfficiencyBasisPoints: 9_400,
      backupCapability: "known_supported",
    },
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 250_123,
      salesPriceNetCents: 390_456,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: "STRICTLY-PRIVATE-SUPPLIER-REFERENCE",
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: "SYNTHETIC-SALES-REFERENCE",
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "manufacturer_datasheet",
      reference: "SYNTHETIC-TECHNICAL-REFERENCE",
      observedOn: "2026-08-29",
      rightsBasis: "manufacturer_published",
      sourceDocumentSha256: null,
    },
  };
}

describe("M1-08c Katalog-Revisionsverlauf", () => {
  it("listet Preis- und Detailrevisionen aufsteigend mit Stand je Revision", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const admin = ctx(members, "adminId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery()));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentPricing(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 1,
        commercial: { ...pricedBattery().commercial, salesPriceNetCents: 410_000 },
      }));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentDetails(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 2,
        presentation: {
          ...pricedBattery().presentation,
          displayName: "Umbenannter Verlaufsspeicher",
        },
        technicalData: pricedBattery().technicalData,
        technicalProvenance: pricedBattery().technicalProvenance,
      }));

    const history = await withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponentRevisions(tx, admin, created.componentId));
    expect(history).not.toBeNull();
    expect(history?.map((entry) => entry.revision)).toEqual([1, 2, 3]);
    expect(history?.[0]).toMatchObject({
      displayName: "Synthetischer Verlaufsspeicher",
      unit: "piece",
      salesPriceNetCents: 390_456,
      purchasePriceNetCents: 250_123,
    });
    expect(history?.[1]).toMatchObject({
      displayName: "Synthetischer Verlaufsspeicher",
      salesPriceNetCents: 410_000,
      purchasePriceNetCents: 250_123,
    });
    expect(history?.[2]).toMatchObject({
      displayName: "Umbenannter Verlaufsspeicher",
      salesPriceNetCents: 410_000,
      purchasePriceNetCents: 250_123,
    });
    for (const entry of history ?? []) {
      expect(entry.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(new Date(entry.createdAt).getTime()).not.toBeNaN();
    }
    expect(new Set((history ?? []).map((entry) => entry.snapshotSha256)).size).toBe(3);
  });

  it("redigiert EK vor Unberechtigten und versteckt Entwuerfe fail-closed", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const viewer = ctx(members, "viewerId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("BAT-M108C-002")));

    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponentRevisions(tx, viewer, created.componentId))).resolves.toBeNull();

    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));
    const viewerHistory = await withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponentRevisions(tx, viewer, created.componentId));
    expect(viewerHistory).toHaveLength(1);
    expect(viewerHistory?.[0]).toMatchObject({
      revision: 1,
      salesPriceNetCents: 390_456,
      purchasePriceNetCents: null,
    });
    expect(JSON.stringify(viewerHistory)).not.toContain("STRICTLY-PRIVATE-SUPPLIER-REFERENCE");

    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponentRevisions(tx, viewer, randomUUID()))).resolves.toBeNull();
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponentRevisions(tx, viewer, "keine-uuid"))).rejects.toBeInstanceOf(
      CatalogInputError,
    );
  });

  it("verweigert den Verlauf vor external_only ohne Projektzuordnung", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("BAT-M108C-003")));
    const external: ServiceCtx = {
      workspaceId: members.workspaceId,
      actor: members.externalId,
      role: "editor",
      capabilities: { manage_catalog: true, edit_prices: true, external_only: true },
      featureFlags: {},
    };
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponentRevisions(tx, external, created.componentId))).rejects.toMatchObject({
      name: "PermissionDeniedError",
      reason: "external_only_without_assignment",
    });
  });
});
