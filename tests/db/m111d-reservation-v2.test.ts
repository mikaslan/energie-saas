import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  canonicalizeCalculationJson,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
  type CatalogComponentRevisionV1,
  type ProjectCatalogResolutionLineV1,
} from "@/lib/integrations/catalog/contract";
import {
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import { confirmProjectEnergyProfileV2 } from "@/modules/energy/service";
import { testPool } from "../setup/test-db";

// F4.1 v2-Reservierung: Confirm + Reserve mit Batterie-Provenienz, v2-Tupel,
// KEIN pg-boss-Dispatch (v2-Queue folgt mit dem Execute-Epic).

const NOW = new Date("2026-08-29T12:00:00.000Z");

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

function sha256Bytes(value: unknown): Buffer {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest();
}

function provenance(kind: "technical" | "purchase" | "sales") {
  return {
    sourceKind: kind === "technical" ? "manufacturer_datasheet" as const
      : kind === "purchase" ? "supplier_price_list" as const
        : "workspace_pricing" as const,
    reference: `m111d-${kind}-synthetic`,
    observedOn: "2026-08-29",
    rightsBasis: kind === "technical" ? "manufacturer_published" as const
      : kind === "purchase" ? "supplier_authorized" as const
        : "workspace_owned" as const,
    sourceDocumentSha256: null,
  };
}

function component(
  workspaceId: string,
  input: {
    componentId: string;
    internalSku: string;
    componentType: "module" | "battery" | "inverter";
    technicalData: Record<string, unknown>;
  },
): CatalogComponentRevisionV1 {
  return sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId,
      componentId: input.componentId,
      revision: 1,
      internalSku: input.internalSku,
      componentType: input.componentType,
    },
    presentation: {
      displayName: `${input.componentType} M111d Test`,
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
      purchasePriceNetCents: 10_000,
      salesPriceNetCents: 15_000,
      purchaseProvenance: provenance("purchase"),
      salesProvenance: provenance("sales"),
    },
    technicalProvenance: provenance("technical"),
  });
}

const BATTERY_TECH = {
  schemaVersion: "battery.v1",
  nominalCapacityWh: 8_500,
  usableCapacityWh: 8_000,
  maxContinuousPowerWatts: 4_000,
  roundTripEfficiencyBasisPoints: 9_400,
  backupCapability: "known_supported",
};

const MODULE_TECH = {
  schemaVersion: "module.v1",
  nominalPowerWatts: 440,
};

type FixtureIds = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
  v1JobId: string;
  v1RevisionId: string;
  batteryId: string;
  inputShaHex: string;
  resultShaHex: string;
};

async function createBase(): Promise<FixtureIds> {
  const ids = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    v1JobId: randomUUID(),
    v1RevisionId: randomUUID(),
    batteryId: randomUUID(),
  };
  const profile = {
    ...GOLDEN_REQUEST.energyProfile,
    roofs: GOLDEN_REQUEST.energyProfile.roofs.map((roof) => ({
      ...roof,
      source: "operator_reviewed" as const,
    })),
  };
  const requirements = {
    schemaVersion: "project-requirements.rechner.v1",
    source: "wmee-rechner-v3",
    branch: "new_installation",
    requestedProducts: {
      targetStorageKwh: 10,
      wallbox: false,
      bidirectionalCharging: false,
      backupPower: false,
    },
  };
  const calculatorSnapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: NOW.toISOString(),
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  const inputSha = createHash("sha256").update("m111d-v1-input").digest();
  const resultSha = createHash("sha256").update("m111d-v1-revision").digest();
  const inputShaHex = inputSha.toString("hex");
  const resultShaHex = resultSha.toString("hex");
  const v1Result = {
    contractVersion: "planning-calculation.v1",
    inputSha256: inputSha.toString("hex"),
    resultSha256: resultSha.toString("hex"),
    quality: "server_reproduced_estimate",
    validationStatus: "not_f4_reference_validated",
    model: {
      id: "wmee-solar",
      version: "1.0.0",
      sourceRevision: "a".repeat(40),
    },
  };

  await withTenantOn(testPool, ids.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${ids.workspaceId}::uuid, ${`M1-11d v2reserve ${ids.projectId}`})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${ids.actorId}::uuid, ${`${ids.actorId}@v2reserve.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${ids.workspaceId}::uuid, ${ids.actorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${ids.workspaceId}::uuid, 'V2R Customer', 'Fixture', 'Contact',
        'v2r.customer@example.test', 'v2r.customer@example.test'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision
      ) values (
        ${ids.siteId}::uuid, ${ids.workspaceId}::uuid, ${ids.contactId}::uuid,
        'V2R Site', 'V2R-Weg 1, 10115 Berlin',
        decode(repeat('75', 32), 'hex'), 1, 'selected', 'V2R-Weg', '1',
        '10115', 'Berlin', 'DE', 52.52, 13.41, 'photon', 'house', false,
        1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${ids.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake_column.id, 'V2R Calculation', 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${ids.workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
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
        ${ids.receiptId}::uuid, ${ids.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('76', 32), 'hex'), 'v2r-fixture-key', ${NOW}, ${NOW}, ${NOW},
        'wmee-rechner-v3', ${"b".repeat(40)}, 'development', 'wmee-solar.v1',
        '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'fixture',
        'https://example.test/privacy', 'created', ${ids.contactId}::uuid,
        ${ids.siteId}::uuid, ${ids.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${ids.snapshotId}::uuid, ${ids.workspaceId}::uuid, ${ids.receiptId}::uuid,
        ${ids.projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', ${NOW},
        ${JSON.stringify(calculatorSnapshot)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${ids.requirementId}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${ids.snapshotId}::uuid,
        ${JSON.stringify(requirements)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${ids.profileId}::uuid, ${ids.workspaceId}::uuid, ${ids.siteId}::uuid, 1,
        'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotId}::uuid, ${ids.projectId}::uuid, 1,
        ${JSON.stringify(profile)}::jsonb,
        ${sha256Bytes(profile)}, null, null, null, null
      )
    `);
    // v1-Ankerjob direkt mit Input-Spalten (Guard verlangt exakte
    // Job-Uebereinstimmung der Revision); wird nach dem Revision-Insert
    // auf succeeded gesetzt, damit die v2-Reservierung konfliktfrei bleibt.
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version,
        state, attempt_count, next_attempt_at, created_by, created_at,
        lease_token, lease_expires_at, started_at,
        input_sha256, input_snapshot, provider_snapshot
      ) values (
        ${ids.v1JobId}::uuid, ${ids.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        ${sha256Bytes({ reservation: ids.v1JobId })},
        'pvgis-5.3-sarah3-2020.v1', 'planning-calculation.v1', 'wmee-solar',
        '1.0.0', ${"a".repeat(40)}, 'wmee-planning-defaults.v1',
        'running', 1, ${NOW}, ${ids.actorId}::uuid,
        ${new Date("2026-08-20T12:00:00.000Z")},
        ${randomUUID()}::uuid, ${new Date("2026-08-30T12:00:00.000Z")}, ${NOW},
        ${inputSha}, '{}'::jsonb, '{}'::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_calculation_revision (
        id, workspace_id, project_id, site_id, revision, job_id,
        address_revision, pin_confirmed_address_revision, profile_id,
        profile_revision, confirmed_profile_revision,
        confirmed_address_revision, requirement_id, requirement_revision,
        source_snapshot_id, contract_version, model_id, model_version,
        source_revision, defaults_version, quality, validation_status,
        input_sha256, result_sha256, input_snapshot, provider_snapshot,
        result, created_by
      ) values (
        ${ids.v1RevisionId}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectId}::uuid, ${ids.siteId}::uuid, 1, ${ids.v1JobId}::uuid,
        1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        'planning-calculation.v1', 'wmee-solar', '1.0.0', ${"a".repeat(40)},
        'wmee-planning-defaults.v1', 'server_reproduced_estimate',
        'not_f4_reference_validated', ${inputSha}, ${resultSha},
        '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(v1Result)}::jsonb,
        ${ids.actorId}::uuid
      )
    `);
    // v1-Ankerjob als abgeschlossen markieren, damit die v2-Reservierung
    // keinen konkurrierenden aktiven Job sieht (Guards bleiben aktiv).
    await tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded',
             lease_token = null,
             lease_expires_at = null,
             finished_at = ${NOW},
             result_revision_id = ${ids.v1RevisionId}::uuid,
             input_sha256 = ${inputSha},
             input_snapshot = '{}'::jsonb,
             provider_snapshot = '{}'::jsonb
       where workspace_id = ${ids.workspaceId}::uuid
         and id = ${ids.v1JobId}::uuid
    `);
  });
  return { ...ids, inputShaHex, resultShaHex };
}

function batteryProduct(workspaceId: string, componentId: string) {
  return component(workspaceId, {
    componentId,
    internalSku: "M111D-BAT-8K",
    componentType: "battery",
    technicalData: { ...BATTERY_TECH },
  });
}

function moduleProduct(workspaceId: string, componentId: string) {
  return component(workspaceId, {
    componentId,
    internalSku: "M111D-PV-440",
    componentType: "module",
    technicalData: { ...MODULE_TECH },
  });
}

function inverterProduct(workspaceId: string, componentId: string) {
  return component(workspaceId, {
    componentId,
    internalSku: "M111D-INV-8K",
    componentType: "inverter",
    technicalData: {
      schemaVersion: "inverter.v1",
      nominalAcPowerWatts: 8_000,
      phaseCount: 3,
      mpptTrackerCount: 2,
    },
  });
}

async function insertProduct(
  tx: TenantTx,
  workspaceId: string,
  actorId: string,
  snapshot: CatalogComponentRevisionV1,
): Promise<void> {
  await tx.execute(sql`
    insert into catalog_component (
      id, workspace_id, internal_sku, component_type, status,
      current_revision, created_by
    ) values (
      ${snapshot.identity.componentId}::uuid, ${workspaceId}::uuid,
      ${snapshot.identity.internalSku}, ${snapshot.identity.componentType},
      'draft', 0, ${actorId}::uuid
    )
  `);
  await tx.execute(sql`
    insert into catalog_component_revision (
      id, workspace_id, component_id, revision, component_type,
      schema_version, canonicalization_version, revision_snapshot,
      snapshot_sha256, created_by
    ) values (
      ${randomUUID()}::uuid, ${workspaceId}::uuid,
      ${snapshot.identity.componentId}::uuid, ${snapshot.identity.revision},
      ${snapshot.identity.componentType}, ${snapshot.schemaVersion},
      ${snapshot.canonicalizationVersion}, ${JSON.stringify(snapshot)}::jsonb,
      decode(${snapshot.snapshotSha256}, 'hex'), ${actorId}::uuid
    )
  `);
  await tx.execute(sql`
    update catalog_component
       set status = 'active', updated_at = now()
     where workspace_id = ${workspaceId}::uuid
       and id = ${snapshot.identity.componentId}::uuid
  `);
}

async function addResolution(
  ids: FixtureIds,
  options: { battery: boolean; storageWh: number },
): Promise<string> {
  const products = [
    moduleProduct(ids.workspaceId, randomUUID()),
    inverterProduct(ids.workspaceId, randomUUID()),
    ...(options.battery ? [batteryProduct(ids.workspaceId, ids.batteryId)] : []),
  ];
  const covers = (type: string): "storage_capacity" | "pv_generation" =>
    type === "battery" ? "storage_capacity" : "pv_generation";
  const resolution = sealProjectCatalogResolution({
    schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    revision: 1,
    bindings: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      siteId: ids.siteId,
      requirementId: ids.requirementId,
      requirementRevision: 1,
      calculationRevisionId: ids.v1RevisionId,
      calculationRevision: 1,
      calculationInputSha256: ids.inputShaHex,
      calculationResultSha256: ids.resultShaHex,
      calculationQuality: "server_reproduced_estimate",
      calculationValidationStatus: "not_f4_reference_validated",
    },
    lines: products.map((product, index): ProjectCatalogResolutionLineV1 => ({
      lineId: randomUUID(),
      position: index + 1,
      quantity: 1,
      coversRequirementKeys: [covers(product.identity.componentType)],
      catalogComponentId: product.identity.componentId,
      catalogComponentRevision: product.identity.revision,
      componentSnapshotSha256: product.snapshotSha256,
      componentSnapshot: product,
    })),
    requested: {
      branch: "new_installation",
      // Exakt 1 Modul à 440 W, damit kein pv_capacity_differs-Ack noetig ist.
      pvPeakPowerWatts: 440,
      storageCapacityWh: options.storageWh,
      wallbox: false,
      backupPower: false,
      bidirectionalCharging: false,
    },
    acknowledgements: ["cross_component_compatibility_unverified"],
    confirmedBy: ids.actorId,
    confirmedAt: "2026-08-29T18:00:00.000Z",
  });
  const resolutionId = randomUUID();
  await withTenantOn(testPool, ids.workspaceId, async (tx) => {
    for (const product of products) {
      await insertProduct(tx, ids.workspaceId, ids.actorId, product);
    }
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
        ${resolutionId}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectId}::uuid, ${ids.siteId}::uuid, ${resolution.revision},
        ${ids.requirementId}::uuid, 1,
        ${ids.v1RevisionId}::uuid, 1,
        decode(${resolution.bindings.calculationInputSha256}, 'hex'),
        decode(${resolution.bindings.calculationResultSha256}, 'hex'),
        'server_reproduced_estimate', 'not_f4_reference_validated',
        ${resolution.schemaVersion}, ${resolution.canonicalizationVersion},
        ${JSON.stringify(resolution)}::jsonb,
        decode(${resolution.resolutionSha256}, 'hex'),
        ${ids.actorId}::uuid, ${resolution.confirmedAt}::timestamptz
      )
    `);
    for (const line of resolution.lines) {
      await tx.execute(sql`
        insert into project_catalog_resolution_line (
          id, workspace_id, resolution_id, project_id, position, quantity,
          catalog_component_id, catalog_component_revision,
          component_snapshot_sha256
        ) values (
          ${line.lineId}::uuid, ${ids.workspaceId}::uuid,
          ${resolutionId}::uuid, ${ids.projectId}::uuid,
          ${line.position}, ${line.quantity},
          ${line.catalogComponentId}::uuid, ${line.catalogComponentRevision},
          decode(${line.componentSnapshotSha256}, 'hex')
        )
      `);
    }
    // KEIN manuelles Status-Update: Der deferred Validator
    // (validate_project_catalog_resolution_snapshot) setzt resolved beim
    // Commit selbst, wenn die Bindungen stimmen — sonst pending.
  });
  return resolutionId;
}

async function reserve(ids: FixtureIds) {
  return withAuthorizedTenantOn(testPool, ids.actorId, ids.workspaceId, (tx, ctx: ServiceCtx) =>
    confirmProjectEnergyProfileV2(tx, ctx, {
      projectId: ids.projectId,
      expectedAddressRevision: 1,
      expectedProfileRevision: 1,
    }));
}

async function readJob(ids: FixtureIds, jobId: string) {
  return withTenantOn(testPool, ids.workspaceId, async (tx) => {
    const job = await tx.execute<{
      state: string;
      contract_version: string;
      provider_recipe_version: string;
      model_id: string;
      model_version: string;
      source_revision: string;
      defaults_version: string;
      preparation_snapshot: unknown;
      input_sha256: string | null;
      [key: string]: unknown;
    }>(sql`
      select state, contract_version, provider_recipe_version, model_id,
             model_version, source_revision, defaults_version,
             preparation_snapshot,
             encode(input_sha256, 'hex') as input_sha256
      from project_calculation_job
      where workspace_id = ${ids.workspaceId}::uuid and id = ${jobId}::uuid
    `);
    const profile = await tx.execute<{ confirmed: number | null }>(sql`
      select confirmed_profile_revision as confirmed
      from site_energy_profile
      where workspace_id = ${ids.workspaceId}::uuid and id = ${ids.profileId}::uuid
    `);
    const events = await tx.execute<{ event_type: string; payload: unknown }>(sql`
      select event_type, payload from domain_events
      where workspace_id = ${ids.workspaceId}::uuid
        and event_type in ('site.energy_profile_confirmed', 'project.calculation_reserved')
    `);
    return {
      job: job.rows[0],
      profileConfirmed: profile.rows[0]?.confirmed,
      events: [...events.rows],
    };
  });
}

describe("F4.1 v2 reservation", () => {
  it("reserviert mit Batterie-Provenienz, bestaetigt und replayt idempotent", async () => {
    const ids = await createBase();
    await addResolution(ids, { battery: true, storageWh: 8_000 });

    const first = await reserve(ids);
    expect(first.replayed).toBe(false);
    expect(first.profileId).toBe(ids.profileId);
    expect(first.reservationKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.battery).toEqual({ componentId: ids.batteryId, revision: 1 });

    const seen = await readJob(ids, first.jobId);
    expect(seen.job?.state).toBe("queued");
    expect(seen.job).toMatchObject({
      contract_version: "planning-calculation.v2",
      provider_recipe_version: "pvgis-5.3-sarah3-2020-quarter-hour.v2",
      model_id: "wmee-solar",
      model_version: CALCULATION_V2_MODEL_VERSION,
      source_revision: CALCULATION_V2_SOURCE_REVISION,
      defaults_version: "wmee-planning-defaults.v2",
    });
    expect(seen.job?.input_sha256).toBeNull();
    const preparation = seen.job?.preparation_snapshot as {
      schemaVersion: string;
      storage: { capacityKwh: number; socMaxKwh: number };
    };
    expect(preparation.schemaVersion).toBe("project-calculation-preparation.v2");
    expect(preparation.storage).toMatchObject({ capacityKwh: 8.5, socMaxKwh: 8 });
    expect(seen.profileConfirmed).toBe(1);
    const reserved = seen.events.find((event) => event.event_type === "project.calculation_reserved");
    expect((reserved?.payload as { contractVersion?: string })?.contractVersion)
      .toBe("planning-calculation.v2");
    expect((reserved?.payload as { battery?: unknown })?.battery)
      .toEqual({ componentId: ids.batteryId, revision: 1 });

    const second = await reserve(ids);
    expect(second.jobId).toBe(first.jobId);
    expect(second.reservationKey).toBe(first.reservationKey);
    expect(second.replayed).toBe(true);
  });

  it("verweigert ohne bestaetigte Aufloesung (cannot_fulfil)", async () => {
    const ids = await createBase();
    await expect(reserve(ids)).rejects.toMatchObject({ code: "cannot_fulfil" });
  });

  it("verweigert bei Requirement-Drift (cannot_fulfil)", async () => {
    const ids = await createBase();
    await addResolution(ids, { battery: true, storageWh: 8_000 });
    await withTenantOn(testPool, ids.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project_requirement (
          id, workspace_id, project_id, revision, schema_version,
          source_snapshot_id, requirements
        ) values (
          ${randomUUID()}::uuid, ${ids.workspaceId}::uuid,
          ${ids.projectId}::uuid, 2, 'project-requirements.rechner.v1',
          ${ids.snapshotId}::uuid,
          (select requirements from project_requirement
            where workspace_id = ${ids.workspaceId}::uuid
              and id = ${ids.requirementId}::uuid and revision = 1)
        )
      `);
      // Status manuell heilen, damit der Test die Bindungspruefung
      // (Aufloesung zeigt auf Rev 1, aktuell ist Rev 2) isoliert und
      // nicht den Status-Pfad trifft.
      await tx.execute(sql`
        update project set catalog_resolution_status = 'resolved'
        where workspace_id = ${ids.workspaceId}::uuid
          and id = ${ids.projectId}::uuid
      `);
    });
    await expect(reserve(ids)).rejects.toMatchObject({ code: "cannot_fulfil" });
  });

  it("verweigert Speicherbedarf ohne Batterie-Line (cannot_fulfil)", async () => {
    const ids = await createBase();
    await addResolution(ids, { battery: false, storageWh: 0 });
    await expect(reserve(ids)).rejects.toMatchObject({ code: "cannot_fulfil" });
  });
});
