import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { withAuthorizedTenantOn, withTenantOn } from "../../lib/db/tenant";
import type { TenantTx } from "../../lib/db/types";
import type { ServiceCtx } from "../../lib/permissions";
import {
  canonicalizeCalculationJson,
  type PlanningCalculationRequestV1,
} from "../../lib/integrations/calculation/contract";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
  type CatalogComponentRevisionV1,
  type ProjectCatalogResolutionLineV1,
} from "../../lib/integrations/catalog/contract";
import type {
  PlanningCalculationRequestV2,
  PlanningCalculationResultV2,
} from "../../lib/integrations/calculation/contract-v2";
import { fetchPlanningSeriesV2 } from "../../lib/integrations/calculation/fetch-compose-v2";
import { parsePVcalcSnapshot } from "../../lib/integrations/calculation/pvcalc-v2";
import { buildPlanningCalculationInputV2 } from "../../lib/integrations/calculation/prepare-v2";
import type {
  ParsedSeriescalcSnapshot,
  SeriesHour,
} from "../../lib/integrations/calculation/provider-v2";
import { runPlanningCalculationV2 } from "../../lib/integrations/calculation/run-v2";
import {
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "../../lib/integrations/calculation/versions-v2";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  finalizeProjectCalculationSuccessV2,
  persistProjectCalculationInputV2,
} from "../../modules/energy/calculation-service";
import {
  confirmProjectEnergyProfileV2,
  getProjectEnergyContext,
} from "../../modules/energy/service";
import { createCalculationExecuteV2Handler } from "../../worker/calculation-v2";

// M1-11g-Fixture: isolierter Workspace + v2-Kettenbausteine (Seeding,
// Reservierung, Handler-Lauf mit Fixture-Bytes). Keine Testregistrierung:
// Specs importieren Helfer von hier (Muster m2-01/m2-04-Fixtures).

export const NOW = new Date("2026-08-29T12:00:00.000Z");
export const TILT_DEG = 30;
export const AZIMUTH_DEG = 0;
export type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
};

export function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof parsed[key] !== "string" || parsed[key] === "") {
      throw new Error("Der private M1-05-E2E-State ist unvollständig.");
    }
  }
  return parsed as E2EState;
}
export const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(process.cwd(), "contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

export function sha256Bytes(value: unknown): Buffer {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest();
}

export type SeedIds = {
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
};

export async function poolOne<T>(callback: (pool: import("pg").Pool) => Promise<T>): Promise<T> {
  const pool = createDrainTrackedPool({ connectionString: state().databaseUrl, max: 1 });
  try {
    return await callback(pool);
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

export async function resolveEditorId(): Promise<string> {
  return poolOne(async (pool) => {
    const result = await pool.query(
      "select id from user_identity where lower(email) = lower($1)",
      [state().editorEmail],
    );
    const id = (result.rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error("E2E-Editoridentitaet fehlt.");
    return id;
  });
}

export async function seedIsolatedWorkspace(actorId: string): Promise<string> {
  const workspaceId = randomUUID();
  await poolOne(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true), pg_catalog.set_config('app.actor_id', '', true)",
        [workspaceId],
      );
      await client.query(
        "insert into public.workspace (id, name) values ($1::uuid, 'M1-11g isolierter v2-Workspace')",
        [workspaceId],
      );
      await client.query(
        `insert into public.membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)`,
        [workspaceId, actorId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
  return workspaceId;
}

export async function seedProjectGraph(
  ids: SeedIds,
  options: {
    branch?: "new_installation" | "existing_installation";
    // F4.2: belegtes Custom-Lastprofil (Monats-Option + Monatswerte).
    customLoadProfile?: {
      monthlyKwh: number[];
      weekdayHourlyKwh: number[] | null;
      weekendHourlyKwh: number[] | null;
    };
    // F4.5b: belegte Investition (EUR netto) im Verbrauchsprofil.
    investmentEuro?: number;
    // F4.2c: Lastgang-CSV (8760 Stundenwerte je kWh, customer_csv.v1).
    csvKwhPerHour?: number;
  } = {},
): Promise<void> {
  const branch = options.branch ?? "new_installation";
  const profile = {
    ...GOLDEN_REQUEST.energyProfile,
    roofs: GOLDEN_REQUEST.energyProfile.roofs.map((roof) => ({
      ...roof,
      tiltDeg: TILT_DEG,
      azimuthDeg: AZIMUTH_DEG,
      source: "operator_reviewed" as const,
    })),
    // Bestand-Branch: belegte Anlage (8 kWp, Inbetriebnahme 2015),
    // Speicher bekannt abwesend -> Baseline speicherlos.
    ...(branch === "existing_installation"
      ? {
        existingAssets: {
          ...GOLDEN_REQUEST.energyProfile.existingAssets,
          pv: {
            status: "known_present" as const,
            source: "rechner_branch" as const,
            peakPowerKwp: 8,
            commissioningYear: 2015,
          },
        },
      }
      : {}),
    // F4.2: Monatsprofil-Option mit belegten Monatswerten.
    ...(options.customLoadProfile !== undefined
      ? {
        consumption: {
          ...GOLDEN_REQUEST.energyProfile.consumption,
          loadProfile: {
            status: "known" as const,
            value: "customer_monthly_hourly.v1",
            source: "customer_input" as const,
          },
          customLoadProfile: {
            status: "known" as const,
            value: options.customLoadProfile,
            source: "customer_input" as const,
          },
        },
      }
      : {}),
    // F4.5b: Investition als bekanntes Profilfeld (economics-Aufloesung).
    ...(options.investmentEuro !== undefined
      ? {
        consumption: {
          ...GOLDEN_REQUEST.energyProfile.consumption,
          ...(options.customLoadProfile !== undefined
            ? {
              loadProfile: {
                status: "known" as const,
                value: "customer_monthly_hourly.v1",
                source: "customer_input" as const,
              },
              customLoadProfile: {
                status: "known" as const,
                value: options.customLoadProfile,
                source: "customer_input" as const,
              },
            }
            : {}),
          investmentEuro: {
            status: "known" as const,
            value: options.investmentEuro,
            source: "operator_reviewed" as const,
          },
        },
      }
      : {}),
    // F4.2c: CSV-Reihe als bekanntes Profilfeld (Compose-Basis).
    ...(options.csvKwhPerHour !== undefined
      ? {
        consumption: {
          ...GOLDEN_REQUEST.energyProfile.consumption,
          householdKwhPerYear: {
            status: "unknown" as const,
            value: null,
            source: "not_collected" as const,
          },
          loadProfile: {
            status: "known" as const,
            value: "customer_csv.v1",
            source: "operator_reviewed" as const,
          },
          customCsvKwh: {
            status: "known" as const,
            value: new Array(8_760).fill(options.csvKwhPerHour),
            source: "operator_reviewed" as const,
          },
          ...(options.investmentEuro !== undefined
            ? {
              investmentEuro: {
                status: "known" as const,
                value: options.investmentEuro,
                source: "operator_reviewed" as const,
              },
            }
            : {}),
        },
      }
      : {}),
  };
  await poolOne(async (pool) => withTenantOn(pool, ids.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${ids.workspaceId}::uuid, 'V2 UI', 'V2', 'Ui',
        'v2.ui@example.test', 'v2.ui@example.test'
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
        'V2 UI Site', 'Sichtweg 2, 10115 Berlin',
        decode(repeat('79', 32), 'hex'), 1, 'selected', 'Sichtweg', '2',
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
             board.id, intake_column.id, 'V2 UI', 'fixture'
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
        decode(repeat('7a', 32), 'hex'), 'v2-ui-key', ${NOW}, ${NOW}, ${NOW},
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
          branch,
          questionnaireVariant: "short",
          resultIntegrity: "client_reported_unverified",
          inputs: {},
          provenance: { investment: "market_estimate" },
          result: { mode: branch },
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
        ${JSON.stringify({
          schemaVersion: "project-requirements.rechner.v1",
          source: "wmee-rechner-v3",
          branch,
          requestedProducts: {
            targetStorageKwh: 10,
            wallbox: false,
            bidirectionalCharging: false,
            backupPower: false,
          },
        })}::jsonb
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
    const inputSha = createHash("sha256").update("m111g-v1-input").digest();
    const resultSha = createHash("sha256").update("m111g-v1-revision").digest();
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
  }));
}

export function provenance(kind: "technical" | "purchase" | "sales") {
  return {
    sourceKind: kind === "technical" ? "manufacturer_datasheet" as const
      : kind === "purchase" ? "supplier_price_list" as const
        : "workspace_pricing" as const,
    reference: `m111g-${kind}-synthetic`,
    observedOn: "2026-08-29",
    rightsBasis: kind === "technical" ? "manufacturer_published" as const
      : kind === "purchase" ? "supplier_authorized" as const
        : "workspace_owned" as const,
    sourceDocumentSha256: null,
  };
}

export function component(
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
      displayName: `${input.componentType} M111g Test`,
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

export async function addResolution(ids: SeedIds, inputShaHex: string, resultShaHex: string): Promise<void> {
  const products = [
    component(ids.workspaceId, {
      componentId: randomUUID(),
      internalSku: "M111G-PV-440",
      componentType: "module",
      technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 440 },
    }),
    component(ids.workspaceId, {
      componentId: randomUUID(),
      internalSku: "M111G-INV-8K",
      componentType: "inverter",
      technicalData: {
        schemaVersion: "inverter.v1",
        nominalAcPowerWatts: 8_000,
        phaseCount: 3,
        mpptTrackerCount: 2,
      },
    }),
    component(ids.workspaceId, {
      componentId: ids.batteryId,
      internalSku: "M111G-BAT-8K",
      componentType: "battery",
      technicalData: {
        schemaVersion: "battery.v1",
        nominalCapacityWh: 8_500,
        usableCapacityWh: 8_000,
        maxContinuousPowerWatts: 4_000,
        roundTripEfficiencyBasisPoints: 9_400,
        backupCapability: "known_supported",
      },
    }),
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
      calculationInputSha256: inputShaHex,
      calculationResultSha256: resultShaHex,
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
  await poolOne(async (pool) => withTenantOn(pool, ids.workspaceId, async (tx) => {
    for (const product of products) {
      await tx.execute(sql`
        insert into catalog_component (
          id, workspace_id, internal_sku, component_type, status,
          current_revision, created_by
        ) values (
          ${product.identity.componentId}::uuid, ${ids.workspaceId}::uuid,
          ${product.identity.internalSku}, ${product.identity.componentType},
          'draft', 0, ${ids.actorId}::uuid
        )
      `);
      await tx.execute(sql`
        insert into catalog_component_revision (
          id, workspace_id, component_id, revision, component_type,
          schema_version, canonicalization_version, revision_snapshot,
          snapshot_sha256, created_by
        ) values (
          ${randomUUID()}::uuid, ${ids.workspaceId}::uuid,
          ${product.identity.componentId}::uuid, ${product.identity.revision},
          ${product.identity.componentType}, ${product.schemaVersion},
          ${product.canonicalizationVersion}, ${JSON.stringify(product)}::jsonb,
          decode(${product.snapshotSha256}, 'hex'), ${ids.actorId}::uuid
        )
      `);
      await tx.execute(sql`
        update catalog_component
           set status = 'active', updated_at = now()
         where workspace_id = ${ids.workspaceId}::uuid
           and id = ${product.identity.componentId}::uuid
      `);
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
        ${randomUUID()}::uuid, ${ids.workspaceId}::uuid,
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
          (select id from project_catalog_resolution
            where workspace_id = ${ids.workspaceId}::uuid
              and project_id = ${ids.projectId}::uuid),
          ${ids.projectId}::uuid,
          ${line.position}, ${line.quantity},
          ${line.catalogComponentId}::uuid, ${line.catalogComponentRevision},
          decode(${line.componentSnapshotSha256}, 'hex')
        )
      `);
    }
  }));
}

export type TiltedEnvelope = {
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

export type HorizontalEnvelope = {
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

export function tiltedEnvelope(): TiltedEnvelope {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "tests/fixtures/f401/pvgis-tilted30-south-2020-berlin.json"),
    "utf8",
  )) as TiltedEnvelope;
}

export function horizontalEnvelope(): HorizontalEnvelope {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), "tests/fixtures/f401/pvgis-horizontal-2020-berlin-52-52-13-41.json"),
    "utf8",
  )) as HorizontalEnvelope;
}

export function seriesSnapshot(
  envelope: { hours: Array<Record<string, number | string>> },
  tilted: boolean,
): ParsedSeriescalcSnapshot {
  const hours: SeriesHour[] = envelope.hours.map((hour) => ({
    time: hour.t as string,
    gb: hour.gb as number,
    gd: hour.gd as number,
    gr: hour.gr as number,
    hSun: hour.hsun as number,
    t2m: hour.t2m as number,
    ws10m: 0,
    int: hour.int as 0 | 1,
    p: tilted ? (hour.p as number) : null,
  }));
  return {
    recipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
    rawSha256: tilted ? "1".repeat(64) : "2".repeat(64),
    inputsMirror: {},
    site: { latitude: 52.52, longitude: 13.41, elevation: 34 },
    meteo: {
      radiationDb: "PVGIS-SARAH3",
      meteoDb: "SARAH3",
      yearMin: 2020,
      yearMax: 2020,
      useHorizon: tilted,
    },
    hours,
  };
}

export function fixtureTransport() {
  const tilted = tiltedEnvelope();
  const horizontal = horizontalEnvelope();
  return {
    async fetchHorizon() {
      return {
        rawSha256: "0".repeat(64),
        heights: [...tilted.horizon.heights48],
        horizonDb: "DEM-calculated",
      };
    },
    async fetchSeries() {
      return seriesSnapshot(tilted, true);
    },
    async fetchHorizontal() {
      return seriesSnapshot(horizontal, false);
    },
    async fetchAnnual() {
      return parsePVcalcSnapshot(readFileSync(
        resolve(process.cwd(), "tests/fixtures/f401/pvcalc-30s-berlin-2020.json"),
        "utf8",
      ));
    },
  };
}

export async function reserve(
  ids: SeedIds,
  expectedProfileRevision = 1,
): Promise<{ jobId: string }> {
  return poolOne(async (pool) => withAuthorizedTenantOn(
    pool,
    ids.actorId,
    ids.workspaceId,
    (tx, ctx: ServiceCtx) => confirmProjectEnergyProfileV2(tx, ctx, {
      projectId: ids.projectId,
      expectedAddressRevision: 1,
      expectedProfileRevision,
    }),
  ));
}

export async function runChain(
  ids: SeedIds,
  jobId: string,
  transport: ReturnType<typeof fixtureTransport> = fixtureTransport(),
): Promise<void> {
  await poolOne(async (pool) => {
    const database = {
      claim: (input: { workspaceId: string; jobId: string; leaseToken: string }) =>
        withTenantOn(pool, input.workspaceId, (tx: TenantTx) =>
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
      }) => withTenantOn(pool, input.workspaceId, (tx: TenantTx) =>
        persistProjectCalculationInputV2(tx, input)),
      finalizeSuccess: (input: {
        workspaceId: string;
        jobId: string;
        leaseToken: string;
        attemptCount: number;
        result: PlanningCalculationResultV2;
      }) => withTenantOn(pool, input.workspaceId, (tx: TenantTx) =>
        finalizeProjectCalculationSuccessV2(tx, input)),
      finalizeFailure: (input: {
        workspaceId: string;
        jobId: string;
        leaseToken: string;
        attemptCount: number;
        errorCode: string;
        retryable: boolean;
        retryAfterMs: number | undefined;
      }) => withTenantOn(pool, input.workspaceId, (tx: TenantTx) =>
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
          // Produktions-Paritaet (worker/index.ts): Bestands-Reihe faellt
          // im Bestand-Branch fail-closed statt still weg.
          existingPvKwh: input.existingPvKwh ?? null,
        }),
      },
      createLeaseToken: randomUUID,
    });
    await handler([{
      data: {
        schemaVersion: "project-calculation-dispatch.v2",
        workspaceId: ids.workspaceId,
        jobId,
      },
    }]);
  });
}
export { getProjectEnergyContext };
