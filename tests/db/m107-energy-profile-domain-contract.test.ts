import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  canonicalizeCalculationJson,
  hashPlanningCalculationInput,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  type PlanningCalculationRequestV1,
  type ProjectRequirementsRechnerV1,
  type SiteEnergyProfileV1,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResult,
} from "@/lib/integrations/calculation/contract";
import { calculatePlanningEstimate } from
  "@/lib/integrations/calculation/engine";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
  PLANNING_RESERVATION_VERSION,
} from "@/lib/integrations/calculation/versions";
import {
  RECHNER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyRechnerSignature,
  type VerifiedRechnerIdentity,
} from "@/lib/integrations/rechner/signature";
import type {
  RechnerIntakeMeta,
  RechnerIntakeV1,
} from "@/lib/integrations/rechner/types";
import { processRechnerIntake } from "@/modules/intake";
import { confirmProjectSitePin } from "@/modules/projects";
import * as energyModule from "@/modules/energy";
import {
  confirmProjectEnergyProfile,
  getProjectEnergyProfileCandidate,
  saveProjectEnergyProfile,
  type ConfirmProjectEnergyProfileResult,
  type ProjectEnergyProfileCandidate,
  type SaveProjectEnergyProfileResult,
} from "@/modules/energy";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const GOLDEN = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
  "utf8",
)) as RechnerIntakeV1;
const NEW_REQUEST_GOLDEN = JSON.parse(readFileSync(
  resolve(
    import.meta.dirname,
    "../../contracts/examples/planning-calculation.v1.new.request.json",
  ),
  "utf8",
)) as PlanningCalculationRequestV1;

type ActorFixture = {
  workspaceId: string;
  actorId: string;
};

type LeadFixture = ActorFixture & {
  projectId: string;
  siteId: string;
  snapshotId: string;
  requirementId: string;
  intake: RechnerIntakeV1;
};

type ConfirmationFootprint = {
  jobs: number;
  siteConfirmedEvents: number;
  calculationReservedEvents: number;
  successAudits: number;
  confirmedProfileRevision: number | null;
  confirmedAddressRevision: number | null;
};

function payload(): RechnerIntakeV1 {
  const value = structuredClone(GOLDEN);
  value.submissionId = randomUUID();
  value.submittedAt = NOW.toISOString();
  value.calculation.calculatedAt = NOW.toISOString();
  if (!value.calculation.inputs.answeredFieldIds.includes("verschattung")) {
    value.calculation.inputs.answeredFieldIds.push("verschattung");
  }
  return value;
}

function existingInstallationWithoutStorageTruth(): RechnerIntakeV1 {
  const value = payload();
  value.calculation.branch = "existing_installation";
  value.calculation.inputs.existingInstallation = {
    peakPowerKwp: 7.4,
    commissioningYear: 2012,
    storageKwh: 0,
  };
  value.calculation.inputs.answeredFieldIds = [
    ...value.calculation.inputs.answeredFieldIds.filter(
      (field) => !["bestandKwp", "bestandJahr", "bestandSpeicher"].includes(field),
    ),
    "bestandKwp",
    "bestandJahr",
  ];
  value.calculation.result = {
    mode: "existing_installation",
    existingPeakPowerKwp: 7.4,
    existingStorageKwh: 0,
    requestedAdditionalStorageKwh:
      value.calculation.inputs.requestedProducts.targetStorageKwh,
    retrofit: null,
  };
  return value;
}

function verifiedIdentity(workspaceId: string): VerifiedRechnerIdentity {
  const keyId = `m107-domain-${randomUUID()}`;
  const secret = Buffer.alloc(32, 41);
  const body = Buffer.from("{}", "utf8");
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const idempotencyKey = randomUUID();
  const contentSha256 = sha256Hex(body);
  const signature = createHmac("sha256", secret)
    .update(signatureMessage({
      method: "POST",
      path: RECHNER_INTAKE_PATH,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");

  return verifyRechnerSignature({
    method: "POST",
    path: RECHNER_INTAKE_PATH,
    body,
    nowSeconds: Number(timestamp),
    credentialsJson: JSON.stringify([{
      keyId,
      workspaceId,
      scope: "rechner-intake.write",
      secretBase64: secret.toString("base64"),
    }]),
    headers: {
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
      signature: `v1=${signature}`,
    },
  });
}

function intakeMeta(value: RechnerIntakeV1): RechnerIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

async function createActor(): Promise<ActorFixture> {
  const fixture = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
  };
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.workspaceId}::uuid, 'M1-07 Domain Contract')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${fixture.actorId}::uuid, ${`${fixture.actorId}@m107-domain.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${fixture.workspaceId}::uuid, ${fixture.actorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return fixture;
}

async function submitLead(
  actor: ActorFixture,
  value = payload(),
): Promise<LeadFixture> {
  const receipt = await withTenantOn(testPool, actor.workspaceId, (tx) =>
    processRechnerIntake(
      tx,
      verifiedIdentity(actor.workspaceId),
      value,
      intakeMeta(value),
    ));
  const result = await withTenantOn(testPool, actor.workspaceId, (tx) => tx.execute<{
    project_id: string;
    site_id: string;
    snapshot_id: string;
    requirement_id: string;
    [key: string]: unknown;
  }>(sql`
    select receipt.project_id, receipt.site_id,
           snapshot.id as snapshot_id, requirement.id as requirement_id
      from inbound_receipt receipt
      join calculator_snapshot snapshot
        on snapshot.workspace_id = receipt.workspace_id
       and snapshot.receipt_id = receipt.id
      join project_requirement requirement
        on requirement.workspace_id = receipt.workspace_id
       and requirement.project_id = receipt.project_id
     where receipt.id = ${receipt.receiptId}::uuid
  `));
  const row = result.rows[0];
  return {
    ...actor,
    projectId: row.project_id,
    siteId: row.site_id,
    snapshotId: row.snapshot_id,
    requirementId: row.requirement_id,
    intake: structuredClone(value),
  };
}

async function asActor<T>(
  fixture: ActorFixture,
  operation: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return withAuthorizedTenantOn(
    testPool,
    fixture.actorId,
    fixture.workspaceId,
    operation,
  );
}

async function confirmPin(fixture: LeadFixture): Promise<void> {
  await asActor(fixture, (tx, ctx) => confirmProjectSitePin(tx, ctx, {
    projectId: fixture.projectId,
    expectedAddressRevision: 1,
  }));
}

async function candidate(fixture: LeadFixture): Promise<ProjectEnergyProfileCandidate> {
  const value = await asActor(fixture, (tx, ctx) =>
    getProjectEnergyProfileCandidate(tx, ctx, fixture.projectId));
  expect(value).not.toBeNull();
  if (value === null) throw new Error("Energieprofil-Kandidat fehlt.");
  return value;
}

async function save(
  fixture: LeadFixture,
  value: ProjectEnergyProfileCandidate,
  options: {
    expectedLatestRevision?: number;
    profile?: SiteEnergyProfileV1;
    roofAcknowledgements?: string[];
  } = {},
): Promise<SaveProjectEnergyProfileResult> {
  const profile = structuredClone(options.profile ?? value.profile);
  return asActor(fixture, (tx, ctx) => saveProjectEnergyProfile(tx, ctx, {
    projectId: fixture.projectId,
    expectedAddressRevision: value.addressRevision,
    expectedLatestRevision: options.expectedLatestRevision ?? value.expectedLatestRevision,
    profile,
    roofAcknowledgements: options.roofAcknowledgements
      ?? profile.roofs.map((roof) => roof.id),
  }));
}

async function confirm(
  fixture: LeadFixture,
  profileRevision: number,
): Promise<ConfirmProjectEnergyProfileResult> {
  return confirmAs(fixture, fixture.actorId, profileRevision);
}

async function confirmAs(
  fixture: LeadFixture,
  actorId: string,
  profileRevision: number,
): Promise<ConfirmProjectEnergyProfileResult> {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => confirmProjectEnergyProfile(tx, ctx, {
    projectId: fixture.projectId,
    expectedAddressRevision: 1,
    expectedProfileRevision: profileRevision,
    }),
  );
}

async function storedProfile(fixture: LeadFixture): Promise<{
  id: string;
  revision: number;
  profile: SiteEnergyProfileV1;
  profile_sha256: string;
  source_kind: string;
  source_snapshot_id: string | null;
  source_project_id: string | null;
  confirmed_profile_revision: number | null;
  confirmed_address_revision: number | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
}> {
  const result = await asActor(fixture, (tx) => tx.execute<{
    id: string;
    revision: number;
    profile: SiteEnergyProfileV1;
    profile_sha256: string;
    source_kind: string;
    source_snapshot_id: string | null;
    source_project_id: string | null;
    confirmed_profile_revision: number | null;
    confirmed_address_revision: number | null;
    confirmed_by: string | null;
    confirmed_at: Date | null;
    [key: string]: unknown;
  }>(sql`
    select id, revision, profile, encode(profile_sha256, 'hex') as profile_sha256,
           source_kind, source_snapshot_id, source_project_id,
           confirmed_profile_revision, confirmed_address_revision,
           confirmed_by, confirmed_at
      from site_energy_profile
     where site_id = ${fixture.siteId}::uuid
  `));
  const row = result.rows[0];
  if (!row) throw new Error("Gespeichertes Energieprofil fehlt.");
  return row;
}

async function confirmationFootprint(fixture: LeadFixture): Promise<ConfirmationFootprint> {
  return asActor(fixture, async (tx) => {
    const counts = await tx.execute<{
      jobs: number;
      site_confirmed_events: number;
      calculation_reserved_events: number;
      success_audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int
           from project_calculation_job job
          where job.project_id = ${fixture.projectId}::uuid) as jobs,
        (select count(*)::int
           from domain_events event
          where event.event_type = 'site.energy_profile_confirmed'
            and event.aggregate_id = ${fixture.siteId}::uuid) as site_confirmed_events,
        (select count(*)::int
           from domain_events event
          where event.event_type = 'project.calculation_reserved'
            and event.aggregate_id = ${fixture.projectId}::uuid) as calculation_reserved_events,
        (select count(*)::int
           from audit_log audit
          where audit.workspace_id = ${fixture.workspaceId}::uuid
            and audit.allowed = true) as success_audits
    `);
    const profile = await storedProfile(fixture);
    const row = counts.rows[0];
    return {
      jobs: row.jobs,
      siteConfirmedEvents: row.site_confirmed_events,
      calculationReservedEvents: row.calculation_reserved_events,
      successAudits: row.success_audits,
      confirmedProfileRevision: profile.confirmed_profile_revision,
      confirmedAddressRevision: profile.confirmed_address_revision,
    };
  });
}

function requirementsFrom(value: RechnerIntakeV1): ProjectRequirementsRechnerV1 {
  const requested = value.calculation.inputs.requestedProducts;
  return {
    schemaVersion: "project-requirements.rechner.v1",
    source: "wmee-rechner-v3",
    branch: value.calculation.branch,
    requestedProducts: {
      targetStorageKwh: requested.targetStorageKwh,
      wallbox: requested.wallbox,
      bidirectionalCharging: requested.bidirectionalCharging,
      backupPower: requested.backupPower,
    },
  };
}

async function setRequirement(fixture: LeadFixture, requirements: unknown): Promise<void> {
  await asActor(fixture, (tx) => tx.execute(sql`
    update project_requirement
       set requirements = ${JSON.stringify(requirements)}::jsonb
     where id = ${fixture.requirementId}::uuid
  `));
}

async function withUncheckedRequirement(
  fixture: LeadFixture,
  requirements: unknown,
  operation: () => Promise<void>,
): Promise<void> {
  const connection = await testPool.connect();
  const constraintName = "project_requirement_json_ck";
  const definition = await connection.query<{ definition: string }>(`
    select pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conrelid = 'project_requirement'::regclass
       and conname = '${constraintName}'
  `);
  const constraintDefinition = definition.rows[0]?.definition;
  if (!constraintDefinition) {
    connection.release();
    throw new Error(`${constraintName} fehlt.`);
  }

  await connection.query(`alter table project_requirement drop constraint ${constraintName}`);
  try {
    await setRequirement(fixture, requirements);
    await operation();
  } finally {
    await setRequirement(fixture, requirementsFrom(fixture.intake));
    await connection.query(
      `alter table project_requirement add constraint ${constraintName} ${constraintDefinition}`,
    );
    connection.release();
  }
}

async function expectInvalidRequirementFailClosed(
  fixture: LeadFixture,
  requirements: unknown,
  profileRevision = 1,
): Promise<void> {
  await withUncheckedRequirement(fixture, requirements, async () => {
    const before = await confirmationFootprint(fixture);
    const [outcome] = await Promise.allSettled([confirm(fixture, profileRevision)]);
    const after = await confirmationFootprint(fixture);

    expect.soft(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect.soft(outcome.reason).toMatchObject({ code: "invalid_profile" });
    }
    expect(after).toEqual(before);
  });
}

function changedConsumption(profile: SiteEnergyProfileV1): SiteEnergyProfileV1 {
  const changed = structuredClone(profile);
  changed.consumption.householdKwhPerYear = {
    status: "known",
    value: 4_777,
    source: "operator_reviewed",
  };
  return changed;
}

async function eventAndAuditCounts(
  fixture: ActorFixture,
  siteId: string,
  projectAId: string,
  projectBId: string,
): Promise<{
  siteConfirmed: number;
  reservedA: number;
  reservedB: number;
  successAudits: number;
  profiles: number;
  jobsA: number;
  jobsB: number;
}> {
  return asActor(fixture, async (tx) => {
    const result = await tx.execute<{
      site_confirmed: number;
      reserved_a: number;
      reserved_b: number;
      success_audits: number;
      profiles: number;
      jobs_a: number;
      jobs_b: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from domain_events event
          where event.event_type = 'site.energy_profile_confirmed'
            and event.aggregate_id = ${siteId}::uuid) as site_confirmed,
        (select count(*)::int from domain_events event
          where event.event_type = 'project.calculation_reserved'
            and event.aggregate_id = ${projectAId}::uuid) as reserved_a,
        (select count(*)::int from domain_events event
          where event.event_type = 'project.calculation_reserved'
            and event.aggregate_id = ${projectBId}::uuid) as reserved_b,
        (select count(*)::int from audit_log audit
          where audit.workspace_id = ${fixture.workspaceId}::uuid
            and audit.allowed = true) as success_audits,
        (select count(*)::int from site_energy_profile profile
          where profile.site_id = ${siteId}::uuid) as profiles,
        (select count(*)::int from project_calculation_job job
          where job.project_id = ${projectAId}::uuid) as jobs_a,
        (select count(*)::int from project_calculation_job job
          where job.project_id = ${projectBId}::uuid) as jobs_b
    `);
    const row = result.rows[0];
    return {
      siteConfirmed: row.site_confirmed,
      reservedA: row.reserved_a,
      reservedB: row.reserved_b,
      successAudits: row.success_audits,
      profiles: row.profiles,
      jobsA: row.jobs_a,
      jobsB: row.jobs_b,
    };
  });
}

async function succeedJob(
  fixture: LeadFixture,
  confirmation: ConfirmProjectEnergyProfileResult,
): Promise<PlanningCalculationRequestV1> {
  return asActor(fixture, async (tx) => {
    const jobResult = await tx.execute<{
      id: string;
      project_id: string;
      site_id: string;
      address_revision: number;
      pin_confirmed_address_revision: number;
      profile_id: string;
      profile_revision: number;
      confirmed_profile_revision: number;
      confirmed_address_revision: number;
      requirement_id: string;
      requirement_revision: number;
      source_snapshot_id: string;
      contract_version: string;
      model_id: string;
      model_version: string;
      source_revision: string;
      defaults_version: string;
      created_by: string;
      [key: string]: unknown;
    }>(sql`
      select id, project_id, site_id, address_revision,
             pin_confirmed_address_revision, profile_id, profile_revision,
             confirmed_profile_revision, confirmed_address_revision,
             requirement_id, requirement_revision, source_snapshot_id,
             contract_version, model_id, model_version, source_revision,
             defaults_version, created_by
        from project_calculation_job
       where id = ${confirmation.jobId}::uuid
    `);
    const job = jobResult.rows[0];
    if (!job) throw new Error("Calculation-Job fehlt.");

    const profileResult = await tx.execute<{
      profile: SiteEnergyProfileV1;
      [key: string]: unknown;
    }>(sql`
      select profile
        from site_energy_profile
       where id = ${job.profile_id}::uuid
    `);
    const profile = profileResult.rows[0]?.profile;
    if (!profile) throw new Error("Calculation-Profil fehlt.");

    const leaseToken = randomUUID();
    const resultRevisionId = randomUUID();
    const inputSnapshot = structuredClone(NEW_REQUEST_GOLDEN);
    inputSnapshot.bindings = {
      workspaceId: fixture.workspaceId,
      projectId: job.project_id,
      siteId: job.site_id,
      addressRevision: job.address_revision,
      pinConfirmedAddressRevision: job.pin_confirmed_address_revision,
      energyProfileId: job.profile_id,
      energyProfileRevision: job.profile_revision,
      confirmedEnergyProfileRevision: job.confirmed_profile_revision,
      confirmedEnergyProfileAddressRevision: job.confirmed_address_revision,
      projectRequirementId: job.requirement_id,
      projectRequirementRevision: job.requirement_revision,
      sourceCalculatorSnapshotId: job.source_snapshot_id,
    };
    inputSnapshot.energyProfile = structuredClone(profile);
    inputSnapshot.projectRequirements = requirementsFrom(fixture.intake);
    inputSnapshot.branch = inputSnapshot.projectRequirements.branch;
    inputSnapshot.effectiveStorageRequest.valueKwh =
      inputSnapshot.projectRequirements.requestedProducts.targetStorageKwh;
    const effectiveConsumption = inputSnapshot.effectiveConsumption as unknown as Record<
      string,
      { resolution: string; value: unknown; [key: string]: unknown }
    >;
    const profileConsumption = inputSnapshot.energyProfile.consumption as unknown as Record<
      string,
      { status: "known" | "unknown"; value: unknown }
    >;
    for (const field of Object.keys(effectiveConsumption)) {
      const profileField = profileConsumption[field];
      if (profileField.status === "known") {
        effectiveConsumption[field] = {
          resolution: "profile_value",
          value: profileField.value,
          profileField: `/consumption/${field}`,
        };
      } else {
        effectiveConsumption[field] = {
          resolution: "versioned_default",
          value: effectiveConsumption[field].value,
          defaultKey: field,
          defaultsVersion: PLANNING_DEFAULTS_VERSION,
        };
      }
    }
    inputSnapshot.yieldSnapshots = inputSnapshot.energyProfile.roofs.map((roof) => {
      const snapshot = structuredClone(NEW_REQUEST_GOLDEN.yieldSnapshots[0]);
      snapshot.roofId = roof.id;
      snapshot.request.tiltDeg = roof.tiltDeg;
      snapshot.request.azimuthDeg = roof.azimuthDeg;
      return snapshot;
    });
    const validatedInput = validatePlanningCalculationRequest(inputSnapshot);
    if (!validatedInput.ok) {
      throw new Error(
        `Test-Calculation-Request verletzt den Contract: ${validatedInput.paths.join(", ")}`,
      );
    }
    const providerSnapshot = {
      provider: "pvgis",
      recipeVersion: PLANNING_PROVIDER_RECIPE_VERSION,
      testOnlyPrivateMarker: "provider-response-must-not-leak",
    };
    const inputSha256 = hashPlanningCalculationInput(validatedInput.value);
    const calculationResult = calculatePlanningEstimate(validatedInput.value);
    const validatedResult = validatePlanningCalculationResult(calculationResult);
    if (!validatedResult.ok) {
      throw new Error(
        `Test-Calculation-Result verletzt den Contract: ${validatedResult.paths.join(", ")}`,
      );
    }
    const resultSha256 = calculationResult.resultSha256;

    await tx.execute(sql`
      update project_calculation_job
         set state = 'running', attempt_count = 1, started_at = now(),
             lease_token = ${leaseToken}::uuid,
             lease_expires_at = now() + interval '5 minutes',
             input_sha256 = decode(${inputSha256}, 'hex'),
             input_snapshot = ${JSON.stringify(inputSnapshot)}::jsonb,
             provider_snapshot = ${JSON.stringify(providerSnapshot)}::jsonb
       where id = ${job.id}::uuid
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
        ${resultRevisionId}::uuid, ${fixture.workspaceId}::uuid,
        ${job.project_id}::uuid, ${job.site_id}::uuid, 1, ${job.id}::uuid,
        ${job.address_revision}, ${job.pin_confirmed_address_revision},
        ${job.profile_id}::uuid, ${job.profile_revision},
        ${job.confirmed_profile_revision}, ${job.confirmed_address_revision},
        ${job.requirement_id}::uuid, ${job.requirement_revision},
        ${job.source_snapshot_id}::uuid, ${job.contract_version},
        ${job.model_id}, ${job.model_version}, ${job.source_revision},
        ${job.defaults_version}, 'server_reproduced_estimate',
        'not_f4_reference_validated', decode(${inputSha256}, 'hex'),
        decode(${resultSha256}, 'hex'), ${JSON.stringify(inputSnapshot)}::jsonb,
        ${JSON.stringify(providerSnapshot)}::jsonb,
        ${JSON.stringify(calculationResult)}::jsonb, ${job.created_by}::uuid
      )
    `);
    await tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded', result_revision_id = ${resultRevisionId}::uuid,
             finished_at = now(), lease_token = null, lease_expires_at = null
       where id = ${job.id}::uuid
    `);
    return validatedInput.value;
  });
}

type ReadProjectEnergyContext = (
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
) => Promise<unknown>;

function projectEnergyContextReader(): ReadProjectEnergyContext {
  const reader = (energyModule as unknown as Record<string, unknown>)[
    "getProjectEnergyContext"
  ];
  expect(typeof reader).toBe("function");
  if (typeof reader !== "function") {
    throw new Error("getProjectEnergyContext fehlt.");
  }
  return reader as ReadProjectEnergyContext;
}

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function commitGraphRevision(
  fixture: LeadFixture,
  current: Awaited<ReturnType<typeof storedProfile>>,
): Promise<void> {
  const nextProfile = changedConsumption(current.profile);
  const nextProfileSha256 = createHash("sha256")
    .update(canonicalizeCalculationJson(nextProfile), "utf8")
    .digest("hex");
  const nextRequirements = requirementsFrom(fixture.intake);
  nextRequirements.requestedProducts.targetStorageKwh += 1;

  await asActor(fixture, async (tx) => {
    await tx.execute(sql`
      update site
         set address_revision = address_revision + 1,
             pin_confirmed_address_revision = address_revision + 1,
             updated_at = now()
       where id = ${fixture.siteId}::uuid
    `);
    await tx.execute(sql`
      update site_energy_profile
         set revision = ${current.revision + 1},
             address_revision = 2,
             profile = ${JSON.stringify(nextProfile)}::jsonb,
             profile_sha256 = decode(${nextProfileSha256}, 'hex'),
             confirmed_profile_revision = null,
             confirmed_address_revision = null,
             confirmed_by = null,
             confirmed_at = null,
             updated_at = now()
       where id = ${current.id}::uuid
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
        ${fixture.projectId}::uuid, 2, 'project-requirements.rechner.v1',
        ${fixture.snapshotId}::uuid, ${JSON.stringify(nextRequirements)}::jsonb
      )
    `);
  });
}

async function readAcrossConcurrentGraphRevision(
  fixture: LeadFixture,
  read: ReadProjectEnergyContext,
): Promise<unknown> {
  const current = await storedProfile(fixture);
  let queryNumber = 0;
  let graphRevision: Promise<void> | undefined;

  const context = await asActor(fixture, async (tx, ctx) => {
    const execute = tx.execute.bind(tx) as (...args: unknown[]) => Promise<unknown>;
    const instrumented = new Proxy(tx, {
      get(target, property) {
        if (property === "execute") {
          return async (...args: unknown[]) => {
            queryNumber += 1;
            const result = await execute(...args);
            if (queryNumber === 1) {
              graphRevision = commitGraphRevision(fixture, current);
              // A coherent implementation may hold a read lock. In that case the
              // writer is allowed to finish only after this read transaction.
              await settlesWithin(graphRevision, 750);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TenantTx;
    return read(instrumented, ctx, fixture.projectId);
  });

  if (graphRevision === undefined) {
    throw new Error("Der Snapshot-Read hat keine Tenant-Abfrage ausgeführt.");
  }
  await graphRevision;
  return context;
}

async function withTamperedReservationKey<T>(
  fixture: LeadFixture,
  jobId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await testPool.connect();
  await connection.query(`
    alter table project_calculation_job
    disable trigger project_calculation_job_mutation_guard
  `);
  try {
    await asActor(fixture, (tx) => tx.execute(sql`
      update project_calculation_job
         set reservation_key = decode(repeat('00', 32), 'hex')
       where id = ${jobId}::uuid
    `));
    return await operation();
  } finally {
    await connection.query(`
      alter table project_calculation_job
      enable trigger project_calculation_job_mutation_guard
    `);
    connection.release();
  }
}

async function failJobPermanently(
  fixture: LeadFixture,
  confirmation: ConfirmProjectEnergyProfileResult,
): Promise<void> {
  await asActor(fixture, async (tx) => {
    const leaseToken = randomUUID();
    await tx.execute(sql`
      update project_calculation_job
         set state = 'running', attempt_count = 1, started_at = now(),
             lease_token = ${leaseToken}::uuid,
             lease_expires_at = now() + interval '5 minutes'
       where id = ${confirmation.jobId}::uuid
    `);
    await tx.execute(sql`
      update project_calculation_job
         set state = 'failed_final', error_code = 'engine_invalid',
             error_retryable = false, finished_at = now(),
             lease_token = null, lease_expires_at = null
       where id = ${confirmation.jobId}::uuid
    `);
  });
}

describe.sequential("M1-07 fachlicher Energieprofil-Domainvertrag", () => {
  it("macht aus einem unveraenderten Default-Dach auch mit Ack keine bestaetigte Site-Wahrheit", async () => {
    const value = payload();
    value.calculation.provenance.roof = "default";
    const fixture = await submitLead(await createActor(), value);
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    expect(projected.profile.roofs[0].source).toBe("default");

    const savedDefault = await save(fixture, projected, {
      roofAcknowledgements: [],
    });
    expect(savedDefault.revision).toBe(1);
    expect((await storedProfile(fixture)).profile.roofs[0].source).toBe("default");

    const beforeAck = await confirmationFootprint(fixture);
    await expect(save(fixture, projected, {
      expectedLatestRevision: 1,
      roofAcknowledgements: projected.profile.roofs.map((roof) => roof.id),
    })).rejects.toMatchObject({ code: "prerequisites_missing" });
    expect(await confirmationFootprint(fixture)).toEqual(beforeAck);
    expect((await storedProfile(fixture)).profile.roofs[0].source).toBe("default");

    const beforeRejectedConfirm = await confirmationFootprint(fixture);
    const [outcome] = await Promise.allSettled([confirm(fixture, 1)]);
    expect.soft(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect.soft(outcome.reason).toMatchObject({ code: "prerequisites_missing" });
    }
    expect.soft(await confirmationFootprint(fixture)).toEqual(beforeRejectedConfirm);

    const replacement = structuredClone(projected.profile);
    replacement.roofs = [{
      ...replacement.roofs[0],
      id: "manual-roof-replacement",
      areaM2: replacement.roofs[0].areaM2 + 1,
      azimuthDeg: replacement.roofs[0].azimuthDeg + 1,
      source: "operator_reviewed",
    }];
    const savedReplacement = await save(fixture, projected, {
      expectedLatestRevision: 1,
      profile: replacement,
      roofAcknowledgements: [replacement.roofs[0].id],
    });
    expect(savedReplacement.revision).toBe(2);
    expect((await storedProfile(fixture)).profile.roofs[0]).toMatchObject({
      id: "manual-roof-replacement",
      source: "operator_reviewed",
    });
    await expect(confirm(fixture, 2)).resolves.toMatchObject({
      profileRevision: 2,
      replayed: false,
    });
  });

  it("teilt die Site-Wahrheit, reserviert A und B getrennt und replayt nur die exakte B-Reservation still", async () => {
    const actor = await createActor();
    const projectA = await submitLead(actor);
    const valueB = payload();
    valueB.calculation.inputs.requestedProducts.targetStorageKwh = 12;
    const projectB = await submitLead(actor, valueB);
    expect(projectB.siteId).toBe(projectA.siteId);
    expect(projectB.projectId).not.toBe(projectA.projectId);
    expect(projectB.requirementId).not.toBe(projectA.requirementId);

    await confirmPin(projectA);
    const projectedA = await candidate(projectA);
    const saved = await save(projectA, projectedA);
    const beforeA = await eventAndAuditCounts(
      actor,
      projectA.siteId,
      projectA.projectId,
      projectB.projectId,
    );

    const confirmationA = await confirm(projectA, saved.revision);
    expect(confirmationA.replayed).toBe(false);
    const afterA = await eventAndAuditCounts(
      actor,
      projectA.siteId,
      projectA.projectId,
      projectB.projectId,
    );
    expect(afterA).toEqual({
      ...beforeA,
      siteConfirmed: beforeA.siteConfirmed + 1,
      reservedA: beforeA.reservedA + 1,
      successAudits: beforeA.successAudits + 1,
      profiles: 1,
      jobsA: 1,
      jobsB: 0,
    });

    // B ist eine echte neue Reservation und unterliegt deshalb dem v1-
    // Actor-Cooldown. Ein zweiter berechtigter Editor beweist weiterhin die
    // Project-Trennung, ohne den neuen Schutzvertrag per Testuhr zu umgehen.
    const secondActorId = randomUUID();
    await withTenantOn(testPool, actor.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${secondActorId}::uuid, ${`${secondActorId}@m107-domain.test`})
      `);
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role, capabilities)
        values (
          ${actor.workspaceId}::uuid,
          ${secondActorId}::uuid,
          'editor',
          '{}'::jsonb
        )
      `);
    });
    const confirmationB = await confirmAs(projectB, secondActorId, saved.revision);
    expect(confirmationB).toMatchObject({ replayed: false });
    expect(confirmationB.jobId).not.toBe(confirmationA.jobId);
    const afterB = await eventAndAuditCounts(
      actor,
      projectA.siteId,
      projectA.projectId,
      projectB.projectId,
    );
    expect(afterB).toEqual({
      ...afterA,
      reservedB: afterA.reservedB + 1,
      successAudits: afterA.successAudits + 1,
      jobsB: 1,
    });

    const replayB = await confirm(projectB, saved.revision);
    expect(replayB).toMatchObject({
      jobId: confirmationB.jobId,
      reservationKey: confirmationB.reservationKey,
      replayed: true,
    });
    expect(await eventAndAuditCounts(
      actor,
      projectA.siteId,
      projectA.projectId,
      projectB.projectId,
    )).toEqual(afterB);

    const jobs = await asActor(actor, (tx) => tx.execute<{
      project_id: string;
      requirement_id: string;
      profile_id: string;
      profile_revision: number;
      [key: string]: unknown;
    }>(sql`
      select project_id, requirement_id, profile_id, profile_revision
        from project_calculation_job
       where project_id in (${projectA.projectId}::uuid, ${projectB.projectId}::uuid)
       order by project_id
    `));
    expect(jobs.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        project_id: projectA.projectId,
        requirement_id: projectA.requirementId,
        profile_id: saved.profileId,
        profile_revision: saved.revision,
      }),
      expect.objectContaining({
        project_id: projectB.projectId,
        requirement_id: projectB.requirementId,
        profile_id: saved.profileId,
        profile_revision: saved.revision,
      }),
    ]));
  });

  for (const invalidCapacity of [-1, 41]) {
    it(`lehnt Requirement targetStorageKwh=${invalidCapacity} ohne Confirmation oder Trace ab`, async () => {
      const fixture = await submitLead(await createActor());
      await confirmPin(fixture);
      const projected = await candidate(fixture);
      await save(fixture, projected);
      const requirements = requirementsFrom(fixture.intake);
      requirements.requestedProducts.targetStorageKwh = invalidCapacity;
      await expectInvalidRequirementFailClosed(fixture, requirements);
    });
  }

  it("lehnt ein zusaetzliches Requirement-Feld auch bei persistierter Altlast fail-closed ab", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    await save(fixture, projected);
    const requirements = {
      ...requirementsFrom(fixture.intake),
      browserOnlyOverride: true,
    };
    await expectInvalidRequirementFailClosed(fixture, requirements);
  });

  it("lehnt den Widerspruch zwischen Requirement-Branch und Quell-Snapshot trotz passend editiertem Profil ab", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const edited = structuredClone(projected.profile);
    edited.existingAssets.pv = {
      status: "known_present",
      source: "operator_reviewed",
      peakPowerKwp: 7.4,
      commissioningYear: 2012,
    };
    await save(fixture, projected, { profile: edited });
    const requirements = requirementsFrom(fixture.intake);
    requirements.branch = "existing_installation";
    await expectInvalidRequirementFailClosed(fixture, requirements);
  });

  it("meldet ein identisches Save nach Confirm mit dem wirklichen Confirmationstatus zurueck", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const first = await save(fixture, projected);
    await confirm(fixture, first.revision);
    const beforeReplaySave = await confirmationFootprint(fixture);

    const replaySave = await save(fixture, projected, {
      expectedLatestRevision: first.revision,
    });
    expect(replaySave).toMatchObject({
      profileId: first.profileId,
      revision: first.revision,
      changed: false,
      confirmed: true,
    });
    expect(await confirmationFootprint(fixture)).toEqual(beforeReplaySave);
  });

  it("bindet Canonicalization-Version und Schema-SHA in das oeffentlich pruefbare Reservationmaterial", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const saved = await save(fixture, projected);
    const confirmation = await confirm(fixture, saved.revision);
    const expectedReservationKey = createHash("sha256")
      .update(canonicalizeCalculationJson({
        reservationVersion: PLANNING_RESERVATION_VERSION,
        canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
        schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
        bindings: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          siteId: fixture.siteId,
          addressRevision: 1,
          pinConfirmedAddressRevision: 1,
          profileId: saved.profileId,
          profileRevision: saved.revision,
          confirmedProfileRevision: saved.revision,
          confirmedAddressRevision: 1,
          requirementId: fixture.requirementId,
          requirementRevision: 1,
          sourceSnapshotId: fixture.snapshotId,
        },
        providerRecipeVersion: PLANNING_PROVIDER_RECIPE_VERSION,
        contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
        modelId: PLANNING_MODEL_ID,
        modelVersion: PLANNING_MODEL_VERSION,
        sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
        defaultsVersion: PLANNING_DEFAULTS_VERSION,
      }), "utf8")
      .digest("hex");

    expect(confirmation.reservationKey).toBe(expectedReservationKey);
  });

  it("liefert bei gleichzeitiger Profil-, Adress- und Requirement-Aenderung nur einen konsistenten Read-Snapshot", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const saved = await save(fixture, projected);
    const confirmation = await confirm(fixture, saved.revision);
    await succeedJob(fixture, confirmation);

    const context = await readAcrossConcurrentGraphRevision(
      fixture,
      projectEnergyContextReader(),
    ) as {
      addressRevision: number;
      profile: {
        revision: number;
        addressRevision: number;
        confirmed: boolean;
      } | null;
      calculation: { status: string };
    };
    expect(context.profile).not.toBeNull();
    if (context.profile === null) return;

    const observed = {
      addressRevision: context.addressRevision,
      profileRevision: context.profile.revision,
      profileAddressRevision: context.profile.addressRevision,
      profileConfirmed: context.profile.confirmed,
      calculationStatus: context.calculation.status,
    };
    expect([
      {
        addressRevision: 1,
        profileRevision: 1,
        profileAddressRevision: 1,
        profileConfirmed: true,
        calculationStatus: "current",
      },
      {
        addressRevision: 2,
        profileRevision: 2,
        profileAddressRevision: 2,
        profileConfirmed: false,
        calculationStatus: "stale",
      },
    ]).toContainEqual(observed);
  });

  it("leitet einen Job mit nicht mehr reproduzierbarem versioniertem Reservation-Key als stale ab", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const saved = await save(fixture, projected);
    const confirmation = await confirm(fixture, saved.revision);
    await succeedJob(fixture, confirmation);
    const read = projectEnergyContextReader();

    await expect(asActor(fixture, (tx, ctx) => read(tx, ctx, fixture.projectId)))
      .resolves.toMatchObject({ calculation: { status: "current" } });

    await withTamperedReservationKey(fixture, confirmation.jobId, async () => {
      const context = await asActor(
        fixture,
        (tx, ctx) => read(tx, ctx, fixture.projectId),
      );
      expect(context).toMatchObject({ calculation: { status: "stale" } });
    });
  });

  it("behandelt dasselbe Site-Profil aus Project B als No-op und bewahrt A-Provenienz, Confirmation und Current-Status", async () => {
    const actor = await createActor();
    const projectA = await submitLead(actor);
    const projectB = await submitLead(actor);
    expect(projectB.siteId).toBe(projectA.siteId);
    await confirmPin(projectA);

    const projectedA = await candidate(projectA);
    const savedA = await save(projectA, projectedA);
    const confirmationA = await confirm(projectA, savedA.revision);
    await succeedJob(projectA, confirmationA);
    const before = await storedProfile(projectA);
    const read = projectEnergyContextReader();
    await expect(asActor(projectA, (tx, ctx) => read(tx, ctx, projectA.projectId)))
      .resolves.toMatchObject({ calculation: { status: "current" } });

    const projectedB = await candidate(projectB);
    const savedB = await save(projectB, projectedB, {
      expectedLatestRevision: savedA.revision,
    });
    const after = await storedProfile(projectA);
    const projectAContext = await asActor(
      projectA,
      (tx, ctx) => read(tx, ctx, projectA.projectId),
    );

    expect.soft(savedB).toMatchObject({
      profileId: savedA.profileId,
      revision: savedA.revision,
      changed: false,
      confirmed: true,
    });
    expect.soft(after.profile).toEqual(before.profile);
    expect.soft({
      profileSha256: after.profile_sha256,
      sourceKind: after.source_kind,
      sourceSnapshotId: after.source_snapshot_id,
      sourceProjectId: after.source_project_id,
      confirmedProfileRevision: after.confirmed_profile_revision,
      confirmedAddressRevision: after.confirmed_address_revision,
      confirmedBy: after.confirmed_by,
      confirmedAt: after.confirmed_at,
    }).toEqual({
      profileSha256: before.profile_sha256,
      sourceKind: before.source_kind,
      sourceSnapshotId: before.source_snapshot_id,
      sourceProjectId: before.source_project_id,
      confirmedProfileRevision: before.confirmed_profile_revision,
      confirmedAddressRevision: before.confirmed_address_revision,
      confirmedBy: before.confirmed_by,
      confirmedAt: before.confirmed_at,
    });
    expect.soft(projectAContext).toMatchObject({
      calculation: { status: "current" },
    });
  });

  it("setzt canConfirm nur bei wirklich ausfuehrbaren Confirmation-Preconditions", async () => {
    const defaultRoofValue = payload();
    defaultRoofValue.calculation.provenance.roof = "default";
    const defaultRoof = await submitLead(await createActor(), defaultRoofValue);
    await confirmPin(defaultRoof);
    const defaultCandidate = await candidate(defaultRoof);
    await save(defaultRoof, defaultCandidate, { roofAcknowledgements: [] });
    const read = projectEnergyContextReader();

    await expect(asActor(
      defaultRoof,
      (tx, ctx) => read(tx, ctx, defaultRoof.projectId),
    )).resolves.toMatchObject({
      calculation: { status: "blocked", blocker: "profile_confirmation" },
      capabilities: { canConfirm: false },
    });

    const invalidRequirement = await submitLead(await createActor());
    await confirmPin(invalidRequirement);
    const invalidCandidate = await candidate(invalidRequirement);
    await save(invalidRequirement, invalidCandidate);
    const contradictory = requirementsFrom(invalidRequirement.intake);
    contradictory.branch = "existing_installation";
    await withUncheckedRequirement(invalidRequirement, contradictory, async () => {
      const context = await asActor(
        invalidRequirement,
        (tx, ctx) => read(tx, ctx, invalidRequirement.projectId),
      );
      expect(context).toMatchObject({
        calculation: { status: "blocked", blocker: "project_requirement" },
        capabilities: { canConfirm: false },
      });
    });

    const unknownShadingValue = payload();
    unknownShadingValue.calculation.inputs.answeredFieldIds =
      unknownShadingValue.calculation.inputs.answeredFieldIds.filter(
        (field) => field !== "verschattung",
      );
    const unknownShading = await submitLead(await createActor(), unknownShadingValue);
    await confirmPin(unknownShading);
    const unknownShadingCandidate = await candidate(unknownShading);
    expect(unknownShadingCandidate.profile.roofs[0].shading.status).toBe("unknown");
    const unknownShadingSaved = await save(unknownShading, unknownShadingCandidate);
    await expect(asActor(
      unknownShading,
      (tx, ctx) => read(tx, ctx, unknownShading.projectId),
    )).resolves.toMatchObject({ capabilities: { canConfirm: false } });
    const beforeUnknownShadingConfirm = await confirmationFootprint(unknownShading);
    await expect(confirm(unknownShading, unknownShadingSaved.revision))
      .rejects.toMatchObject({ code: "prerequisites_missing" });
    expect(await confirmationFootprint(unknownShading)).toEqual(beforeUnknownShadingConfirm);
    expect(beforeUnknownShadingConfirm.jobs).toBe(0);

    const unknownStorage = await submitLead(
      await createActor(),
      existingInstallationWithoutStorageTruth(),
    );
    await confirmPin(unknownStorage);
    const unknownStorageCandidate = await candidate(unknownStorage);
    expect(unknownStorageCandidate.profile.existingAssets).toMatchObject({
      pv: { status: "known_present" },
      storage: { status: "unknown" },
    });
    const unknownStorageSaved = await save(unknownStorage, unknownStorageCandidate);
    await expect(asActor(
      unknownStorage,
      (tx, ctx) => read(tx, ctx, unknownStorage.projectId),
    )).resolves.toMatchObject({ capabilities: { canConfirm: false } });
    const beforeUnknownStorageConfirm = await confirmationFootprint(unknownStorage);
    await expect(confirm(unknownStorage, unknownStorageSaved.revision))
      .rejects.toMatchObject({ code: "prerequisites_missing" });
    expect(await confirmationFootprint(unknownStorage)).toEqual(beforeUnknownStorageConfirm);
    expect(beforeUnknownStorageConfirm.jobs).toBe(0);
  });

  it("setzt canRetry nur wenn ein Retry ueber die oeffentliche Servicegrenze ausfuehrbar ist", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const saved = await save(fixture, projected);
    const confirmation = await confirm(fixture, saved.revision);
    await failJobPermanently(fixture, confirmation);

    const context = await asActor(
      fixture,
      (tx, ctx) => projectEnergyContextReader()(tx, ctx, fixture.projectId),
    );
    expect(context).toMatchObject({
      calculation: {
        status: "failed",
        jobId: confirmation.jobId,
        retryable: false,
      },
      capabilities: { canRetry: false },
    });
  });

  it("liefert am validierten Result nur minimierte Bindungs-, Annahmen- und Quellenmetadaten", async () => {
    const fixture = await submitLead(await createActor());
    await confirmPin(fixture);
    const projected = await candidate(fixture);
    const saved = await save(fixture, projected);
    const confirmation = await confirm(fixture, saved.revision);
    const request = await succeedJob(fixture, confirmation);

    const context = await asActor(
      fixture,
      (tx, ctx) => projectEnergyContextReader()(tx, ctx, fixture.projectId),
    );
    expect(context).toMatchObject({
      calculation: {
        status: "current",
        result: {
          binding: {
            addressRevision: 1,
            profile: { id: saved.profileId, revision: saved.revision },
            requirement: { id: fixture.requirementId, revision: 1 },
          },
          assumptions: request.resolvedAssumptions,
          sources: {
            providerRecipeVersion: PLANNING_PROVIDER_RECIPE_VERSION,
            contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
            canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
            schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
            defaultsVersion: PLANNING_DEFAULTS_VERSION,
            modelId: PLANNING_MODEL_ID,
            modelVersion: PLANNING_MODEL_VERSION,
            sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
          },
        },
      },
    });

    const serialized = JSON.stringify(context);
    for (const forbidden of [
      "inputSnapshot",
      "input_snapshot",
      "providerSnapshot",
      "provider_snapshot",
      "yieldSnapshots",
      "rawResponseSha256",
      "provider-response-must-not-leak",
      fixture.intake.customer.email,
      fixture.intake.customer.phoneRaw,
      "market_estimate",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("exportiert den minimierten Project-Read und leitet A nach einer Site-Aenderung durch B als stale ab", async () => {
    const readContext = (energyModule as unknown as Record<string, unknown>)[
      "getProjectEnergyContext"
    ];
    expect(typeof readContext).toBe("function");
    if (typeof readContext !== "function") return;

    const actor = await createActor();
    const projectA = await submitLead(actor);
    const projectB = await submitLead(actor);
    expect(projectB.siteId).toBe(projectA.siteId);
    await confirmPin(projectA);
    const projectedA = await candidate(projectA);
    const saved = await save(projectA, projectedA);
    const confirmationA = await confirm(projectA, saved.revision);
    await succeedJob(projectA, confirmationA);

    const read = readContext as (
      tx: TenantTx,
      ctx: ServiceCtx,
      projectId: string,
    ) => Promise<unknown>;
    const current = await asActor(projectA, (tx, ctx) => read(tx, ctx, projectA.projectId));
    expect(current).toMatchObject({
      projectId: projectA.projectId,
      siteId: projectA.siteId,
      calculation: { status: "current" },
    });
    const serialized = JSON.stringify(current);
    for (const forbidden of [
      "provider-input-must-not-leak",
      "provider-response-must-not-leak",
      projectA.intake.customer.email,
      projectA.intake.customer.phoneRaw,
      "market_estimate",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const projectedB = await candidate(projectB);
    await save(projectB, projectedB, {
      expectedLatestRevision: saved.revision,
      profile: changedConsumption(projectedB.profile),
    });
    const stale = await asActor(projectA, (tx, ctx) => read(tx, ctx, projectA.projectId));
    expect(stale).toMatchObject({
      projectId: projectA.projectId,
      siteId: projectA.siteId,
      calculation: { status: "stale" },
    });
  });
});
