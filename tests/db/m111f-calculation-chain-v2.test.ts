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
import type {
  PlanningCalculationRequestV2,
  PlanningCalculationResultV2,
} from "@/lib/integrations/calculation/contract-v2";
import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import { fetchPlanningSeriesV2 } from "@/lib/integrations/calculation/fetch-compose-v2";
import { parsePVcalcSnapshot } from "@/lib/integrations/calculation/pvcalc-v2";
import { buildPlanningCalculationInputV2 } from "@/lib/integrations/calculation/prepare-v2";
import type {
  ParsedSeriescalcSnapshot,
  SeriesHour,
} from "@/lib/integrations/calculation/provider-v2";
import { runPlanningCalculationV2 } from "@/lib/integrations/calculation/run-v2";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_RESULT_CONTRACT_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  finalizeProjectCalculationSuccessV2,
  persistProjectCalculationInputV2,
} from "@/modules/energy/calculation-service";
import {
  confirmProjectEnergyProfileV2,
  getProjectEnergyContext,
} from "@/modules/energy/service";
import { createCalculationExecuteV2Handler } from "@/worker/calculation-v2";
import { testPool } from "../setup/test-db";

// F4.1 v2-Kette durchgaengig: Eingabe (Reservierung mit
// Batterie-Provenienz) -> Fetch (echte Fixture-Bytes: Berlin 2020,
// horizontal + tilted-30-Sued + PVcalc-Referenz + DEM-Horizont; nur
// Transport gefakt, keine Netzabrufe; Subhour via Hay-Geometriegewichte)
// -> Build -> Run -> Persist -> sichtbarer Context (currentV2 mit
// provider_estimate-Warnung). Keine reinen Bausteine:
// Jede Stufe nutzt die Produktionsfunktion.

const NOW = new Date("2026-08-29T12:00:00.000Z");

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

// Fixture-Geometrie: exakt die verifizierten Berlin-Abrufe (tilt 30,
// Sued). Produktions-Geometrie kaeme aus Vermessung (F3); hier belegt
// das Dach die Kette bis zur echten PVGIS-Referenz.
const TILT_DEG = 30;
const AZIMUTH_DEG = 0;
const EXPECTED_KWP = 10.4;

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
    reference: `m111f-${kind}-synthetic`,
    observedOn: "2026-08-29",
    rightsBasis: kind === "technical" ? "manufacturer_published" as const
      : kind === "purchase" ? "supplier_authorized" as const
        : "workspace_owned" as const,
    sourceDocumentSha256: null,
  };
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
      displayName: `${input.componentType} M111f Test`,
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
  jobV1Id: string;
  revisionV1Id: string;
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
    jobV1Id: randomUUID(),
    revisionV1Id: randomUUID(),
    batteryId: randomUUID(),
  };
  const profile = {
    ...GOLDEN_REQUEST.energyProfile,
    roofs: GOLDEN_REQUEST.energyProfile.roofs.map((roof) => ({
      ...roof,
      tiltDeg: TILT_DEG,
      azimuthDeg: AZIMUTH_DEG,
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
  const inputSha = createHash("sha256").update("m111f-v1-input").digest();
  const inputShaHex = inputSha.toString("hex");
  const resultShaHex = createHash("sha256").update("m111f-v1-revision").digest("hex");

  await withTenantOn(testPool, ids.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${ids.workspaceId}::uuid, ${`M1-11f v2-chain ${ids.projectId}`})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${ids.actorId}::uuid, ${`${ids.actorId}@chain-v2.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${ids.workspaceId}::uuid, ${ids.actorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${ids.workspaceId}::uuid, 'V2 Chain', 'Chain', 'Fixture',
        'v2.chain@example.test', 'v2.chain@example.test'
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
        'V2 Chain Site', 'Kettenweg 1, 10115 Berlin',
        decode(repeat('79', 32), 'hex'), 1, 'selected', 'Kettenweg', '1',
        '10115', 'Berlin', 'DE', 52.52, 13.41, 'photon', 'house', false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${ids.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake_column.id, 'V2 Chain', 'fixture'
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
        decode(repeat('7a', 32), 'hex'), 'v2-chain-key', ${NOW}, ${NOW}, ${NOW},
        'wmee-rechner-v3', ${CALCULATION_V2_SOURCE_REVISION}, 'development', 'wmee-solar.v1',
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
        ${JSON.stringify({
          schemaVersion: "wmee-solar-snapshot.v1",
          calculatedAt: NOW.toISOString(),
          branch: "new_installation",
          questionnaireVariant: "short",
          resultIntegrity: "client_reported_unverified",
          inputs: {},
          provenance: { investment: "market_estimate" },
          result: { mode: "new_installation" },
        })}::jsonb
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
        ${ids.jobV1Id}::uuid, ${ids.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        decode(repeat('7b', 32), 'hex'), 'pvgis-hourly.v1',
        'planning-calculation.v1', 'wmee-solar', '1.0.0',
        ${"a".repeat(40)}, 'wmee-planning-defaults.v1',
        'running', 1, ${NOW}, ${ids.actorId}::uuid,
        ${new Date("2026-08-20T12:00:00.000Z")},
        ${randomUUID()}::uuid, ${new Date("2026-08-30T12:00:00.000Z")}, ${NOW},
        ${inputSha}, '{}'::jsonb, '{}'::jsonb
      )
    `);
    const resultSha = createHash("sha256").update("m111f-v1-revision").digest();
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
        ${ids.revisionV1Id}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectId}::uuid, ${ids.siteId}::uuid, 1, ${ids.jobV1Id}::uuid,
        1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        'planning-calculation.v1', 'wmee-solar', '1.0.0', ${"a".repeat(40)},
        'wmee-planning-defaults.v1', 'server_reproduced_estimate',
        'not_f4_reference_validated', ${inputSha}, ${resultSha},
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        ${ids.actorId}::uuid
      )
    `);
    await tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded',
             lease_token = null,
             lease_expires_at = null,
             finished_at = ${NOW},
             result_revision_id = ${ids.revisionV1Id}::uuid,
             input_sha256 = ${inputSha},
             input_snapshot = '{}'::jsonb,
             provider_snapshot = '{}'::jsonb
       where workspace_id = ${ids.workspaceId}::uuid
         and id = ${ids.jobV1Id}::uuid
    `);
  });

  return { ...ids, inputShaHex, resultShaHex };
}

function moduleProduct(workspaceId: string, componentId: string) {
  return component(workspaceId, {
    componentId,
    internalSku: "M111F-PV-440",
    componentType: "module",
    technicalData: { ...MODULE_TECH },
  });
}

function inverterProduct(workspaceId: string, componentId: string) {
  return component(workspaceId, {
    componentId,
    internalSku: "M111F-INV-8K",
    componentType: "inverter",
    technicalData: {
      schemaVersion: "inverter.v1",
      nominalAcPowerWatts: 8_000,
      phaseCount: 3,
      mpptTrackerCount: 2,
    },
  });
}

function batteryProduct(workspaceId: string, componentId: string) {
  return component(workspaceId, {
    componentId,
    internalSku: "M111F-BAT-8K",
    componentType: "battery",
    technicalData: { ...BATTERY_TECH },
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

async function addResolution(ids: FixtureIds): Promise<string> {
  const products = [
    moduleProduct(ids.workspaceId, randomUUID()),
    inverterProduct(ids.workspaceId, randomUUID()),
    batteryProduct(ids.workspaceId, ids.batteryId),
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
      calculationRevisionId: ids.revisionV1Id,
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
      pvPeakPowerWatts: 440,
      storageCapacityWh: 8000,
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
        ${ids.revisionV1Id}::uuid, 1,
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
  });
  return resolutionId;
}

type TiltedEnvelope = {
  hours: Array<{
    t: string;
    gb: number;
    gd: number;
    gr: number;
    hsun: number;
    t2m: number;
    int: number;
    p: number;
  }>;
  horizon: { heights48: number[] };
};

function tiltedEnvelope(): TiltedEnvelope {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "tests/fixtures/f401/pvgis-tilted30-south-2020-berlin.json"),
    "utf8",
  )) as TiltedEnvelope;
}

function berlinAnnualKwhPerKwp(): number {
  return parsePVcalcSnapshot(readFileSync(
    resolve(process.cwd(), "tests/fixtures/f401/pvcalc-30s-berlin-2020.json"),
    "utf8",
  )).annualReferenceKwhPerKwp;
}

type HorizontalEnvelope = {
  hours: Array<{
    t: string;
    gb: number;
    gd: number;
    gr: number;
    hsun: number;
    t2m: number;
    int: number;
  }>;
};

function horizontalEnvelope(): HorizontalEnvelope {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "tests/fixtures/f401/pvgis-horizontal-2020-berlin-52-52-13-41.json"),
    "utf8",
  )) as HorizontalEnvelope;
}

function fixtureTransport(envelope: TiltedEnvelope) {
  const horizontal = horizontalEnvelope();
  return {
    async fetchHorizon() {
      return {
        rawSha256: "0".repeat(64),
        heights: [...envelope.horizon.heights48],
        horizonDb: "DEM-calculated",
      };
    },
    async fetchHorizontal(): Promise<ParsedSeriescalcSnapshot> {
      const hours: SeriesHour[] = horizontal.hours.map((hour) => ({
        time: hour.t,
        gb: hour.gb,
        gd: hour.gd,
        gr: hour.gr,
        hSun: hour.hsun,
        t2m: hour.t2m,
        ws10m: 0,
        int: hour.int as 0 | 1,
        p: null,
      }));
      return {
        recipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
        rawSha256: "2".repeat(64),
        inputsMirror: {},
        site: { latitude: 52.52, longitude: 13.41, elevation: 34 },
        meteo: {
          radiationDb: "PVGIS-SARAH3",
          meteoDb: "SARAH3",
          yearMin: 2020,
          yearMax: 2020,
          useHorizon: false,
        },
        hours,
      };
    },
    async fetchSeries(): Promise<ParsedSeriescalcSnapshot> {
      const hours: SeriesHour[] = envelope.hours.map((hour) => ({
        time: hour.t,
        gb: hour.gb,
        gd: hour.gd,
        gr: hour.gr,
        hSun: hour.hsun,
        t2m: hour.t2m,
        ws10m: 0,
        int: hour.int as 0 | 1,
        p: hour.p,
      }));
      return {
        recipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
        rawSha256: "1".repeat(64),
        inputsMirror: {},
        site: { latitude: 52.52, longitude: 13.41, elevation: 34 },
        meteo: {
          radiationDb: "PVGIS-SARAH3",
          meteoDb: "SARAH3",
          yearMin: 2020,
          yearMax: 2020,
          useHorizon: true,
        },
        hours,
      };
    },
    async fetchAnnual() {
      return parsePVcalcSnapshot(readFileSync(
        resolve(process.cwd(), "tests/fixtures/f401/pvcalc-30s-berlin-2020.json"),
        "utf8",
      ));
    },
  };
}

async function reserve(
  ids: FixtureIds,
): Promise<{ jobId: string; replayed: boolean }> {
  return withAuthorizedTenantOn(
    testPool,
    ids.actorId,
    ids.workspaceId,
    (tx, ctx: ServiceCtx) => confirmProjectEnergyProfileV2(tx, ctx, {
      projectId: ids.projectId,
      expectedAddressRevision: 1,
      expectedProfileRevision: 1,
    }),
  );
}

describe("F4.1 v2 chain end to end", () => {
  it("fuehrt Eingabe->Fetch->Run->Persist bis zum sichtbaren currentV2", async () => {
    const ids = await createBase();
    await addResolution(ids);
    const reserved = await reserve(ids);
    expect(reserved.replayed).toBe(false);

    const transport = fixtureTransport(tiltedEnvelope());
    const database = {
      claim: (input: { workspaceId: string; jobId: string; leaseToken: string }) =>
        withTenantOn(testPool, input.workspaceId, (tx: TenantTx) =>
          claimProjectCalculationJob(tx, input)),
      persistInput: (input: {
        workspaceId: string;
        jobId: string;
        leaseToken: string;
        attemptCount: number;
        inputSnapshot: PlanningCalculationRequestV2;
        pvKwh: unknown;
        loadKwh: unknown;
        providerEstimate: boolean;
      }) => withTenantOn(testPool, input.workspaceId, (tx: TenantTx) =>
        persistProjectCalculationInputV2(tx, input)),
      finalizeSuccess: (input: {
        workspaceId: string;
        jobId: string;
        leaseToken: string;
        attemptCount: number;
        result: PlanningCalculationResultV2;
      }) => withTenantOn(testPool, input.workspaceId, (tx: TenantTx) =>
        finalizeProjectCalculationSuccessV2(tx, input)),
      finalizeFailure: (input: {
        workspaceId: string;
        jobId: string;
        leaseToken: string;
        attemptCount: number;
        errorCode: string;
        retryable: boolean;
        retryAfterMs: number | undefined;
      }) => withTenantOn(testPool, input.workspaceId, (tx: TenantTx) =>
        finalizeProjectCalculationFailure(tx, input)),
    };
    const handler = createCalculationExecuteV2Handler({
      database,
      provider: {
        fetch: async (request) => {
          const composed = await fetchPlanningSeriesV2({ request, transport });
          return {
            pvKwh: composed.pvKwh,
            loadKwh: composed.loadKwh,
            providerEstimate: composed.providerEstimate,
            existingPvKwh: composed.existingPvKwh,
          };
        },
      },
      buildInput: buildPlanningCalculationInputV2,
      engine: {
        calculate: async (input) => runPlanningCalculationV2({
          request: input.request,
          pvKwh: input.pvKwh,
          loadKwh: input.loadKwh,
          providerEstimate: input.providerEstimate,
        }),
      },
      createLeaseToken: randomUUID,
    });
    await handler([{
      data: {
        schemaVersion: "project-calculation-dispatch.v2",
        workspaceId: ids.workspaceId,
        jobId: reserved.jobId,
      },
    }]);

    const expectedAnnualKwh = berlinAnnualKwhPerKwp() * EXPECTED_KWP;
    const context = await withAuthorizedTenantOn(
      testPool,
      ids.actorId,
      ids.workspaceId,
      (tx, ctx: ServiceCtx) => getProjectEnergyContext(tx, ctx, ids.projectId),
    );
    expect(context?.calculation.status).toBe("currentV2");
    if (context?.calculation.status !== "currentV2") throw new Error("kein currentV2");
    const result = context.calculation.resultV2;
    expect(result.value.contractVersion).toBe(CALCULATION_V2_RESULT_CONTRACT_VERSION);
    expect(result.value.annual.generationKwh).toBeCloseTo(expectedAnnualKwh, 0);
    expect(result.value.warnings).toContainEqual(
      expect.objectContaining({ code: "provider_estimate" }),
    );
    expect(result.sources.contractVersion).toBe(CALCULATION_V2_CONTRACT_VERSION);
    expect(result.binding.profile).toEqual({ id: ids.profileId, revision: 1 });
    const monthlyGeneration = neumaierSum(
      result.value.monthly.map((month) => month.generationKwh),
    );
    expect(monthlyGeneration).toBeCloseTo(result.value.annual.generationKwh, 6);
    // Persistierte Eingabe-Serien tragen exakt die fetch-komponierte Energie.
    const persisted = await withTenantOn(testPool, ids.workspaceId, (tx: TenantTx) =>
      tx.execute<{ provider_snapshot: unknown }>(sql`
        select provider_snapshot
        from project_calculation_job
        where workspace_id = ${ids.workspaceId}::uuid and id = ${reserved.jobId}::uuid
      `));
    const bundle = persisted.rows[0]?.provider_snapshot as {
      pvKwh: number[];
      loadKwh: number[];
      providerEstimate: boolean;
    };
    expect(bundle.providerEstimate).toBe(true);
    expect(bundle.pvKwh).toHaveLength(35040);
    expect(neumaierSum(bundle.pvKwh)).toBeCloseTo(expectedAnnualKwh, 0);
    expect(neumaierSum(bundle.loadKwh)).toBeCloseTo(6600, 6);
  });
});
