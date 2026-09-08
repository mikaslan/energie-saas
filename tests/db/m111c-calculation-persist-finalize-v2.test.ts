import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  canonicalizeCalculationJson,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import {
  planningCalculationRequestV2Schema,
  type PlanningCalculationRequestV2,
  type PlanningCalculationResultV2,
} from "@/lib/integrations/calculation/contract-v2";
import { QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import { hashPlanningCalculationInputV2 } from "@/lib/integrations/calculation/prepare-v2";
import { runPlanningCalculationV2 } from "@/lib/integrations/calculation/run-v2";
import {
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationSuccessV2,
  persistProjectCalculationInputV2,
} from "@/modules/energy/calculation-service";
import { testPool } from "../setup/test-db";

// F4.1 v2-Persist/Finalize (Migration 0079 + calculation-service):
// Claim -> Persist (Serien-Bundle) -> Finalize (exaktes Server-Replay +
// finalize_project_calculation_success_v2) auf echten DB-Zeilen mit
// v2-Vertragstupel. v1-Elternzeilen (Profil/Requirements/Snapshot) dienen
// nur als FK-Anker; die v2-Bindung prueft IDs + Revisionen.

const NOW = new Date("2026-08-29T12:00:00.000Z");

// v1-Ankerprofil aus dem geprueften Beispielvertrag (erfuellt
// site_energy_profile_json_ck; v2 bindet nur ID/Revision).
const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

const NO_STORAGE = {
  capacityKwh: 0,
  socMinKwh: 0,
  socMaxKwh: 0,
  chargeKw: 0,
  dischargeKw: 0,
  etaCharge: 1,
  etaDischarge: 1,
};

function sha256Bytes(value: unknown): Buffer {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest();
}

function constantSeries(value: number): number[] {
  return new Array<number>(QUARTER_HOUR_SLOTS).fill(value);
}

type CalculationFixtureV2 = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
  jobId: string;
  request: PlanningCalculationRequestV2;
  pvKwh: number[];
  loadKwh: number[];
  result: PlanningCalculationResultV2;
  inputSha256: string;
};

function boundRequest(ids: {
  workspaceId: string;
  projectId: string;
  siteId: string;
  profileId: string;
  requirementId: string;
  snapshotId: string;
}): PlanningCalculationRequestV2 {
  const parsed = planningCalculationRequestV2Schema.safeParse({
    contractVersion: "planning-calculation.v2",
    canonicalizationVersion: "planning-jcs.v1",
    branch: "new_installation",
    asOfDate: "2026-08-29",
    commissioningDate: "2026-08-29",
    bindings: {
      workspaceId: ids.workspaceId,
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
    },
    site: { countryCode: "DE", latitude: 52.52, longitude: 13.41 },
    axis: { slots: 35_040, resolution: "quarter_hour" },
    storage: { ...NO_STORAGE },
  });
  if (!parsed.success) throw new Error("invalid v2 request fixture");
  return parsed.data;
}

async function createFixture(): Promise<CalculationFixtureV2> {
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
    jobId: randomUUID(),
  };
  const request = boundRequest(ids);
  const pvKwh = constantSeries(1);
  const loadKwh = constantSeries(0.5);
  const result = runPlanningCalculationV2({
    request,
    pvKwh,
    loadKwh,
    providerEstimate: false,
  });
  const inputSha256 = hashPlanningCalculationInputV2(request);
  if (result.inputSha256 !== inputSha256) {
    throw new Error("v2 fixture result/input sha mismatch");
  }

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
  // Profil-/Requirement-Inhalte sind v1-foermig (FK-Anker + CHECKs); v2
  // bindet nur IDs/Revisionen, keine Inhalte.
  const profile = GOLDEN_REQUEST.energyProfile;
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
  const preparationSnapshot = {
    schemaVersion: "project-calculation-preparation.v2",
    latitude: request.site.latitude,
    longitude: request.site.longitude,
  };

  await withTenantOn(testPool, ids.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${ids.workspaceId}::uuid, ${`M1-11c v2 ${ids.jobId}`})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${ids.actorId}::uuid, ${`${ids.actorId}@calculation-v2.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${ids.workspaceId}::uuid, ${ids.actorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${ids.workspaceId}::uuid, 'V2 Customer', 'Fixture', 'Contact',
        'v2.customer@example.test', 'v2.customer@example.test'
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
        'V2 Site', 'V2-Weg 1, 10115 Berlin',
        decode(repeat('73', 32), 'hex'), 1, 'selected', 'V2-Weg', '1',
        '10115', 'Berlin', 'DE', ${request.site.latitude},
        ${request.site.longitude}, 'photon', 'house', false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${ids.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake_column.id, 'V2 Calculation', 'fixture'
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
        decode(repeat('74', 32), 'hex'), 'v2-fixture-key', ${NOW}, ${NOW}, ${NOW},
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
        ${sha256Bytes(profile)}, 1, 1,
        ${ids.actorId}::uuid, ${NOW}
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
        preparation_snapshot, preparation_sha256, state, attempt_count,
        next_attempt_at, created_by
      ) values (
        ${ids.jobId}::uuid, ${ids.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        ${sha256Bytes({ reservation: ids.jobId })}, ${CALCULATION_V2_PROVIDER_RECIPE_VERSION},
        'planning-calculation.v2', ${CALCULATION_V2_MODEL_ID}, ${CALCULATION_V2_MODEL_VERSION},
        ${CALCULATION_V2_SOURCE_REVISION}, ${CALCULATION_V2_DEFAULTS_VERSION},
        ${JSON.stringify(preparationSnapshot)}::jsonb,
        ${sha256Bytes(preparationSnapshot)}, 'queued', 0, ${NOW},
        ${ids.actorId}::uuid
      )
    `);
  });

  return { ...ids, request, pvKwh, loadKwh, result, inputSha256 };
}

async function claim(fixture: CalculationFixtureV2): Promise<string> {
  const leaseToken = randomUUID();
  const claimed = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
    claimProjectCalculationJob(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      leaseToken,
    }));
  expect(claimed).toMatchObject({
    workspaceId: fixture.workspaceId,
    jobId: fixture.jobId,
    attemptCount: 1,
  });
  return leaseToken;
}

async function persist(
  fixture: CalculationFixtureV2,
  leaseToken: string,
  overrides: {
    pvKwh?: unknown;
    loadKwh?: unknown;
    providerEstimate?: boolean;
    attemptCount?: number;
  } = {},
) {
  return withTenantOn(testPool, fixture.workspaceId, (tx) =>
    persistProjectCalculationInputV2(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      leaseToken,
      attemptCount: overrides.attemptCount ?? 1,
      inputSnapshot: fixture.request,
      pvKwh: overrides.pvKwh ?? fixture.pvKwh,
      loadKwh: overrides.loadKwh ?? fixture.loadKwh,
      providerEstimate: overrides.providerEstimate ?? false,
    }));
}

async function finalize(
  fixture: CalculationFixtureV2,
  leaseToken: string,
  result: unknown = fixture.result,
  attemptCount = 1,
) {
  return withTenantOn(testPool, fixture.workspaceId, (tx) =>
    finalizeProjectCalculationSuccessV2(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      leaseToken,
      attemptCount,
      result,
    }));
}

type JobRow = {
  state: string;
  input_sha256: string | null;
  quality: string | null;
  [key: string]: unknown;
};

async function footprint(fixture: CalculationFixtureV2) {
  return withTenantOn(testPool, fixture.workspaceId, async (tx: TenantTx) => {
    const job = await tx.execute<JobRow>(sql`
      select state, encode(input_sha256, 'hex') as input_sha256,
             result_revision_id
      from project_calculation_job
      where workspace_id = ${fixture.workspaceId}::uuid
        and id = ${fixture.jobId}::uuid
    `);
    const revisions = await tx.execute<{
      id: string;
      revision: number;
      quality: string;
      validation_status: string;
      contract_version: string;
      [key: string]: unknown;
    }>(sql`
      select id, revision, quality, validation_status, contract_version,
             encode(input_sha256, 'hex') as input_sha256,
             encode(result_sha256, 'hex') as result_sha256
      from project_calculation_revision
      where workspace_id = ${fixture.workspaceId}::uuid
        and job_id = ${fixture.jobId}::uuid
      order by revision
    `);
    const events = await tx.execute<{ event_type: string; [key: string]: unknown }>(sql`
      select event_type
      from domain_events
      where workspace_id = ${fixture.workspaceId}::uuid
        and event_type = 'project.calculation_succeeded'
    `);
    const audits = await tx.execute<{ action: string; resource: string; [key: string]: unknown }>(sql`
      select action, resource
      from audit_log
      where workspace_id = ${fixture.workspaceId}::uuid
        and action = 'project.write'
        and resource = 'calculation_result'
    `);
    return {
      job: job.rows[0],
      revisions: [...revisions.rows],
      events: [...events.rows],
      audits: [...audits.rows],
    };
  });
}

describe("F4.1 v2 persist/finalize service", () => {
  it("persistiert Serien und finalisiert exakt mit v2-Tupel", async () => {
    const fixture = await createFixture();
    const leaseToken = await claim(fixture);

    const persisted = await persist(fixture, leaseToken);
    expect(persisted.replayed).toBe(false);
    expect(persisted.inputSha256).toBe(fixture.inputSha256);
    expect(persisted.providerSeries.schemaVersion).toBe("calculation-input-series.v2");
    expect(persisted.providerSeries.pvKwh).toHaveLength(QUARTER_HOUR_SLOTS);

    const finalized = await finalize(fixture, leaseToken);
    expect(finalized).toMatchObject({ revision: 1, replayed: false });
    expect(finalized.revisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const seen = await footprint(fixture);
    expect(seen.job?.state).toBe("succeeded");
    expect(seen.job?.input_sha256).toBe(fixture.inputSha256);
    expect(seen.revisions).toHaveLength(1);
    expect(seen.revisions[0]).toMatchObject({
      revision: 1,
      quality: "server_reproduced_public_reference",
      validation_status: "f4_public_reference_validated",
      contract_version: "planning-calculation.v2",
      input_sha256: fixture.inputSha256,
    });
    expect(seen.revisions[0]?.result_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.events).toHaveLength(1);
    expect(seen.audits).toHaveLength(1);
  });

  it("replayt Persist und Finalize idempotent", async () => {
    const fixture = await createFixture();
    const leaseToken = await claim(fixture);

    await persist(fixture, leaseToken);
    const replayed = await persist(fixture, leaseToken);
    expect(replayed.replayed).toBe(true);
    expect(replayed.inputSha256).toBe(fixture.inputSha256);

    const first = await finalize(fixture, leaseToken);
    const second = await finalize(fixture, leaseToken);
    expect(second).toMatchObject({
      revisionId: first.revisionId,
      revision: 1,
      replayed: true,
    });
    const seen = await footprint(fixture);
    expect(seen.revisions).toHaveLength(1);
  });

  it("lehnt ein manipuliertes Result fail-closed ab", async () => {
    const fixture = await createFixture();
    const leaseToken = await claim(fixture);
    await persist(fixture, leaseToken);

    const tampered = structuredClone(fixture.result);
    tampered.annual.generationKwh += 1;
    await expect(finalize(fixture, leaseToken, tampered)).rejects.toMatchObject({
      code: "invalid_input",
    });
    const seen = await footprint(fixture);
    expect(seen.revisions).toHaveLength(0);
  });

  it("lehnt kurze Serien und fremde Leases ab", async () => {
    const fixture = await createFixture();
    const leaseToken = await claim(fixture);

    await expect(
      persist(fixture, leaseToken, { pvKwh: fixture.pvKwh.slice(0, 8_759) }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      persist(fixture, randomUUID()),
    ).rejects.toMatchObject({ code: "stale" });
  });

  it("lehnt v1-Finalize fuer v2-Jobs ab (Kettentrennung)", async () => {
    const { finalizeProjectCalculationSuccess } = await import(
      "@/modules/energy/calculation-service"
    );
    const fixture = await createFixture();
    const leaseToken = await claim(fixture);
    await persist(fixture, leaseToken);
    // v1-Request-Shape passt nicht auf v2-Job: invalid_input, keine Zeile.
    const v1ish = {
      contractVersion: "planning-calculation.v1",
    };
    await expect(
      withTenantOn(testPool, fixture.workspaceId, (tx) =>
        finalizeProjectCalculationSuccess(tx, {
          workspaceId: fixture.workspaceId,
          jobId: fixture.jobId,
          leaseToken,
          attemptCount: 1,
          result: v1ish,
        })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
