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
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  archiveCatalogComponent,
  CatalogConflictError,
  createCatalogComponent,
  getCatalogComponent,
  listCatalogComponents,
  returnCatalogComponentToDraft,
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
  manageOnlyId: string;
  editOnlyId: string;
  priceReaderId: string;
};

async function createMembers(): Promise<Members> {
  const members = {
    workspaceId: randomUUID(),
    adminId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    manageOnlyId: randomUUID(),
    editOnlyId: randomUUID(),
    priceReaderId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'M1-08 Katalogservice')
    `);
    for (const userId of [
      members.adminId,
      members.editorId,
      members.viewerId,
      members.externalId,
      members.manageOnlyId,
      members.editOnlyId,
      members.priceReaderId,
    ]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@m108-catalog.test`})
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
          '{"manage_catalog":true,"edit_prices":true,"external_only":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.manageOnlyId}::uuid, 'editor',
          '{"manage_catalog":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.editOnlyId}::uuid, 'editor',
          '{"edit_prices":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.priceReaderId}::uuid, 'editor',
          '{"see_purchase_prices":true}'::jsonb)
    `);
  });
  return members;
}

function customCtx(
  members: Members,
  actor: string,
  capabilities: ServiceCtx["capabilities"],
): ServiceCtx {
  return {
    workspaceId: members.workspaceId,
    actor,
    role: "editor",
    capabilities,
    featureFlags: {},
  };
}

function ctx(
  members: Members,
  actor: keyof Pick<Members, "adminId" | "editorId" | "viewerId" | "externalId">,
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
  if (actor === "viewerId") {
    return {
      workspaceId: members.workspaceId,
      actor: members.viewerId,
      role: "viewer",
      capabilities: {},
      featureFlags: {},
    };
  }
  return {
    workspaceId: members.workspaceId,
    actor: members[actor],
    role: "editor",
    capabilities: actor === "externalId"
      ? { manage_catalog: true, edit_prices: true, external_only: true }
      : { manage_catalog: true, edit_prices: true },
    featureFlags: {},
  };
}

function pricedBattery(sku = "BAT-M108-001"): CatalogComponentCreateCommandV1 {
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: sku,
    componentType: "battery",
    presentation: {
      displayName: "Synthetischer Testspeicher",
      manufacturer: "WMEE Testwerk",
      model: "M1-08 Fixture",
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitForNamedSessionBlockedBy(
  applicationName: string,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await testPool.query<{ waiting: boolean }>(`
      select exists (
        select 1
          from pg_catalog.pg_stat_activity activity
         where activity.application_name = $1
           and activity.wait_event_type = 'Lock'
           and $2 = any(pg_catalog.pg_blocking_pids(activity.pid))
      ) as waiting
    `, [applicationName, blockerPid]);
    if (waiting.rows[0]?.waiting === true) return;
  }
  throw new Error("Konkurrierende Katalogmutation erreichte den erwarteten Lock nicht.");
}

describe("M1-08 Katalog-Servicegrenze", () => {
  it("legt einen Draft revisionsgebunden an und redigiert EK vor jedem nicht berechtigten Read", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const admin = ctx(members, "adminId");
    const viewer = ctx(members, "viewerId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("  bat-m108-001  ")));
    expect(created).toMatchObject({ revision: 1, status: "draft" });

    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponents(tx, viewer))).resolves.toEqual([]);
    const editorRead = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getCatalogComponent(tx, editor, created.componentId));
    const adminRead = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getCatalogComponent(tx, admin, created.componentId));
    expect(JSON.stringify(editorRead)).not.toContain("purchasePriceNetCents");
    expect(JSON.stringify(editorRead)).not.toContain("STRICTLY-PRIVATE-SUPPLIER-REFERENCE");
    expect(editorRead?.current).not.toHaveProperty("sourceSnapshotSha256");
    expect(JSON.stringify(adminRead)).toContain("purchasePriceNetCents");
    expect(adminRead?.current.sourceSnapshotSha256).toMatch(/^[0-9a-f]{64}$/u);

    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));
    const visible = await withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponents(tx, viewer));
    expect(visible).toHaveLength(1);
    expect(JSON.stringify(visible)).not.toContain("purchasePriceNetCents");
    expect(visible[0]?.current).not.toHaveProperty("sourceSnapshotSha256");
    expect(JSON.stringify(visible)).toContain("salesPriceNetCents");
  });

  it("kopiert interne Preise bei Detailrevisionen und erzwingt Optimistic Locking", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const admin = ctx(members, "adminId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("BAT-M108-REV")));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));

    const revised = await withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentDetails(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 1,
        presentation: {
          ...pricedBattery().presentation,
          displayName: "Überarbeiteter synthetischer Testspeicher",
        },
        technicalData: pricedBattery().technicalData,
        technicalProvenance: pricedBattery().technicalProvenance,
      }));
    expect(revised).toMatchObject({ revision: 2, status: "draft" });
    const privileged = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getCatalogComponent(tx, admin, created.componentId));
    expect(privileged?.current.commercial).toMatchObject({
      purchasePriceNetCents: 250_123,
      salesPriceNetCents: 390_456,
    });

    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentDetails(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 1,
        presentation: pricedBattery().presentation,
        technicalData: pricedBattery().technicalData,
        technicalProvenance: pricedBattery().technicalProvenance,
      }))).rejects.toBeInstanceOf(CatalogConflictError);

    await withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentPricing(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 2,
        commercial: pricedBattery().commercial,
      }));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 3,
        expectedStatus: "draft",
      }));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      archiveCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 3,
        expectedStatus: "active",
      }));
    const reopened = await withTenantOn(testPool, members.workspaceId, (tx) =>
      returnCatalogComponentToDraft(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 3,
        expectedStatus: "archived",
      }));
    expect(reopened).toMatchObject({ revision: 3, status: "draft" });
  });

  it("committet bei gleicher normalisierter SKU genau eine konkurrierende Anlage", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const winnerReady = deferred<{ componentId: string; pid: number }>();
    const winnerMayCommit = deferred<void>();
    const winner = withTenantOn(testPool, members.workspaceId, async (tx) => {
      const backend = await tx.execute<{ pid: number; [key: string]: unknown }>(sql`
        select pg_catalog.pg_backend_pid() as pid
      `);
      const created = await createCatalogComponent(
        tx,
        editor,
        pricedBattery("  race-sku-m108  "),
      );
      winnerReady.resolve({
        componentId: created.componentId,
        pid: backend.rows[0]!.pid,
      });
      await winnerMayCommit.promise;
      return created;
    });
    void winner.catch(winnerReady.reject);
    const ready = await winnerReady.promise;

    const loserApplicationName = `m108-sku-${randomUUID().slice(0, 8)}`;
    const loser = withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`
        select set_config('application_name', ${loserApplicationName}, true)
      `);
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '4s'`);
      return createCatalogComponent(
        tx,
        editor,
        pricedBattery("RACE-SKU-M108"),
      );
    });
    const loserOutcome = loser.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let waitFailure: unknown = null;
    try {
      await waitForNamedSessionBlockedBy(loserApplicationName, ready.pid);
    } catch (error) {
      waitFailure = error;
    } finally {
      winnerMayCommit.resolve();
    }
    const [created, conflict] = await Promise.all([winner, loserOutcome]);
    if (waitFailure !== null) throw waitFailure;
    expect(created).toMatchObject({
      componentId: ready.componentId,
      revision: 1,
      status: "draft",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("Die konkurrierende SKU-Anlage haette verlieren muessen.");
    expect(conflict.error).toBeInstanceOf(CatalogConflictError);

    const footprint = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{
        components: number;
        revisions: number;
        events: number;
        audits: number;
        [key: string]: unknown;
      }>(sql`
        select
          (select count(*)::int from catalog_component
            where workspace_id = ${members.workspaceId}::uuid
              and internal_sku = 'RACE-SKU-M108') as components,
          (select count(*)::int from catalog_component_revision
            where workspace_id = ${members.workspaceId}::uuid
              and component_id = ${ready.componentId}::uuid) as revisions,
          (select count(*)::int from domain_events
            where workspace_id = ${members.workspaceId}::uuid
              and aggregate_id = ${ready.componentId}::uuid) as events,
          (select count(*)::int from audit_log
            where workspace_id = ${members.workspaceId}::uuid
              and details->>'componentId' = ${ready.componentId}) as audits
      `));
    expect(footprint.rows[0]).toEqual({
      components: 1,
      revisions: 1,
      events: 1,
      audits: 1,
    });
  }, 10_000);

  it("publiziert bei konkurrierender Detail- und Preisrevision dieselbe N+1 nur einmal", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const admin = ctx(members, "adminId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("BAT-M108-REV-RACE")));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));

    const winnerReady = deferred<{ pid: number }>();
    const winnerMayCommit = deferred<void>();
    const detailWinner = withTenantOn(testPool, members.workspaceId, async (tx) => {
      const backend = await tx.execute<{ pid: number; [key: string]: unknown }>(sql`
        select pg_catalog.pg_backend_pid() as pid
      `);
      const revised = await reviseCatalogComponentDetails(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 1,
        presentation: {
          ...pricedBattery().presentation,
          displayName: "Gewinnende parallele Detailrevision",
        },
        technicalData: pricedBattery().technicalData,
        technicalProvenance: pricedBattery().technicalProvenance,
      });
      winnerReady.resolve({ pid: backend.rows[0]!.pid });
      await winnerMayCommit.promise;
      return revised;
    });
    void detailWinner.catch(winnerReady.reject);
    const ready = await winnerReady.promise;

    const loserApplicationName = `m108-revision-${randomUUID().slice(0, 8)}`;
    const commercial = pricedBattery().commercial;
    if (commercial === null) throw new Error("Preisfixture darf nicht leer sein.");
    const priceLoser = withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`
        select set_config('application_name', ${loserApplicationName}, true)
      `);
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '4s'`);
      return reviseCatalogComponentPricing(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: created.componentId,
        expectedRevision: 1,
        commercial: {
          ...commercial,
          salesPriceNetCents: commercial.salesPriceNetCents + 50_000,
        },
      });
    });
    const loserOutcome = priceLoser.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let waitFailure: unknown = null;
    try {
      await waitForNamedSessionBlockedBy(loserApplicationName, ready.pid);
    } catch (error) {
      waitFailure = error;
    } finally {
      winnerMayCommit.resolve();
    }
    const [revised, conflict] = await Promise.all([detailWinner, loserOutcome]);
    if (waitFailure !== null) throw waitFailure;
    expect(revised).toMatchObject({ revision: 2, status: "draft" });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("Die parallele Preisrevision haette verlieren muessen.");
    expect(conflict.error).toBeInstanceOf(CatalogConflictError);

    const current = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getCatalogComponent(tx, admin, created.componentId));
    expect(current).toMatchObject({
      status: "draft",
      current: {
        identity: { revision: 2 },
        presentation: { displayName: "Gewinnende parallele Detailrevision" },
        commercial: {
          purchasePriceNetCents: 250_123,
          salesPriceNetCents: 390_456,
        },
      },
    });
    const footprint = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{
        current_revision: number;
        revisions: number;
        revised_events: number;
        price_audits: number;
        [key: string]: unknown;
      }>(sql`
        select component.current_revision,
          (select count(*)::int from catalog_component_revision revision
            where revision.workspace_id = component.workspace_id
              and revision.component_id = component.id) as revisions,
          (select count(*)::int from domain_events event
            where event.workspace_id = component.workspace_id
              and event.aggregate_id = component.id
              and event.event_type = 'catalog.component_revised') as revised_events,
          (select count(*)::int from audit_log audit
            where audit.workspace_id = component.workspace_id
              and audit.details->>'componentId' = component.id::text
              and audit.action = 'price.edit') as price_audits
          from catalog_component component
         where component.workspace_id = ${members.workspaceId}::uuid
           and component.id = ${created.componentId}::uuid
      `));
    expect(footprint.rows[0]).toEqual({
      current_revision: 2,
      revisions: 2,
      revised_events: 1,
      price_audits: 0,
    });
  }, 10_000);

  it("sperrt Viewer-Mutationen und external_only vor jeder SQL-Ausgabe", async () => {
    const members = await createMembers();
    const viewer = ctx(members, "viewerId");
    const external = ctx(members, "externalId");
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, viewer, pricedBattery("BAT-M108-DENY"))))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      listCatalogComponents(tx, external))).rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, external, pricedBattery("BAT-M108-EXT"))))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
  });

  it("trennt Katalogpflege, Preisschreiben und EK-Lesen als unabhängige Rechte", async () => {
    const members = await createMembers();
    const manageOnly = customCtx(
      members,
      members.manageOnlyId,
      { manage_catalog: true },
    );
    const editOnly = customCtx(
      members,
      members.editOnlyId,
      { edit_prices: true },
    );
    const priceReader = customCtx(
      members,
      members.priceReaderId,
      { see_purchase_prices: true },
    );
    const editor = ctx(members, "editorId");
    const unpriced = { ...pricedBattery("BAT-M108-MANAGE"), commercial: null };

    const managed = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, manageOnly, unpriced));
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentDetails(tx, manageOnly, {
        schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
        componentId: managed.componentId,
        expectedRevision: 1,
        presentation: pricedBattery().presentation,
        technicalData: pricedBattery().technicalData,
        technicalProvenance: pricedBattery().technicalProvenance,
      }))).resolves.toMatchObject({ revision: 2, status: "draft" });
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      archiveCatalogComponent(tx, manageOnly, {
        componentId: managed.componentId,
        expectedRevision: 2,
        expectedStatus: "draft",
      }))).resolves.toMatchObject({ status: "archived" });
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, manageOnly, pricedBattery("BAT-M108-PRICE-DENY"))))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "price.edit" });
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentPricing(tx, manageOnly, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: managed.componentId,
        expectedRevision: 2,
        commercial: pricedBattery().commercial,
      }))).rejects.toMatchObject({ name: "PermissionDeniedError", action: "price.edit" });
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editOnly, unpriced)))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "catalog.manage" });

    const priced = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("BAT-M108-EK-READ")));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: priced.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));
    const editorView = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getCatalogComponent(tx, editor, priced.componentId));
    const purchaseView = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getCatalogComponent(tx, priceReader, priced.componentId));
    expect(editorView?.current.commercial).not.toHaveProperty("purchasePriceNetCents");
    expect(editorView?.current.commercial).not.toHaveProperty("purchaseProvenance");
    expect(editorView?.current).not.toHaveProperty("sourceSnapshotSha256");
    expect(purchaseView?.current.commercial).toMatchObject({
      purchasePriceNetCents: 250_123,
      purchaseProvenance: { reference: "STRICTLY-PRIVATE-SUPPLIER-REFERENCE" },
    });
    expect(purchaseView?.current.sourceSnapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(purchaseView?.permissions).toEqual({
      canManage: false,
      canEditPrices: false,
      canReadPurchasePrice: true,
    });
  });

  it("rollt Produkt, Revision, Event und Audit gemeinsam zurück", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const marker = new Error("absichtlicher M1-08 Katalog-Rollback");
    let componentId: string | null = null;
    await expect(withTenantOn(testPool, members.workspaceId, async (tx) => {
      const created = await createCatalogComponent(
        tx,
        editor,
        pricedBattery("BAT-M108-ROLLBACK"),
      );
      componentId = created.componentId;
      throw marker;
    })).rejects.toBe(marker);
    if (componentId === null) throw new Error("Rollback-Fixture wurde nicht erzeugt.");

    const footprint = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{
        components: number;
        revisions: number;
        events: number;
        audits: number;
        [key: string]: unknown;
      }>(sql`
        select
          (select count(*)::int from catalog_component
            where workspace_id = ${members.workspaceId}::uuid
              and id = ${componentId}::uuid) as components,
          (select count(*)::int from catalog_component_revision
            where workspace_id = ${members.workspaceId}::uuid
              and component_id = ${componentId}::uuid) as revisions,
          (select count(*)::int from domain_events
            where workspace_id = ${members.workspaceId}::uuid
              and aggregate_id = ${componentId}::uuid) as events,
          (select count(*)::int from audit_log
            where workspace_id = ${members.workspaceId}::uuid
              and details->>'componentId' = ${componentId}) as audits
      `));
    expect(footprint.rows[0]).toEqual({
      components: 0,
      revisions: 0,
      events: 0,
      audits: 0,
    });
  });

  it("schreibt in Event und Audit nur IDs, Revision, Status und Hash statt Preis-/Quellwerten", async () => {
    const members = await createMembers();
    const editor = ctx(members, "editorId");
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, pricedBattery("BAT-M108-AUDIT")));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));
    const logs = await withTenantOn(testPool, members.workspaceId, async (tx) => {
      const events = await tx.execute<{
        event_type: string;
        payload: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select event_type, payload from domain_events
        where workspace_id = ${members.workspaceId}::uuid
          and aggregate_id = ${created.componentId}::uuid
        order by occurred_at, id
      `);
      const audit = await tx.execute<{
        action: string;
        resource: string;
        allowed: boolean;
        details: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select action, resource, allowed, details from audit_log
        where workspace_id = ${members.workspaceId}::uuid
          and details->>'componentId' = ${created.componentId}
        order by occurred_at, id
      `);
      return { events: events.rows, audit: audit.rows };
    });
    const serialized = JSON.stringify(logs);
    expect(logs.events.map((event) => event.event_type)).toEqual([
      "catalog.component_created",
      "catalog.component_status_changed",
    ]);
    expect(logs.audit).toHaveLength(2);
    for (const event of logs.events) {
      expect(Object.keys(event.payload).sort()).toEqual([
        "componentId",
        "fieldClasses",
        "revision",
        "snapshotSha256",
        "status",
      ]);
    }
    for (const audit of logs.audit) {
      expect(audit).toMatchObject({
        action: "catalog.manage",
        resource: "catalog_component",
        allowed: true,
      });
      expect(Object.keys(audit.details).sort()).toEqual([
        "componentId",
        "fieldClasses",
        "revision",
        "snapshotSha256",
        "status",
      ]);
    }
    expect(serialized).not.toContain("250123");
    expect(serialized).not.toContain("390456");
    expect(serialized).not.toContain("STRICTLY-PRIVATE-SUPPLIER-REFERENCE");
    expect(serialized).not.toContain("SYNTHETIC-SALES-REFERENCE");
    expect(serialized).not.toContain("SYNTHETIC-TECHNICAL-REFERENCE");
  });
});
