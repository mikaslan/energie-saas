import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
} from "../../lib/integrations/catalog/contract";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m107_erasure_migrator";
const RUNTIME_PASSWORD = "m107_erasure_runtime";
const WORKER_PASSWORD = "m107_erasure_worker";
const TOMBSTONE_REASON = "inactive_lead_24_months";

const snapshotPayload = {
  schemaVersion: "wmee-solar-snapshot.v1",
  calculatedAt: "2024-01-01T00:00:00.000Z",
  branch: "new_installation",
  questionnaireVariant: "short",
  resultIntegrity: "client_reported_unverified",
  inputs: { annualConsumptionKwh: 9_876 },
  provenance: { investment: "market_estimate" },
  result: { mode: "new_installation" },
};

const requirementPayload = {
  schemaVersion: "project-requirements.rechner.v1",
  source: "wmee-rechner-v3",
  branch: "new_installation",
  requestedProducts: {
    targetStorageKwh: 8,
    wallbox: false,
    bidirectionalCharging: false,
    backupPower: false,
  },
};

const profilePayload = {
  schemaVersion: "site-energy-profile.v1",
  inputMode: "consumption",
  building: {},
  roofs: [{ id: "roof-erasure-fixture" }],
  consumption: { householdKwhPerYear: 9_876 },
  existingAssets: {},
  provenance: {},
};

type JobState = "running" | "succeeded";

type ProjectFixture = {
  id: string;
  siteId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
  jobId: string;
  revisionId: string | null;
};

type SiteFixture = {
  id: string;
  profileId: string;
  sourceProjectId: string;
  sourceSnapshotId: string;
};

type SubjectFixture = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  marker: string;
  email: string;
  oldAt: Date;
  sites: SiteFixture[];
  projects: ProjectFixture[];
};

type CatalogErasureFixture = {
  componentId: string;
  resolutionId: string;
};

function serviceUrl(
  embedded: EmbeddedTestDatabase,
  role: string,
  password: string,
): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

function monthsAgo(months: number): Date {
  const value = new Date();
  value.setUTCMonth(value.getUTCMonth() - months);
  return value;
}

async function bootstrapStrictRoles(admin: Pool): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password '${MIGRATOR_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login password '${RUNTIME_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password '${WORKER_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_erasure nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role identity_reconciler nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;

    grant app_owner to app_migrator
      with admin false, inherit false, set true;
    grant app_worker to app_migrator
      with admin false, inherit false, set true;
    grant app_membership_writer to app_owner
      with admin false, inherit false, set false;
    grant app_membership_writer to app_system
      with admin false, inherit false, set false;
    grant identity_reconciler to app_owner
      with admin true, inherit false, set false;

    alter database ${DATABASE_NAME} owner to app_owner;
    alter schema public owner to app_owner;
    revoke all on schema public from public;
    create schema pgboss authorization app_worker;
    grant connect on database ${DATABASE_NAME} to app_runtime, app_worker;
  `);
}

async function installPgBoss(workerUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: workerUrl, schema: "pgboss", createSchema: false });
  const errors: unknown[] = [];
  boss.on("error", (error) => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue("calculation.execute", {
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 900,
    });
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  expect(errors, `pg-boss-Bootstrap: ${errors.map(String).join(", ")}`).toEqual([]);
}

async function insertSourceGraph(
  admin: Pool,
  fixture: SubjectFixture,
  project: ProjectFixture,
  includeReceipt: boolean,
): Promise<void> {
  if (includeReceipt) {
    await admin.query(
      `insert into public.inbound_receipt (
         id, workspace_id, source_key, submission_id, contract_version,
         body_sha256, auth_key_id, signed_at, submitted_at, received_at,
         producer_application, producer_git_revision, producer_environment,
         calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
         privacy_notice_version, privacy_notice_url, contact_resolution,
         contact_id, site_id, project_id
       ) values (
         $1, $2, 'wmee-rechner-v3', $3, 'rechner-intake.v1',
         decode(repeat('10', 32), 'hex'), 'erasure-fixture', $4, $4, $4,
         'wmee-rechner-v3', $5, 'development', 'wmee-solar.v1', '{}'::jsonb,
         'offer_request', 'art_6_1_b_precontractual', 'fixture-v1',
         'https://example.test/privacy', 'created', $6, $7, $8
       )`,
      [
        project.receiptId,
        fixture.workspaceId,
        randomUUID(),
        fixture.oldAt,
        "1".repeat(40),
        fixture.contactId,
        project.siteId,
        project.id,
      ],
    );
  }

  await admin.query(
    `insert into public.calculator_snapshot (
       id, workspace_id, receipt_id, project_id, schema_version,
       calculator_engine, result_integrity, investment_source, calculated_at,
       snapshot, created_at
     ) values (
       $1, $2, $3, $4, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
       'client_reported_unverified', 'market_estimate', $5, $6::jsonb, $5
     )`,
    [
      project.snapshotId,
      fixture.workspaceId,
      project.receiptId,
      project.id,
      fixture.oldAt,
      JSON.stringify(snapshotPayload),
    ],
  );
  await admin.query(
    `insert into public.project_requirement (
       id, workspace_id, project_id, revision, schema_version,
       source_snapshot_id, requirements, created_at
     ) values ($1, $2, $3, 1, 'project-requirements.rechner.v1', $4, $5::jsonb, $6)`,
    [
      project.requirementId,
      fixture.workspaceId,
      project.id,
      project.snapshotId,
      JSON.stringify(requirementPayload),
      fixture.oldAt,
    ],
  );
}

async function insertProfile(
  admin: Pool,
  fixture: SubjectFixture,
  site: SiteFixture,
): Promise<void> {
  await admin.query(
    `insert into public.site_energy_profile (
       id, workspace_id, site_id, revision, schema_version, input_mode,
       source_kind, source_snapshot_id, source_project_id, address_revision,
       profile, profile_sha256, confirmed_profile_revision,
       confirmed_address_revision, confirmed_by, confirmed_at, created_at, updated_at
     ) values (
       $1, $2, $3, 1, 'site-energy-profile.v1', 'consumption',
       'rechner_snapshot', $4, $5, 1, $6::jsonb,
       decode(repeat('20', 32), 'hex'), 1, 1, $7, $8, $8, $8
     )`,
    [
      site.profileId,
      fixture.workspaceId,
      site.id,
      site.sourceSnapshotId,
      site.sourceProjectId,
      JSON.stringify(profilePayload),
      fixture.actorId,
      fixture.oldAt,
    ],
  );
}

async function insertJob(
  admin: Pool,
  fixture: SubjectFixture,
  project: ProjectFixture,
  state: JobState,
): Promise<void> {
  const profile = fixture.sites.find((site) => site.id === project.siteId);
  if (!profile) throw new Error("Fixture-Profil fehlt");
  const inputSnapshot = {
    contractVersion: "planning-calculation.v1",
    bindings: {
      workspaceId: fixture.workspaceId,
      projectId: project.id,
      siteId: project.siteId,
    },
  };
  const providerSnapshot = { provider: "pvgis", recipeVersion: "fixture.v1" };
  const leaseExpiresAt = state === "running"
    ? new Date(Date.now() + 5 * 60_000)
    : fixture.oldAt;

  await admin.query(
    `insert into public.project_calculation_job (
       id, workspace_id, project_id, site_id, address_revision,
       pin_confirmed_address_revision, profile_id, profile_revision,
       confirmed_profile_revision, confirmed_address_revision,
       requirement_id, requirement_revision, source_snapshot_id,
       reservation_key, provider_recipe_version, contract_version,
       model_id, model_version, source_revision, defaults_version,
       state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
       input_sha256, input_snapshot, provider_snapshot, created_by,
       created_at, started_at
     ) values (
       $1, $2, $3, $4, 1, 1, $5, 1, 1, 1, $6, 1, $7,
       decode(repeat('30', 32), 'hex'), 'pvgis-5.3-sarah3-2020.v1',
       'planning-calculation.v1', 'wmee-solar', '1.0.0', $8,
       'wmee-planning-defaults.v1', 'running', 1, $9, $10, $11,
       decode(repeat('40', 32), 'hex'), $12::jsonb, $13::jsonb, $14, $9, $9
     )`,
    [
      project.jobId,
      fixture.workspaceId,
      project.id,
      project.siteId,
      profile.profileId,
      project.requirementId,
      project.snapshotId,
      "a".repeat(40),
      fixture.oldAt,
      randomUUID(),
      leaseExpiresAt,
      JSON.stringify(inputSnapshot),
      JSON.stringify(providerSnapshot),
      fixture.actorId,
    ],
  );

  if (state === "running") return;
  if (!project.revisionId) throw new Error("Resultrevision fehlt");
  const result = {
    contractVersion: "planning-calculation.v1",
    model: { id: "wmee-solar", version: "1.0.0", sourceRevision: "a".repeat(40) },
    inputSha256: "40".repeat(32),
    resultSha256: "50".repeat(32),
    quality: "server_reproduced_estimate",
    validationStatus: "not_f4_reference_validated",
  };
  await admin.query(
    `insert into public.project_calculation_revision (
       id, workspace_id, project_id, site_id, revision, job_id,
       address_revision, pin_confirmed_address_revision, profile_id,
       profile_revision, confirmed_profile_revision, confirmed_address_revision,
       requirement_id, requirement_revision, source_snapshot_id,
       contract_version, model_id, model_version, source_revision,
       defaults_version, quality, validation_status, input_sha256,
       result_sha256, input_snapshot, provider_snapshot, result, created_by, created_at
     ) values (
       $1, $2, $3, $4, 1, $5, 1, 1, $6, 1, 1, 1, $7, 1, $8,
       'planning-calculation.v1', 'wmee-solar', '1.0.0', $9,
       'wmee-planning-defaults.v1', 'server_reproduced_estimate',
       'not_f4_reference_validated', decode(repeat('40', 32), 'hex'),
       decode(repeat('50', 32), 'hex'), $10::jsonb, $11::jsonb, $12::jsonb, $13, $14
     )`,
    [
      project.revisionId,
      fixture.workspaceId,
      project.id,
      project.siteId,
      project.jobId,
      profile.profileId,
      project.requirementId,
      project.snapshotId,
      "a".repeat(40),
      JSON.stringify(inputSnapshot),
      JSON.stringify(providerSnapshot),
      JSON.stringify(result),
      fixture.actorId,
      fixture.oldAt,
    ],
  );
  await admin.query(
    `update public.project_calculation_job
        set state = 'succeeded', lease_token = null, lease_expires_at = null,
            finished_at = $1, result_revision_id = $2
      where workspace_id = $3 and id = $4`,
    [fixture.oldAt, project.revisionId, fixture.workspaceId, project.jobId],
  );
}

async function createSubject(
  admin: Pool,
  options: {
    ageMonths: number;
    sharedAndExclusive?: boolean;
    jobState?: JobState;
    outcome?: "open" | "won";
  },
): Promise<SubjectFixture> {
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const contactId = randomUUID();
  const marker = `pii-${contactId}`;
  const email = `${contactId}@erasure.test`;
  const oldAt = monthsAgo(options.ageMonths);
  await admin.query("insert into public.workspace (id, name, created_at) values ($1, $2, $3)", [
    workspaceId,
    `Erasure ${contactId}`,
    oldAt,
  ]);
  await admin.query("insert into public.user_identity (id, email, created_at) values ($1, $2, $3)", [
    actorId,
    `${actorId}@actor.test`,
    oldAt,
  ]);
  const membershipClient = await admin.connect();
  try {
    await membershipClient.query("begin");
    await membershipClient.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    await membershipClient.query(
      "insert into public.membership (workspace_id, user_id, role, created_at) values ($1, $2, 'editor', $3)",
      [workspaceId, actorId, oldAt],
    );
    await membershipClient.query("commit");
  } catch (error) {
    await membershipClient.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    membershipClient.release();
  }
  await admin.query(
    `insert into public.contact (
       id, workspace_id, display_name, email_primary, email_normalized,
       phone_raw, phone_e164, created_at, updated_at
     ) values ($1, $2, $3, $4, $4, '+491701234567', '+491701234567', $5, $5)`,
    [contactId, workspaceId, marker, email, oldAt],
  );
  const board = await admin.query<{ board_id: string; column_id: string }>(
    `select board.id as board_id, column_row.id as column_id
       from public.kanban_board board
       join public.kanban_column column_row
         on column_row.workspace_id = board.workspace_id
        and column_row.board_id = board.id
      where board.workspace_id = $1 and board.is_default and column_row.is_intake`,
    [workspaceId],
  );
  const boardRow = board.rows[0];
  if (!boardRow) throw new Error("Default-Board-Fixture fehlt");

  const siteIds = options.sharedAndExclusive
    ? [randomUUID(), randomUUID()]
    : [randomUUID()];
  for (const siteId of siteIds) {
    await admin.query(
      `insert into public.site (
         id, workspace_id, contact_id, label, formatted_address, street,
         house_number, postal_code, city, address_mode, country,
         address_revision, pin_confirmed, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, 'PII-Strasse', '7', '10115',
                 'PII-Stadt', 'legacy', 'DE', 1, false, $6, $6)`,
      [siteId, workspaceId, contactId, marker, `${marker} Adresse`, oldAt],
    );
  }

  const projectSiteIds = options.sharedAndExclusive
    ? [siteIds[0]!, siteIds[0]!, siteIds[1]!]
    : [siteIds[0]!];
  const projects: ProjectFixture[] = [];
  for (const siteId of projectSiteIds) {
    const project: ProjectFixture = {
      id: randomUUID(),
      siteId,
      receiptId: randomUUID(),
      snapshotId: randomUUID(),
      requirementId: randomUUID(),
      jobId: randomUUID(),
      revisionId: options.jobState === "running" ? null : randomUUID(),
    };
    await admin.query(
      `insert into public.project (
         id, workspace_id, contact_id, site_id, kanban_board_id,
         kanban_column_id, name, phase, outcome, source_key, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, 'request', $8, 'fixture', $9, $9)`,
      [
        project.id,
        workspaceId,
        contactId,
        siteId,
        boardRow.board_id,
        boardRow.column_id,
        marker,
        options.outcome ?? "open",
        oldAt,
      ],
    );
    projects.push(project);
  }

  const sites: SiteFixture[] = siteIds.map((id) => {
    const source = projects.find((project) => project.siteId === id)!;
    return {
      id,
      profileId: randomUUID(),
      sourceProjectId: source.id,
      sourceSnapshotId: source.snapshotId,
    };
  });
  const fixture: SubjectFixture = {
    workspaceId,
    actorId,
    contactId,
    marker,
    email,
    oldAt,
    sites,
    projects,
  };
  for (const project of projects) await insertSourceGraph(admin, fixture, project, true);
  for (const site of sites) await insertProfile(admin, fixture, site);
  for (const project of projects) {
    await insertJob(admin, fixture, project, options.jobState ?? "succeeded");
  }
  return fixture;
}

async function createCatalogResolutionForErasure(
  admin: Pool,
  fixture: SubjectFixture,
): Promise<CatalogErasureFixture> {
  const project = fixture.projects[0];
  if (!project?.revisionId) throw new Error("Katalog-Erasure-Fixture verlangt eine Berechnung.");

  const componentId = randomUUID();
  const componentRevisionId = randomUUID();
  const resolutionId = randomUUID();
  const lineId = randomUUID();
  const confirmedAt = fixture.oldAt.toISOString();
  const componentSnapshot = sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: fixture.workspaceId,
      componentId,
      revision: 1,
      internalSku: "ERASURE-BAT-001",
      componentType: "battery",
    },
    presentation: {
      displayName: "Synthetischer Erasure-Testspeicher",
      manufacturer: "WMEE Testwerk",
      model: "Fixture 8",
      unit: "piece",
      keyPoints: ["Ausschliesslich synthetische Testdaten"],
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
      purchasePriceNetCents: 250_000,
      salesPriceNetCents: 390_000,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: "synthetic-erasure-purchase-fixture",
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: "synthetic-erasure-sales-fixture",
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "manufacturer_datasheet",
      reference: "synthetic-erasure-technical-fixture",
      observedOn: "2026-08-29",
      rightsBasis: "manufacturer_published",
      sourceDocumentSha256: null,
    },
  });
  const resolutionSnapshot = sealProjectCatalogResolution({
    schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    revision: 1,
    bindings: {
      workspaceId: fixture.workspaceId,
      projectId: project.id,
      siteId: project.siteId,
      requirementId: project.requirementId,
      requirementRevision: 1,
      calculationRevisionId: project.revisionId,
      calculationRevision: 1,
      calculationInputSha256: "40".repeat(32),
      calculationResultSha256: "50".repeat(32),
      calculationQuality: "server_reproduced_estimate",
      calculationValidationStatus: "not_f4_reference_validated",
    },
    lines: [{
      lineId,
      position: 1,
      quantity: 1,
      coversRequirementKeys: ["storage_capacity"],
      catalogComponentId: componentId,
      catalogComponentRevision: 1,
      componentSnapshotSha256: componentSnapshot.snapshotSha256,
      componentSnapshot,
    }],
    requested: {
      branch: "new_installation",
      pvPeakPowerWatts: 0,
      storageCapacityWh: 8_000,
      wallbox: false,
      backupPower: false,
      bidirectionalCharging: false,
    },
    acknowledgements: [],
    confirmedBy: fixture.actorId,
    confirmedAt,
  });

  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [
      fixture.workspaceId,
    ]);
    await client.query(
      `insert into public.catalog_component (
         id, workspace_id, internal_sku, component_type, created_by,
         created_at, updated_at
       ) values ($1, $2, 'ERASURE-BAT-001', 'battery', $3, $4, $4)`,
      [componentId, fixture.workspaceId, fixture.actorId, fixture.oldAt],
    );
    await client.query(
      `insert into public.catalog_component_revision (
         id, workspace_id, component_id, revision, component_type,
         schema_version, canonicalization_version, revision_snapshot,
         snapshot_sha256, created_by, created_at
       ) values (
         $1, $2, $3, 1, 'battery', $4, $5, $6::jsonb,
         decode($7, 'hex'), $8, $9
       )`,
      [
        componentRevisionId,
        fixture.workspaceId,
        componentId,
        CATALOG_COMPONENT_CONTRACT_VERSION,
        CATALOG_CANONICALIZATION_VERSION,
        JSON.stringify(componentSnapshot),
        componentSnapshot.snapshotSha256,
        fixture.actorId,
        fixture.oldAt,
      ],
    );
    await client.query(
      `update public.catalog_component
          set status = 'active', updated_at = $1
        where workspace_id = $2 and id = $3`,
      [fixture.oldAt, fixture.workspaceId, componentId],
    );
    await client.query(
      `insert into public.project_catalog_resolution (
         id, workspace_id, project_id, site_id, revision,
         requirement_id, requirement_revision, calculation_revision_id,
         calculation_revision, calculation_input_sha256,
         calculation_result_sha256, calculation_quality,
         calculation_validation_status, schema_version,
         canonicalization_version, resolution_snapshot, resolution_sha256,
         confirmed_by, confirmed_at, created_at
       ) values (
         $1, $2, $3, $4, 1, $5, 1, $6, 1,
         decode(repeat('40', 32), 'hex'), decode(repeat('50', 32), 'hex'),
         'server_reproduced_estimate', 'not_f4_reference_validated',
         $7, $8, $9::jsonb, decode($10, 'hex'), $11, $12, $12
       )`,
      [
        resolutionId,
        fixture.workspaceId,
        project.id,
        project.siteId,
        project.requirementId,
        project.revisionId,
        PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
        CATALOG_CANONICALIZATION_VERSION,
        JSON.stringify(resolutionSnapshot),
        resolutionSnapshot.resolutionSha256,
        fixture.actorId,
        fixture.oldAt,
      ],
    );
    await client.query(
      `insert into public.project_catalog_resolution_line (
         id, workspace_id, resolution_id, project_id, position, quantity,
         catalog_component_id, catalog_component_revision,
         component_snapshot_sha256, created_at
       ) values ($1, $2, $3, $4, 1, 1, $5, 1, decode($6, 'hex'), $7)`,
      [
        lineId,
        fixture.workspaceId,
        resolutionId,
        project.id,
        componentId,
        componentSnapshot.snapshotSha256,
        fixture.oldAt,
      ],
    );
    await client.query("set constraints all immediate");
    await client.query(
      `update public.project set updated_at = $1
        where workspace_id = $2 and id = $3`,
      [fixture.oldAt, fixture.workspaceId, project.id],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { componentId, resolutionId };
}

async function restoreSubject(admin: Pool, fixture: SubjectFixture): Promise<void> {
  await admin.query(
    `update public.contact
        set display_name = $1, email_primary = $2, email_normalized = $2,
            phone_raw = '+491701234567', phone_e164 = '+491701234567',
            deleted_at = null, updated_at = $3
      where workspace_id = $4 and id = $5`,
    [fixture.marker, fixture.email, fixture.oldAt, fixture.workspaceId, fixture.contactId],
  );
  await admin.query(
    `update public.site
        set label = $1, formatted_address = $2, street = 'PII-Strasse',
            house_number = '7', postal_code = '10115', city = 'PII-Stadt',
            address_mode = 'legacy', pin_confirmed = false,
            pin_confirmed_address_revision = null, updated_at = $3
      where workspace_id = $4 and id = any($5::uuid[])`,
    [
      fixture.marker,
      `${fixture.marker} Adresse`,
      fixture.oldAt,
      fixture.workspaceId,
      fixture.sites.map((site) => site.id),
    ],
  );
  await admin.query(
    `update public.project set name = $1, updated_at = $2
      where workspace_id = $3 and id = any($4::uuid[])`,
    [fixture.marker, fixture.oldAt, fixture.workspaceId, fixture.projects.map((p) => p.id)],
  );
  for (const project of fixture.projects) await insertSourceGraph(admin, fixture, project, false);
  for (const site of fixture.sites) await insertProfile(admin, fixture, site);
  for (const project of fixture.projects) await insertJob(admin, fixture, project, "succeeded");
}

async function callAsErasure(
  admin: Pool,
  routine: "erase_inactive_lead" | "replay_erasure_tombstone",
  args: string[],
  lockTimeout?: string,
): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_erasure");
    if (lockTimeout) await client.query(`set local lock_timeout = '${lockTimeout}'`);
    const placeholders = args.map((_, index) => `$${index + 1}::uuid`).join(", ");
    const result = await client.query<{ operation_id: string }>(
      `select public.${routine}(${placeholders})::text as operation_id`,
      args,
    );
    await client.query("commit");
    return result.rows[0]!.operation_id;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectErasureRejection(
  promise: Promise<unknown>,
  message: RegExp,
  code = "P0001",
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({ code });
  expect(String((caught as Error).message)).toMatch(message);
}

async function tombstoneCount(admin: Pool, fixture: SubjectFixture): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `select count(*)::int as count from public.erasure_tombstone
      where workspace_id = $1 and contact_id = $2`,
    [fixture.workspaceId, fixture.contactId],
  );
  return result.rows[0]!.count;
}

async function mutateTombstoneAsOwner(
  ownerPool: Pool,
  workspaceId: string,
  statement: string,
  values: unknown[] = [],
): Promise<void> {
  const owner = await ownerPool.connect();
  try {
    await owner.query("begin");
    await owner.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await owner.query(statement, values);
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    owner.release();
  }
}

describe.sequential("M1-07 DSGVO-Erasure- und Restorevertrag", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let ownerPool: Pool;
  let workerPool: Pool;
  let eligible: SubjectFixture;
  let eligibleCatalog: CatalogErasureFixture;
  let recent: SubjectFixture;
  let held: SubjectFixture;
  let won: SubjectFixture;
  let running: SubjectFixture;
  let locked: SubjectFixture;
  let operationId: string;
  let initialErasureCompleted = false;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 4 });
    await bootstrapStrictRoles(admin);
    await installPgBoss(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));
    ownerPool = new Pool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      options: "-c role=app_owner",
      max: 1,
    });
    await migrate(drizzle(ownerPool), { migrationsFolder: resolve("drizzle") });
    const owner = await ownerPool.connect();
    try {
      await applyRoleContract(owner);
    } finally {
      owner.release();
    }
    workerPool = new Pool({
      connectionString: serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
      max: 1,
    });

    eligible = await createSubject(admin, { ageMonths: 25, sharedAndExclusive: true });
    eligibleCatalog = await createCatalogResolutionForErasure(admin, eligible);
    recent = await createSubject(admin, { ageMonths: 23 });
    held = await createSubject(admin, { ageMonths: 25 });
    won = await createSubject(admin, { ageMonths: 25, outcome: "won" });
    running = await createSubject(admin, { ageMonths: 25, jobState: "running" });
    locked = await createSubject(admin, { ageMonths: 25 });
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end().catch(() => undefined);
    await ownerPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

  it("pinnt den NOLOGIN-Principal, zwei geschlossene Definer-Routinen und keinerlei Tabellenrecht", async () => {
    const role = await admin.query<{
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(`
      select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        from pg_catalog.pg_roles where rolname = 'app_erasure'
    `);
    expect(role.rows[0]).toEqual({
      rolcanlogin: false,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });

    const routines = await admin.query<{
      signature: string;
      owner: string;
      security_definer: boolean;
      config: string[] | null;
    }>(`
      select routine.proname || '(' || pg_catalog.oidvectortypes(routine.proargtypes) || ')'
               as signature,
             owner.rolname as owner,
             routine.prosecdef as security_definer,
             routine.proconfig as config
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_roles owner on owner.oid = routine.proowner
       where namespace.nspname = 'public'
         and routine.proname in ('erase_inactive_lead', 'replay_erasure_tombstone')
       order by signature
    `);
    expect.soft(routines.rows).toEqual([
      {
        signature: "erase_inactive_lead(uuid, uuid, uuid)",
        owner: "app_owner",
        security_definer: true,
        config: ["search_path=pg_catalog"],
      },
      {
        signature: "replay_erasure_tombstone(uuid)",
        owner: "app_owner",
        security_definer: true,
        config: ["search_path=pg_catalog"],
      },
    ]);
    const routineAcl = await admin.query<{
      grantee: string;
      grantor: string;
      signature: string;
      privilege_type: string;
    }>(`
      select coalesce(grantee.rolname, 'PUBLIC') as grantee,
             grantor.rolname as grantor,
             routine.proname || '(' || pg_catalog.oidvectortypes(routine.proargtypes) || ')'
               as signature,
             acl.privilege_type
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) acl
        join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
       where namespace.nspname = 'public'
         and routine.proname in ('erase_inactive_lead', 'replay_erasure_tombstone')
         and acl.grantee <> routine.proowner
       order by signature, grantee
    `);
    expect.soft(routineAcl.rows).toEqual([
      {
        grantee: "app_erasure",
        grantor: "app_owner",
        signature: "erase_inactive_lead(uuid, uuid, uuid)",
        privilege_type: "EXECUTE",
      },
      {
        grantee: "app_erasure",
        grantor: "app_owner",
        signature: "replay_erasure_tombstone(uuid)",
        privilege_type: "EXECUTE",
      },
    ]);

    const relationAcl = await admin.query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where grantee = 'app_erasure' and table_schema in ('public', 'pgboss')
       order by table_schema, table_name, privilege_type
    `);
    expect.soft(relationAcl.rows).toEqual([]);

    const schemaAcl = await admin.query<{ usage: boolean; create: boolean }>(`
      select pg_catalog.has_schema_privilege('app_erasure', 'public', 'USAGE') as usage,
             pg_catalog.has_schema_privilege('app_erasure', 'public', 'CREATE') as create
    `);
    expect.soft(schemaAcl.rows[0]).toEqual({ usage: true, create: false });

    const protectedTables = await admin.query<{
      name: string;
      rls: boolean;
      force_rls: boolean;
    }>(`
      select relation.relname as name,
             relation.relrowsecurity as rls,
             relation.relforcerowsecurity as force_rls
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'public'
         and relation.relname in ('contact_legal_hold', 'erasure_tombstone')
       order by relation.relname
    `);
    expect.soft(protectedTables.rows).toEqual([
      { name: "contact_legal_hold", rls: true, force_rls: true },
      { name: "erasure_tombstone", rls: true, force_rls: true },
    ]);

    const tombstoneColumns = await admin.query<{ column_name: string }>(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'erasure_tombstone'
       order by ordinal_position
    `);
    expect.soft(tombstoneColumns.rows.map((row) => row.column_name)).toEqual([
      "operation_id",
      "workspace_id",
      "contact_id",
      "reason",
      "graph_sha256",
      "tombstone_sha256",
      "graph_ids",
      "eligible_at",
      "erased_at",
    ]);

    const circularFks = await admin.query<{
      name: string;
      deferrable: boolean;
      deferred: boolean;
    }>(`
      select constraint_row.conname as name,
             constraint_row.condeferrable as deferrable,
             constraint_row.condeferred as deferred
        from pg_catalog.pg_constraint constraint_row
       where constraint_row.conname in (
         'project_calculation_revision_job_project_site_fk',
         'project_calculation_job_result_revision_project_site_fk'
       )
       order by constraint_row.conname
    `);
    expect.soft(circularFks.rows).toEqual([
      {
        name: "project_calculation_job_result_revision_project_site_fk",
        deferrable: true,
        deferred: true,
      },
      {
        name: "project_calculation_revision_job_project_site_fk",
        deferrable: true,
        deferred: true,
      },
    ]);
  });

  it("macht einen Lead erst nach 24 Kalendermonaten DB-seitig eligible", async () => {
    const op = randomUUID();
    await expectErasureRejection(
      callAsErasure(admin, "erase_inactive_lead", [recent.workspaceId, recent.contactId, op]),
      /erasure_not_eligible/,
    );
    expect(await tombstoneCount(admin, recent)).toBe(0);
  });

  it("schließt einen aktiven Legal Hold und einen Lead mit Vertrag vollständig aus", async () => {
    await admin.query(
      `insert into public.contact_legal_hold (
         id, workspace_id, contact_id, reason, placed_at
       ) values ($1, $2, $3, 'legal_claim', now())`,
      [randomUUID(), held.workspaceId, held.contactId],
    );
    await expectErasureRejection(
      callAsErasure(admin, "erase_inactive_lead", [held.workspaceId, held.contactId, randomUUID()]),
      /erasure_legal_hold/,
    );
    await expectErasureRejection(
      callAsErasure(admin, "erase_inactive_lead", [won.workspaceId, won.contactId, randomUUID()]),
      /erasure_contract_retained/,
    );
    expect(await tombstoneCount(admin, held)).toBe(0);
    expect(await tombstoneCount(admin, won)).toBe(0);
  });

  it("löscht nie gegen einen laufenden Worker-Lease", async () => {
    await expectErasureRejection(
      callAsErasure(admin, "erase_inactive_lead", [
        running.workspaceId,
        running.contactId,
        randomUUID(),
      ]),
      /erasure_worker_active/,
      "55006",
    );
    expect(await tombstoneCount(admin, running)).toBe(0);
  });

  it("wartet auf Worker-Locks und committet bei einem Race keinen Teilgraphen", async () => {
    const worker = await workerPool.connect();
    try {
      await worker.query("begin");
      await worker.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [
        locked.workspaceId,
      ]);
      await worker.query(
        `select 1 from public.project_calculation_job
          where workspace_id = $1 and id = $2 for update`,
        [locked.workspaceId, locked.projects[0]!.jobId],
      );
      await expectErasureRejection(
        callAsErasure(
          admin,
          "erase_inactive_lead",
          [locked.workspaceId, locked.contactId, randomUUID()],
          "250ms",
        ),
        /lock timeout|could not obtain lock/i,
        "55P03",
      );
      expect(await tombstoneCount(admin, locked)).toBe(0);
    } finally {
      await worker.query("rollback").catch(() => undefined);
      worker.release();
    }
  });

  it("entfernt den vollständigen exklusiven und geteilten M1-07-Graph atomar", async () => {
    operationId = randomUUID();
    const firstResult = await callAsErasure(admin, "erase_inactive_lead", [
      eligible.workspaceId,
      eligible.contactId,
      operationId,
    ]);
    expect(firstResult).toBe(operationId);
    initialErasureCompleted = true;
    await expect(
      callAsErasure(admin, "erase_inactive_lead", [
        eligible.workspaceId,
        eligible.contactId,
        operationId,
      ]),
    ).resolves.toBe(operationId);

    const contact = await admin.query<{
      display_name: string;
      email_primary: string | null;
      email_normalized: string | null;
      phone_raw: string | null;
      phone_e164: string | null;
      marketing_consent: boolean;
      marketing_consent_at: Date | null;
      marketing_consent_source: string | null;
      deleted: boolean;
    }>(`
      select display_name, email_primary, email_normalized, phone_raw, phone_e164,
             marketing_consent, marketing_consent_at, marketing_consent_source,
             deleted_at is not null as deleted
        from public.contact where workspace_id = $1 and id = $2
    `, [eligible.workspaceId, eligible.contactId]);
    expect(contact.rows[0]).toEqual({
      display_name: `geloescht-${eligible.contactId}`,
      email_primary: null,
      email_normalized: null,
      phone_raw: null,
      phone_e164: null,
      marketing_consent: false,
      marketing_consent_at: null,
      marketing_consent_source: null,
      deleted: true,
    });

    const remaining = await admin.query<{
      profiles: number;
      jobs: number;
      revisions: number;
      requirements: number;
      snapshots: number;
      projects: number;
      sites: number;
      memberships: number;
      catalog_resolutions: number;
      catalog_resolution_lines: number;
      catalog_components: number;
      catalog_component_revisions: number;
    }>(`
      select
        (select count(*)::int from public.site_energy_profile
          where workspace_id = $1 and site_id = any($2::uuid[])) as profiles,
        (select count(*)::int from public.project_calculation_job
          where workspace_id = $1 and project_id = any($3::uuid[])) as jobs,
        (select count(*)::int from public.project_calculation_revision
          where workspace_id = $1 and project_id = any($3::uuid[])) as revisions,
        (select count(*)::int from public.project_requirement
          where workspace_id = $1 and project_id = any($3::uuid[])) as requirements,
        (select count(*)::int from public.calculator_snapshot
          where workspace_id = $1 and project_id = any($3::uuid[])) as snapshots,
        (select count(*)::int from public.project
          where workspace_id = $1 and id = any($3::uuid[])) as projects,
        (select count(*)::int from public.site
          where workspace_id = $1 and id = any($2::uuid[])) as sites,
        (select count(*)::int from public.membership
          where workspace_id = $1 and user_id = $4) as memberships,
        (select count(*)::int from public.project_catalog_resolution
          where workspace_id = $1 and id = $5) as catalog_resolutions,
        (select count(*)::int from public.project_catalog_resolution_line
          where workspace_id = $1 and resolution_id = $5) as catalog_resolution_lines,
        (select count(*)::int from public.catalog_component
          where workspace_id = $1 and id = $6) as catalog_components,
        (select count(*)::int from public.catalog_component_revision
          where workspace_id = $1 and component_id = $6) as catalog_component_revisions
    `, [
      eligible.workspaceId,
      eligible.sites.map((site) => site.id),
      eligible.projects.map((project) => project.id),
      eligible.actorId,
      eligibleCatalog.resolutionId,
      eligibleCatalog.componentId,
    ]);
    expect(remaining.rows[0]).toEqual({
      profiles: 0,
      jobs: 0,
      revisions: 0,
      requirements: 0,
      snapshots: 0,
      projects: 3,
      sites: 2,
      memberships: 1,
      catalog_resolutions: 0,
      catalog_resolution_lines: 0,
      catalog_components: 1,
      catalog_component_revisions: 1,
    });

    const retainedPii = await admin.query<{ document: string }>(`
      select pg_catalog.jsonb_build_object(
        'sites', (select pg_catalog.jsonb_agg(site_row) from public.site site_row
          where workspace_id = $1 and id = any($2::uuid[])),
        'projects', (select pg_catalog.jsonb_agg(project_row) from public.project project_row
          where workspace_id = $1 and id = any($3::uuid[])),
        'events', (select pg_catalog.jsonb_agg(event_row) from public.domain_events event_row
          where workspace_id = $1),
        'audit', (select pg_catalog.jsonb_agg(audit_row) from public.audit_log audit_row
          where workspace_id = $1)
      )::text as document
    `, [
      eligible.workspaceId,
      eligible.sites.map((site) => site.id),
      eligible.projects.map((project) => project.id),
    ]);
    expect(retainedPii.rows[0]!.document).not.toContain(eligible.marker);
    expect(retainedPii.rows[0]!.document).not.toContain(eligible.email);
    expect(retainedPii.rows[0]!.document).not.toContain("PII-Strasse");
    expect(await tombstoneCount(admin, eligible)).toBe(1);
  });

  it("hält den ID-/Hash-Tombstone auch für Owner UPDATE, DELETE und TRUNCATE append-only", async () => {
    const tombstone = await admin.query<{
      operation_id: string;
      workspace_id: string;
      contact_id: string;
      reason: string;
      graph_sha256_length: number;
      tombstone_sha256_length: number;
      graph_ids: unknown;
      eligible_at: Date;
      erased_at: Date;
      document: string;
    }>(`
      select operation_id, workspace_id, contact_id, reason,
             pg_catalog.octet_length(graph_sha256) as graph_sha256_length,
             pg_catalog.octet_length(tombstone_sha256) as tombstone_sha256_length,
             graph_ids, eligible_at, erased_at, pg_catalog.to_jsonb(tombstone)::text as document
        from public.erasure_tombstone tombstone where operation_id = $1
    `, [operationId]);
    expect(tombstone.rows[0]).toMatchObject({
      operation_id: operationId,
      workspace_id: eligible.workspaceId,
      contact_id: eligible.contactId,
      reason: TOMBSTONE_REASON,
      graph_sha256_length: 32,
      tombstone_sha256_length: 32,
    });
    expect(tombstone.rows[0]!.eligible_at).toBeInstanceOf(Date);
    expect(tombstone.rows[0]!.erased_at).toBeInstanceOf(Date);
    expect(tombstone.rows[0]!.graph_ids).toBeTypeOf("object");
    expect(tombstone.rows[0]!.document).not.toContain(eligible.marker);
    expect(tombstone.rows[0]!.document).not.toContain(eligible.email);
    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        eligible.workspaceId,
        "update public.erasure_tombstone set reason = 'changed' where operation_id = $1",
        [operationId],
      ),
    ).rejects.toThrow(/append-only|WORM/i);
    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        eligible.workspaceId,
        "delete from public.erasure_tombstone where operation_id = $1",
        [operationId],
      ),
    ).rejects.toThrow(/append-only|WORM/i);
    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        eligible.workspaceId,
        "truncate public.erasure_tombstone",
      ),
    ).rejects.toThrow(/append-only|WORM/i);
  });

  it("löscht nach simuliertem Restore denselben Graph erneut und bleibt bei Replay einfach", async () => {
    expect(
      initialErasureCompleted,
      "Die noch fehlende Erasure-Implementierung verhinderte den initialen Lauf",
    ).toBe(true);
    await restoreSubject(admin, eligible);
    expect(await tombstoneCount(admin, eligible)).toBe(1);
    await expect(
      callAsErasure(admin, "replay_erasure_tombstone", [operationId]),
    ).resolves.toBe(operationId);
    await expect(
      callAsErasure(admin, "replay_erasure_tombstone", [operationId]),
    ).resolves.toBe(operationId);
    expect(await tombstoneCount(admin, eligible)).toBe(1);

    const restored = await admin.query<{ deleted: boolean; snapshots: number; jobs: number }>(`
      select
        (select deleted_at is not null from public.contact
          where workspace_id = $1 and id = $2) as deleted,
        (select count(*)::int from public.calculator_snapshot
          where workspace_id = $1 and project_id = any($3::uuid[])) as snapshots,
        (select count(*)::int from public.project_calculation_job
          where workspace_id = $1 and project_id = any($3::uuid[])) as jobs
    `, [eligible.workspaceId, eligible.contactId, eligible.projects.map((project) => project.id)]);
    expect(restored.rows[0]).toEqual({ deleted: true, snapshots: 0, jobs: 0 });
  });
});
