import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
  type CatalogComponentRevisionV1,
  type ProjectCatalogResolutionLineV1,
} from "@/lib/integrations/catalog/contract";
import { withTenantOn } from "@/lib/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

const CATALOG_TABLES = [
  "catalog_component",
  "catalog_component_revision",
  "project_catalog_resolution",
  "project_catalog_resolution_line",
] as const;

type PlanningGraph = {
  workspaceId: string;
  actorId: string;
  projectId: string;
  siteId: string;
  requirementId: string;
  requirementRevision: number;
  calculationRevisionId: string;
  calculationRevision: number;
  calculationInputSha256: string;
  calculationResultSha256: string;
};

type CatalogFixture = {
  graph: PlanningGraph;
  resolutionId: string;
  resolution: ReturnType<typeof sealProjectCatalogResolution>;
  products: CatalogComponentRevisionV1[];
};

function provenance(kind: "technical" | "purchase" | "sales") {
  return {
    sourceKind: kind === "technical" ? "manufacturer_datasheet" as const
      : kind === "purchase" ? "supplier_price_list" as const
        : "workspace_pricing" as const,
    reference: `m108-${kind}-synthetic`,
    observedOn: "2026-08-29",
    rightsBasis: kind === "technical" ? "manufacturer_published" as const
      : kind === "purchase" ? "supplier_authorized" as const
        : "workspace_owned" as const,
    sourceDocumentSha256: null,
  };
}

function component(
  graph: PlanningGraph,
  input: {
    componentId: string;
    revision?: number;
    internalSku: string;
    componentType: "module" | "inverter" | "battery";
    technicalData: Record<string, unknown>;
    purchasePriceNetCents: number;
    salesPriceNetCents: number;
  },
): CatalogComponentRevisionV1 {
  return sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: graph.workspaceId,
      componentId: input.componentId,
      revision: input.revision ?? 1,
      internalSku: input.internalSku,
      componentType: input.componentType,
    },
    presentation: {
      displayName: `${input.componentType} M1-08 Test`,
      manufacturer: "WMEE Synthetik",
      model: input.internalSku,
      unit: "piece",
      keyPoints: ["Ausschliesslich synthetische Testdaten"],
      image: null,
      datasheet: null,
    },
    technicalData: input.technicalData,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: input.purchasePriceNetCents,
      salesPriceNetCents: input.salesPriceNetCents,
      purchaseProvenance: provenance("purchase"),
      salesProvenance: provenance("sales"),
    },
    technicalProvenance: provenance("technical"),
  });
}

function resolutionLine(
  position: number,
  quantity: number,
  snapshot: CatalogComponentRevisionV1,
  coversRequirementKeys: ProjectCatalogResolutionLineV1["coversRequirementKeys"],
): ProjectCatalogResolutionLineV1 {
  return {
    lineId: randomUUID(),
    position,
    quantity,
    coversRequirementKeys,
    catalogComponentId: snapshot.identity.componentId,
    catalogComponentRevision: snapshot.identity.revision,
    componentSnapshotSha256: snapshot.snapshotSha256,
    componentSnapshot: snapshot,
  };
}

async function expectPgRejection(
  operation: Promise<unknown>,
  pattern: RegExp = /constraint|row-level security|immutable|mutation|revision/i,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, "Das unzulaessige Statement haette scheitern muessen.").toBeInstanceOf(Error);
  const cause = (caught as { cause?: unknown }).cause;
  expect(`${String(caught)}\n${String(cause)}`).toMatch(pattern);
}

async function waitForNamedSessionLock(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await testPool.query<{ waiting: boolean }>(`
      select exists (
        select 1
          from pg_catalog.pg_stat_activity
         where application_name = $1
           and wait_event_type = 'Lock'
      ) as waiting
    `, [applicationName]);
    if (waiting.rows[0]?.waiting === true) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Deferred Resolution-Validator erreichte den Project-Lock nicht.");
}

async function createPlanningGraph(label: string): Promise<PlanningGraph> {
  const workspaceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name) values (${workspaceId}::uuid, ${label})
    `);
    await tenantFixtures.project_calculation_revision(tx, workspaceId);
  });
  const { rows } = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
    actor_id: string;
    project_id: string;
    site_id: string;
    requirement_id: string;
    requirement_revision: number;
    calculation_revision_id: string;
    calculation_revision: number;
    input_sha256: string;
    result_sha256: string;
    [key: string]: unknown;
  }>(sql`
    select revision.created_by as actor_id,
           revision.project_id,
           revision.site_id,
           revision.requirement_id,
           revision.requirement_revision,
           revision.id as calculation_revision_id,
           revision.revision as calculation_revision,
           encode(revision.input_sha256, 'hex') as input_sha256,
           encode(revision.result_sha256, 'hex') as result_sha256
      from project_calculation_revision revision
     where revision.workspace_id = ${workspaceId}::uuid
     order by revision.created_at desc, revision.id desc
     limit 1
  `));
  const row = rows[0];
  if (!row) throw new Error("M1-08-Testgraph konnte nicht aufgebaut werden.");
  return {
    workspaceId,
    actorId: row.actor_id,
    projectId: row.project_id,
    siteId: row.site_id,
    requirementId: row.requirement_id,
    requirementRevision: row.requirement_revision,
    calculationRevisionId: row.calculation_revision_id,
    calculationRevision: row.calculation_revision,
    calculationInputSha256: row.input_sha256,
    calculationResultSha256: row.result_sha256,
  };
}

async function insertProduct(
  graph: PlanningGraph,
  snapshot: CatalogComponentRevisionV1,
): Promise<void> {
  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into catalog_component (
        id, workspace_id, internal_sku, component_type, status,
        current_revision, created_by
      ) values (
        ${snapshot.identity.componentId}::uuid, ${graph.workspaceId}::uuid,
        ${snapshot.identity.internalSku}, ${snapshot.identity.componentType},
        'draft', 0, ${graph.actorId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into catalog_component_revision (
        id, workspace_id, component_id, revision, component_type,
        schema_version, canonicalization_version, revision_snapshot,
        snapshot_sha256, created_by
      ) values (
        ${randomUUID()}::uuid, ${graph.workspaceId}::uuid,
        ${snapshot.identity.componentId}::uuid, ${snapshot.identity.revision},
        ${snapshot.identity.componentType}, ${snapshot.schemaVersion},
        ${snapshot.canonicalizationVersion}, ${JSON.stringify(snapshot)}::jsonb,
        decode(${snapshot.snapshotSha256}, 'hex'), ${graph.actorId}::uuid
      )
    `);
    await tx.execute(sql`
      update catalog_component
         set status = 'active', updated_at = now()
       where workspace_id = ${graph.workspaceId}::uuid
         and id = ${snapshot.identity.componentId}::uuid
    `);
  });
}

async function createCatalogFixture(label: string): Promise<CatalogFixture> {
  const graph = await createPlanningGraph(label);
  const products = [
    component(graph, {
      componentId: randomUUID(),
      internalSku: "M108-PV-440",
      componentType: "module",
      technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 440 },
      purchasePriceNetCents: 7_900,
      salesPriceNetCents: 12_900,
    }),
    component(graph, {
      componentId: randomUUID(),
      internalSku: "M108-INV-8K",
      componentType: "inverter",
      technicalData: {
        schemaVersion: "inverter.v1",
        nominalAcPowerWatts: 8_000,
        phaseCount: 3,
        mpptTrackerCount: 2,
      },
      purchasePriceNetCents: 80_000,
      salesPriceNetCents: 120_000,
    }),
    component(graph, {
      componentId: randomUUID(),
      internalSku: "M108-BAT-8K",
      componentType: "battery",
      technicalData: {
        schemaVersion: "battery.v1",
        nominalCapacityWh: 8_500,
        usableCapacityWh: 8_000,
        maxContinuousPowerWatts: 4_000,
        roundTripEfficiencyBasisPoints: 9_400,
        backupCapability: "known_supported",
      },
      purchasePriceNetCents: 250_000,
      salesPriceNetCents: 390_000,
    }),
  ];
  for (const product of products) await insertProduct(graph, product);

  const resolution = sealProjectCatalogResolution({
    schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    revision: 1,
    bindings: {
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      siteId: graph.siteId,
      requirementId: graph.requirementId,
      requirementRevision: graph.requirementRevision,
      calculationRevisionId: graph.calculationRevisionId,
      calculationRevision: graph.calculationRevision,
      calculationInputSha256: graph.calculationInputSha256,
      calculationResultSha256: graph.calculationResultSha256,
      calculationQuality: "server_reproduced_estimate",
      calculationValidationStatus: "not_f4_reference_validated",
    },
    lines: [
      resolutionLine(1, 20, products[0]!, ["pv_generation"]),
      resolutionLine(2, 1, products[1]!, ["pv_generation"]),
      resolutionLine(3, 1, products[2]!, ["storage_capacity"]),
    ],
    requested: {
      branch: "new_installation",
      pvPeakPowerWatts: 8_800,
      storageCapacityWh: 8_000,
      wallbox: false,
      backupPower: false,
      bidirectionalCharging: false,
    },
    acknowledgements: ["cross_component_compatibility_unverified"],
    confirmedBy: graph.actorId,
    confirmedAt: "2026-08-29T18:00:00.000Z",
  });
  const resolutionId = randomUUID();

  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into project_catalog_resolution (
        id, workspace_id, project_id, site_id, revision,
        requirement_id, requirement_revision,
        calculation_revision_id, calculation_revision,
        calculation_input_sha256, calculation_result_sha256,
        calculation_quality, calculation_validation_status,
        schema_version, canonicalization_version, resolution_snapshot,
        resolution_sha256, confirmed_by, confirmed_at
      ) values (
        ${resolutionId}::uuid, ${graph.workspaceId}::uuid,
        ${graph.projectId}::uuid, ${graph.siteId}::uuid, ${resolution.revision},
        ${graph.requirementId}::uuid, ${graph.requirementRevision},
        ${graph.calculationRevisionId}::uuid, ${graph.calculationRevision},
        decode(${graph.calculationInputSha256}, 'hex'),
        decode(${graph.calculationResultSha256}, 'hex'),
        'server_reproduced_estimate', 'not_f4_reference_validated',
        ${resolution.schemaVersion}, ${resolution.canonicalizationVersion},
        ${JSON.stringify(resolution)}::jsonb,
        decode(${resolution.resolutionSha256}, 'hex'),
        ${graph.actorId}::uuid, ${resolution.confirmedAt}::timestamptz
      )
    `);
    for (const line of resolution.lines) {
      await tx.execute(sql`
        insert into project_catalog_resolution_line (
          id, workspace_id, resolution_id, project_id, position, quantity,
          catalog_component_id, catalog_component_revision,
          component_snapshot_sha256
        ) values (
          ${line.lineId}::uuid, ${graph.workspaceId}::uuid,
          ${resolutionId}::uuid, ${graph.projectId}::uuid,
          ${line.position}, ${line.quantity},
          ${line.catalogComponentId}::uuid, ${line.catalogComponentRevision},
          decode(${line.componentSnapshotSha256}, 'hex')
        )
      `);
    }
    await tx.execute(sql`set constraints all immediate`);
  });
  return { graph, resolutionId, resolution, products };
}

describe.sequential("M1-08 Katalogschema", () => {
  beforeAll(async () => {
    const { rows } = await testPool.query<{ table_name: string }>(`
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and table_name = any($1::text[])
       order by table_name
    `, [CATALOG_TABLES]);
    expect(rows.map((row) => row.table_name)).toEqual([...CATALOG_TABLES].sort());
  });

  it("erzwingt fuer alle vier Relationen Tenant-RLS und genau eine Standardpolicy", async () => {
    const { rows } = await testPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(`
      select relation.relname, relation.relrowsecurity, relation.relforcerowsecurity,
             count(policy.policyname)::int as policies
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        left join pg_catalog.pg_policies policy
          on policy.schemaname = namespace.nspname and policy.tablename = relation.relname
       where namespace.nspname = 'public'
         and relation.relname = any($1::text[])
       group by relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
       order by relation.relname
    `, [CATALOG_TABLES]);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      });
    }
  });

  it("publiziert Revisionen lueckenlos, projiziert Filterwerte und schuetzt WORM-Daten", async () => {
    const fixture = await createCatalogFixture("M1-08 Revision und WORM");
    const battery = fixture.products[2]!;
    const { rows } = await withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute<{
      status: string;
      current_revision: number;
      nominal_power_watts: number | null;
      usable_capacity_wh: number | null;
      [key: string]: unknown;
    }>(sql`
      select status, current_revision, nominal_power_watts, usable_capacity_wh
        from catalog_component
       where id = ${battery.identity.componentId}::uuid
    `));
    expect(rows[0]).toEqual({
      status: "active",
      current_revision: 1,
      nominal_power_watts: null,
      usable_capacity_wh: 8_000,
    });

    await expectPgRejection(withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute(sql`
      update catalog_component_revision
         set revision_snapshot = jsonb_set(revision_snapshot, '{presentation,model}', '"manipuliert"')
       where component_id = ${battery.identity.componentId}::uuid
    `)), /immutable|mutation|forbid|append-only/i);
    await expectPgRejection(withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute(sql`
      delete from catalog_component_revision
       where component_id = ${battery.identity.componentId}::uuid
    `)), /immutable|mutation|forbid/i);

    const skipped = component(fixture.graph, {
      componentId: battery.identity.componentId,
      revision: 3,
      internalSku: battery.identity.internalSku,
      componentType: "battery",
      technicalData: battery.technicalData,
      purchasePriceNetCents: 250_000,
      salesPriceNetCents: 390_000,
    });
    await expectPgRejection(withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute(sql`
      insert into catalog_component_revision (
        workspace_id, component_id, revision, component_type, schema_version,
        canonicalization_version, revision_snapshot, snapshot_sha256, created_by
      ) values (
        ${fixture.graph.workspaceId}::uuid, ${battery.identity.componentId}::uuid,
        3, 'battery', ${skipped.schemaVersion}, ${skipped.canonicalizationVersion},
        ${JSON.stringify(skipped)}::jsonb, decode(${skipped.snapshotSha256}, 'hex'),
        ${fixture.graph.actorId}::uuid
      )
    `)), /revision|lueckenlos|concurrent/i);
  });

  it("bindet eine Projektaufloesung relational an Requirement, Calculation und exakte Produktrevisionen", async () => {
    const fixture = await createCatalogFixture("M1-08 relationale Bindung");
    const { rows } = await withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute<{
      status: string;
      lines: number;
      [key: string]: unknown;
    }>(sql`
      select project.catalog_resolution_status as status,
             count(line.id)::int as lines
        from project
        join project_catalog_resolution resolution
          on resolution.workspace_id = project.workspace_id
         and resolution.project_id = project.id
        join project_catalog_resolution_line line
          on line.workspace_id = resolution.workspace_id
         and line.resolution_id = resolution.id
       where project.id = ${fixture.graph.projectId}::uuid
       group by project.catalog_resolution_status
    `));
    expect(rows[0]).toEqual({ status: "resolved", lines: 3 });

    const { rows: foreignKeys } = await testPool.query<{
      constraint_name: string;
      delete_action: string;
    }>(`
      select constraint_name, delete_rule as delete_action
        from information_schema.referential_constraints
       where constraint_schema = 'public'
         and constraint_name in (
           'project_catalog_resolution_project_site_fk',
           'project_catalog_resolution_requirement_fk',
           'project_catalog_resolution_calculation_fk',
           'project_catalog_resolution_line_catalog_revision_fk'
         )
       order by constraint_name
    `);
    expect(foreignKeys).toEqual([
      { constraint_name: "project_catalog_resolution_calculation_fk", delete_action: "CASCADE" },
      { constraint_name: "project_catalog_resolution_line_catalog_revision_fk", delete_action: "NO ACTION" },
      { constraint_name: "project_catalog_resolution_project_site_fk", delete_action: "CASCADE" },
      { constraint_name: "project_catalog_resolution_requirement_fk", delete_action: "CASCADE" },
    ]);
  });

  it("markiert nur den aktuellen Projektstand bei neuer Produktrevision stale", async () => {
    const fixture = await createCatalogFixture("M1-08 Katalog-Stale");
    const battery = fixture.products[2]!;
    const revised = component(fixture.graph, {
      componentId: battery.identity.componentId,
      revision: 2,
      internalSku: battery.identity.internalSku,
      componentType: "battery",
      technicalData: {
        ...battery.technicalData,
        usableCapacityWh: 8_100,
      },
      purchasePriceNetCents: 255_000,
      salesPriceNetCents: 395_000,
    });
    await withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute(sql`
      insert into catalog_component_revision (
        workspace_id, component_id, revision, component_type, schema_version,
        canonicalization_version, revision_snapshot, snapshot_sha256, created_by
      ) values (
        ${fixture.graph.workspaceId}::uuid, ${battery.identity.componentId}::uuid,
        2, 'battery', ${revised.schemaVersion}, ${revised.canonicalizationVersion},
        ${JSON.stringify(revised)}::jsonb, decode(${revised.snapshotSha256}, 'hex'),
        ${fixture.graph.actorId}::uuid
      )
    `));
    const { rows } = await withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute<{
      catalog_resolution_status: string;
      [key: string]: unknown;
    }>(sql`
      select catalog_resolution_status from project
       where id = ${fixture.graph.projectId}::uuid
    `));
    expect(rows[0]?.catalog_resolution_status).toBe("pending");

    await expectPgRejection(withTenantOn(testPool, fixture.graph.workspaceId, (tx) => tx.execute(sql`
      update project_catalog_resolution
         set resolution_snapshot = jsonb_set(
           resolution_snapshot, '{warnings}', '["calculation_not_sku_specific"]'::jsonb
         )
       where id = ${fixture.resolutionId}::uuid
    `)), /immutable|mutation|forbid|append-only/i);
  });

  it("liest Currentness nach einem wartenden Project-Lock mit frischem Snapshot", async () => {
    const fixture = await createCatalogFixture("M1-08 Deferred-Validator-Race");
    const applicationName = `m108-validator-${randomUUID().slice(0, 8)}`;
    let reportProjectLocked!: () => void;
    let rejectProjectLock!: (error: unknown) => void;
    let allowRequirementInsert!: () => void;
    const projectLocked = new Promise<void>((resolveLock, rejectLock) => {
      reportProjectLocked = resolveLock;
      rejectProjectLock = rejectLock;
    });
    const requirementInsertAllowed = new Promise<void>((resolveInsert) => {
      allowRequirementInsert = resolveInsert;
    });

    const requirementInsert = withTenantOn(
      testPool,
      fixture.graph.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          select id
            from project
           where workspace_id = ${fixture.graph.workspaceId}::uuid
             and id = ${fixture.graph.projectId}::uuid
           for update
        `);
        reportProjectLocked();
        await requirementInsertAllowed;
        await tx.execute(sql`
          insert into project_requirement (
            id, workspace_id, project_id, revision, schema_version,
            source_snapshot_id, requirements
          )
          select ${randomUUID()}::uuid, workspace_id, project_id, 2,
                 schema_version, source_snapshot_id, requirements
            from project_requirement
           where workspace_id = ${fixture.graph.workspaceId}::uuid
             and project_id = ${fixture.graph.projectId}::uuid
             and id = ${fixture.graph.requirementId}::uuid
        `);
      },
    );
    void requirementInsert.catch(rejectProjectLock);
    await projectLocked;

    // Invoke the exact production deferred validator once through an isolated
    // transaction-local trigger harness. One event is intentional: it proves
    // that Currentness is evaluated after the waiting Project lock, rather
    // than being accidentally repaired by the subsequent header/line events.
    const validator = withTenantOn(testPool, fixture.graph.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('application_name', ${applicationName}, true)`);
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '4s'`);
      await tx.execute(sql`
        create temporary table project_catalog_resolution (
          id uuid not null,
          workspace_id uuid not null
        ) on commit drop
      `);
      await tx.execute(sql`
        create constraint trigger m108_resolution_validator_race
          after insert on project_catalog_resolution
          deferrable initially deferred
          for each row execute function public.validate_project_catalog_resolution_snapshot()
      `);
      await tx.execute(sql`
        insert into project_catalog_resolution (id, workspace_id)
        values (${fixture.resolutionId}::uuid, ${fixture.graph.workspaceId}::uuid)
      `);
      await tx.execute(sql`set constraints m108_resolution_validator_race immediate`);
    });

    let waitFailure: unknown = null;
    try {
      await waitForNamedSessionLock(applicationName);
    } catch (error) {
      waitFailure = error;
    } finally {
      allowRequirementInsert();
    }
    await Promise.all([requirementInsert, validator]);
    if (waitFailure !== null) throw waitFailure;

    const { rows } = await withTenantOn(
      testPool,
      fixture.graph.workspaceId,
      (tx) => tx.execute<{
        catalog_resolution_status: string;
        requirement_revision: number;
        [key: string]: unknown;
      }>(sql`
        select project_record.catalog_resolution_status,
               max(requirement.revision)::int as requirement_revision
          from project project_record
          join project_requirement requirement
            on requirement.workspace_id = project_record.workspace_id
           and requirement.project_id = project_record.id
         where project_record.workspace_id = ${fixture.graph.workspaceId}::uuid
           and project_record.id = ${fixture.graph.projectId}::uuid
         group by project_record.catalog_resolution_status
      `),
    );
    expect(rows[0]).toEqual({
      catalog_resolution_status: "pending",
      requirement_revision: 2,
    });
  }, 10_000);

  it("bindet den Worker-Project-Lock fail-closed an den Tenant-GUC", async () => {
    const tenantWorkspaceId = randomUUID();
    await expectPgRejection(withTenantOn(testPool, tenantWorkspaceId, (tx) => tx.execute(sql`
      select public.lock_project_calculation_finalization(
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid
      )
    `)), /tenant context mismatch|42501/i);
  });
});
