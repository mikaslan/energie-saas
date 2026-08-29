import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";

async function fixtureProjectGraph(tx: TenantTx, wsId: string): Promise<{
  contactId: string;
  siteId: string;
  projectId: string;
}> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();
  await tx.execute(sql`
    insert into contact (
      id, workspace_id, display_name, email_primary, email_normalized
    ) values (
      ${contactId}::uuid, ${wsId}::uuid, 'Fixture Contact',
      ${`${contactId}@test.local`}, ${`${contactId}@test.local`}
    )
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${wsId}::uuid, ${contactId}::uuid, 'Fixture Site')
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    )
    select ${projectId}::uuid, ${wsId}::uuid, ${contactId}::uuid,
           ${siteId}::uuid, board.id, intake_column.id,
           'Fixture Project', 'fixture'
    from kanban_board board
    join kanban_column intake_column
      on intake_column.workspace_id = board.workspace_id
      and intake_column.board_id = board.id
      and intake_column.is_intake = true
      and intake_column.archived_at is null
    where board.workspace_id = ${wsId}::uuid
      and board.scope = 'residential'
      and board.is_default = true
      and board.archived_at is null
  `);
  return { contactId, siteId, projectId };
}

async function fixtureReceipt(tx: TenantTx, wsId: string): Promise<{
  receiptId: string;
  projectId: string;
}> {
  const { contactId, siteId, projectId } = await fixtureProjectGraph(tx, wsId);
  const receiptId = randomUUID();
  await tx.execute(sql`
    insert into inbound_receipt (
      id, workspace_id, source_key, submission_id, contract_version,
      body_sha256, auth_key_id, signed_at, submitted_at, received_at,
      producer_application, producer_git_revision, producer_environment,
      calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
      privacy_notice_version, privacy_notice_url, contact_resolution,
      contact_id, site_id, project_id
    ) values (
      ${receiptId}::uuid, ${wsId}::uuid, 'wmee-rechner-v3', ${randomUUID()}::uuid,
      'rechner-intake.v1', decode(repeat('00', 32), 'hex'), 'fixture-key',
      now(), now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)}, 'development',
      'wmee-solar.v1', '{}'::jsonb, 'offer_request',
      'art_6_1_b_precontractual', 'fixture', 'https://example.test/privacy',
      'created', ${contactId}::uuid, ${siteId}::uuid, ${projectId}::uuid
    )
  `);
  return { receiptId, projectId };
}

async function fixtureSnapshot(tx: TenantTx, wsId: string): Promise<{
  snapshotId: string;
  projectId: string;
}> {
  const { receiptId, projectId } = await fixtureReceipt(tx, wsId);
  const snapshotId = randomUUID();
  const snapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-08-29T00:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  await tx.execute(sql`
    insert into calculator_snapshot (
      id, workspace_id, receipt_id, project_id, schema_version,
      calculator_engine, result_integrity, investment_source, calculated_at,
      snapshot
    ) values (
      ${snapshotId}::uuid, ${wsId}::uuid, ${receiptId}::uuid, ${projectId}::uuid,
      'wmee-solar-snapshot.v1', 'wmee-solar.v1', 'client_reported_unverified',
      'market_estimate', now(), ${JSON.stringify(snapshot)}::jsonb
    )
  `);
  return { snapshotId, projectId };
}

const fixtureRequirements = {
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

const fixtureEnergyProfile = {
  schemaVersion: "site-energy-profile.v1",
  inputMode: "consumption",
  building: {
    type: { status: "unknown", value: null, source: "not_collected" },
    year: { status: "unknown", value: null, source: "not_collected" },
    heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
  },
  roofs: [{
    id: "fixture-roof",
    areaM2: 42,
    azimuthDeg: 0,
    tiltDeg: 35,
    type: "pitched",
    shading: { status: "unknown", value: null, source: "not_collected" },
    source: "user_drawn",
  }],
  consumption: {
    householdKwhPerYear: { status: "known", value: 4_200, source: "customer_metered" },
    electricityPriceCentsPerKwh: { status: "known", value: 36, source: "customer_input" },
    annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
    loadProfile: { status: "unknown", value: null, source: "not_collected" },
    evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
    evChargingPattern: { status: "unknown", value: null, source: "not_collected" },
    heatPumpKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    coolingKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    heatingAcKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    hotWaterKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
  },
  existingAssets: {
    pv: { status: "known_absent", source: "rechner_branch" },
    storage: { status: "unknown", source: "not_collected" },
    wallbox: { status: "unknown", source: "not_collected" },
    ev: { status: "unknown", source: "not_collected" },
  },
  provenance: {
    source: "rechner_snapshot",
    sourceSchemaVersion: "wmee-solar-snapshot.v1",
    sourceEngine: "wmee-solar.v1",
    roof: "user_drawn",
    consumption: "metered_kwh",
    electricityPrice: "customer",
    annualPriceIncrease: "default",
  },
};

async function fixtureEnergyGraph(tx: TenantTx, wsId: string): Promise<{
  actorId: string;
  siteId: string;
  projectId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
}> {
  const actorId = randomUUID();
  await tx.execute(sql`
    insert into user_identity (id, email)
    values (${actorId}::uuid, ${`${actorId}@energy-fixture.test`})
  `);
  await tx.execute(sql`
    insert into membership (workspace_id, user_id, role)
    values (${wsId}::uuid, ${actorId}::uuid, 'editor')
  `);

  const { snapshotId, projectId } = await fixtureSnapshot(tx, wsId);
  const projectRow = await tx.execute<{ site_id: string; [key: string]: unknown }>(sql`
    select site_id from project
    where workspace_id = ${wsId}::uuid and id = ${projectId}::uuid
  `);
  const siteId = projectRow.rows[0].site_id;
  const requirementId = randomUUID();
  const profileId = randomUUID();

  await tx.execute(sql`
    insert into project_requirement (
      id, workspace_id, project_id, revision, schema_version,
      source_snapshot_id, requirements
    ) values (
      ${requirementId}::uuid, ${wsId}::uuid, ${projectId}::uuid, 1,
      'project-requirements.rechner.v1', ${snapshotId}::uuid,
      ${JSON.stringify(fixtureRequirements)}::jsonb
    )
  `);
  await tx.execute(sql`
    insert into site_energy_profile (
      id, workspace_id, site_id, revision, schema_version, input_mode,
      source_kind, source_snapshot_id, source_project_id, address_revision,
      profile, profile_sha256, confirmed_profile_revision,
      confirmed_address_revision, confirmed_by, confirmed_at
    ) values (
      ${profileId}::uuid, ${wsId}::uuid, ${siteId}::uuid, 1,
      'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
      ${snapshotId}::uuid, ${projectId}::uuid, 1,
      ${JSON.stringify(fixtureEnergyProfile)}::jsonb,
      decode(repeat('11', 32), 'hex'), 1, 1, ${actorId}::uuid, now()
    )
  `);

  return { actorId, siteId, projectId, snapshotId, requirementId, profileId };
}

async function fixtureCalculationJob(tx: TenantTx, wsId: string): Promise<{
  actorId: string;
  siteId: string;
  projectId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
  jobId: string;
}> {
  const graph = await fixtureEnergyGraph(tx, wsId);
  const jobId = randomUUID();
  await tx.execute(sql`
    insert into project_calculation_job (
      id, workspace_id, project_id, site_id, address_revision,
      pin_confirmed_address_revision, profile_id, profile_revision,
      confirmed_profile_revision, confirmed_address_revision,
      requirement_id, requirement_revision, source_snapshot_id,
      reservation_key, provider_recipe_version, contract_version,
      model_id, model_version, source_revision, defaults_version,
      state, attempt_count, next_attempt_at, created_by
    ) values (
      ${jobId}::uuid, ${wsId}::uuid, ${graph.projectId}::uuid,
      ${graph.siteId}::uuid, 1, 1, ${graph.profileId}::uuid, 1, 1, 1,
      ${graph.requirementId}::uuid, 1, ${graph.snapshotId}::uuid,
      decode(repeat('22', 32), 'hex'), 'pvgis-5.3-sarah3-2020.v1',
      'planning-calculation.v1', 'wmee-solar', '1.0.0', ${"a".repeat(40)},
      'wmee-planning-defaults.v1', 'queued', 0, now(), ${graph.actorId}::uuid
    )
  `);
  return { ...graph, jobId };
}

// Factory legt GENAU EINE Zeile im gegebenen Workspace an (workspace-Zeile existiert bereits).
// Jede neue Mandantentabelle MUSS hier eine Factory registrieren, sonst wird
// tests/db/tenant-invariants.test.ts rot — das ist der Mechanismus, der die
// Tenant-Isolations-Invariante über alle künftigen Module (M1–M8) trägt.
export const tenantFixtures: Record<string, (tx: TenantTx, wsId: string) => Promise<void>> = {
  workspace: async () => {}, // Zeile wird vom Suite-Setup selbst angelegt
  // Der Workspace-Provisioning-Trigger legt diese Zeilen bereits an. Die
  // Lesebaseline wird in tenant-invariants.test.ts explizit berücksichtigt;
  // Cross-Writes brauchen unten eigene Overrides, damit sie weiterhin an RLS
  // statt an einem No-op geprüft werden.
  kanban_board: async () => {},
  kanban_column: async () => {},
  membership: async (tx, wsId) => {
    // KEIN select von user_identity: dessen SELECT-Policy (Migration 0002)
    // verlangt eine bereits existierende Membership im aktuellen Workspace —
    // für eine frische Identität ohne Membership ist das chicken-egg. Aus
    // demselben Grund auch kein "insert ... returning" (RETURNING unterliegt
    // ebenfalls der SELECT-Policy). Stattdessen: client-seitige UUID, die
    // direkt in beide Inserts eingesetzt wird.
    const userId = randomUUID();
    await tx.execute(
      sql`insert into user_identity (id, email) values (${userId}, ${`${randomUUID()}@test.local`})`,
    );
    await tx.execute(
      sql`insert into membership (workspace_id, user_id, role) values (${wsId}, ${userId}, 'viewer')`,
    );
  },
  domain_events: async (tx, wsId) => {
    await tx.execute(sql`insert into domain_events (workspace_id, aggregate_type, aggregate_id, event_type, actor)
      values (${wsId}::uuid, 'workspace', ${wsId}::uuid, 'fixture', 'system')`);
  },
  audit_log: async (tx, wsId) => {
    await tx.execute(sql`insert into audit_log (workspace_id, actor, action, resource, allowed)
      values (${wsId}::uuid, 'system', 'fixture', 'none', true)`);
  },
  contact: async (tx, wsId) => {
    const id = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
      values (${id}::uuid, ${wsId}::uuid, 'Fixture Contact',
        ${`${id}@test.local`}, ${`${id}@test.local`})
    `);
  },
  contact_legal_hold: async (tx, wsId) => {
    const contactId = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${wsId}::uuid, 'Legal Hold Fixture',
        ${`${contactId}@test.local`}, ${`${contactId}@test.local`})
    `);
    await tx.execute(sql`
      insert into contact_legal_hold (workspace_id, contact_id, reason)
      values (${wsId}::uuid, ${contactId}::uuid, 'fixture')
    `);
  },
  erasure_tombstone: async (tx, wsId) => {
    const contactId = randomUUID();
    const operationId = randomUUID();
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, deleted_at
      ) values (
        ${contactId}::uuid, ${wsId}::uuid,
        ${`geloescht-${contactId}`}, now()
      )
    `);
    await tx.execute(sql`
      insert into erasure_operation_locator (operation_id, scope_id)
      values (${operationId}::uuid, ${wsId}::uuid)
    `);
    await tx.execute(sql`
      insert into erasure_tombstone (
        operation_id, workspace_id, contact_id, reason, graph_sha256,
        tombstone_sha256, graph_ids, eligible_at, erased_at
      ) values (
        ${operationId}::uuid, ${wsId}::uuid, ${contactId}::uuid,
        'inactive_lead_24_months', decode(repeat('55', 32), 'hex'),
        decode(repeat('66', 32), 'hex'),
        ${JSON.stringify({
          contactId,
          legalHoldIds: [],
          siteIds: [],
          projectIds: [],
          profileIds: [],
          jobIds: [],
          revisionIds: [],
          requirementIds: [],
          snapshotIds: [],
          receiptIds: [],
        })}::jsonb,
        now() - interval '1 day', now()
      )
    `);
  },
  site: async (tx, wsId) => {
    await tx.execute(sql`insert into site (workspace_id, city) values (${wsId}::uuid, 'fixture')`);
  },
  project: async (tx, wsId) => {
    await fixtureProjectGraph(tx, wsId);
  },
  inbound_receipt: async (tx, wsId) => {
    await fixtureReceipt(tx, wsId);
  },
  calculator_snapshot: async (tx, wsId) => {
    await fixtureSnapshot(tx, wsId);
  },
  project_requirement: async (tx, wsId) => {
    const { snapshotId, projectId } = await fixtureSnapshot(tx, wsId);
    await tx.execute(sql`
      insert into project_requirement (
        workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${wsId}::uuid, ${projectId}::uuid, 1,
        'project-requirements.rechner.v1', ${snapshotId}::uuid,
        ${JSON.stringify(fixtureRequirements)}::jsonb
      )
    `);
  },
  site_energy_profile: async (tx, wsId) => {
    await fixtureEnergyGraph(tx, wsId);
  },
  project_calculation_job: async (tx, wsId) => {
    await fixtureCalculationJob(tx, wsId);
  },
  project_calculation_revision: async (tx, wsId) => {
    const graph = await fixtureCalculationJob(tx, wsId);
    const leaseToken = randomUUID();
    const inputSnapshot = {
      contractVersion: "planning-calculation.v1",
      canonicalizationVersion: "planning-jcs.v1",
      bindings: {
        workspaceId: wsId,
        projectId: graph.projectId,
        siteId: graph.siteId,
      },
    };
    const providerSnapshot = {
      provider: "pvgis",
      apiVersion: "5_3",
      recipeVersion: "pvgis-5.3-sarah3-2020.v1",
    };
    await tx.execute(sql`
      update project_calculation_job
      set state = 'running', attempt_count = 1, started_at = now(),
          lease_token = ${leaseToken}::uuid,
          lease_expires_at = now() + interval '5 minutes',
          input_sha256 = decode(repeat('33', 32), 'hex'),
          input_snapshot = ${JSON.stringify(inputSnapshot)}::jsonb,
          provider_snapshot = ${JSON.stringify(providerSnapshot)}::jsonb
      where workspace_id = ${wsId}::uuid and id = ${graph.jobId}::uuid
    `);
    const resultId = randomUUID();
    const result = {
      contractVersion: "planning-calculation.v1",
      model: {
        id: "wmee-solar",
        version: "1.0.0",
        sourceRevision: "a".repeat(40),
      },
      inputSha256: "33".repeat(32),
      resultSha256: "44".repeat(32),
      quality: "server_reproduced_estimate",
      validationStatus: "not_f4_reference_validated",
    };
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
        ${resultId}::uuid, ${wsId}::uuid, ${graph.projectId}::uuid,
        ${graph.siteId}::uuid, 1, ${graph.jobId}::uuid, 1, 1,
        ${graph.profileId}::uuid, 1, 1, 1, ${graph.requirementId}::uuid, 1,
        ${graph.snapshotId}::uuid, 'planning-calculation.v1', 'wmee-solar',
        '1.0.0', ${"a".repeat(40)}, 'wmee-planning-defaults.v1',
        'server_reproduced_estimate', 'not_f4_reference_validated',
        decode(repeat('33', 32), 'hex'), decode(repeat('44', 32), 'hex'),
        ${JSON.stringify(inputSnapshot)}::jsonb,
        ${JSON.stringify(providerSnapshot)}::jsonb,
        ${JSON.stringify(result)}::jsonb, ${graph.actorId}::uuid
      )
    `);
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Cross-Write-Test (Codex-Review #3): dieselbe Factory wird mit einem FREMDEN
// Workspace-Parameter in einer Transaktion des EIGENEN Workspace aufgerufen —
// der Insert MUSS an der with-check-Klausel scheitern.
//
// Für die meisten Tabellen leistet die normale Factory das schon (sie schreibt
// workspace_id = <fremd>). `workspace` selbst hat keine eigene Factory (die
// Zeile legt das Suite-Setup an), deshalb hier ein expliziter Fall: eine
// FRISCHE UUID (weder A noch B). Eine bereits existierende fremde ID würde am
// Primary Key scheitern und den Test vacuum-grün machen — nur mit einer
// frischen UUID kann AUSSCHLIESSLICH die RLS-with-check-Klausel greifen.
// ═══════════════════════════════════════════════════════════════════════
export const crossWriteOverrides: Record<string, (tx: TenantTx) => Promise<void>> = {
  workspace: async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${randomUUID()}::uuid, 'cross-write')`);
  },
  project: async (tx) => {
    await tx.execute(sql`
      insert into project (
        workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'Cross Write', 'fixture'
      )
    `);
  },
  kanban_board: async (tx) => {
    await tx.execute(sql`
      insert into kanban_board (workspace_id, name, scope, is_default)
      values (${randomUUID()}::uuid, 'Cross Write', 'residential', false)
    `);
  },
  kanban_column: async (tx) => {
    await tx.execute(sql`
      insert into kanban_column (
        workspace_id, board_id, name, column_type, position, color, is_intake
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'Cross Write', 'lead', 99, 'neutral', false
      )
    `);
  },
  inbound_receipt: async (tx) => {
    await tx.execute(sql`
      insert into inbound_receipt (
        workspace_id, source_key, submission_id, contract_version, body_sha256,
        auth_key_id, signed_at, submitted_at, producer_application,
        producer_git_revision, producer_environment, calculator_engine,
        acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${randomUUID()}::uuid, 'wmee-rechner-v3', ${randomUUID()}::uuid,
        'rechner-intake.v1', decode(repeat('00', 32), 'hex'), 'fixture-key',
        now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)}, 'development',
        'wmee-solar.v1', '{}'::jsonb, 'offer_request',
        'art_6_1_b_precontractual', 'fixture', 'https://example.test/privacy',
        'created', ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid
      )
    `);
  },
  calculator_snapshot: async (tx) => {
    const snapshot = {
      schemaVersion: "wmee-solar-snapshot.v1",
      calculatedAt: "2026-08-29T00:00:00.000Z",
      branch: "new_installation",
      questionnaireVariant: "short",
      resultIntegrity: "client_reported_unverified",
      inputs: {},
      provenance: { investment: "market_estimate" },
      result: { mode: "new_installation" },
    };
    await tx.execute(sql`
      insert into calculator_snapshot (
        workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source, calculated_at,
        snapshot
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(snapshot)}::jsonb
      )
    `);
  },
  project_requirement: async (tx) => {
    await tx.execute(sql`
      insert into project_requirement (
        workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1,
        'project-requirements.rechner.v1', ${randomUUID()}::uuid,
        ${JSON.stringify(fixtureRequirements)}::jsonb
      )
    `);
  },
};

// Globale Tabellen ohne workspace_id — jede Ausnahme ist hier begründet:
export const TENANT_EXEMPT = new Set<string>([
  // globale Identität, EIGENE membership-basierte RLS (Migration 0002), kein
  // workspace_id — von der generischen workspace_id-Suite ausgenommen, durch
  // tests/db/rls.test.ts abgedeckt
  "user_identity",
  // Migrations-Buchhaltung. Lebt tatsächlich im Schema "drizzle", nicht
  // "public" (drizzle-orm-Default), taucht in der public-Tabellenliste der
  // Suite also nie auf — der Eintrag ist harmlose, dokumentierende
  // Absicherung falls sich das je ändert.
  "__drizzle_migrations",
  // Globale, zweispaltige und WORM-geschützte ID-Route für
  // replay_erasure_tombstone(uuid). Sie enthält keine Fachdaten und bewusst
  // keine workspace_id-Spalte: Erst der Definer-Lookup setzt den Tenant-
  // Kontext, bevor der neunspaltige FORCE-RLS-Tombstone gelesen wird.
  "erasure_operation_locator",
]);

// ═══════════════════════════════════════════════════════════════════════
// EXAKTE Auth-Allowlist statt Präfix-Match (Codex-Review #4).
//
// Vorher stand hier TENANT_EXEMPT_PREFIXES = ["auth_", …]. Beim Doppeldefekt
// war das vakuum-grün: eine echte Mandantentabelle namens
// `auth_workspace_invitation`, bei der versehentlich auch workspace_id fehlt,
// wurde als Auth-Tabelle exemptiert UND erfüllte den Wächter anschließend
// gerade WEGEN der fehlenden Spalte. Mit exakten Namen ist jede unbekannte
// auth_*-Tabelle automatisch ein Suite-Fehler.
//
// Die Liste MUSS mit den modelName-Angaben in lib/auth.ts übereinstimmen.
// auth_rate_limit kommt aus rateLimit.modelName (Codex-Review #21).
//
// pg-boss steht bewusst NICHT hier: es legt seine Tabellen in einem EIGENEN
// Schema ("pgboss") an, nicht in "public" — die Suite scannt nur "public" und
// sieht sie deshalb ohnehin nie.
// ═══════════════════════════════════════════════════════════════════════
export const TENANT_EXEMPT_AUTH = new Set<string>([
  "auth_user",
  "auth_session",
  "auth_account",
  "auth_verification",
  "auth_rate_limit",
]);

// Regel 1 (UNIQUE (workspace_id, id)): existiert, damit ein
// zusammengesetzter FK auf die Tabelle zeigen kann. Append-only-Protokolle
// sind Blätter im Referenzgraph — auf sie zeigt nie ein FK.
export const COMPOSITE_KEY_EXEMPT = new Set<string>([
  "domain_events",
  "audit_log",
  // WORM-Blatt mit eigener operation_id-Identität; kein FK darf darauf zeigen.
  "erasure_tombstone",
]);

// Regel 3 (FK workspace_id -> workspace.id): koppelt die Löschbarkeit des
// Workspace an die der Zeile. Bei append-only-Protokollen (drizzle/0004,
// drizzle/0005 sperren DELETE und TRUNCATE) entstünde ein Workspace, der
// nicht mehr löschbar ist, ohne legalen Ausweg.
export const WORKSPACE_FK_EXEMPT = new Set<string>(["domain_events", "audit_log"]);

// ═══════════════════════════════════════════════════════════════════════
// Materialisierte Views (Codex-Review #5).
//
// Eine Matview speichert Cross-Tenant-Ergebnisse PHYSISCH und erbt die RLS
// ihrer Basistabellen NICHT. Die Architektur sieht materialisierte
// Reporting-Views vor — solange keine ein explizit tenantgeschütztes
// Cache-Muster mitbringt (eigener Schutznachweis + Eintrag hier), ist jede
// Matview in "public" ein Suite-Fehler.
// ═══════════════════════════════════════════════════════════════════════
export const MATVIEW_ALLOWLIST = new Set<string>([]);

export function isExempt(name: string): boolean {
  return TENANT_EXEMPT.has(name) || TENANT_EXEMPT_AUTH.has(name);
}
