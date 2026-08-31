import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenantOn } from "@/lib/db/tenant";
import { calculatePlanningEstimate } from "@/lib/integrations/calculation/engine";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  canonicalizeCalculationJson,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
  PLANNING_RESERVATION_VERSION,
} from "@/lib/integrations/calculation/versions";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
  type CatalogComponentType,
} from "@/lib/integrations/catalog/contract";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
  getProjectCatalogResolutionContext,
  ProjectCatalogBlockedError,
  ProjectCatalogConflictError,
  resolveProjectCatalog,
  reviseCatalogComponentPricing,
  searchActiveProjectCatalogComponents,
} from "@/modules/catalog";
import { testPool } from "../setup/test-db";

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(
    import.meta.dirname,
    "../../contracts/examples/planning-calculation.v1.new.request.json",
  ),
  "utf8",
)) as PlanningCalculationRequestV1;

type ResolutionMembers = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  viewerId: string;
  externalId: string;
  projectEditorId: string;
};

type PlanningProject = {
  projectId: string;
  siteId: string;
  requirementId: string;
  calculationRevisionId: string;
};

type ProductSet = Record<"module" | "inverter" | "battery" | "wallbox", string>;

async function createResolutionMembers(): Promise<ResolutionMembers> {
  const members = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    adminId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    projectEditorId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'M1-08 Projektauflösung')
    `);
    for (const userId of [
      members.editorId,
      members.adminId,
      members.viewerId,
      members.externalId,
      members.projectEditorId,
    ]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@m108-resolution.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.editorId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.adminId}::uuid, 'admin', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.externalId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"external_only":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.projectEditorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return members;
}

function resolutionCtx(
  members: ResolutionMembers,
  actor: "editor" | "project" | "admin" | "viewer" | "external",
): ServiceCtx {
  if (actor === "admin") {
    return {
      workspaceId: members.workspaceId,
      actor: members.adminId,
      role: "admin",
      capabilities: {},
      featureFlags: {},
    };
  }
  if (actor === "viewer") {
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
    actor: actor === "external"
      ? members.externalId
      : actor === "project"
        ? members.projectEditorId
        : members.editorId,
    role: "editor",
    capabilities: actor === "external"
      ? { manage_catalog: true, edit_prices: true, external_only: true }
      : actor === "project"
        ? {}
        : { manage_catalog: true, edit_prices: true },
    featureFlags: {},
  };
}

async function createPlanningProject(members: ResolutionMembers): Promise<PlanningProject> {
  const ids = {
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobId: randomUUID(),
    calculationRevisionId: randomUUID(),
  };
  const request = structuredClone(GOLDEN_REQUEST);
  request.bindings = {
    ...request.bindings,
    workspaceId: members.workspaceId,
    projectId: ids.projectId,
    siteId: ids.siteId,
    addressRevision: 1,
    pinConfirmedAddressRevision: 1,
    energyProfileId: ids.profileId,
    energyProfileRevision: 1,
    confirmedEnergyProfileRevision: 1,
    confirmedEnergyProfileAddressRevision: 1,
    projectRequirementId: ids.requirementId,
    projectRequirementRevision: 1,
    sourceCalculatorSnapshotId: ids.snapshotId,
  };
  const result = calculatePlanningEstimate(request);
  const profileSha256 = createHash("sha256")
    .update(canonicalizeCalculationJson(request.energyProfile), "utf8")
    .digest("hex");
  const reservationSha256 = createHash("sha256")
    .update(canonicalizeCalculationJson({
      reservationVersion: PLANNING_RESERVATION_VERSION,
      canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
      schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
      bindings: {
        workspaceId: members.workspaceId,
        projectId: ids.projectId,
        siteId: ids.siteId,
        addressRevision: 1,
        pinConfirmedAddressRevision: 1,
        profileId: ids.profileId,
        profileRevision: 1,
        confirmedProfileRevision: 1,
        confirmedAddressRevision: 1,
        requirementId: ids.requirementId,
        requirementRevision: 1,
        sourceSnapshotId: ids.snapshotId,
      },
      providerRecipeVersion: PLANNING_PROVIDER_RECIPE_VERSION,
      contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
      modelId: PLANNING_MODEL_ID,
      modelVersion: PLANNING_MODEL_VERSION,
      sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
      defaultsVersion: PLANNING_DEFAULTS_VERSION,
    }), "utf8")
    .digest("hex");
  const calculatorSnapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-08-29T12:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };

  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${members.workspaceId}::uuid,
        'Synthetischer Auflösungskontakt', 'resolution@example.test',
        'resolution@example.test'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision
      )
      values (
        ${ids.siteId}::uuid, ${members.workspaceId}::uuid,
        ${ids.contactId}::uuid, 'Synthetischer Standort',
        'Testweg 7, 69168 Dielheim', decode(repeat('ab', 32), 'hex'), 1,
        'selected', 'Testweg', '7', '69168', 'Dielheim', 'DE',
        ${request.site.latitude}, ${request.site.longitude}, 'photon', 'house',
        false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${members.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake.id, 'Synthetisches Auflösungsprojekt', 'fixture'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
       where board.workspace_id = ${members.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
         and intake.archived_at is null
    `);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${ids.receiptId}::uuid, ${members.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1', decode(repeat('10', 32), 'hex'),
        'm108-fixture', now(), now(), now(), 'wmee-rechner-v3',
        ${"1".repeat(40)}, 'development', 'wmee-solar.v1', '{}'::jsonb,
        'offer_request', 'art_6_1_b_precontractual', 'fixture-v1',
        'https://example.test/privacy', 'created', ${ids.contactId}::uuid,
        ${ids.siteId}::uuid, ${ids.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source, calculated_at,
        snapshot
      ) values (
        ${ids.snapshotId}::uuid, ${members.workspaceId}::uuid,
        ${ids.receiptId}::uuid, ${ids.projectId}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(calculatorSnapshot)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${ids.requirementId}::uuid, ${members.workspaceId}::uuid,
        ${ids.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${ids.snapshotId}::uuid, ${JSON.stringify(request.projectRequirements)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${ids.profileId}::uuid, ${members.workspaceId}::uuid, ${ids.siteId}::uuid,
        1, 'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotId}::uuid, ${ids.projectId}::uuid, 1,
        ${JSON.stringify(request.energyProfile)}::jsonb,
        decode(${profileSha256}, 'hex'), 1, 1, ${members.editorId}::uuid, now()
      )
    `);
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version,
        state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
        input_sha256, input_snapshot, provider_snapshot, created_by, started_at
      ) values (
        ${ids.jobId}::uuid, ${members.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        decode(${reservationSha256}, 'hex'), ${PLANNING_PROVIDER_RECIPE_VERSION},
        ${PLANNING_CALCULATION_CONTRACT_VERSION}, ${result.model.id},
        ${result.model.version}, ${result.model.sourceRevision},
        ${PLANNING_DEFAULTS_VERSION},
        'running', 1, now(), ${randomUUID()}::uuid, now() + interval '15 minutes',
        decode(${result.inputSha256}, 'hex'), ${JSON.stringify(request)}::jsonb,
        ${JSON.stringify(request.yieldSnapshots)}::jsonb,
        ${members.editorId}::uuid, now()
      )
    `);
    await tx.execute(sql`
      insert into project_calculation_revision (
        id, workspace_id, project_id, site_id, revision, job_id,
        address_revision, pin_confirmed_address_revision, profile_id,
        profile_revision, confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        contract_version, model_id, model_version, source_revision,
        defaults_version, quality, validation_status, input_sha256,
        result_sha256, input_snapshot, provider_snapshot, result, created_by
      ) values (
        ${ids.calculationRevisionId}::uuid, ${members.workspaceId}::uuid,
        ${ids.projectId}::uuid, ${ids.siteId}::uuid, 1, ${ids.jobId}::uuid,
        1, 1, ${ids.profileId}::uuid, 1, 1, 1, ${ids.requirementId}::uuid, 1,
        ${ids.snapshotId}::uuid, ${PLANNING_CALCULATION_CONTRACT_VERSION},
        ${result.model.id},
        ${result.model.version}, ${result.model.sourceRevision},
        ${PLANNING_DEFAULTS_VERSION}, ${result.quality}, ${result.validationStatus},
        decode(${result.inputSha256}, 'hex'), decode(${result.resultSha256}, 'hex'),
        ${JSON.stringify(request)}::jsonb, ${JSON.stringify(request.yieldSnapshots)}::jsonb,
        ${JSON.stringify(result)}::jsonb, ${members.editorId}::uuid
      )
    `);
    await tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded', lease_token = null, lease_expires_at = null,
             finished_at = now(), result_revision_id = ${ids.calculationRevisionId}::uuid
       where workspace_id = ${members.workspaceId}::uuid
         and id = ${ids.jobId}::uuid
    `);
  });
  return {
    projectId: ids.projectId,
    siteId: ids.siteId,
    requirementId: ids.requirementId,
    calculationRevisionId: ids.calculationRevisionId,
  };
}

function productCommand(
  type: keyof ProductSet,
  index: number,
): CatalogComponentCreateCommandV1 {
  const technicalData = type === "module"
    ? { schemaVersion: "module.v1" as const, nominalPowerWatts: 400 }
    : type === "inverter"
      ? {
          schemaVersion: "inverter.v1" as const,
          nominalAcPowerWatts: 10_000,
          phaseCount: 3 as const,
          mpptTrackerCount: 3,
        }
      : type === "battery"
        ? {
            schemaVersion: "battery.v1" as const,
            nominalCapacityWh: 8_500,
            usableCapacityWh: 8_000,
            maxContinuousPowerWatts: 4_000,
            roundTripEfficiencyBasisPoints: 9_400,
            backupCapability: "known_supported" as const,
          }
        : {
            schemaVersion: "wallbox.v1" as const,
            maxChargingPowerWatts: 11_000,
            phaseCount: 3 as const,
            connector: "type2_cable" as const,
            bidirectionalCapability: "known_supported" as const,
          };
  const provenance = {
    sourceKind: "workspace_manual" as const,
    reference: `SYNTHETIC-TECH-${index}`,
    observedOn: "2026-08-29",
    rightsBasis: "workspace_owned" as const,
    sourceDocumentSha256: null,
  };
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: `M108-${type.toUpperCase()}-${index}`,
    componentType: type as CatalogComponentType,
    presentation: {
      displayName: `Synthetische ${type}-Komponente`,
      manufacturer: "WMEE Testwerk",
      model: `Fixture ${index}`,
      unit: "piece",
      keyPoints: ["Keine realen Produktdaten"],
      image: null,
      datasheet: null,
    },
    technicalData,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 100_000 + index,
      salesPriceNetCents: 150_000 + index,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `PRIVATE-PURCHASE-${index}`,
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-SALES-${index}`,
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: provenance,
  };
}

async function createActiveProducts(members: ResolutionMembers): Promise<ProductSet> {
  const editor = resolutionCtx(members, "editor");
  const entries = await Promise.all(([
    "module", "inverter", "battery", "wallbox",
  ] as const).map(async (type, index) => {
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, editor, productCommand(type, index + 1)));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));
    return [type, created.componentId] as const;
  }));
  return Object.fromEntries(entries) as ProductSet;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromiseValue, rejectPromiseValue) => {
    resolvePromise = resolvePromiseValue;
    rejectPromise = rejectPromiseValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitForNamedSessionLock(
  applicationName: string,
  blockerPid?: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await testPool.query<{ waiting: boolean }>(`
      select exists (
        select 1
          from pg_catalog.pg_stat_activity activity
         where activity.application_name = $1
           and activity.wait_event_type = 'Lock'
           and ($2::integer is null
             or $2 = any(pg_catalog.pg_blocking_pids(activity.pid)))
      ) as waiting
    `, [applicationName, blockerPid ?? null]);
    if (waiting.rows[0]?.waiting === true) return;
  }
  throw new Error("Konkurrierende Projektauflösung erreichte den erwarteten Lock nicht.");
}

describe("M1-08 Projekt-Katalogauflösung", () => {
  it("findet eine aktive SKU hinter der 200er-Anzeigegrenze serverseitig", async () => {
    const members = await createResolutionMembers();
    const project = await createPlanningProject(members);
    const editor = resolutionCtx(members, "editor");
    const projectEditor = resolutionCtx(members, "project");
    let targetId = "";

    await withTenantOn(testPool, members.workspaceId, async (tx) => {
      for (let index = 0; index < 205; index += 1) {
        const command = productCommand("module", 10_000 + index);
        command.internalSku = `AAA-M108-${index.toString().padStart(3, "0")}`;
        const created = await createCatalogComponent(tx, editor, command);
        await activateCatalogComponent(tx, editor, {
          componentId: created.componentId,
          expectedRevision: 1,
          expectedStatus: "draft",
        });
      }
      const target = productCommand("module", 20_000);
      target.internalSku = "ZZZ-M108-SERVER-SEARCH-TARGET";
      const created = await createCatalogComponent(tx, editor, target);
      targetId = created.componentId;
      await activateCatalogComponent(tx, editor, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      });
    });

    const context = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, projectEditor, project.projectId));
    expect(context?.activeComponents).toHaveLength(200);
    expect(context?.activeComponents.some((component) => component.id === targetId)).toBe(false);

    const found = await withTenantOn(testPool, members.workspaceId, (tx) =>
      searchActiveProjectCatalogComponents(tx, projectEditor, {
        projectId: project.projectId,
        query: "zzz-m108-server-search-target",
      }));
    expect(found).toHaveLength(1);
    expect(found?.[0]).toMatchObject({
      id: targetId,
      status: "active",
      current: { identity: { internalSku: "ZZZ-M108-SERVER-SEARCH-TARGET" } },
    });
  }, 30_000);

  it("bindet ausschließlich aktuelle Planung und aktive Revisionen, redigiert Reads und leitet Stale ab", async () => {
    const members = await createResolutionMembers();
    const project = await createPlanningProject(members);
    const products = await createActiveProducts(members);
    const editor = resolutionCtx(members, "editor");
    const projectEditor = resolutionCtx(members, "project");
    const viewer = resolutionCtx(members, "viewer");
    const admin = resolutionCtx(members, "admin");
    const external = resolutionCtx(members, "external");

    const pending = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, projectEditor, project.projectId));
    expect(pending).toMatchObject({
      state: "pending",
      blocker: null,
      currentRequirementRevision: 1,
      currentCalculationRevision: 1,
      requested: {
        branch: "new_installation",
        pvPeakPowerWatts: 10_400,
        storageCapacityWh: 8_000,
        wallbox: true,
      },
    });
    expect(pending?.activeComponents).toHaveLength(4);

    const command = {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: project.projectId,
      expectedResolutionRevision: 0,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
        { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.battery, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified" as const],
    };
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      resolveProjectCatalog(tx, projectEditor, { ...command, acknowledgements: [] })))
      .rejects.toMatchObject({ name: "CatalogInputError" });
    const beforeResolve = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{ count: number; [key: string]: unknown }>(sql`
        select count(*)::int as count from project_catalog_resolution
        where workspace_id = ${members.workspaceId}::uuid
          and project_id = ${project.projectId}::uuid
      `));
    expect(beforeResolve.rows[0].count).toBe(0);

    const resolved = await withTenantOn(testPool, members.workspaceId, (tx) =>
      resolveProjectCatalog(tx, projectEditor, command));
    expect(resolved).toMatchObject({ projectId: project.projectId, revision: 1 });
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      resolveProjectCatalog(tx, projectEditor, command))).rejects.toBeInstanceOf(
        ProjectCatalogConflictError,
      );

    const currentViewer = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, viewer, project.projectId));
    expect(currentViewer).toMatchObject({
      state: "current",
      blocker: null,
      staleReasons: [],
      permissions: { canResolve: false, canReadPurchasePrice: false },
    });
    const viewerJson = JSON.stringify(currentViewer);
    expect(viewerJson).not.toContain("purchasePriceNetCents");
    expect(viewerJson).not.toContain("PRIVATE-PURCHASE-");
    expect(viewerJson).not.toContain("sourceSnapshotSha256");
    expect(viewerJson).not.toContain("componentSnapshotSha256");
    expect(viewerJson).not.toContain("sourceResolutionSha256");
    expect(viewerJson).toContain("salesPriceNetCents");
    const adminContext = await withTenantOn(
      testPool,
      members.workspaceId,
      (tx) => getProjectCatalogResolutionContext(tx, admin, project.projectId),
    );
    const adminJson = JSON.stringify(adminContext);
    expect(adminJson).toContain("purchasePriceNetCents");
    expect(adminContext?.latestResolution?.sourceResolutionSha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    for (const line of adminContext?.latestResolution?.lines ?? []) {
      expect(line.componentSnapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(line.componentSnapshot.sourceSnapshotSha256).toMatch(
        /^[0-9a-f]{64}$/u,
      );
    }

    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, external, project.projectId)))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      resolveProjectCatalog(tx, external, command))).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );

    await withTenantOn(testPool, members.workspaceId, (tx) =>
      reviseCatalogComponentPricing(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: products.battery,
        expectedRevision: 1,
        commercial: productCommand("battery", 3).commercial,
      }));
    const stale = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, viewer, project.projectId));
    expect(stale?.state).toBe("stale");
    expect(stale?.staleReasons).toContain("catalog_component_changed");
    expect(stale?.staleReasons).toContain("project_status_pending");
    expect(stale?.latestResolution?.revision).toBe(1);
  });

  it("hält Auflösungs-Event und Audit frei von Mengen, Preisen und freien Quellen", async () => {
    const members = await createResolutionMembers();
    const project = await createPlanningProject(members);
    const products = await createActiveProducts(members);
    const projectEditor = resolutionCtx(members, "project");
    await withTenantOn(testPool, members.workspaceId, (tx) => resolveProjectCatalog(tx, projectEditor, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: project.projectId,
      expectedResolutionRevision: 0,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
        { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.battery, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified"],
    }));
    const logs = await withTenantOn(testPool, members.workspaceId, async (tx) => {
      const events = await tx.execute<{
        payload: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select payload from domain_events
        where workspace_id = ${members.workspaceId}::uuid
          and aggregate_id = ${project.projectId}::uuid
          and event_type = 'project.catalog_resolved'
      `);
      const audits = await tx.execute<{
        action: string;
        resource: string;
        allowed: boolean;
        details: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select action, resource, allowed, details from audit_log
        where workspace_id = ${members.workspaceId}::uuid
          and resource = 'project_catalog_resolution'
          and details->>'projectId' = ${project.projectId}
      `);
      return { events: events.rows, audits: audits.rows };
    });
    const serialized = JSON.stringify(logs);
    expect(logs.events).toHaveLength(1);
    expect(logs.audits).toHaveLength(1);
    const safeKeys = [
      "calculationRevision",
      "componentRevisions",
      "projectId",
      "requirementRevision",
      "resolutionId",
      "resolutionSha256",
      "revision",
    ];
    expect(Object.keys(logs.events[0]!.payload).sort()).toEqual(safeKeys);
    expect(Object.keys(logs.audits[0]!.details).sort()).toEqual(safeKeys);
    expect(logs.audits[0]).toMatchObject({
      action: "project.write",
      resource: "project_catalog_resolution",
      allowed: true,
    });
    const componentRevisions = logs.events[0]!.payload.componentRevisions;
    expect(componentRevisions).toBeInstanceOf(Array);
    for (const component of componentRevisions as Array<Record<string, unknown>>) {
      expect(Object.keys(component).sort()).toEqual([
        "componentId",
        "revision",
        "snapshotSha256",
      ]);
    }
    expect(serialized).not.toContain("quantity");
    expect(serialized).not.toContain("purchasePriceNetCents");
    expect(serialized).not.toContain("salesPriceNetCents");
    expect(serialized).not.toContain("PRIVATE-PURCHASE-");
    expect(serialized).not.toContain("SYNTHETIC-TECH-");
  });

  it("rollt Auflösung, Zeilen, Status, Event und Audit gemeinsam zurück", async () => {
    const members = await createResolutionMembers();
    const project = await createPlanningProject(members);
    const products = await createActiveProducts(members);
    const projectEditor = resolutionCtx(members, "project");
    const marker = new Error("absichtlicher M1-08 Auflösungs-Rollback");
    let resolutionId: string | null = null;
    await expect(withTenantOn(testPool, members.workspaceId, async (tx) => {
      const resolved = await resolveProjectCatalog(tx, projectEditor, {
        schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
        projectId: project.projectId,
        expectedResolutionRevision: 0,
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        selections: [
          { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
          { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
          { componentId: products.battery, expectedComponentRevision: 1, quantity: 1 },
          { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
        ],
        acknowledgements: ["cross_component_compatibility_unverified"],
      });
      resolutionId = resolved.resolutionId;
      throw marker;
    })).rejects.toBe(marker);
    if (resolutionId === null) throw new Error("Rollback-Fixture wurde nicht erzeugt.");

    const footprint = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{
        status: string;
        resolutions: number;
        lines: number;
        events: number;
        audits: number;
        [key: string]: unknown;
      }>(sql`
        select project_record.catalog_resolution_status as status,
          (select count(*)::int from project_catalog_resolution
            where workspace_id = ${members.workspaceId}::uuid
              and id = ${resolutionId}::uuid) as resolutions,
          (select count(*)::int from project_catalog_resolution_line
            where workspace_id = ${members.workspaceId}::uuid
              and resolution_id = ${resolutionId}::uuid) as lines,
          (select count(*)::int from domain_events
            where workspace_id = ${members.workspaceId}::uuid
              and aggregate_id = ${project.projectId}::uuid
              and event_type = 'project.catalog_resolved') as events,
          (select count(*)::int from audit_log
            where workspace_id = ${members.workspaceId}::uuid
              and details->>'resolutionId' = ${resolutionId}) as audits
          from project project_record
         where project_record.workspace_id = ${members.workspaceId}::uuid
           and project_record.id = ${project.projectId}::uuid
      `));
    expect(footprint.rows[0]).toEqual({
      status: "pending",
      resolutions: 0,
      lines: 0,
      events: 0,
      audits: 0,
    });
  });

  it("serialisiert Resolve gegen Produktrevision ohne Deadlock oder falsches resolved", async () => {
    const members = await createResolutionMembers();
    const project = await createPlanningProject(members);
    const products = await createActiveProducts(members);
    const editor = resolutionCtx(members, "editor");
    const projectEditor = resolutionCtx(members, "project");
    const baseCommand = {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: project.projectId,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
        { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.battery, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified" as const],
    };
    await expect(withTenantOn(testPool, members.workspaceId, (tx) =>
      resolveProjectCatalog(tx, projectEditor, {
        ...baseCommand,
        expectedResolutionRevision: 0,
      }))).resolves.toMatchObject({ revision: 1 });

    const componentOwnerReady = deferred<number>();
    const componentOwnerMayRevise = deferred<void>();
    const componentOwner = withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '4s'`);
      const backend = await tx.execute<{ pid: number; [key: string]: unknown }>(sql`
        select pg_catalog.pg_backend_pid() as pid
      `);
      await tx.execute(sql`
        select id
          from catalog_component
         where workspace_id = ${members.workspaceId}::uuid
           and id = ${products.battery}::uuid
         for update
      `);
      componentOwnerReady.resolve(backend.rows[0]!.pid);
      await componentOwnerMayRevise.promise;
      return reviseCatalogComponentPricing(tx, editor, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: products.battery,
        expectedRevision: 1,
        commercial: productCommand("battery", 30).commercial,
      });
    });
    void componentOwner.catch(componentOwnerReady.reject);
    const componentOwnerPid = await componentOwnerReady.promise;

    const resolverApplicationName = `m108-resolve-component-${randomUUID().slice(0, 8)}`;
    const resolver = withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`
        select set_config('application_name', ${resolverApplicationName}, true)
      `);
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '4s'`);
      return resolveProjectCatalog(tx, projectEditor, {
        ...baseCommand,
        expectedResolutionRevision: 1,
      });
    });
    const resolverOutcome = resolver.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let waitFailure: unknown = null;
    try {
      await waitForNamedSessionLock(resolverApplicationName, componentOwnerPid);
    } catch (error) {
      waitFailure = error;
    } finally {
      componentOwnerMayRevise.resolve();
    }
    const [revised, blocked] = await Promise.all([componentOwner, resolverOutcome]);
    if (waitFailure !== null) throw waitFailure;
    expect(revised).toMatchObject({
      componentId: products.battery,
      revision: 2,
      status: "draft",
      changed: true,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("Resolve haette die neue Draft-Revision ablehnen muessen.");
    expect(blocked.error).toBeInstanceOf(ProjectCatalogBlockedError);
    expect(blocked.error).toMatchObject({ code: "component_not_active" });

    const footprint = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{
        project_status: string;
        component_revision: number;
        component_status: string;
        resolution_count: number;
        latest_resolution_revision: number;
        bound_component_revision: number;
        [key: string]: unknown;
      }>(sql`
        select project_record.catalog_resolution_status as project_status,
               component.current_revision as component_revision,
               component.status as component_status,
               (select count(*)::int
                  from project_catalog_resolution resolution
                 where resolution.workspace_id = project_record.workspace_id
                   and resolution.project_id = project_record.id) as resolution_count,
               (select max(resolution.revision)::int
                  from project_catalog_resolution resolution
                 where resolution.workspace_id = project_record.workspace_id
                   and resolution.project_id = project_record.id) as latest_resolution_revision,
               (select line.catalog_component_revision
                  from project_catalog_resolution resolution
                  join project_catalog_resolution_line line
                    on line.workspace_id = resolution.workspace_id
                   and line.resolution_id = resolution.id
                 where resolution.workspace_id = project_record.workspace_id
                   and resolution.project_id = project_record.id
                   and line.catalog_component_id = component.id
                 order by resolution.revision desc
                 limit 1) as bound_component_revision
          from project project_record
          join catalog_component component
            on component.workspace_id = project_record.workspace_id
           and component.id = ${products.battery}::uuid
         where project_record.workspace_id = ${members.workspaceId}::uuid
           and project_record.id = ${project.projectId}::uuid
      `));
    expect(footprint.rows[0]).toEqual({
      project_status: "pending",
      component_revision: 2,
      component_status: "draft",
      resolution_count: 1,
      latest_resolution_revision: 1,
      bound_component_revision: 1,
    });

    const context = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, projectEditor, project.projectId));
    expect(context).toMatchObject({
      state: "stale",
      blocker: null,
      latestResolution: { revision: 1 },
    });
    expect(context?.staleReasons).toEqual(expect.arrayContaining([
      "catalog_component_changed",
      "project_status_pending",
    ]));
  }, 10_000);

  it("bleibt bei erster Auflösung gegen einen wartenden Requirement-Insert sicher pending", async () => {
    const members = await createResolutionMembers();
    const project = await createPlanningProject(members);
    const products = await createActiveProducts(members);
    const projectEditor = resolutionCtx(members, "project");
    const applicationName = `m108-req-${randomUUID().slice(0, 8)}`;
    const productIdList = sql.join(
      Object.values(products).sort().map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    let reportProjectLock!: () => void;
    let continueResolver!: () => void;
    const projectLocked = new Promise<void>((resolveLock) => {
      reportProjectLock = resolveLock;
    });
    const resolverMayContinue = new Promise<void>((resolveContinue) => {
      continueResolver = resolveContinue;
    });

    const resolver = withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`
        select component.id
          from catalog_component component
         where component.workspace_id = ${members.workspaceId}::uuid
           and component.id in (${productIdList})
         order by component.id
         for update of component
      `);
      await tx.execute(sql`
        select id
          from project
         where workspace_id = ${members.workspaceId}::uuid
           and id = ${project.projectId}::uuid
         for update
      `);
      reportProjectLock();
      await resolverMayContinue;
      return resolveProjectCatalog(tx, projectEditor, {
        schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
        projectId: project.projectId,
        expectedResolutionRevision: 0,
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        selections: [
          { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
          { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
          { componentId: products.battery, expectedComponentRevision: 1, quantity: 1 },
          { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
        ],
        acknowledgements: ["cross_component_compatibility_unverified"],
      });
    });
    await projectLocked;

    const requirementInsert = withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('application_name', ${applicationName}, true)`);
      await tx.execute(sql`
        insert into project_requirement (
          id, workspace_id, project_id, revision, schema_version,
          source_snapshot_id, requirements
        )
        select ${randomUUID()}::uuid, workspace_id, project_id, 2,
               schema_version, source_snapshot_id, requirements
          from project_requirement
         where workspace_id = ${members.workspaceId}::uuid
           and project_id = ${project.projectId}::uuid
           and id = ${project.requirementId}::uuid
      `);
    });

    let waitFailure: unknown = null;
    try {
      await waitForNamedSessionLock(applicationName);
    } catch (error) {
      waitFailure = error;
    } finally {
      continueResolver();
    }
    await Promise.all([resolver, requirementInsert]);
    if (waitFailure !== null) throw waitFailure;

    const state = await withTenantOn(testPool, members.workspaceId, (tx) =>
      tx.execute<{ catalog_resolution_status: string; requirement_revision: number; [key: string]: unknown }>(sql`
        select project_record.catalog_resolution_status,
               max(requirement.revision)::int as requirement_revision
          from project project_record
          join project_requirement requirement
            on requirement.workspace_id = project_record.workspace_id
           and requirement.project_id = project_record.id
         where project_record.workspace_id = ${members.workspaceId}::uuid
           and project_record.id = ${project.projectId}::uuid
         group by project_record.catalog_resolution_status
      `));
    expect(state.rows[0]).toMatchObject({
      catalog_resolution_status: "pending",
      requirement_revision: 2,
    });
    const context = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getProjectCatalogResolutionContext(tx, projectEditor, project.projectId));
    expect(context).toMatchObject({
      state: "blocked",
      blocker: "calculation_not_current",
      currentRequirementRevision: 2,
      latestResolution: { revision: 1 },
    });
  });
});
