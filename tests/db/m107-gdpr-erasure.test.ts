import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { canonicalizeOfferJson } from "../../lib/integrations/offers/contract";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
  CATALOG_IMPORT_QUEUE_OPTIONS,
  OFFER_ISSUANCE_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
  OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m107_erasure_migrator";
const RUNTIME_PASSWORD = "m107_erasure_runtime";
const WORKER_PASSWORD = "m107_erasure_worker";
const TOMBSTONE_REASON = "inactive_lead_24_months";
const PRE_M2_INDEX = 31;

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

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

type ProjectTaskErasureFixture = {
  taskId: string;
  assigneeId: string;
  checklistId: string;
  labelId: string;
};

type CatalogErasureFixture = {
  componentId: string;
  resolutionId: string;
};

type OfferErasureFixture = {
  offerId: string;
  variantId: string;
  revisionId: string;
  sectionId: string;
  lineId: string;
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

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-erasure-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(source, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspraefix 0..${maxIndex} ist nicht lueckenlos.`);
  }
  for (const entry of entries) {
    cpSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(target, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return target;
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
    await boss.createQueue("catalog.import.v1", CATALOG_IMPORT_QUEUE_OPTIONS);
    await boss.createQueue(
      "catalog.import.cleanup.v1",
      CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
    );
    await boss.createQueue("pdf.render", OFFER_PDF_QUEUE_OPTIONS);
    await boss.createQueue(
      "offer.release-candidate.render",
      OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
    );
    await boss.createQueue(
      "offer-issuance.render.v1",
      OFFER_ISSUANCE_QUEUE_OPTIONS,
    );
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

async function createOfferForErasure(
  admin: Pool,
  fixture: SubjectFixture,
  catalog: CatalogErasureFixture,
  options: { revisionCreatedAt?: Date } = {},
): Promise<OfferErasureFixture> {
  const project = fixture.projects[0];
  if (!project?.revisionId) throw new Error("Offer-Erasure-Fixture verlangt eine Berechnung.");

  const offerId = randomUUID();
  const variantId = randomUUID();
  const revisionId = randomUUID();
  const sectionId = randomUUID();
  const sectionDomainId = randomUUID();
  const lineId = randomUUID();
  const lineDomainId = randomUUID();
  const offerCreatedAt = fixture.oldAt.toISOString();
  const revisionCreatedAt = (options.revisionCreatedAt ?? fixture.oldAt).toISOString();
  const resolution = await admin.query<{
    resolution_sha256: string;
  }>(
    `select encode(resolution_sha256, 'hex') as resolution_sha256
       from public.project_catalog_resolution
      where workspace_id = $1 and id = $2`,
    [fixture.workspaceId, catalog.resolutionId],
  );
  const resolutionSha256 = resolution.rows[0]?.resolution_sha256;
  if (!resolutionSha256) throw new Error("Offer-Erasure-Aufloesung fehlt.");

  const sourceBindings = {
    projectId: project.id,
    contactId: fixture.contactId,
    siteId: project.siteId,
    inboundReceiptId: project.receiptId,
    inboundPayloadSha256: "10".repeat(32),
    requirementId: project.requirementId,
    requirementRevision: 1,
    calculationRevisionId: project.revisionId,
    calculationRevision: 1,
    calculationInputSha256: "40".repeat(32),
    calculationResultSha256: "50".repeat(32),
    resolutionId: catalog.resolutionId,
    resolutionRevision: 1,
    resolutionSha256,
  };
  const priceAudienceDecision = {
    audience: "b2c",
    confirmationCode: "b2c_operator_confirmed",
    confirmedBy: fixture.actorId,
    confirmedAt: offerCreatedAt,
  };
  const contactContext = {
    displayName: fixture.marker,
    emailPrimary: fixture.email,
    phoneE164: "+491701234567",
  };
  const installationSiteContext = {
    addressRevision: 1,
    formattedAddress: `${fixture.marker} Adresse`,
    street: "PII-Strasse",
    houseNumber: "7",
    postalCode: "10115",
    city: "PII-Stadt",
    country: "DE",
  };
  const lineSnapshot = {
    lineDomainId,
    position: 1,
    componentCategory: "other",
    positionType: "required",
    isHidden: false,
    quantityMilli: 1_000,
    product: {
      kind: "custom",
      displayName: `${fixture.marker} freie Position`,
      description: fixture.email,
      unit: "piece",
    },
    source: { kind: "custom" },
    salesPricing: { originalUnitNetCents: 100, effectiveUnitNetCents: 100 },
    purchasePricing: { originalUnitNetCents: 50, effectiveUnitNetCents: 50 },
    lineDiscountBps: 0,
    taxTreatment: "standard_19",
    taxRateBps: 1_900,
    computed: {
      lineBaseNetCents: 100,
      lineDiscountedNetCents: 100,
      sectionDiscountedNetCents: 100,
      finalSalesNetCents: 100,
      salesTaxCents: 19,
      salesGrossCents: 119,
      purchaseNetCents: 50,
    },
  };
  const sectionSnapshot = {
    sectionDomainId,
    position: 1,
    category: "other",
    title: `${fixture.marker} Sektion`,
    discountBps: 0,
    lines: [lineSnapshot],
  };
  const revisionSnapshotBody = {
    schemaVersion: "offer-variant-snapshot.v1",
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: fixture.workspaceId,
    offerId,
    variantId,
    revision: 1,
    sourceBindings,
    priceAudienceDecision,
    contactContext,
    installationSiteContext,
    variantName: "Basis",
    description: `${fixture.marker} Variante`,
    createdBy: fixture.actorId,
    createdAt: revisionCreatedAt,
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    sections: [sectionSnapshot],
  };
  const snapshotSha256 = createHash("sha256")
    .update(canonicalizeOfferJson(revisionSnapshotBody), "utf8")
    .digest("hex");
  const revisionSnapshot = { ...revisionSnapshotBody, snapshotSha256 };

  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [
      fixture.workspaceId,
    ]);
    await client.query(
      `insert into public.offer_number_series (
         workspace_id, series_year, last_sequence, created_at, updated_at
       ) values ($1, 2024, 1, $2, $2)`,
      [fixture.workspaceId, fixture.oldAt],
    );
    await client.query(
      `insert into public.offer (
         id, workspace_id, project_id, contact_id, site_id,
         offer_number, number_year, number_sequence,
         price_audience_decision, contact_context, installation_site_context,
         source_bindings, inbound_receipt_id, inbound_payload_sha256,
         requirement_id, requirement_revision, calculation_revision_id,
         calculation_revision, calculation_input_sha256,
         calculation_result_sha256, resolution_id, resolution_revision,
         resolution_sha256, create_digest, created_by, created_at, updated_at
       ) values (
         $1, $2, $3, $4, $5, 'ANG-2024-000001', 2024, 1,
         $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10,
         decode(repeat('10', 32), 'hex'), $11, 1, $12, 1,
         decode(repeat('40', 32), 'hex'), decode(repeat('50', 32), 'hex'),
         $13, 1, decode($14, 'hex'), decode(repeat('aa', 32), 'hex'),
         $15, $16::timestamptz, $16::timestamptz
       )`,
      [
        offerId,
        fixture.workspaceId,
        project.id,
        fixture.contactId,
        project.siteId,
        JSON.stringify(priceAudienceDecision),
        JSON.stringify(contactContext),
        JSON.stringify(installationSiteContext),
        JSON.stringify(sourceBindings),
        project.receiptId,
        project.requirementId,
        project.revisionId,
        catalog.resolutionId,
        resolutionSha256,
        fixture.actorId,
        offerCreatedAt,
      ],
    );
    await client.query(
      `insert into public.offer_variant (
         id, workspace_id, offer_id, ordinal, current_revision, name,
         description, created_by, created_at, updated_at
       ) values ($1, $2, $3, 1, 1, 'Basis', $4, $5, $6::timestamptz, $6::timestamptz)`,
      [
        variantId,
        fixture.workspaceId,
        offerId,
        `${fixture.marker} Variante`,
        fixture.actorId,
        fixture.oldAt.toISOString(),
      ],
    );
    await client.query(
      `insert into public.offer_variant_revision (
         id, workspace_id, offer_id, variant_id, project_id, revision,
         schema_version, canonicalization_version, revision_snapshot,
         snapshot_sha256, resolution_id, resolution_revision,
         resolution_sha256, basis_net_cents, basis_tax_cents,
         basis_gross_cents, optional_net_cents, optional_tax_cents,
         optional_gross_cents, created_by, created_at
       ) values (
         $1, $2, $3, $4, $5, 1, 'offer-variant-snapshot.v1',
         'offer-jcs.v1', $6::jsonb, decode($7, 'hex'), $8, 1,
         decode($9, 'hex'), 100, 19, 119, 0, 0, 0, $10, $11::timestamptz
       )`,
      [
        revisionId,
        fixture.workspaceId,
        offerId,
        variantId,
        project.id,
        JSON.stringify(revisionSnapshot),
        snapshotSha256,
        catalog.resolutionId,
        resolutionSha256,
        fixture.actorId,
        revisionCreatedAt,
      ],
    );
    await client.query(
      `insert into public.offer_variant_section (
         id, workspace_id, offer_id, variant_id, project_id, revision_id,
         revision, section_domain_id, position, category, title,
         discount_bps, section_snapshot, created_at
       ) values ($1, $2, $3, $4, $5, $6, 1, $7, 1, 'other', $8, 0,
                 $9::jsonb, $10::timestamptz)`,
      [
        sectionId,
        fixture.workspaceId,
        offerId,
        variantId,
        project.id,
        revisionId,
        sectionDomainId,
        `${fixture.marker} Sektion`,
        JSON.stringify(sectionSnapshot),
        revisionCreatedAt,
      ],
    );
    await client.query(
      `insert into public.offer_bom_line (
         id, workspace_id, offer_id, variant_id, project_id, revision_id,
         revision, section_id, section_domain_id, line_domain_id, position,
         component_category, position_type, is_hidden, quantity_milli, unit,
         source_kind, original_sales_unit_net_cents,
         effective_sales_unit_net_cents, original_purchase_unit_net_cents,
         effective_purchase_unit_net_cents, line_discount_bps, tax_treatment,
         tax_rate_bps, line_base_net_cents, line_discounted_net_cents,
         section_discounted_net_cents, final_sales_net_cents, sales_tax_cents,
         sales_gross_cents, purchase_net_cents, line_snapshot, created_at
       ) values (
         $1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 1, 'other', 'required',
         false, 1000, 'piece', 'custom', 100, 100, 50, 50, 0,
         'standard_19', 1900, 100, 100, 100, 100, 19, 119, 50,
         $10::jsonb, $11::timestamptz
       )`,
      [
        lineId,
        fixture.workspaceId,
        offerId,
        variantId,
        project.id,
        revisionId,
        sectionId,
        sectionDomainId,
        lineDomainId,
        JSON.stringify(lineSnapshot),
        revisionCreatedAt,
      ],
    );
    await client.query("set constraints all immediate");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { offerId, variantId, revisionId, sectionId, lineId };
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

async function createProjectTaskForErasure(
  admin: Pool,
  fixture: SubjectFixture,
  options: {
    ids?: ProjectTaskErasureFixture;
    occurredAt?: Date;
  } = {},
): Promise<ProjectTaskErasureFixture> {
  const project = fixture.projects[0];
  if (!project) throw new Error("Project-Task-Erasure-Fixture verlangt ein Project.");
  const membership = await admin.query<{ id: string }>(
    `select id from public.membership
      where workspace_id = $1 and user_id = $2`,
    [fixture.workspaceId, fixture.actorId],
  );
  const membershipId = membership.rows[0]?.id;
  if (!membershipId) throw new Error("Project-Task-Erasure-Fixture verlangt eine Membership.");

  const ids = options.ids ?? {
    taskId: randomUUID(),
    assigneeId: randomUUID(),
    checklistId: randomUUID(),
    labelId: randomUUID(),
  };
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [
      fixture.workspaceId,
    ]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [
      fixture.actorId,
    ]);
    await client.query(
      `insert into public.project_task (
         id, workspace_id, project_id, title, body_version, body,
         created_by, updated_by
       ) values (
         $1, $2, $3, $4, 'task-rich-text.v1',
         '{"type":"doc","content":[]}'::jsonb, $5, $5
       )`,
      [ids.taskId, fixture.workspaceId, project.id, fixture.marker, fixture.actorId],
    );
    await client.query(
      `insert into public.project_task_assignee (
         id, workspace_id, task_id, membership_id
       ) values ($1, $2, $3, $4)`,
      [ids.assigneeId, fixture.workspaceId, ids.taskId, membershipId],
    );
    await client.query(
      `insert into public.project_task_checklist_item (
         id, workspace_id, task_id, position, text
       ) values ($1, $2, $3, 0, $4)`,
      [ids.checklistId, fixture.workspaceId, ids.taskId, fixture.marker],
    );
    await client.query(
      `insert into public.project_task_label (
         id, workspace_id, task_id, position, name, color
       ) values ($1, $2, $3, 0, $4, 'blue')`,
      [ids.labelId, fixture.workspaceId, ids.taskId, fixture.marker],
    );
    await client.query("commit");

    if (options.occurredAt) {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(
        `update public.project_task
            set created_at = $1, updated_at = $1
          where workspace_id = $2 and id = $3`,
        [options.occurredAt, fixture.workspaceId, ids.taskId],
      );
      await client.query(
        `update public.project_task_assignee set created_at = $1
          where workspace_id = $2 and task_id = $3`,
        [options.occurredAt, fixture.workspaceId, ids.taskId],
      );
      await client.query(
        `update public.project_task_checklist_item
            set created_at = $1, updated_at = $1
          where workspace_id = $2 and task_id = $3`,
        [options.occurredAt, fixture.workspaceId, ids.taskId],
      );
      await client.query(
        `update public.project_task_label set created_at = $1
          where workspace_id = $2 and task_id = $3`,
        [options.occurredAt, fixture.workspaceId, ids.taskId],
      );
      await client.query("commit");
    }
    return ids;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

describe.sequential("M1-07/M2-01 DSGVO-Erasure- und Restorevertrag [M201-PRIVACY-01]", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let ownerPool: Pool;
  let runtimePool: Pool;
  let workerPool: Pool;
  let migrationPrefixDir: string;
  let eligible: SubjectFixture;
  let eligibleTask: ProjectTaskErasureFixture;
  let eligibleCatalog: CatalogErasureFixture;
  let eligibleOffer: OfferErasureFixture;
  let freshOfferSubject: SubjectFixture;
  let freshOffer: OfferErasureFixture;
  let freshTaskSubject: SubjectFixture;
  let freshTask: ProjectTaskErasureFixture;
  let legacyReplay: SubjectFixture;
  let recent: SubjectFixture;
  let held: SubjectFixture;
  let won: SubjectFixture;
  let running: SubjectFixture;
  let locked: SubjectFixture;
  let operationId: string;
  let legacyOperationId: string;
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
    migrationPrefixDir = migrationPrefixThrough(PRE_M2_INDEX);
    await migrate(drizzle(ownerPool), { migrationsFolder: migrationPrefixDir });
    legacyReplay = await createSubject(admin, { ageMonths: 25 });
    legacyOperationId = randomUUID();
    await callAsErasure(admin, "erase_inactive_lead", [
      legacyReplay.workspaceId,
      legacyReplay.contactId,
      legacyOperationId,
    ]);

    await migrate(drizzle(ownerPool), { migrationsFolder: resolve("drizzle") });
    await restoreSubject(admin, legacyReplay);
    const owner = await ownerPool.connect();
    try {
      await applyRoleContract(owner);
    } finally {
      owner.release();
    }
    runtimePool = new Pool({
      connectionString: serviceUrl(embedded, "app_runtime", RUNTIME_PASSWORD),
      max: 1,
    });
    workerPool = new Pool({
      connectionString: serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
      max: 1,
    });

    eligible = await createSubject(admin, { ageMonths: 25, sharedAndExclusive: true });
    eligibleTask = await createProjectTaskForErasure(admin, eligible, {
      occurredAt: eligible.oldAt,
    });
    eligibleCatalog = await createCatalogResolutionForErasure(admin, eligible);
    eligibleOffer = await createOfferForErasure(admin, eligible, eligibleCatalog);
    freshOfferSubject = await createSubject(admin, { ageMonths: 25 });
    const freshCatalog = await createCatalogResolutionForErasure(admin, freshOfferSubject);
    freshOffer = await createOfferForErasure(admin, freshOfferSubject, freshCatalog, {
      revisionCreatedAt: new Date(),
    });
    freshTaskSubject = await createSubject(admin, { ageMonths: 25 });
    freshTask = await createProjectTaskForErasure(admin, freshTaskSubject);
    recent = await createSubject(admin, { ageMonths: 23 });
    held = await createSubject(admin, { ageMonths: 25 });
    won = await createSubject(admin, { ageMonths: 25, outcome: "won" });
    running = await createSubject(admin, { ageMonths: 25, jobState: "running" });
    locked = await createSubject(admin, { ageMonths: 25 });
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end().catch(() => undefined);
    await runtimePool?.end().catch(() => undefined);
    await ownerPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
    if (migrationPrefixDir) rmSync(migrationPrefixDir, { recursive: true, force: true });
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
    const m201Helpers = await admin.query<{
      signature: string;
      owner: string;
      security_definer: boolean;
      config: string[] | null;
      public_execute: boolean;
      erasure_execute: boolean;
    }>(`
      select routine.proname || '(' || pg_catalog.oidvectortypes(routine.proargtypes) || ')'
               as signature,
             owner.rolname as owner,
             routine.prosecdef as security_definer,
             routine.proconfig as config,
             pg_catalog.has_function_privilege(
               'public', routine.oid, 'execute'
             ) as public_execute,
             pg_catalog.has_function_privilege(
               'app_erasure', routine.oid, 'execute'
             ) as erasure_execute
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_roles owner on owner.oid = routine.proowner
       where namespace.nspname = 'public'
         and routine.proname in (
           'build_inactive_lead_erasure_graph',
           'guard_erasure_tombstone_worm',
           'guard_offer_erasure_mutation'
         )
       order by signature
    `);
    expect.soft(m201Helpers.rows).toEqual([
      {
        signature: "build_inactive_lead_erasure_graph(uuid, uuid)",
        owner: "app_owner",
        security_definer: false,
        config: ["search_path=pg_catalog"],
        public_execute: false,
        erasure_execute: false,
      },
      {
        signature: "guard_erasure_tombstone_worm()",
        owner: "app_owner",
        security_definer: false,
        config: ["search_path=pg_catalog"],
        public_execute: false,
        erasure_execute: false,
      },
      {
        signature: "guard_offer_erasure_mutation()",
        owner: "app_owner",
        security_definer: false,
        config: ["search_path=pg_catalog"],
        public_execute: false,
        erasure_execute: false,
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

  it("wertet eine frische Projektaufgabe als Aktivitaet und behaelt ihren Graph", async () => {
    await expectErasureRejection(
      callAsErasure(admin, "erase_inactive_lead", [
        freshTaskSubject.workspaceId,
        freshTaskSubject.contactId,
        randomUUID(),
      ]),
      /erasure_not_eligible/,
    );
    expect(await tombstoneCount(admin, freshTaskSubject)).toBe(0);
    const retained = await admin.query<{ tasks: number; children: number }>(
      `select
         (select count(*)::int from public.project_task
           where workspace_id = $1) as tasks,
         (
           (select count(*) from public.project_task_assignee where workspace_id = $1)
           + (select count(*) from public.project_task_checklist_item where workspace_id = $1)
           + (select count(*) from public.project_task_label where workspace_id = $1)
         )::int as children`,
      [freshTaskSubject.workspaceId],
    );
    expect(retained.rows[0]).toEqual({ tasks: 1, children: 3 });
  });

  it("haelt normale Kindmutationen in app_runtime vom privaten Erasurepfad getrennt", async () => {
    const client = await runtimePool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [
        freshTaskSubject.workspaceId,
      ]);
      await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [
        freshTaskSubject.actorId,
      ]);
      const deleted = await client.query<{ id: string }>(
        `delete from public.project_task_label
          where workspace_id = $1 and task_id = $2
          returning id`,
        [freshTaskSubject.workspaceId, freshTask.taskId],
      );
      expect(deleted.rowCount).toBe(1);
      const updated = await client.query<{ id: string }>(
        `update public.project_task_checklist_item
            set text = text || ' runtime'
          where workspace_id = $1
          returning id`,
        [freshTaskSubject.workspaceId],
      );
      expect(updated.rowCount).toBe(1);
      await client.query("set constraints all immediate");
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("wertet eine frische Offer-Revision als Aktivitaet und sperrt Runtime-Loeschungen", async () => {
    await expectErasureRejection(
      callAsErasure(admin, "erase_inactive_lead", [
        freshOfferSubject.workspaceId,
        freshOfferSubject.contactId,
        randomUUID(),
      ]),
      /erasure_not_eligible/,
    );
    expect(await tombstoneCount(admin, freshOfferSubject)).toBe(0);

    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        freshOfferSubject.workspaceId,
        "delete from public.offer where workspace_id = $1 and id = $2",
        [freshOfferSubject.workspaceId, freshOffer.offerId],
      ),
    ).rejects.toThrow(/DELETE ist nur im Erasurevertrag erlaubt/);
    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        freshOfferSubject.workspaceId,
        "delete from public.offer_variant_revision where workspace_id = $1 and id = $2",
        [freshOfferSubject.workspaceId, freshOffer.revisionId],
      ),
    ).rejects.toThrow(/DELETE ist nur im Erasurevertrag erlaubt/);
  });

  it("wartet hinter einer Offer-Mutation in globaler Project-vor-Offer-Reihenfolge", async () => {
    const mutation = await ownerPool.connect();
    try {
      await mutation.query("begin");
      await mutation.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [
        freshOfferSubject.workspaceId,
      ]);
      await mutation.query(
        `select 1 from public.project
          where workspace_id = $1 and id = $2 for update`,
        [freshOfferSubject.workspaceId, freshOfferSubject.projects[0]!.id],
      );
      await mutation.query(
        `select 1 from public.offer
          where workspace_id = $1 and id = $2 for update`,
        [freshOfferSubject.workspaceId, freshOffer.offerId],
      );
      await expectErasureRejection(
        callAsErasure(
          admin,
          "erase_inactive_lead",
          [freshOfferSubject.workspaceId, freshOfferSubject.contactId, randomUUID()],
          "250ms",
        ),
        /lock timeout|could not obtain lock/i,
        "55P03",
      );
      expect(await tombstoneCount(admin, freshOfferSubject)).toBe(0);
      const retained = await admin.query<{ count: number }>(
        `select count(*)::int as count from public.offer
          where workspace_id = $1 and id = $2`,
        [freshOfferSubject.workspaceId, freshOffer.offerId],
      );
      expect(retained.rows[0]!.count).toBe(1);
    } finally {
      await mutation.query("rollback").catch(() => undefined);
      mutation.release();
    }
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
      offers: number;
      offer_variants: number;
      offer_revisions: number;
      offer_sections: number;
      offer_lines: number;
      offer_number_series: number;
      tasks: number;
      task_assignees: number;
      task_checklist_items: number;
      task_labels: number;
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
          where workspace_id = $1 and component_id = $6) as catalog_component_revisions,
        (select count(*)::int from public.offer
          where workspace_id = $1 and id = $7) as offers,
        (select count(*)::int from public.offer_variant
          where workspace_id = $1 and id = $8) as offer_variants,
        (select count(*)::int from public.offer_variant_revision
          where workspace_id = $1 and id = $9) as offer_revisions,
        (select count(*)::int from public.offer_variant_section
          where workspace_id = $1 and id = $10) as offer_sections,
        (select count(*)::int from public.offer_bom_line
          where workspace_id = $1 and id = $11) as offer_lines,
        (select count(*)::int from public.offer_number_series
          where workspace_id = $1 and series_year = 2024) as offer_number_series,
        (select count(*)::int from public.project_task
          where workspace_id = $1 and id = $12) as tasks,
        (select count(*)::int from public.project_task_assignee
          where workspace_id = $1 and task_id = $12) as task_assignees,
        (select count(*)::int from public.project_task_checklist_item
          where workspace_id = $1 and task_id = $12) as task_checklist_items,
        (select count(*)::int from public.project_task_label
          where workspace_id = $1 and task_id = $12) as task_labels
    `, [
      eligible.workspaceId,
      eligible.sites.map((site) => site.id),
      eligible.projects.map((project) => project.id),
      eligible.actorId,
      eligibleCatalog.resolutionId,
      eligibleCatalog.componentId,
      eligibleOffer.offerId,
      eligibleOffer.variantId,
      eligibleOffer.revisionId,
      eligibleOffer.sectionId,
      eligibleOffer.lineId,
      eligibleTask.taskId,
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
      offers: 0,
      offer_variants: 0,
      offer_revisions: 0,
      offer_sections: 0,
      offer_lines: 0,
      offer_number_series: 1,
      tasks: 0,
      task_assignees: 0,
      task_checklist_items: 0,
      task_labels: 0,
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
      graph_sha256_hex: string;
      tombstone_sha256_length: number;
      graph_ids: unknown;
      eligible_at: Date;
      erased_at: Date;
      document: string;
      graph_hash_valid: boolean;
      tombstone_hash_valid: boolean;
      event_graph_sha256: string;
      audit_graph_sha256: string;
    }>(`
      select operation_id, workspace_id, contact_id, reason,
             pg_catalog.octet_length(graph_sha256) as graph_sha256_length,
             pg_catalog.encode(graph_sha256, 'hex') as graph_sha256_hex,
             pg_catalog.octet_length(tombstone_sha256) as tombstone_sha256_length,
             graph_ids, eligible_at, erased_at,
             graph_sha256 = pg_catalog.sha256(
               pg_catalog.convert_to(graph_ids::text, 'UTF8')
             ) as graph_hash_valid,
             tombstone_sha256 = pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.concat_ws(
                 '|', operation_id::text, workspace_id::text, contact_id::text,
                 reason, pg_catalog.encode(graph_sha256, 'hex'),
                 pg_catalog.encode(pg_catalog.timestamptz_send(eligible_at), 'hex'),
                 pg_catalog.encode(pg_catalog.timestamptz_send(erased_at), 'hex')
               ), 'UTF8'
             )) as tombstone_hash_valid,
             (select event.payload->>'graphSha256'
                from public.domain_events as event
               where event.workspace_id = tombstone.workspace_id
                 and event.event_type = 'contact.erased'
                 and event.payload->>'operationId' = tombstone.operation_id::text
               limit 1) as event_graph_sha256,
             (select audit.details->>'graphSha256'
                from public.audit_log as audit
               where audit.workspace_id = tombstone.workspace_id
                 and audit.action = 'contact.erase_inactive_lead'
                 and audit.details->>'operationId' = tombstone.operation_id::text
               limit 1) as audit_graph_sha256,
             pg_catalog.to_jsonb(tombstone)::text as document
        from public.erasure_tombstone tombstone where operation_id = $1
    `, [operationId]);
    expect(tombstone.rows[0]).toMatchObject({
      operation_id: operationId,
      workspace_id: eligible.workspaceId,
      contact_id: eligible.contactId,
      reason: TOMBSTONE_REASON,
      graph_sha256_length: 32,
      tombstone_sha256_length: 32,
      graph_hash_valid: true,
      tombstone_hash_valid: true,
    });
    expect(tombstone.rows[0]!.event_graph_sha256).toBe(
      tombstone.rows[0]!.graph_sha256_hex,
    );
    expect(tombstone.rows[0]!.audit_graph_sha256).toBe(
      tombstone.rows[0]!.graph_sha256_hex,
    );
    expect(tombstone.rows[0]!.eligible_at).toBeInstanceOf(Date);
    expect(tombstone.rows[0]!.erased_at).toBeInstanceOf(Date);
    expect(tombstone.rows[0]!.graph_ids).toBeTypeOf("object");
    expect(tombstone.rows[0]!.graph_ids).toMatchObject({
      offerIds: [eligibleOffer.offerId],
      offerVariantIds: [eligibleOffer.variantId],
      offerVariantRevisionIds: [eligibleOffer.revisionId],
      offerVariantSectionIds: [eligibleOffer.sectionId],
      offerBomLineIds: [eligibleOffer.lineId],
      taskIds: [eligibleTask.taskId],
    });
    for (const [key, value] of Object.entries(
      tombstone.rows[0]!.graph_ids as Record<string, unknown>,
    )) {
      if (key === "contactId") continue;
      expect(value, `${key} muss deterministisch UUID-sortiert sein`).toEqual(
        [...(value as string[])].sort(),
      );
    }
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
    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        eligible.workspaceId,
        `insert into public.erasure_tombstone (
           operation_id, workspace_id, contact_id, reason, graph_sha256,
           tombstone_sha256, graph_ids, eligible_at, erased_at
         )
         select $2, workspace_id, contact_id, reason, graph_sha256,
                tombstone_sha256,
                jsonb_set(graph_ids, '{projectIds}', (
                  select jsonb_agg(value order by value desc)
                    from jsonb_array_elements(graph_ids->'projectIds') as item(value)
                )),
                eligible_at, erased_at
           from public.erasure_tombstone where operation_id = $1`,
        [operationId, randomUUID()],
      ),
    ).rejects.toThrow(/kanonisch sortierten ID-only-Graphen/);
    await expect(
      mutateTombstoneAsOwner(
        ownerPool,
        eligible.workspaceId,
        `insert into public.erasure_tombstone (
           operation_id, workspace_id, contact_id, reason, graph_sha256,
           tombstone_sha256, graph_ids, eligible_at, erased_at
         )
         select $2, workspace_id, contact_id, reason, graph_sha256,
                tombstone_sha256,
                graph_ids - array[
                  'offerIds', 'offerVariantIds', 'offerVariantRevisionIds',
                  'offerVariantSectionIds', 'offerBomLineIds'
                ]::text[],
                eligible_at, erased_at
           from public.erasure_tombstone where operation_id = $1`,
        [operationId, randomUUID()],
      ),
    ).rejects.toThrow(/keinen kanonischen ID-only-Graphen/);
  });

  it("löscht nach simuliertem Restore denselben Graph erneut und bleibt bei Replay einfach", async () => {
    expect(
      initialErasureCompleted,
      "Die noch fehlende Erasure-Implementierung verhinderte den initialen Lauf",
    ).toBe(true);
    await restoreSubject(admin, eligible);
    await createProjectTaskForErasure(admin, eligible, {
      ids: eligibleTask,
      occurredAt: eligible.oldAt,
    });
    expect(await tombstoneCount(admin, eligible)).toBe(1);
    await expect(
      callAsErasure(admin, "replay_erasure_tombstone", [operationId]),
    ).resolves.toBe(operationId);
    await expect(
      callAsErasure(admin, "replay_erasure_tombstone", [operationId]),
    ).resolves.toBe(operationId);
    expect(await tombstoneCount(admin, eligible)).toBe(1);

    const restored = await admin.query<{
      deleted: boolean;
      snapshots: number;
      jobs: number;
      tasks: number;
      task_children: number;
    }>(`
      select
        (select deleted_at is not null from public.contact
          where workspace_id = $1 and id = $2) as deleted,
        (select count(*)::int from public.calculator_snapshot
          where workspace_id = $1 and project_id = any($3::uuid[])) as snapshots,
        (select count(*)::int from public.project_calculation_job
          where workspace_id = $1 and project_id = any($3::uuid[])) as jobs,
        (select count(*)::int from public.project_task
          where workspace_id = $1 and id = $4) as tasks,
        (
          (select count(*) from public.project_task_assignee
            where workspace_id = $1 and task_id = $4)
          + (select count(*) from public.project_task_checklist_item
            where workspace_id = $1 and task_id = $4)
          + (select count(*) from public.project_task_label
            where workspace_id = $1 and task_id = $4)
        )::int as task_children
    `, [
      eligible.workspaceId,
      eligible.contactId,
      eligible.projects.map((project) => project.id),
      eligibleTask.taskId,
    ]);
    expect(restored.rows[0]).toEqual({
      deleted: true,
      snapshots: 0,
      jobs: 0,
      tasks: 0,
      task_children: 0,
    });
  });

  it("replayt einen vor M2-01 erzeugten Tombstone ohne Hash- oder Graphmigration idempotent", async () => {
    const stored = await admin.query<{
      graph_ids: Record<string, unknown>;
      graph_hash_valid: boolean;
    }>(
      `select graph_ids,
              graph_sha256 = sha256(convert_to(graph_ids::text, 'UTF8'))
                as graph_hash_valid
         from public.erasure_tombstone
        where operation_id = $1`,
      [legacyOperationId],
    );
    expect(stored.rows[0]!.graph_hash_valid).toBe(true);
    expect(Object.keys(stored.rows[0]!.graph_ids).sort()).toEqual([
      "contactId",
      "jobIds",
      "legalHoldIds",
      "profileIds",
      "projectIds",
      "receiptIds",
      "requirementIds",
      "revisionIds",
      "siteIds",
      "snapshotIds",
    ]);

    await expect(
      callAsErasure(admin, "replay_erasure_tombstone", [legacyOperationId]),
    ).resolves.toBe(legacyOperationId);
    await expect(
      callAsErasure(admin, "replay_erasure_tombstone", [legacyOperationId]),
    ).resolves.toBe(legacyOperationId);

    const erased = await admin.query<{
      deleted: boolean;
      jobs: number;
      tombstones: number;
    }>(
      `select
         (select deleted_at is not null from public.contact
           where workspace_id = $1 and id = $2) as deleted,
         (select count(*)::int from public.project_calculation_job
           where workspace_id = $1 and project_id = any($3::uuid[])) as jobs,
         (select count(*)::int from public.erasure_tombstone
           where operation_id = $4) as tombstones`,
      [
        legacyReplay.workspaceId,
        legacyReplay.contactId,
        legacyReplay.projects.map((project) => project.id),
        legacyOperationId,
      ],
    );
    expect(erased.rows[0]).toEqual({ deleted: true, jobs: 0, tombstones: 1 });
  });
});
