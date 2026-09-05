import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  canonicalizeCatalogJson,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
  type CatalogComponentCreateCommandV1,
} from "@/lib/integrations/catalog/contract";
import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256,
  catalogCsvMappingPersistenceEnvelope,
  catalogImportRowPersistenceEnvelope,
  sealCatalogImportRowCommand,
} from "@/lib/integrations/catalog/import-contract";
import { canonicalizeOfferJson } from "@/lib/integrations/offers/contract";
import { hashOfferPdfDraftInput } from "@/lib/integrations/offers/pdf-contract";
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
      id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
    ) values (
      ${contactId}::uuid, ${wsId}::uuid, 'Fixture Contact', 'Fixture', 'Contact',
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

// M1-11b: erzeugt ein cannot_fulfill-Projekt + eine queued Outbox-Zeile.
// Die Outcome-Trigger werden fuer das Fixture-Update deaktiviert, weil der
// direkte UPDATE weder den Transition-Guard (Actor/Rolle) noch die
// Evidenz-Trigger (nested trigger depth) durchlaufen soll.
async function fixtureCustomerNotificationGraph(
  tx: TenantTx,
  wsId: string,
): Promise<{ projectId: string; notificationId: string }> {
  const { projectId } = await fixtureProjectGraph(tx, wsId);
  await tx.execute(sql`alter table project disable trigger project_outcome_mutation_guard`);
  await tx.execute(sql`alter table project disable trigger project_outcome_evidence`);
  await tx.execute(sql`
    update project
       set outcome = 'cannot_fulfill', outcome_revision = 1,
           closed_at = now(), updated_at = now()
     where workspace_id = ${wsId}::uuid and id = ${projectId}::uuid
  `);
  await tx.execute(sql`alter table project enable trigger project_outcome_mutation_guard`);
  await tx.execute(sql`alter table project enable trigger project_outcome_evidence`);
  const notificationId = randomUUID();
  await tx.execute(sql`
    insert into customer_notification (id, workspace_id, project_id, idempotency_key)
    values (${notificationId}::uuid, ${wsId}::uuid, ${projectId}::uuid,
      ${`cannot-fulfil:${projectId}`})
  `);
  return { projectId, notificationId };
}

async function fixtureMembership(
  tx: TenantTx,
  wsId: string,
  role: "viewer" | "editor" | "admin" = "viewer",
  capabilities: string | null = null,
): Promise<{
  userId: string;
  membershipId: string;
}> {
  // Keine RETURNING-Klausel: die SELECT-Policy von user_identity setzt bereits
  // eine Membership voraus. Clientseitige IDs halten den Bootstrap eindeutig.
  const userId = randomUUID();
  const membershipId = randomUUID();
  await tx.execute(sql`
    insert into user_identity (id, email)
    values (${userId}::uuid, ${`${randomUUID()}@test.local`})
  `);
  await tx.execute(sql`
    insert into membership (id, workspace_id, user_id, role, capabilities)
    values (${membershipId}::uuid, ${wsId}::uuid, ${userId}::uuid, ${role}, ${capabilities ?? "{}"}::jsonb)
  `);
  return { userId, membershipId };
}

async function fixtureProjectTaskGraph(tx: TenantTx, wsId: string): Promise<void> {
  const { userId, membershipId } = await fixtureMembership(tx, wsId, "editor");
  await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
  const { projectId } = await fixtureProjectGraph(tx, wsId);
  const taskId = randomUUID();
  await tx.execute(sql`
    insert into project_task (
      id, workspace_id, project_id, title, body_version, body,
      created_by, updated_by
    ) values (
      ${taskId}::uuid, ${wsId}::uuid, ${projectId}::uuid, 'Fixture Task',
      'task-rich-text.v1', '{"type":"doc","content":[]}'::jsonb,
      ${userId}::uuid, ${userId}::uuid
    )
  `);
  await tx.execute(sql`
    insert into project_task_assignee (workspace_id, task_id, membership_id)
    values (${wsId}::uuid, ${taskId}::uuid, ${membershipId}::uuid)
  `);
  await tx.execute(sql`
    insert into project_task_checklist_item (workspace_id, task_id, position, text)
    values (${wsId}::uuid, ${taskId}::uuid, 0, 'Fixture Checklist')
  `);
  await tx.execute(sql`
    insert into project_task_label (workspace_id, task_id, position, name, color)
    values (${wsId}::uuid, ${taskId}::uuid, 0, 'Fixture Label', 'blue')
  `);
}

async function fixtureProjectNoteGraph(tx: TenantTx, wsId: string): Promise<void> {
  const { userId } = await fixtureMembership(tx, wsId, "editor");
  await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
  const { projectId } = await fixtureProjectGraph(tx, wsId);
  await tx.execute(sql`
    insert into project_note (
      id, workspace_id, project_id, parent_type, text_version, text_markdown,
      revision, created_by
    ) values (
      ${randomUUID()}::uuid, ${wsId}::uuid, ${projectId}::uuid,
      'project', 'note-text.v1', 'Fixture Note', 1, ${userId}::uuid
    )
  `);
}

async function fixtureProjectAppointmentGraph(tx: TenantTx, wsId: string): Promise<void> {
  const { userId, membershipId } = await fixtureMembership(tx, wsId, "editor");
  await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
  const { projectId } = await fixtureProjectGraph(tx, wsId);
  const calendarId = randomUUID();
  await tx.execute(sql`
    insert into calendar (id, workspace_id, name, calendar_type, created_by)
    values (${calendarId}::uuid, ${wsId}::uuid, ${`Fixture Calendar ${userId}`}, 'tenancy', ${userId}::uuid)
  `);
  const appointmentId = randomUUID();
  await tx.execute(sql`
    insert into project_appointment (
      id, workspace_id, project_id, title, start_at, end_at, all_day,
      appointment_type, revision, calendar_id, created_by
    ) values (
      ${appointmentId}::uuid, ${wsId}::uuid, ${projectId}::uuid, 'Fixture Appointment',
      now() - interval '1 hour', now() + interval '1 hour', false,
      'on_site', 1, ${calendarId}::uuid, ${userId}::uuid
    )
  `);
  await tx.execute(sql`
    insert into project_appointment_attendee (workspace_id, appointment_id, membership_id)
    values (${wsId}::uuid, ${appointmentId}::uuid, ${membershipId}::uuid)
  `);
}

async function fixtureCalendarCategoryGraph(tx: TenantTx, wsId: string): Promise<void> {
  await tx.execute(sql`
    insert into calendar_category (workspace_id, name, "order")
    values (${wsId}::uuid, ${`Fixture Category ${randomUUID()}`}, 0)
  `);
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

async function fixtureCatalogImportGraph(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from catalog_import_job
     where workspace_id = ${wsId}::uuid
     limit 1
  `);
  if (existing.rows.length > 0) return;

  const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
  const actorId = randomUUID();
  const jobId = randomUUID();
  const leaseToken = randomUUID();
  const componentId = randomUUID();
  const internalSku = `IMPORT-${componentId.slice(0, 8).toUpperCase()}`;
  await tx.execute(sql`
    insert into user_identity (id, email)
    values (${actorId}::uuid, ${`${actorId}@catalog-import-fixture.test`})
  `);
  await tx.execute(sql`
    insert into membership (workspace_id, user_id, role)
    values (${wsId}::uuid, ${actorId}::uuid, 'editor')
  `);

  const requiredMappingFields = [
    "internalSku",
    "componentType",
    "displayName",
    "manufacturer",
    "model",
    "unit",
    "technicalSourceKind",
    "technicalReference",
    "technicalObservedOn",
    "technicalRightsBasis",
    "purchasePriceNet",
    "purchaseSourceKind",
    "purchaseReference",
    "purchaseObservedOn",
    "purchaseRightsBasis",
    "salesPriceNet",
    "salesSourceKind",
    "salesReference",
    "salesObservedOn",
    "salesRightsBasis",
  ] as const;
  const mappingEnvelope = catalogCsvMappingPersistenceEnvelope({
    schemaVersion: "catalog-csv-column-mapping.v1",
    columns: requiredMappingFields.map((field, index) => ({
      field,
      sourceHeader: `fixture-header-${index}`,
    })),
  });
  const fileSha256 = digest("synthetic catalog import tenant fixture");
  const sourceCommand = {
    schemaVersion: "catalog-component-create-command.v1",
    internalSku,
    componentType: "module",
    presentation: {
      displayName: "Synthetisches Importmodul",
      manufacturer: "WMEE Fixture",
      model: internalSku,
      unit: "piece",
      keyPoints: ["Keine realen Produktdaten"],
      image: null,
      datasheet: null,
    },
    technicalData: {
      schemaVersion: "module.v1",
      nominalPowerWatts: 440,
    },
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 7_900,
      salesPriceNetCents: 12_900,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: "synthetic-import-purchase-fixture",
        observedOn: "2026-08-31",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: "synthetic-import-sales-fixture",
        observedOn: "2026-08-31",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "manufacturer_datasheet",
      reference: "synthetic-import-technical-fixture",
      observedOn: "2026-08-31",
      rightsBasis: "manufacturer_published",
      sourceDocumentSha256: null,
    },
  } satisfies CatalogComponentCreateCommandV1;
  const sourceCommandSha256 = digest(canonicalizeCatalogJson(sourceCommand));
  const previewRowBody = {
    status: "valid" as const,
    rowNumber: 2,
    normalizedSku: internalSku,
    commandSha256: sourceCommandSha256,
    command: sourceCommand,
  };
  const sourceRow = {
    ...previewRowBody,
    rowSha256: digest(canonicalizeCatalogJson(previewRowBody)),
  };
  const targetSnapshot = sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: wsId,
      componentId,
      revision: 1,
      internalSku,
      componentType: "module",
    },
    presentation: sourceCommand.presentation,
    technicalData: sourceCommand.technicalData,
    commercial: sourceCommand.commercial,
    technicalProvenance: sourceCommand.technicalProvenance,
  });
  const rowCommand = sealCatalogImportRowCommand({
    fileSha256,
    mappingSha256: mappingEnvelope.sha256,
    sourceRow,
    operation: "create",
    targetComponentId: componentId,
    expected: null,
    sealedTarget: targetSnapshot,
  });
  const rowEnvelope = catalogImportRowPersistenceEnvelope(rowCommand);

  await tx.execute(sql`
    insert into catalog_import_job (
      id, workspace_id, intent_id, reservation_key,
      file_name, file_size_bytes, file_sha256, encoding, delimiter,
      contract_version, parser_version, mapping_version,
      mapping_snapshot, mapping_body_canonical, mapping_sha256,
      total_count, valid_count, invalid_count, sensitive_payload_bytes,
      state, created_by, preview_expires_at
    ) values (
      ${jobId}::uuid, ${wsId}::uuid, ${randomUUID()}::uuid,
      decode(${digest(`catalog-import:${jobId}`)}, 'hex'),
      'synthetic-fixture.csv', 128, decode(${fileSha256}, 'hex'),
      'utf-8', ';', 'catalog-csv-import.v1', 'papaparse-5.7.0-wmee.v1',
      'catalog-csv-column-mapping.v1',
      ${JSON.stringify(mappingEnvelope.snapshot)}::jsonb,
      pg_catalog.convert_to(${mappingEnvelope.bodyCanonical}, 'UTF8'),
      decode(${mappingEnvelope.sha256}, 'hex'),
      1, 1, 0, 1, 'ready_for_review', ${actorId}::uuid,
      pg_catalog.transaction_timestamp() + interval '7 days'
    )
  `);
  await tx.execute(sql`
    insert into catalog_import_row (
      workspace_id, job_id, row_number, validation_status,
      normalized_sku, operation, command_snapshot,
      preview_row_body_canonical, source_command_body_canonical,
      row_command_body_canonical, row_sha256, source_command_sha256,
      row_command_sha256, target_component_id, sealed_target_snapshot,
      sealed_target_body_canonical, target_snapshot_sha256,
      sensitive_payload_bytes
    ) values (
      ${wsId}::uuid, ${jobId}::uuid, 2, 'valid', ${internalSku}, 'create',
      ${JSON.stringify(rowEnvelope.command)}::jsonb,
      pg_catalog.convert_to(${rowEnvelope.previewRowBodyCanonical}, 'UTF8'),
      pg_catalog.convert_to(${rowEnvelope.sourceCommandBodyCanonical}, 'UTF8'),
      pg_catalog.convert_to(${rowEnvelope.rowCommandBodyCanonical}, 'UTF8'),
      decode(${sourceRow.rowSha256}, 'hex'),
      decode(${rowEnvelope.sourceCommandSha256}, 'hex'),
      decode(${rowEnvelope.rowCommandSha256}, 'hex'),
      ${componentId}::uuid, ${JSON.stringify(targetSnapshot)}::jsonb,
      pg_catalog.convert_to(${rowEnvelope.sealedTargetBodyCanonical!}, 'UTF8'),
      decode(${rowEnvelope.targetSnapshotSha256}, 'hex'), 0
    )
  `);
  await tx.execute(sql`
    with derived as (
      select job.workspace_id, job.id,
             (
               pg_catalog.octet_length(pg_catalog.convert_to(job.file_name, 'UTF8'))
               + pg_catalog.octet_length(pg_catalog.convert_to(
                   job.mapping_snapshot::text,
                   'UTF8'
                 ))
               + pg_catalog.octet_length(job.mapping_body_canonical)
               + (
                   select pg_catalog.sum(import_row.sensitive_payload_bytes)::integer
                     from catalog_import_row as import_row
                    where import_row.workspace_id = job.workspace_id
                      and import_row.job_id = job.id
                 )
             )::integer as payload_bytes
        from catalog_import_job as job
       where job.workspace_id = ${wsId}::uuid and job.id = ${jobId}::uuid
    )
    update catalog_import_job as job
       set sensitive_payload_bytes = derived.payload_bytes
      from derived
     where job.workspace_id = derived.workspace_id and job.id = derived.id
  `);
  await tx.execute(sql`
    update catalog_import_job
       set state = 'queued', execution_actor_id = ${actorId}::uuid,
           attestation_version = 'catalog-import-rights-attestation.v1',
           attestation_text_sha256 = decode(${CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256}, 'hex'),
           attested_by = ${actorId}::uuid,
           attested_at = pg_catalog.transaction_timestamp(),
           started_at = pg_catalog.transaction_timestamp(),
           next_attempt_at = pg_catalog.transaction_timestamp(),
           updated_at = pg_catalog.transaction_timestamp()
     where workspace_id = ${wsId}::uuid and id = ${jobId}::uuid
  `);
  await tx.execute(sql`
    update catalog_import_job
       set state = 'running', lease_generation = lease_generation + 1,
           lease_token = ${leaseToken}::uuid,
           lease_row_numbers = array[2]::integer[],
           lease_expires_at = pg_catalog.transaction_timestamp() + interval '3 minutes',
           next_attempt_at = null, updated_at = pg_catalog.transaction_timestamp()
     where workspace_id = ${wsId}::uuid and id = ${jobId}::uuid
  `);
  await tx.execute(sql`
    insert into catalog_import_row_result (
      workspace_id, job_id, row_number, result_state, error_code
    ) values (
      ${wsId}::uuid, ${jobId}::uuid, 2, 'conflict', 'status_drift'
    )
  `);
  await tx.execute(sql`
    select public.complete_catalog_import_batch_v1(
      ${wsId}::uuid, ${jobId}::uuid, ${leaseToken}::uuid, 1::bigint
    )
  `);
}

async function fixtureCatalogGraph(tx: TenantTx, wsId: string): Promise<void> {
  await tenantFixtures.project_calculation_revision(tx, wsId);
  const calculation = await tx.execute<{
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
     where revision.workspace_id = ${wsId}::uuid
     order by revision.created_at desc, revision.id desc
     limit 1
  `);
  const row = calculation.rows[0];
  if (!row) throw new Error("Catalog-Fixture braucht eine Calculation-Revision.");

  const componentId = randomUUID();
  const internalSku = `FIX-${componentId.slice(0, 8).toUpperCase()}`;
  const snapshot = sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: wsId,
      componentId,
      revision: 1,
      internalSku,
      componentType: "battery",
    },
    presentation: {
      displayName: "Synthetischer Fixture-Speicher",
      manufacturer: "WMEE Fixture",
      model: internalSku,
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
      purchasePriceNetCents: 250_000,
      salesPriceNetCents: 390_000,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: "synthetic-purchase-fixture",
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: "synthetic-sales-fixture",
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "manufacturer_datasheet",
      reference: "synthetic-technical-fixture",
      observedOn: "2026-08-29",
      rightsBasis: "manufacturer_published",
      sourceDocumentSha256: null,
    },
  });
  await tx.execute(sql`
    insert into catalog_component (
      id, workspace_id, internal_sku, component_type, status,
      current_revision, created_by
    ) values (
      ${componentId}::uuid, ${wsId}::uuid, ${internalSku}, 'battery',
      'draft', 0, ${row.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    insert into catalog_component_revision (
      workspace_id, component_id, revision, component_type, schema_version,
      canonicalization_version, revision_snapshot, snapshot_sha256, created_by
    ) values (
      ${wsId}::uuid, ${componentId}::uuid, 1, 'battery',
      ${snapshot.schemaVersion}, ${snapshot.canonicalizationVersion},
      ${JSON.stringify(snapshot)}::jsonb, decode(${snapshot.snapshotSha256}, 'hex'),
      ${row.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    update catalog_component set status = 'active', updated_at = now()
     where workspace_id = ${wsId}::uuid and id = ${componentId}::uuid
  `);

  const lineId = randomUUID();
  const resolution = sealProjectCatalogResolution({
    schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    revision: 1,
    bindings: {
      workspaceId: wsId,
      projectId: row.project_id,
      siteId: row.site_id,
      requirementId: row.requirement_id,
      requirementRevision: row.requirement_revision,
      calculationRevisionId: row.calculation_revision_id,
      calculationRevision: row.calculation_revision,
      calculationInputSha256: row.input_sha256,
      calculationResultSha256: row.result_sha256,
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
      componentSnapshotSha256: snapshot.snapshotSha256,
      componentSnapshot: snapshot,
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
    confirmedBy: row.actor_id,
    confirmedAt: "2026-08-29T18:00:00.000Z",
  });
  const resolutionId = randomUUID();
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
      ${resolutionId}::uuid, ${wsId}::uuid, ${row.project_id}::uuid,
      ${row.site_id}::uuid, 1, ${row.requirement_id}::uuid,
      ${row.requirement_revision}, ${row.calculation_revision_id}::uuid,
      ${row.calculation_revision}, decode(${row.input_sha256}, 'hex'),
      decode(${row.result_sha256}, 'hex'), 'server_reproduced_estimate',
      'not_f4_reference_validated', ${resolution.schemaVersion},
      ${resolution.canonicalizationVersion}, ${JSON.stringify(resolution)}::jsonb,
      decode(${resolution.resolutionSha256}, 'hex'), ${row.actor_id}::uuid,
      ${resolution.confirmedAt}::timestamptz
    )
  `);
  await tx.execute(sql`
    insert into project_catalog_resolution_line (
      id, workspace_id, resolution_id, project_id, position, quantity,
      catalog_component_id, catalog_component_revision,
      component_snapshot_sha256
    ) values (
      ${lineId}::uuid, ${wsId}::uuid, ${resolutionId}::uuid,
      ${row.project_id}::uuid, 1, 1, ${componentId}::uuid, 1,
      decode(${snapshot.snapshotSha256}, 'hex')
    )
  `);
}

type FixtureOfferSource = {
  workspace_id: string;
  actor_id: string;
  contact_id: string;
  site_id: string;
  project_id: string;
  inbound_receipt_id: string;
  inbound_payload_sha256: string;
  requirement_id: string;
  requirement_revision: number;
  calculation_revision_id: string;
  calculation_revision: number;
  calculation_input_sha256: string;
  calculation_result_sha256: string;
  resolution_id: string;
  resolution_revision: number;
  resolution_sha256: string;
  [key: string]: unknown;
};

/**
 * Legt genau einen vollständigen, von den deferred DB-Guards akzeptierten
 * Offer-Graphen an. Alle sieben M2-01-Tenanttabellen teilen sich diese
 * Factory: Der erste Aufruf erzeugt den Graphen, spätere Aufrufe finden ihn
 * bereits vor. So prüft die generische Tenant-Suite echte Rows statt die
 * neuen Tabellen zu exemptieren.
 */
async function fixtureOfferGraph(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from offer where workspace_id = ${wsId}::uuid limit 1
  `);
  if (existing.rows[0]) return;

  const resolution = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from project_catalog_resolution
     where workspace_id = ${wsId}::uuid
     limit 1
  `);
  if (!resolution.rows[0]) await fixtureCatalogGraph(tx, wsId);

  const sourceResult = await tx.execute<FixtureOfferSource>(sql`
    select resolution.workspace_id,
           resolution.confirmed_by as actor_id,
           project.contact_id,
           project.site_id,
           project.id as project_id,
           receipt.id as inbound_receipt_id,
           encode(receipt.body_sha256, 'hex') as inbound_payload_sha256,
           resolution.requirement_id,
           resolution.requirement_revision,
           resolution.calculation_revision_id,
           resolution.calculation_revision,
           encode(resolution.calculation_input_sha256, 'hex') as calculation_input_sha256,
           encode(resolution.calculation_result_sha256, 'hex') as calculation_result_sha256,
           resolution.id as resolution_id,
           resolution.revision as resolution_revision,
           encode(resolution.resolution_sha256, 'hex') as resolution_sha256
      from project_catalog_resolution as resolution
      join project
        on project.workspace_id = resolution.workspace_id
       and project.id = resolution.project_id
      join inbound_receipt as receipt
        on receipt.workspace_id = project.workspace_id
       and receipt.project_id = project.id
     where resolution.workspace_id = ${wsId}::uuid
     order by resolution.revision desc
     limit 1
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Offer-Tenant-Fixture braucht einen Source-Graphen.");

  const offerId = randomUUID();
  const variantId = randomUUID();
  const revisionId = randomUUID();
  const sectionId = randomUUID();
  const sectionDomainId = randomUUID();
  const lineId = randomUUID();
  const lineDomainId = randomUUID();
  const createdAt = "2026-08-29T12:00:00.000Z";
  const contactContext = {
    displayName: "Offer Tenant Fixture",
    emailPrimary: null,
    phoneE164: null,
  };
  const installationSiteContext = {
    addressRevision: 1,
    formattedAddress: "Testweg 1, 10115 Berlin",
    street: "Testweg",
    houseNumber: "1",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
  };
  const bindings = {
    projectId: source.project_id,
    contactId: source.contact_id,
    siteId: source.site_id,
    inboundReceiptId: source.inbound_receipt_id,
    inboundPayloadSha256: source.inbound_payload_sha256,
    requirementId: source.requirement_id,
    requirementRevision: source.requirement_revision,
    calculationRevisionId: source.calculation_revision_id,
    calculationRevision: source.calculation_revision,
    calculationInputSha256: source.calculation_input_sha256,
    calculationResultSha256: source.calculation_result_sha256,
    resolutionId: source.resolution_id,
    resolutionRevision: source.resolution_revision,
    resolutionSha256: source.resolution_sha256,
  };
  const audienceDecision = {
    audience: "b2c",
    confirmationCode: "b2c_operator_confirmed",
    confirmedBy: source.actor_id,
    confirmedAt: createdAt,
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
      displayName: "Freie Tenant-Fixture-Position",
      description: null,
      unit: "piece",
    },
    source: {
      kind: "custom",
      enteredBy: source.actor_id,
      enteredAt: createdAt,
    },
    salesPricing: {
      originalUnitNetCents: 100,
      effectiveUnitNetCents: 100,
      provenance: {
        kind: "custom",
        enteredBy: source.actor_id,
        enteredAt: createdAt,
      },
    },
    purchasePricing: {
      originalUnitNetCents: 50,
      effectiveUnitNetCents: 50,
      provenance: {
        kind: "custom",
        enteredBy: source.actor_id,
        enteredAt: createdAt,
      },
    },
    lineDiscountBps: 0,
    taxTreatment: "standard_19",
    taxRateBps: 1_900,
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: source.actor_id,
      selectedAt: createdAt,
    },
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
    title: "Tenant Fixture",
    discountBps: 0,
    lines: [lineSnapshot],
  };
  const snapshotBody = {
    schemaVersion: "offer-variant-snapshot.v2",
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: wsId,
    offerId,
    variantId,
    revision: 1,
    sourceBindings: bindings,
    priceAudienceDecision: audienceDecision,
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: source.actor_id,
      selectedAt: createdAt,
    },
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice D: Snapshot-Vertrag traegt den globalen Fix-Rabatt
    // (null = keiner) — v1-Strict-Schema verlangt das Feld.
    globalFixDiscountCents: null,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    customDealNetCents: null,
    contactContext,
    installationSiteContext,
    variantName: "Basis",
    description: "Vollständige Tenant-Fixture",
    createdBy: source.actor_id,
    createdAt,
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
    .update(canonicalizeOfferJson(snapshotBody), "utf8")
    .digest("hex");
  const snapshot = { ...snapshotBody, snapshotSha256 };

  await tx.execute(sql`
    insert into offer (
      id, workspace_id, project_id, contact_id, site_id,
      offer_number, number_year, number_sequence,
      price_audience_decision, contact_context, installation_site_context,
      source_bindings, inbound_receipt_id, inbound_payload_sha256,
      requirement_id, requirement_revision,
      calculation_revision_id, calculation_revision,
      calculation_input_sha256, calculation_result_sha256,
      resolution_id, resolution_revision, resolution_sha256,
      create_digest, created_by, created_at, updated_at
    ) values (
      ${offerId}::uuid, ${wsId}::uuid, ${source.project_id}::uuid,
      ${source.contact_id}::uuid, ${source.site_id}::uuid,
      'ANG-2026-000001', 2026, 1, ${JSON.stringify(audienceDecision)}::jsonb,
      ${JSON.stringify(contactContext)}::jsonb,
      ${JSON.stringify(installationSiteContext)}::jsonb,
      ${JSON.stringify(bindings)}::jsonb, ${source.inbound_receipt_id}::uuid,
      decode(${source.inbound_payload_sha256}, 'hex'),
      ${source.requirement_id}::uuid, ${source.requirement_revision},
      ${source.calculation_revision_id}::uuid, ${source.calculation_revision},
      decode(${source.calculation_input_sha256}, 'hex'),
      decode(${source.calculation_result_sha256}, 'hex'),
      ${source.resolution_id}::uuid, ${source.resolution_revision},
      decode(${source.resolution_sha256}, 'hex'), decode(repeat('aa', 32), 'hex'),
      ${source.actor_id}::uuid, ${createdAt}::timestamptz, ${createdAt}::timestamptz
    )
  `);
  await tx.execute(sql`
    insert into offer_variant (
      id, workspace_id, offer_id, ordinal, current_revision,
      name, description, created_by
    ) values (
      ${variantId}::uuid, ${wsId}::uuid, ${offerId}::uuid,
      1, 1, 'Basis', 'Vollständige Tenant-Fixture', ${source.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    insert into offer_variant_revision (
      id, workspace_id, offer_id, variant_id, project_id, revision,
      schema_version, canonicalization_version, revision_snapshot,
      snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
      basis_net_cents, basis_tax_cents, basis_gross_cents,
      optional_net_cents, optional_tax_cents, optional_gross_cents,
      created_by, created_at
    ) values (
      ${revisionId}::uuid, ${wsId}::uuid, ${offerId}::uuid, ${variantId}::uuid,
      ${source.project_id}::uuid, 1, 'offer-variant-snapshot.v2', 'offer-jcs.v1',
      ${JSON.stringify(snapshot)}::jsonb, decode(${snapshotSha256}, 'hex'),
      ${source.resolution_id}::uuid, ${source.resolution_revision},
      decode(${source.resolution_sha256}, 'hex'), 100, 19, 119, 0, 0, 0,
      ${source.actor_id}::uuid, ${createdAt}::timestamptz
    )
  `);
  await tx.execute(sql`
    insert into offer_variant_section (
      id, workspace_id, offer_id, variant_id, project_id,
      revision_id, revision, section_domain_id, position,
      category, title, discount_bps, section_snapshot
    ) values (
      ${sectionId}::uuid, ${wsId}::uuid, ${offerId}::uuid, ${variantId}::uuid,
      ${source.project_id}::uuid, ${revisionId}::uuid, 1,
      ${sectionDomainId}::uuid, 1, 'other', 'Tenant Fixture', 0,
      ${JSON.stringify(sectionSnapshot)}::jsonb
    )
  `);
  await tx.execute(sql`
    insert into offer_bom_line (
      id, workspace_id, offer_id, variant_id, project_id,
      revision_id, revision, section_id, section_domain_id, line_domain_id,
      position, component_category, position_type, is_hidden,
      quantity_milli, unit, source_kind,
      original_sales_unit_net_cents, effective_sales_unit_net_cents,
      original_purchase_unit_net_cents, effective_purchase_unit_net_cents,
      line_discount_bps, tax_treatment, tax_rate_bps,
      line_base_net_cents, line_discounted_net_cents,
      section_discounted_net_cents, final_sales_net_cents,
      sales_tax_cents, sales_gross_cents, purchase_net_cents, line_snapshot
    ) values (
      ${lineId}::uuid, ${wsId}::uuid, ${offerId}::uuid, ${variantId}::uuid,
      ${source.project_id}::uuid, ${revisionId}::uuid, 1, ${sectionId}::uuid,
      ${sectionDomainId}::uuid, ${lineDomainId}::uuid, 1, 'other', 'required',
      false, 1000, 'piece', 'custom', 100, 100, 50, 50, 0,
      'standard_19', 1900, 100, 100, 100, 100, 19, 119, 50,
      ${JSON.stringify(lineSnapshot)}::jsonb
    )
  `);
  await tx.execute(sql`
    insert into offer_number_series (
      workspace_id, series_year, last_sequence, created_at, updated_at
    ) values (${wsId}::uuid, 2026, 1, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
  `);
  await tx.execute(sql`
    insert into offer_mutation_rate_window (
      workspace_id, scope, actor_id, window_start, attempts,
      created_at, updated_at
    ) values (
      ${wsId}::uuid, 'actor', ${source.actor_id}::uuid,
      timestamptz '2026-08-30 12:00:00+00', 1,
      ${createdAt}::timestamptz, ${createdAt}::timestamptz
    )
  `);
}

async function fixtureOfferPdfDraft(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from offer_pdf_draft
     where workspace_id = ${wsId}::uuid
     limit 1
  `);
  if (existing.rows[0]) return;
  await fixtureOfferGraph(tx, wsId);
  const source = await tx.execute<{
    offer_id: string;
    offer_number: string;
    project_id: string;
    variant_id: string;
    revision_id: string;
    revision: number;
    revision_snapshot: unknown;
    snapshot_sha256: string;
    created_by: string;
    [key: string]: unknown;
  }>(sql`
    select revision.offer_id, offer_record.offer_number,
           revision.project_id, revision.variant_id,
           revision.id as revision_id, revision.revision,
           revision.revision_snapshot,
           encode(revision.snapshot_sha256, 'hex') as snapshot_sha256,
           revision.created_by
      from offer_variant_revision revision
      join offer offer_record
        on offer_record.workspace_id = revision.workspace_id
       and offer_record.id = revision.offer_id
     where revision.workspace_id = ${wsId}::uuid
     order by revision.created_at desc, revision.id desc
     limit 1
  `);
  const row = source.rows[0];
  if (!row) throw new Error("PDF-Tenant-Fixture braucht eine Offer-Revision.");
  const input = {
    schemaVersion: "offer-pdf-draft-input.v1" as const,
    canonicalizationVersion: "offer-jcs.v1" as const,
    templateVersion: "offer-pdf-draft-template.v1" as const,
    rendererRecipeVersion:
      "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac" as const,
    offerNumber: row.offer_number,
    preparedAt: "2026-08-29T12:00:00.000Z",
    recipient: { displayName: "Offer Tenant Fixture" },
    installationSite: { formattedAddress: "Testweg 1, 10115 Berlin" },
    variant: {
      name: "Basis",
      revision: row.revision,
    },
    commercialTerms: {
      globalDiscountBps: 0,
      globalDiscountCapCents: null,
      globalFixDiscountCents: null,
      customDealNetCents: null,
    },
    sections: [{
      position: 1,
      title: "Tenant Fixture",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Freie Tenant-Fixture-Position",
        description: null,
        quantityMilli: 1_000,
        unit: "piece" as const,
        positionType: "required" as const,
        isHidden: false,
        salesUnitNetCents: 100,
        lineDiscountBps: 0,
        taxRateBps: 1_900 as const,
        finalNetCents: 100,
        taxCents: 19,
        grossCents: 119,
      }],
    }],
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
  };
  const inputSha256 = hashOfferPdfDraftInput(input);
  const reservation = createHash("sha256")
    .update(`offer-pdf-tenant-fixture:${row.revision_id}`, "utf8")
    .digest("hex");
  await tx.execute(sql`
    insert into offer_pdf_draft (
      workspace_id, project_id, offer_id, variant_id,
      variant_revision_id, variant_revision, variant_snapshot_sha256,
      input_version, canonicalization_version, template_version,
      renderer_recipe_version, reservation_key, input_snapshot, input_sha256,
      state, attempt_count, next_attempt_at, created_by, created_at, updated_at
    ) values (
      ${wsId}::uuid, ${row.project_id}::uuid, ${row.offer_id}::uuid,
      ${row.variant_id}::uuid, ${row.revision_id}::uuid, ${row.revision},
      decode(${row.snapshot_sha256}, 'hex'), 'offer-pdf-draft-input.v1',
      'offer-jcs.v1', 'offer-pdf-draft-template.v1',
      'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
      decode(${reservation}, 'hex'),
      ${JSON.stringify(input)}::jsonb, decode(${inputSha256}, 'hex'),
      'queued', 0, ${input.preparedAt}::timestamptz, ${row.created_by}::uuid,
      ${input.preparedAt}::timestamptz, ${input.preparedAt}::timestamptz
    )
  `);
}

/**
 * Erzeugt den vollstaendigen M2-03a-Release-Graphen ueber dieselben schmalen
 * Datenbankgrenzen wie die Anwendung. Die sieben Release-Tabellen teilen sich
 * diese Factory, damit die generische Tenant-Suite fuer jede Relation echte
 * Zeilen, RLS-Lesetrennung und einen Cross-Tenant-Schreibversuch prueft.
 */
async function fixtureOfferReleaseGraph(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from offer_release_candidate_approval
     where workspace_id = ${wsId}::uuid
     limit 1
  `);
  if (existing.rows[0]) return;

  await fixtureOfferPdfDraft(tx, wsId);
  const sourceResult = await tx.execute<{
    source_pdf_draft_id: string;
    source_state: string;
    project_id: string;
    offer_id: string;
    variant_id: string;
    variant_revision_id: string;
    variant_revision: number;
    actor_id: string;
    [key: string]: unknown;
  }>(sql`
    select draft.id as source_pdf_draft_id,
           draft.state as source_state,
           draft.project_id,
           draft.offer_id,
           draft.variant_id,
           draft.variant_revision_id,
           draft.variant_revision,
           offer_record.created_by as actor_id
      from offer_pdf_draft as draft
      join offer as offer_record
        on offer_record.workspace_id = draft.workspace_id
       and offer_record.id = draft.offer_id
     where draft.workspace_id = ${wsId}::uuid
     order by draft.created_at desc, draft.id desc
     limit 1
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Release-Tenant-Fixture braucht einen PDF-Entwurf.");

  await tx.execute(sql`
    update membership
       set role = 'admin', capabilities = '{}'::jsonb
     where workspace_id = ${wsId}::uuid
       and user_id = ${source.actor_id}::uuid
  `);
  await tx.execute(sql`
    select set_config('app.actor_id', ${source.actor_id}, true)
  `);

  const sender = {
    legalName: "Fixture Energie GmbH",
    tradingName: "Fixture Energie",
    representedBy: "Fixture Vertretung",
    address: {
      street: "Testweg",
      houseNumber: "1",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    email: "office@fixture.invalid",
    phoneE164: "+493000000000",
    websiteHttpsUrl: "https://fixture.invalid",
    registerCourt: "Fixture Registergericht",
    registerNumber: "HRB FIXTURE 1",
    vatId: "DE000000000",
  };
  const legalDocuments = {
    terms: { title: "Fixture Bedingungen", plainText: "Synthetische Bedingungen." },
    withdrawalInformation: {
      title: "Fixture Widerrufsinformation",
      plainText: "Synthetische Widerrufsinformation.",
    },
    privacyNotice: {
      title: "Fixture Datenschutzhinweis",
      plainText: "Synthetischer Datenschutzhinweis.",
    },
  };
  await tx.execute(sql`
    select public.revise_offer_release_profile(
      ${wsId}::uuid,
      0,
      'Tenant Fixture Profil',
      ${JSON.stringify(sender)}::jsonb,
      ${JSON.stringify(legalDocuments)}::jsonb
    )
  `);
  const profileResult = await tx.execute<{
    profile_id: string;
    profile_revision_id: string;
    profile_revision: number;
    [key: string]: unknown;
  }>(sql`
    select profile.id as profile_id,
           revision.id as profile_revision_id,
           revision.revision as profile_revision
      from offer_release_profile as profile
      join offer_release_profile_revision as revision
        on revision.workspace_id = profile.workspace_id
       and revision.profile_id = profile.id
       and revision.revision = profile.current_revision
     where profile.workspace_id = ${wsId}::uuid
     limit 1
  `);
  const profile = profileResult.rows[0];
  if (!profile) throw new Error("Release-Tenant-Fixture braucht eine Profilrevision.");
  await tx.execute(sql`
    select public.activate_offer_release_profile(
      ${wsId}::uuid,
      ${profile.profile_id}::uuid,
      ${profile.profile_revision_id}::uuid,
      ${profile.profile_revision}
    )
  `);

  const billingAddress = {
    street: "Rechnungsweg",
    houseNumber: "8a",
    postalCode: "10999",
    city: "Berlin",
    country: "DE",
  };
  await tx.execute(sql`
    select public.revise_offer_recipient(
      ${wsId}::uuid,
      ${source.offer_id}::uuid,
      0,
      'Fixture Rechnungsempfaenger',
      'Fixture Kundin GmbH',
      'rechnung@fixture.invalid',
      ${JSON.stringify(billingAddress)}::jsonb,
      true
    )
  `);
  const recipientResult = await tx.execute<{
    recipient_revision_id: string;
    recipient_revision: number;
    [key: string]: unknown;
  }>(sql`
    select revision.id as recipient_revision_id,
           revision.revision as recipient_revision
      from offer_recipient as recipient
      join offer_recipient_revision as revision
        on revision.workspace_id = recipient.workspace_id
       and revision.recipient_id = recipient.id
       and revision.revision = recipient.current_revision
     where recipient.workspace_id = ${wsId}::uuid
       and recipient.offer_id = ${source.offer_id}::uuid
     limit 1
  `);
  const recipient = recipientResult.rows[0];
  if (!recipient) throw new Error("Release-Tenant-Fixture braucht eine Empfaengerrevision.");

  if (source.source_state === "queued") {
    await tx.execute(sql`
      update offer_pdf_draft
         set state = 'running',
             attempt_count = 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + interval '5 minutes',
             started_at = clock_timestamp(),
             updated_at = clock_timestamp()
       where workspace_id = ${wsId}::uuid
         and id = ${source.source_pdf_draft_id}::uuid
         and state = 'queued'
    `);
  }
  if (source.source_state !== "succeeded") {
    const sourceArtifact = Buffer.from(
      `%PDF-1.7\n${"synthetic-tenant-release-source".repeat(8)}\n%%EOF`,
      "utf8",
    );
    await tx.execute(sql`
      update offer_pdf_draft
         set state = 'succeeded',
             lease_token = null,
             lease_expires_at = null,
             artifact_mime_type = 'application/pdf',
             artifact_bytes = ${sourceArtifact},
             artifact_sha256 = sha256(${sourceArtifact}),
             artifact_size_bytes = octet_length(${sourceArtifact}),
             finished_at = clock_timestamp(),
             updated_at = clock_timestamp()
       where workspace_id = ${wsId}::uuid
         and id = ${source.source_pdf_draft_id}::uuid
         and state = 'running'
    `);
  }

  await tx.execute(sql`
    select public.prepare_offer_release_candidate(
      ${wsId}::uuid,
      ${source.offer_id}::uuid,
      ${source.variant_id}::uuid,
      ${source.variant_revision},
      ${source.source_pdf_draft_id}::uuid,
      ${profile.profile_id}::uuid,
      ${profile.profile_revision_id}::uuid,
      ${profile.profile_revision},
      ${recipient.recipient_revision_id}::uuid,
      ${recipient.recipient_revision},
      ((clock_timestamp() at time zone 'Europe/Berlin')::date + 14)::date
    )
  `);
  const candidateResult = await tx.execute<{
    candidate_id: string;
    [key: string]: unknown;
  }>(sql`
    select id as candidate_id
      from offer_release_candidate
     where workspace_id = ${wsId}::uuid
       and offer_id = ${source.offer_id}::uuid
     order by created_at desc, id desc
     limit 1
  `);
  const candidate = candidateResult.rows[0];
  if (!candidate) throw new Error("Release-Tenant-Fixture braucht einen Candidate.");
  await tx.execute(sql`
    update offer_release_candidate
       set state = 'running',
           attempt_count = 1,
           lease_token = gen_random_uuid(),
           lease_expires_at = clock_timestamp() + interval '5 minutes',
           started_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where workspace_id = ${wsId}::uuid
       and id = ${candidate.candidate_id}::uuid
       and state = 'queued'
  `);
  const candidateArtifact = Buffer.from(
    `%PDF-1.7\n${"synthetic-tenant-release-candidate".repeat(8)}\n%%EOF`,
    "utf8",
  );
  const artifactVersion = randomUUID();
  await tx.execute(sql`
    update offer_release_candidate
       set state = 'ready_for_approval',
           lease_token = null,
           lease_expires_at = null,
           artifact_mime_type = 'application/pdf',
           artifact_bytes = ${candidateArtifact},
           artifact_sha256 = sha256(${candidateArtifact}),
           artifact_size_bytes = octet_length(${candidateArtifact}),
           artifact_version = ${artifactVersion}::uuid,
           finished_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where workspace_id = ${wsId}::uuid
       and id = ${candidate.candidate_id}::uuid
       and state = 'running'
  `);
  await tx.execute(sql`
    select public.approve_offer_release_candidate(
      ${wsId}::uuid,
      ${source.offer_id}::uuid,
      ${candidate.candidate_id}::uuid,
      ${artifactVersion}::uuid,
      true,
      true,
      true,
      true,
      null
    )
  `);
  const approval = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from offer_release_candidate_approval
     where workspace_id = ${wsId}::uuid
       and candidate_id = ${candidate.candidate_id}::uuid
     limit 1
  `);
  if (!approval.rows[0]) {
    throw new Error("Release-Tenant-Fixture konnte keine Freigabe erzeugen.");
  }
}

/**
 * Erzeugt den vollständigen lokalen M2-03b1-Graphen über die schmalen
 * Produktfunktionen. Eine Freigabe genügt für die Approval-Tabelle; der
 * anschließende strukturierte Rückzug belegt zusätzlich den terminalen
 * Withdrawal-Pfad, ohne einen archivierten oder ausgestellten Zustand zu
 * erfinden.
 */
async function fixtureOfferIssuanceGraph(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from offer_issuance_withdrawal
     where workspace_id = ${wsId}::uuid
     limit 1
  `);
  if (existing.rows[0]) return;

  await fixtureOfferReleaseGraph(tx, wsId);
  const sourceResult = await tx.execute<{
    actor_id: string;
    candidate_id: string;
    offer_id: string;
    [key: string]: unknown;
  }>(sql`
    select approval.approved_by as actor_id,
           candidate.id as candidate_id,
           candidate.offer_id
      from offer_release_candidate as candidate
      join offer_release_candidate_approval as approval
        on approval.workspace_id = candidate.workspace_id
       and approval.candidate_id = candidate.id
     where candidate.workspace_id = ${wsId}::uuid
       and candidate.state = 'ready_for_approval'
       and candidate.publication_status = 'not_issued'
     order by approval.approved_at desc, approval.id desc
     limit 1
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Issuance-Tenant-Fixture braucht einen freigegebenen Candidate.");

  await tx.execute(sql`
    select set_config('app.actor_id', ${source.actor_id}, true)
  `);
  const preparedRows = await tx.execute<{
    result: { issuanceId?: unknown; status?: unknown };
    [key: string]: unknown;
  }>(sql`
    select public.prepare_offer_issuance(
      ${wsId}::uuid,
      ${source.offer_id}::uuid,
      ${source.candidate_id}::uuid
    ) as result
  `);
  const prepared = preparedRows.rows[0]?.result;
  if (prepared?.status !== "prepared" || typeof prepared.issuanceId !== "string") {
    throw new Error("Issuance-Tenant-Fixture konnte keine Reservation erzeugen.");
  }
  const issuanceId = prepared.issuanceId;
  const leaseToken = randomUUID();
  const claimedRows = await tx.execute<{
    result: { status?: unknown };
    [key: string]: unknown;
  }>(sql`
    select public.claim_offer_issuance_render(
      ${wsId}::uuid,
      ${issuanceId}::uuid,
      ${leaseToken}::uuid,
      120
    ) as result
  `);
  if (claimedRows.rows[0]?.result.status !== "claimed") {
    throw new Error("Issuance-Tenant-Fixture konnte die Reservation nicht claimen.");
  }

  const finalArtifact = Buffer.from(
    `%PDF-1.7\n${"synthetic-tenant-issuance-final".repeat(8)}\n%%EOF`,
    "utf8",
  );
  const finalizedRows = await tx.execute<{
    result: { status?: unknown };
    [key: string]: unknown;
  }>(sql`
    select public.finalize_offer_issuance_render_success(
      ${wsId}::uuid,
      ${issuanceId}::uuid,
      ${leaseToken}::uuid,
      1,
      ${finalArtifact}
    ) as result
  `);
  if (finalizedRows.rows[0]?.result.status !== "ready_for_approval") {
    throw new Error("Issuance-Tenant-Fixture konnte kein finales PDF versiegeln.");
  }

  const approvedRows = await tx.execute<{
    result: { status?: unknown };
    [key: string]: unknown;
  }>(sql`
    select public.approve_offer_issuance(
      ${wsId}::uuid,
      ${issuanceId}::uuid,
      true,
      true,
      true,
      true,
      null
    ) as result
  `);
  if (approvedRows.rows[0]?.result.status !== "approved") {
    throw new Error("Issuance-Tenant-Fixture konnte keine Freigabe erzeugen.");
  }

  const withdrawnRows = await tx.execute<{
    result: { status?: unknown };
    [key: string]: unknown;
  }>(sql`
    select public.withdraw_offer_issuance(
      ${wsId}::uuid,
      ${issuanceId}::uuid,
      'other'
    ) as result
  `);
  if (withdrawnRows.rows[0]?.result.status !== "withdrawn") {
    throw new Error("Issuance-Tenant-Fixture konnte den Rückzug nicht erzeugen.");
  }
}

// M2-04: erzeugt eine NICHT zurückgezogene, 2/2-freigegebene Ausstellungsfassung
// und darauf einen pending signature_request (idempotent). Die bestehende
// fixtureOfferIssuanceGraph zieht am Ende zurück und ist hier ungeeignet.
// M2-04: legt einen pending signature_request an (idempotent). Variante (c):
// Direkt-INSERT auf der von fixtureOfferIssuanceGraph erzeugten Ausstellungs-
// fassung — deren state bleibt 'ready_for_approval' (der Rückzug liegt in
// offer_issuance_withdrawal, nicht im state), sodass der Insert-Guard die
// Bindung akzeptiert. So ist die Factory unabhängig von der Fixture-Reihenfolge
// und erzeugt keine zweite Issuance auf demselben Candidate.
// M2-04: legt einen pending signature_request an (idempotent). Variante (c):
// Direkt-INSERT auf der von fixtureOfferIssuanceGraph erzeugten Ausstellungs-
// fassung — deren state bleibt 'ready_for_approval' (der Rückzug liegt in
// offer_issuance_withdrawal, nicht im state), sodass der Insert-Guard die
// Bindung akzeptiert. So ist die Factory unabhängig von der Fixture-Reihenfolge.
async function fixtureSignatureRequest(tx: TenantTx, wsId: string): Promise<string> {
  await fixtureOfferIssuanceGraph(tx, wsId);

  const source = await tx.execute<{
    issuance_id: string;
    project_id: string;
    offer_id: string;
    variant_id: string;
    variant_revision_id: string;
    actor_id: string;
    artifact_sha256: Buffer;
    [key: string]: unknown;
  }>(sql`
    select issuance.id as issuance_id, issuance.project_id, issuance.offer_id,
           issuance.variant_id, issuance.variant_revision_id,
           issuance.artifact_sha256,
           offer_record.created_by as actor_id
      from offer_issuance as issuance
      join offer as offer_record
        on offer_record.workspace_id = issuance.workspace_id
       and offer_record.id = issuance.offer_id
     where issuance.workspace_id = ${wsId}::uuid
     order by issuance.created_at desc, issuance.id desc
     limit 1
  `);
  const row = source.rows[0];
  if (!row) throw new Error("Signature-Tenant-Fixture braucht eine Ausstellungsfassung.");

  // Actor setzen, damit der Idempotenz-Lookup die (actor-geschützten)
  // signature_request-Zeilen sehen kann.
  await tx.execute(sql`select set_config('app.actor_id', ${row.actor_id}, true)`);

  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from signature_request where workspace_id = ${wsId}::uuid limit 1
  `);
  if (existing.rows[0]) return existing.rows[0].id;

  const requestId = randomUUID();
  const tokenHash = Buffer.alloc(32, 0x42);
  await tx.execute(sql`
    insert into public.signature_request (
      id, workspace_id, project_id, offer_id, variant_id, variant_revision_id,
      issuance_id, status, token_hash, expires_at, content_sha256, created_by
    ) values (
      ${requestId}::uuid, ${wsId}::uuid, ${row.project_id}::uuid, ${row.offer_id}::uuid,
      ${row.variant_id}::uuid, ${row.variant_revision_id}::uuid, ${row.issuance_id}::uuid,
      'pending', ${tokenHash}, clock_timestamp() + interval '14 days',
      ${row.artifact_sha256}, ${row.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    insert into public.signature_token_locator (token_hash, workspace_id, signature_request_id)
    values (${tokenHash}, ${wsId}::uuid, ${requestId}::uuid)
  `);
  return requestId;
}

async function fixtureSignatureAttestation(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from signature_attestation where workspace_id = ${wsId}::uuid limit 1
  `);
  if (existing.rows[0]) return;
  const requestId = await fixtureSignatureRequest(tx, wsId);

  // Analog-Pfad (interner Editor), da die öffentliche Token-Kapsel
  // SECURITY DEFINER (app_owner) ist und im legacy-Testmodus nicht greift.
  const req = await tx.execute<{
    signer_name: string;
    content_sha256: Buffer;
    [key: string]: unknown;
  }>(sql`
    select request_record.content_sha256, contact_record.display_name as signer_name
      from signature_request as request_record
      join offer as offer_record
        on offer_record.workspace_id = request_record.workspace_id
       and offer_record.id = request_record.offer_id
      join contact as contact_record
        on contact_record.workspace_id = offer_record.workspace_id
       and contact_record.id = offer_record.contact_id
     where request_record.workspace_id = ${wsId}::uuid
       and request_record.id = ${requestId}::uuid
     limit 1
  `);
  const row = req.rows[0];
  if (!row) throw new Error("Signature-Tenant-Fixture: Request/Signer fehlt.");

  await tx.execute(sql`
    update public.signature_request
       set status = 'signed',
           signer_name = ${row.signer_name}::text,
           signed_variant_id = variant_id,
           signed_at = clock_timestamp()
     where workspace_id = ${wsId}::uuid
       and id = ${requestId}::uuid
       and status = 'pending'
  `);
  const artifact = Buffer.from("%PDF-1.7\nanalog-signature-scan\n%%EOF", "latin1");
  await tx.execute(sql`
    insert into public.signature_attestation (
      id, workspace_id, signature_request_id, mode, signer_name, content_sha256,
      signing_date, artifact_mime_type, artifact_sha256, artifact_size_bytes, artifact_bytes
    ) values (
      ${randomUUID()}::uuid, ${wsId}::uuid, ${requestId}::uuid, 'analog',
      ${row.signer_name}::text, ${row.content_sha256},
      clock_timestamp(), 'application/pdf', sha256(${artifact}),
      octet_length(${artifact}), ${artifact}
    )
  `);
}

async function fixtureSignatureViewLog(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from signature_view_log where workspace_id = ${wsId}::uuid limit 1
  `);
  if (existing.rows[0]) return;
  const requestId = await fixtureSignatureRequest(tx, wsId);
  await tx.execute(sql`
    insert into public.signature_view_log (workspace_id, signature_request_id)
    values (${wsId}::uuid, ${requestId}::uuid)
  `);
}

// Factory legt GENAU EINE Zeile im gegebenen Workspace an (workspace-Zeile existiert bereits).
// Jede neue Mandantentabelle MUSS hier eine Factory registrieren, sonst wird
// tests/db/tenant-invariants.test.ts rot — das ist der Mechanismus, der die
// Tenant-Isolations-Invariante über alle künftigen Module (M1–M8) trägt.
export const tenantFixtures: Record<string, (tx: TenantTx, wsId: string) => Promise<void>> = {
  workspace_invoicing_settings: async (tx, wsId) => {
    const { userId, membershipId } = await fixtureMembership(tx, wsId, "editor", '{"invoicing":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into workspace_invoicing_settings (
        id, workspace_id, company_name, company_email, company_country,
        company_address_line1, company_postal_code, company_city,
        accounting_method, revision, created_by
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'M300 GmbH', 'office@m300.invalid', 'DE',
        'Musterweg', '10115', 'Berlin', 'accrual', 1, ${membershipId}::uuid
      )
    `);
  },

  commercial_document_group: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor", '{"invoicing":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into commercial_document_group (
        id, workspace_id, name, created_by
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'M3-01 Gruppe', ${userId}::uuid
      )
    `);
  },
  commercial_document_number_series: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor", '{"invoicing":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into commercial_document_number_series (
        id, workspace_id, type, series_year, prefix, padding
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'invoice',
        extract(year from now())::integer, 'RE', 5
      )
    `);
  },
  commercial_document: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor", '{"invoicing":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into commercial_document (
        id, workspace_id, type, status, name, created_by, due_date, payment_status
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'invoice', 'draft',
        'M3-01 Entwurf', ${userId}::uuid, (now()::date + 14), 'unpaid'
      )
    `);
  },
  commercial_document_line: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor", '{"invoicing":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    const documentId = randomUUID();
    await tx.execute(sql`
      insert into commercial_document (
        id, workspace_id, type, status, name, created_by, due_date, payment_status
      ) values (
        ${documentId}::uuid, ${wsId}::uuid, 'invoice', 'draft',
        'M3-01 Entwurf (Line-Fixture)', ${userId}::uuid, (now()::date + 14), 'unpaid'
      )
    `);
    await tx.execute(sql`
      insert into commercial_document_line (
        id, workspace_id, document_id, position, name, quantity_milli, unit,
        net_cents, tax_cents, gross_cents, tax_rate_bps
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, ${documentId}::uuid, 1,
        'Position', 1000, 'piece', 100, 19, 119, 1900
      )
    `);
  },
  workspace_economics_settings: async (tx, wsId) => {
    const { userId, membershipId } = await fixtureMembership(tx, wsId, "editor", '{"economics":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into workspace_economics_settings (
        id, workspace_id, electricity_price_net_cents_per_kwh,
        escalation_rate_bps, cashflow_horizon_years, revision, created_by
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 30, 100, 20, 1, ${membershipId}::uuid
      )
    `);
  },

  workspace_document_number_format: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor", '{"invoicing":true}');
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into workspace_document_number_format (
        id, workspace_id, type, format_template
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'invoice', 'Rechnung-{YEAR}-{MONTH}-{NUMBER}'
      )
    `);
  },

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
    await fixtureMembership(tx, wsId);
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
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${id}::uuid, ${wsId}::uuid, 'Fixture Contact', 'Fixture', 'Contact',
        ${`${id}@test.local`}, ${`${id}@test.local`})
    `);
  },
  contact_legal_hold: async (tx, wsId) => {
    const contactId = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${wsId}::uuid, 'Legal Hold Fixture', 'Legal', 'Hold',
        ${`${contactId}@test.local`}, ${`${contactId}@test.local`})
    `);
    await tx.execute(sql`
      insert into contact_legal_hold (workspace_id, contact_id, reason)
      values (${wsId}::uuid, ${contactId}::uuid, 'fixture')
    `);
  },
  lead_source: async (tx, wsId) => {
    const id = randomUUID();
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${id}::uuid, ${wsId}::uuid, ${`Fixture Lead Source ${id}`},
        ${`fixture lead source ${id}`})
    `);
  },
  checklist_template: async (tx, wsId) => {
    const userId = randomUUID();
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${userId}::uuid, ${`${userId}@fixture.local`})
    `);
    await tx.execute(sql`
      insert into checklist_template (
        workspace_id, name, name_normalized, created_by
      ) values (
        ${wsId}::uuid, ${`Fixture Template ${userId}`},
        ${`fixture template ${userId}`}, ${userId}::uuid
      )
    `);
  },
  calendar: async (tx, wsId) => {
    const userId = randomUUID();
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${userId}::uuid, ${`${userId}@fixture.local`})
    `);
    await tx.execute(sql`
      insert into calendar (workspace_id, name, calendar_type, created_by)
      values (${wsId}::uuid, ${`Fixture Calendar ${userId}`}, 'tenancy', ${userId}::uuid)
    `);
  },
  project_checklist: async (tx, wsId) => {
    const contactId = randomUUID();
    const siteId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${userId}::uuid, ${`${userId}@fixture.local`})
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${wsId}::uuid, 'Checklist Fixture', 'Check', 'Fixture', ${`${contactId}@fixture.local`}, ${`${contactId}@fixture.local`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${wsId}::uuid, ${contactId}::uuid, 'Checklist Fixture Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${wsId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'Checklist Fixture Projekt', 'fixture'
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
    await tx.execute(sql`
      insert into project_checklist (
        workspace_id, project_id, version, blocks, created_by
      ) values (
        ${wsId}::uuid, ${projectId}::uuid, 1,
        '[]'::jsonb, ${userId}::uuid
      )
    `);
  },
  time_event_type: async (tx, wsId) => {
    const id = randomUUID();
    await tx.execute(sql`
      insert into time_event_type (id, workspace_id, name, name_normalized)
      values (${id}::uuid, ${wsId}::uuid, ${`Fixture Event Type ${id}`},
        ${`fixture event type ${id}`})
    `);
  },
  time_entry: async (tx, wsId) => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const contactId = randomUUID();
    const siteId = randomUUID();
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${userId}::uuid, ${`${userId}@fixture.local`})
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${wsId}::uuid, 'Zeit Fixture', 'Zeit', 'Fixture', ${`${contactId}@fixture.local`}, ${`${contactId}@fixture.local`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${wsId}::uuid, ${contactId}::uuid, 'Zeit Fixture Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${wsId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'Zeit Fixture Projekt', 'fixture'
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
    await tx.execute(sql`
      insert into time_entry (
        workspace_id, user_id, project_id, start_at, end_at,
        working_time_minutes, created_by
      ) values (
        ${wsId}::uuid, ${userId}::uuid, ${projectId}::uuid,
        now() - interval '2 hours', now() - interval '1 hour',
        60, ${userId}::uuid
      )
    `);
  },
  time_entry_revision: async (tx, wsId) => {
    // F9.4 Slice B: eigene Entry-Kette (FK time_entry_revision_entry_fk).
    // Cross-Write-Pfad: crossWriteOverrides.time_entry_revision (die
    // Factory liest hier per RLS nur eigene Zeilen).
    await tenantFixtures.time_entry(tx, wsId);
    const entry = await tx.execute<{
      id: string; user_id: string; project_id: string;
    }>(sql`select id, user_id, project_id from time_entry
             where workspace_id = ${wsId}::uuid limit 1`);
    const row = entry.rows[0];
    if (!row) throw new Error("Revision-Fixture braucht einen time_entry.");
    await tx.execute(sql`
      insert into time_entry_revision (
        workspace_id, entry_id, user_id, project_id, start_at, end_at,
        working_time_minutes, comment, revised_by
      ) values (
        ${wsId}::uuid, ${row.id}::uuid, ${row.user_id}::uuid,
        ${row.project_id}::uuid, now() - interval '2 hours',
        now() - interval '1 hour', 60, 'Fixture-Revision', ${row.user_id}::uuid
      )
    `);
  },
  // F16.3 Slice A (0060): Rabatt-Vorlagen — nur workspace-FK, RLS
  // tenant_isolation, keine Actor-Policies, keine Trigger-Guards.
  discount_template: async (tx, wsId) => {
    await tx.execute(sql`
      insert into discount_template (
        id, workspace_id, name, name_normalized, kind, amount_cents,
        percent_bps, cap_cents, active, position, created_by
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'Fixture Rabatt',
        'fixture rabatt', 'fix_cents', 500, null, null, true, 0,
        ${randomUUID()}::uuid
      )
    `);
  },
  // F16.3 Slice B (0061): Foerder-Vorlagen — gleiche Gestalt wie discount_template.
  subsidy_template: async (tx, wsId) => {
    await tx.execute(sql`
      insert into subsidy_template (
        id, workspace_id, name, name_normalized, kind, amount_cents,
        percent_bps, cap_cents, active, position, created_by
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, 'Fixture Foerderung',
        'fixture foerderung', 'fix_cents', 750, null, null, true, 0,
        ${randomUUID()}::uuid
      )
    `);
  },
  // F2.5 Slice A (0068): Zahlarten-Stammdaten — nur workspace-FK, RLS
  // tenant_isolation, keine Actor-Policies.
  payment_option: async (tx, wsId) => {
    await tx.execute(sql`
      insert into payment_option (id, workspace_id, key, label, kind)
      values (${randomUUID()}::uuid, ${wsId}::uuid, 'purchase', 'Kauf', 'purchase')
    `);
  },
  // F7.1 Slice A (0069): genau eine Ausfuehrungsphase je Projekt.
  installation: async (tx, wsId) => {
    const { projectId } = await fixtureProjectGraph(tx, wsId);
    await tx.execute(sql`
      insert into installation (workspace_id, project_id, source, status)
      values (${wsId}::uuid, ${projectId}::uuid, 'direct', 'active')
    `);
  },
  // F1-09 (0067): Mention-Zeile zu einer echten Notiz mit echter Identitaet.
  project_note_mention: async (tx, wsId) => {
    await fixtureProjectNoteGraph(tx, wsId);
    const note = await tx.execute<{ id: string; project_id: string }>(sql`
      select id, project_id from project_note where workspace_id = ${wsId}::uuid limit 1
    `);
    const identity = await tx.execute<{ id: string; email: string }>(sql`
      select identity_record.id, identity_record.email
        from user_identity identity_record
        join membership membership_record
          on membership_record.user_id = identity_record.id
       where membership_record.workspace_id = ${wsId}::uuid
       limit 1
    `);
    const noteRow = note.rows[0];
    const identityRow = identity.rows[0];
    if (!noteRow || !identityRow) throw new Error("Mention-Fixture braucht Notiz und Identitaet.");
    await tx.execute(sql`
      insert into project_note_mention (
        workspace_id, project_id, note_id, mentioned_identity_id,
        email_lower, revision
      ) values (
        ${wsId}::uuid, ${noteRow.project_id}::uuid, ${noteRow.id}::uuid,
        ${identityRow.id}::uuid, ${identityRow.email.toLowerCase()}, 1
      )
    `);
  },
  erasure_tombstone: async (tx, wsId) => {
    const contactId = randomUUID();
    const operationId = randomUUID();
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, deleted_at
      ) values (
        ${contactId}::uuid, ${wsId}::uuid,
        ${`geloescht-${contactId}`}, 'Fixture', 'Contact', now()
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
          offerIds: [],
          offerVariantIds: [],
          offerVariantRevisionIds: [],
          offerVariantSectionIds: [],
          offerBomLineIds: [],
        })}::jsonb,
        now() - interval '1 day', now()
      )
    `);
  },
  signature_request: async (tx, wsId) => {
    await fixtureSignatureRequest(tx, wsId);
  },
  signature_attestation: fixtureSignatureAttestation,
  signature_view_log: fixtureSignatureViewLog,
  site: async (tx, wsId) => {
    await tx.execute(sql`insert into site (workspace_id, city) values (${wsId}::uuid, 'fixture')`);
  },
  // F10.1 Kundenportal: Invite braucht Editor-Actor (Create-Guard), Projekt-
  // Bindung und 32-Byte-Token-Hash; View-Log haengt am Invite (FK).
  portal_invite: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor");
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    const { projectId } = await fixtureProjectGraph(tx, wsId);
    await tx.execute(sql`
      insert into portal_invite (
        id, workspace_id, project_id, token_hash, expires_at, created_by
      ) values (
        ${randomUUID()}::uuid, ${wsId}::uuid, ${projectId}::uuid,
        decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '14 days', ${userId}::uuid
      )
    `);
  },
  portal_view_log: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "editor");
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    const { projectId } = await fixtureProjectGraph(tx, wsId);
    const inviteId = randomUUID();
    await tx.execute(sql`
      insert into portal_invite (
        id, workspace_id, project_id, token_hash, expires_at, created_by
      ) values (
        ${inviteId}::uuid, ${wsId}::uuid, ${projectId}::uuid,
        decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '14 days', ${userId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into portal_view_log (workspace_id, portal_invite_id)
      values (${wsId}::uuid, ${inviteId}::uuid)
    `);
  },
  project: async (tx, wsId) => {
    await fixtureProjectGraph(tx, wsId);
  },
  customer_notification: async (tx, wsId) => {
    await fixtureCustomerNotificationGraph(tx, wsId);
  },
  customer_notification_delivery_attempt: async (tx, wsId) => {
    const { notificationId } = await fixtureCustomerNotificationGraph(tx, wsId);
    await tx.execute(sql`
      insert into customer_notification_delivery_attempt (
        workspace_id, notification_id, attempt_number, outcome, error_class
      ) values (${wsId}::uuid, ${notificationId}::uuid, 1, 'delivered', null)
    `);
  },
  project_loss_reason: async (tx, wsId) => {
    const { userId } = await fixtureMembership(tx, wsId, "admin");
    await tx.execute(sql`select set_config('app.actor_id', ${userId}, true)`);
    await tx.execute(sql`
      insert into project_loss_reason (workspace_id, label, position)
      values (${wsId}::uuid, ${`Fixture Loss ${randomUUID()}`}, 1)
    `);
  },
  project_assignment: async (tx, wsId) => {
    const { membershipId } = await fixtureMembership(tx, wsId);
    const { projectId } = await fixtureProjectGraph(tx, wsId);
    await tx.execute(sql`
      insert into project_assignment (
        workspace_id, project_id, membership_id, assignment_role
      ) values (
        ${wsId}::uuid, ${projectId}::uuid, ${membershipId}::uuid, 'user'
      )
    `);
  },
  project_task: fixtureProjectTaskGraph,
  project_task_assignee: fixtureProjectTaskGraph,
  project_task_checklist_item: fixtureProjectTaskGraph,
  project_task_label: fixtureProjectTaskGraph,
  project_note: fixtureProjectNoteGraph,
  project_appointment: fixtureProjectAppointmentGraph,
  project_appointment_attendee: fixtureProjectAppointmentGraph,
  calendar_category: fixtureCalendarCategoryGraph,
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
  catalog_component: fixtureCatalogGraph,
  catalog_component_revision: fixtureCatalogGraph,
  project_catalog_resolution: fixtureCatalogGraph,
  project_catalog_resolution_line: fixtureCatalogGraph,
  catalog_import_job: fixtureCatalogImportGraph,
  catalog_import_row: fixtureCatalogImportGraph,
  catalog_import_row_result: fixtureCatalogImportGraph,
  catalog_import_dispatch_receipt: fixtureCatalogImportGraph,
  offer: fixtureOfferGraph,
  offer_bom_line: fixtureOfferGraph,
  offer_mutation_rate_window: fixtureOfferGraph,
  offer_number_series: fixtureOfferGraph,
  offer_pdf_draft: fixtureOfferPdfDraft,
  offer_issuance: fixtureOfferIssuanceGraph,
  offer_issuance_approval: fixtureOfferIssuanceGraph,
  offer_issuance_withdrawal: fixtureOfferIssuanceGraph,
  offer_recipient: fixtureOfferReleaseGraph,
  offer_recipient_revision: fixtureOfferReleaseGraph,
  offer_release_candidate: fixtureOfferReleaseGraph,
  offer_release_candidate_approval: fixtureOfferReleaseGraph,
  offer_release_profile: fixtureOfferReleaseGraph,
  offer_release_profile_activation: fixtureOfferReleaseGraph,
  offer_release_profile_revision: fixtureOfferReleaseGraph,
  offer_variant: fixtureOfferGraph,
  offer_variant_revision: fixtureOfferGraph,
  offer_variant_section: fixtureOfferGraph,
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
  catalog_import_job: async (tx) => {
    await tx.execute(sql`
      alter table catalog_import_job
      disable trigger catalog_import_job_validate_input
    `);
    await tx.execute(sql`
      insert into catalog_import_job (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  catalog_import_row: async (tx) => {
    await tx.execute(sql`
      alter table catalog_import_row
      disable trigger catalog_import_row_derive_payload
    `);
    await tx.execute(sql`
      alter table catalog_import_row
      disable trigger catalog_import_row_validate_input
    `);
    await tx.execute(sql`
      insert into catalog_import_row (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  catalog_import_row_result: async (tx) => {
    await tx.execute(sql`
      alter table catalog_import_row_result
      disable trigger catalog_import_row_result_validate_input
    `);
    await tx.execute(sql`
      insert into catalog_import_row_result (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  catalog_import_dispatch_receipt: async (tx) => {
    await tx.execute(sql`
      alter table catalog_import_dispatch_receipt
      disable trigger catalog_import_dispatch_receipt_validate_input
    `);
    await tx.execute(sql`
      insert into catalog_import_dispatch_receipt (dispatch_id, workspace_id)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid)
    `);
  },
  project_task: async (tx) => {
    await tx.execute(sql`alter table project_task disable trigger project_task_mutation_guard`);
    await tx.execute(sql`
      insert into project_task (
        workspace_id, project_id, title, created_by, updated_by
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'cross-write',
        ${randomUUID()}::uuid, ${randomUUID()}::uuid
      )
    `);
  },
  project_task_assignee: async (tx) => {
    await tx.execute(sql`
      alter table project_task_assignee disable trigger project_task_assignee_mutation_guard
    `);
    await tx.execute(sql`
      insert into project_task_assignee (workspace_id, task_id, membership_id)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid)
    `);
  },
  project_task_checklist_item: async (tx) => {
    await tx.execute(sql`
      alter table project_task_checklist_item disable trigger project_task_checklist_mutation_guard
    `);
    await tx.execute(sql`
      insert into project_task_checklist_item (workspace_id, task_id, position, text)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid, 0, 'cross-write')
    `);
  },
  project_task_label: async (tx) => {
    await tx.execute(sql`
      alter table project_task_label disable trigger project_task_label_mutation_guard
    `);
    await tx.execute(sql`
      insert into project_task_label (workspace_id, task_id, position, name, color)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid, 0, 'cross-write', 'blue')
    `);
  },
  project_appointment: async (tx) => {
    await tx.execute(sql`
      alter table project_appointment disable trigger project_appointment_mutation_guard
    `);
    await tx.execute(sql`
      insert into project_appointment (
        workspace_id, project_id, title, start_at, end_at, appointment_type,
        created_by
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'cross-write',
        now(), now() + interval '1 hour', 'phone', ${randomUUID()}::uuid
      )
    `);
  },
  project_appointment_attendee: async (tx) => {
    await tx.execute(sql`
      alter table project_appointment_attendee
      disable trigger project_appointment_attendee_mutation_guard
    `);
    await tx.execute(sql`
      insert into project_appointment_attendee (workspace_id, appointment_id, membership_id)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid)
    `);
  },
  // F10.1: Der BEFORE-Guard prueft den Actor VOR dem RLS-WITH-CHECK und
  // wuerde mit 23514 statt "row-level security" ablehnen (vacuum-gruen).
  // Guard aus, damit exakt die RLS-Schranke prueft (Muster project_task).
  portal_invite: async (tx) => {
    await tx.execute(sql`
      alter table portal_invite disable trigger portal_invite_mutation_guard
    `);
    await tx.execute(sql`
      insert into portal_invite (
        id, workspace_id, project_id, token_hash, expires_at, created_by
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '14 days', ${randomUUID()}::uuid
      )
    `);
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
  customer_notification: async (tx) => {
    await tx.execute(sql`
      alter table customer_notification disable trigger customer_notification_mutation_guard
    `);
    await tx.execute(sql`
      insert into customer_notification (workspace_id, project_id, idempotency_key)
      values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::text)
    `);
  },
  customer_notification_delivery_attempt: async (tx) => {
    await tx.execute(sql`
      alter table customer_notification_delivery_attempt disable trigger customer_notification_delivery_attempt_mutation_guard
    `);
    await tx.execute(sql`
      insert into customer_notification_delivery_attempt (
        workspace_id, notification_id, attempt_number, outcome
      ) values (${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, 'delivered')
    `);
  },
  project_loss_reason: async (tx) => {
    await tx.execute(sql`
      alter table project_loss_reason disable trigger project_loss_reason_mutation_guard
    `);
    await tx.execute(sql`
      insert into project_loss_reason (workspace_id, label, position)
      values (${randomUUID()}::uuid, 'Cross Write', 1)
    `);
  },
  project_assignment: async (tx) => {
    await tx.execute(sql`
      insert into project_assignment (
        workspace_id, project_id, membership_id, assignment_role
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 'user'
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
  offer: async (tx) => {
    await tx.execute(sql`
      insert into offer (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_bom_line: async (tx) => {
    await tx.execute(sql`
      insert into offer_bom_line (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_mutation_rate_window: async (tx) => {
    await tx.execute(sql`
      insert into offer_mutation_rate_window (
        workspace_id, scope, actor_id, window_start, attempts
      ) values (
        ${randomUUID()}::uuid, 'actor', ${randomUUID()}::uuid,
        timestamptz '2026-08-30 12:00:00+00', 1
      )
    `);
  },
  offer_number_series: async (tx) => {
    await tx.execute(sql`
      insert into offer_number_series (workspace_id, series_year)
      values (${randomUUID()}::uuid, 2026)
    `);
  },
  offer_pdf_draft: async (tx) => {
    await tx.execute(sql`
      insert into offer_pdf_draft (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_issuance: async (tx) => {
    // Der Binding-Trigger läuft vor dem RLS-WITH-CHECK. Für diese Probe wird
    // ausschließlich dieser frühere Guard transaktional ausgeblendet, damit
    // ein grünes Ergebnis tatsächlich von FORCE RLS stammt. Der erwartete
    // Insert-Fehler rollt das ALTER TABLE zusammen mit der Testtransaktion zurück.
    await tx.execute(sql`
      alter table offer_issuance
      disable trigger offer_issuance_mutation_guard
    `);
    await tx.execute(sql`
      insert into offer_issuance (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_issuance_approval: async (tx) => {
    await tx.execute(sql`
      alter table offer_issuance_approval
      disable trigger offer_issuance_approval_mutation_guard
    `);
    await tx.execute(sql`
      insert into offer_issuance_approval (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_issuance_withdrawal: async (tx) => {
    await tx.execute(sql`
      alter table offer_issuance_withdrawal
      disable trigger offer_issuance_withdrawal_mutation_guard
    `);
    await tx.execute(sql`
      insert into offer_issuance_withdrawal (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_variant: async (tx) => {
    await tx.execute(sql`
      insert into offer_variant (
        workspace_id, offer_id, ordinal, current_revision, name, created_by
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, 1,
        'Cross Write', ${randomUUID()}::uuid
      )
    `);
  },
  offer_variant_revision: async (tx) => {
    await tx.execute(sql`
      insert into offer_variant_revision (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_variant_section: async (tx) => {
    await tx.execute(sql`
      insert into offer_variant_section (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  time_entry_revision: async (tx) => {
    // F9.4 Slice B: RLS-WITH-CHECK feuert vor den FK-Checks — die
    // Zufalls-UUIDs erreichen nie die Entry-FK (Muster offer_variant_*).
    await tx.execute(sql`
      insert into time_entry_revision (
        workspace_id, entry_id, user_id, project_id, start_at, revised_by
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, now(), ${randomUUID()}::uuid
      )
    `);
  },
  project_note_mention: async (tx) => {
    // F1-09: RLS-WITH-CHECK feuert vor den FK-Checks (Muster oben).
    await tx.execute(sql`
      insert into project_note_mention (
        workspace_id, project_id, note_id, mentioned_identity_id,
        email_lower, revision
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 'fremd@f109.test', 1
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
  // RLS-FREIER Token-Locator des öffentlichen Signierlinks (M2-04). Er trägt
  // workspace_id für die FK-Integrität, ist aber bewusst NICHT tenant-RLS-
  // geschützt: Der Token-Pfad muss den Token-Hash cross-tenant auflösen, BEVOR
  // app.workspace_id gesetzt werden kann. Zugriff ausschließlich über die
  // SECURITY-DEFINER-Kapseln in drizzle/0044 (Muster erasure_operation_locator).
  "signature_token_locator",
  // RLS-FREIER Token-Locator des öffentlichen Kundenportal-Links (F10.1).
  // Baugleich M2-04: workspace_id nur für FK-Integrität, Token-Hash muss
  // cross-tenant auflösbar sein, BEVOR app.workspace_id existiert. Zugriff
  // ausschließlich über SECURITY-DEFINER-Kapseln (resolve_portal_public_view,
  // Portal-Erzeugung) in drizzle/0056.
  "portal_token_locator",
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
  // WORM-Receiptblatt: dispatch_id ist die global eindeutige Replay-Identität;
  // kein FK zeigt auf diese technische Zustellquittung.
  "catalog_import_dispatch_receipt",
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
