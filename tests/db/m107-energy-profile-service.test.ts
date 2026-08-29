import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  projectRechnerSnapshotToEnergyProfile,
} from "@/lib/integrations/calculation/rechner-profile";
import {
  PLANNING_CALCULATION_CONTRACT_VERSION,
  type SiteEnergyProfileV1,
} from "@/lib/integrations/calculation/contract";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
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
import {
  CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1,
  confirmProjectEnergyProfile,
  EnergyProfileRateLimitError,
  getProjectEnergyProfileCandidate,
  saveProjectEnergyProfile,
} from "@/modules/energy/service";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const GOLDEN = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
  "utf8",
)) as RechnerIntakeV1;

type Members = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  viewerId: string;
  externalId: string;
  outsiderId: string;
};

type LeadGraph = {
  projectId: string;
  siteId: string;
  snapshotId: string;
  requirementId: string;
};

type LeadFixture = Members & LeadGraph;

type EnergyProfileCandidate = {
  projectId: string;
  siteId: string;
  sourceSnapshotId: string;
  addressRevision: number;
  expectedLatestRevision: number;
  profile: SiteEnergyProfileV1;
};

type SaveEnergyProfileInput = {
  projectId: string;
  expectedAddressRevision: number;
  expectedLatestRevision: number;
  profile: unknown;
  roofAcknowledgements: string[];
};

type SavedEnergyProfile = {
  profileId: string;
  revision: number;
  addressRevision: number;
};

type ConfirmedEnergyProfile = {
  profileId: string;
  profileRevision: number;
  addressRevision: number;
  jobId: string;
  reservationKey: string;
  replayed: boolean;
};

type ProfileRow = {
  id: string;
  revision: number;
  address_revision: number;
  source_kind: string;
  source_snapshot_id: string | null;
  source_project_id: string | null;
  profile: SiteEnergyProfileV1;
  profile_sha256_hex: string;
  confirmed_profile_revision: number | null;
  confirmed_address_revision: number | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  [key: string]: unknown;
};

type EnergyFootprint = {
  profiles: number;
  jobs: number;
  savedEvents: number;
  confirmedEvents: number;
  successAuditIds: string[];
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

function expectedProfile(value: RechnerIntakeV1): SiteEnergyProfileV1 {
  const projected = projectRechnerSnapshotToEnergyProfile(value.calculation);
  if (!projected.ok) {
    throw new Error(`Golden-Rechnerprofil ist nicht projizierbar: ${projected.code}`);
  }
  return structuredClone(projected.value);
}

function verifiedIdentity(workspaceId: string): VerifiedRechnerIdentity {
  const keyId = `energy-profile-${randomUUID()}`;
  const secret = Buffer.alloc(32, 29);
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

async function createMembers(name = "M1-07 Energieprofil"): Promise<Members> {
  const members: Members = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    adminId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    outsiderId: randomUUID(),
  };

  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, ${name})
    `);
    for (const userId of [
      members.editorId,
      members.adminId,
      members.viewerId,
      members.externalId,
      members.outsiderId,
    ]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@energy-profile.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.editorId}::uuid, 'editor', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.adminId}::uuid, 'admin', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.externalId}::uuid, 'editor',
          '{"external_only":true}'::jsonb)
    `);
  });

  return members;
}

async function createWorkspaceForExistingEditor(
  editorId: string,
  name: string,
): Promise<Members> {
  const members: Members = {
    workspaceId: randomUUID(),
    editorId,
    adminId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    outsiderId: randomUUID(),
  };

  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, ${name})
    `);
    for (const userId of [
      members.adminId,
      members.viewerId,
      members.externalId,
      members.outsiderId,
    ]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@energy-profile.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.editorId}::uuid, 'editor', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.adminId}::uuid, 'admin', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.externalId}::uuid, 'editor',
          '{"external_only":true}'::jsonb)
    `);
  });

  return members;
}

async function submitLead(
  members: Members,
  value = payload(),
): Promise<LeadFixture> {
  const receipt = await withTenantOn(testPool, members.workspaceId, (tx) =>
    processRechnerIntake(
      tx,
      verifiedIdentity(members.workspaceId),
      value,
      intakeMeta(value),
    ));
  const graph = await withTenantOn(testPool, members.workspaceId, (tx) => tx.execute<{
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
  const row = graph.rows[0];
  return {
    ...members,
    projectId: row.project_id,
    siteId: row.site_id,
    snapshotId: row.snapshot_id,
    requirementId: row.requirement_id,
  };
}

async function createLead(value = payload()): Promise<LeadFixture> {
  return submitLead(await createMembers(), value);
}

async function asActor<T>(
  fixture: Members,
  actorId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    fn,
  );
}

async function confirmPin(
  fixture: LeadFixture,
  actorId = fixture.editorId,
  expectedAddressRevision = 1,
): Promise<void> {
  await asActor(fixture, actorId, (tx, ctx) => confirmProjectSitePin(tx, ctx, {
    projectId: fixture.projectId,
    expectedAddressRevision,
  }));
}

async function getCandidate(
  fixture: LeadFixture,
  actorId = fixture.editorId,
): Promise<EnergyProfileCandidate | null> {
  return asActor(fixture, actorId, async (tx, ctx) => {
    const result = await getProjectEnergyProfileCandidate(tx, ctx, fixture.projectId);
    return result as EnergyProfileCandidate | null;
  });
}

async function requireCandidate(
  fixture: LeadFixture,
  actorId = fixture.editorId,
): Promise<EnergyProfileCandidate> {
  const candidate = await getCandidate(fixture, actorId);
  expect(candidate).not.toBeNull();
  if (candidate === null) throw new Error("Energieprofil-Kandidat fehlt.");
  return candidate;
}

function saveInput(
  fixture: LeadFixture,
  candidate: EnergyProfileCandidate,
  overrides: Partial<SaveEnergyProfileInput> = {},
): SaveEnergyProfileInput {
  return {
    projectId: fixture.projectId,
    expectedAddressRevision: candidate.addressRevision,
    expectedLatestRevision: candidate.expectedLatestRevision,
    profile: structuredClone(candidate.profile),
    roofAcknowledgements: candidate.profile.roofs.map((roof) => roof.id),
    ...overrides,
  };
}

async function saveProfile(
  fixture: LeadFixture,
  actorId: string,
  input: SaveEnergyProfileInput,
): Promise<SavedEnergyProfile> {
  return asActor(fixture, actorId, async (tx, ctx) => {
    const result = await saveProjectEnergyProfile(tx, ctx, input);
    return result as SavedEnergyProfile;
  });
}

async function confirmProfile(
  fixture: LeadFixture,
  actorId: string,
  profileRevision: number,
  addressRevision = 1,
): Promise<ConfirmedEnergyProfile> {
  return asActor(fixture, actorId, async (tx, ctx) => {
    const result = await confirmProjectEnergyProfile(tx, ctx, {
      projectId: fixture.projectId,
      expectedAddressRevision: addressRevision,
      expectedProfileRevision: profileRevision,
    });
    return result as ConfirmedEnergyProfile;
  });
}

async function readProfile(fixture: LeadFixture): Promise<ProfileRow | null> {
  return asActor(fixture, fixture.editorId, async (tx) => {
    const result = await tx.execute<ProfileRow>(sql`
      select id, revision, address_revision, source_kind,
             source_snapshot_id, source_project_id, profile,
             encode(profile_sha256, 'hex') as profile_sha256_hex,
             confirmed_profile_revision, confirmed_address_revision,
             confirmed_by, confirmed_at
      from site_energy_profile
      where site_id = ${fixture.siteId}::uuid
    `);
    return result.rows[0] ?? null;
  });
}

async function footprint(fixture: LeadFixture): Promise<EnergyFootprint> {
  return asActor(fixture, fixture.editorId, async (tx) => {
    const counts = await tx.execute<{
      profiles: number;
      jobs: number;
      saved_events: number;
      confirmed_events: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from site_energy_profile profile
          where profile.site_id = ${fixture.siteId}::uuid) as profiles,
        (select count(*)::int from project_calculation_job job
          where job.project_id = ${fixture.projectId}::uuid) as jobs,
        (select count(*)::int from domain_events event
          where event.aggregate_id = ${fixture.siteId}::uuid
            and event.event_type = 'site.energy_profile_saved') as saved_events,
        (select count(*)::int from domain_events event
          where event.aggregate_id = ${fixture.siteId}::uuid
            and event.event_type = 'site.energy_profile_confirmed') as confirmed_events
    `);
    const audits = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id
      from audit_log
      where allowed = true
      order by id
    `);
    const row = counts.rows[0];
    return {
      profiles: row.profiles,
      jobs: row.jobs,
      savedEvents: row.saved_events,
      confirmedEvents: row.confirmed_events,
      successAuditIds: audits.rows.map((audit) => audit.id),
    };
  });
}

function changedConsumption(
  profile: SiteEnergyProfileV1,
  value: number,
): SiteEnergyProfileV1 {
  const changed = structuredClone(profile);
  changed.consumption.householdKwhPerYear = {
    status: "known",
    value,
    source: "operator_reviewed",
  };
  return changed;
}

function payloadForDistinctSite(index: number): RechnerIntakeV1 {
  const value = payload();
  const houseNumber = String(100 + index);
  value.site.houseNumber = houseNumber;
  value.site.formattedAddress = `Mühlstraße ${houseNumber}, 69234 Dielheim`;
  value.site.latitude += index / 10_000;
  value.site.longitude += index / 10_000;
  return value;
}

async function prepareReservationLead(
  members: Members,
  index: number,
): Promise<{ fixture: LeadFixture; saved: SavedEnergyProfile }> {
  const fixture = await submitLead(members, payloadForDistinctSite(index));
  await confirmPin(fixture);
  const candidate = await requireCandidate(fixture);
  const saved = await saveProfile(
    fixture,
    fixture.editorId,
    saveInput(fixture, candidate),
  );
  return { fixture, saved };
}

async function seedTerminalReservations(
  fixture: LeadFixture,
  profileId: string,
  actorId: string,
  count: number,
  ageSeconds = 900,
): Promise<void> {
  const reservationSeed = randomUUID();
  await asActor(fixture, fixture.editorId, (tx) => tx.execute(sql`
    insert into project_calculation_job (
      id, workspace_id, project_id, site_id,
      address_revision, pin_confirmed_address_revision,
      profile_id, profile_revision, confirmed_profile_revision,
      confirmed_address_revision, requirement_id, requirement_revision,
      source_snapshot_id, reservation_key, provider_recipe_version,
      contract_version, model_id, model_version, source_revision,
      defaults_version, state, attempt_count, next_attempt_at,
      error_code, error_retryable, created_by, created_at, started_at,
      finished_at
    )
    select pg_catalog.gen_random_uuid(), ${fixture.workspaceId}::uuid,
           ${fixture.projectId}::uuid, ${fixture.siteId}::uuid,
           1, 1, ${profileId}::uuid, 1, 1, 1,
           ${fixture.requirementId}::uuid, 1, ${fixture.snapshotId}::uuid,
           pg_catalog.decode(
             pg_catalog.md5(${reservationSeed} || ':' || series.value::text)
               || pg_catalog.md5(series.value::text || ':' || ${reservationSeed}),
             'hex'
           ),
           ${PLANNING_PROVIDER_RECIPE_VERSION},
           ${PLANNING_CALCULATION_CONTRACT_VERSION},
           ${PLANNING_MODEL_ID}, ${PLANNING_MODEL_VERSION},
           ${PLANNING_MODEL_SOURCE_REVISION}, ${PLANNING_DEFAULTS_VERSION},
           'failed_final', 1,
           pg_catalog.clock_timestamp()
             - pg_catalog.make_interval(secs => ${ageSeconds}),
           'rate_limit_fixture', false, ${actorId}::uuid,
           pg_catalog.clock_timestamp()
             - pg_catalog.make_interval(secs => ${ageSeconds}),
           pg_catalog.clock_timestamp()
             - pg_catalog.make_interval(secs => ${ageSeconds}),
           pg_catalog.clock_timestamp()
             - pg_catalog.make_interval(secs => ${ageSeconds})
      from pg_catalog.generate_series(1, ${count}) as series(value)
  `));
}

type ReservationFootprint = {
  jobs: number;
  reservedEvents: number;
  confirmedEvents: number;
  confirmedProfiles: number;
  successAudits: number;
};

async function workspaceReservationFootprint(
  fixture: LeadFixture,
): Promise<ReservationFootprint> {
  return asActor(fixture, fixture.editorId, async (tx) => {
    const result = await tx.execute<{
      jobs: number;
      reserved_events: number;
      confirmed_events: number;
      confirmed_profiles: number;
      success_audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from project_calculation_job) as jobs,
        (select count(*)::int from domain_events
          where event_type = 'project.calculation_reserved') as reserved_events,
        (select count(*)::int from domain_events
          where event_type = 'site.energy_profile_confirmed') as confirmed_events,
        (select count(*)::int from site_energy_profile
          where confirmed_profile_revision is not null) as confirmed_profiles,
        (select count(*)::int from audit_log
          where allowed = true) as success_audits
    `);
    const row = result.rows[0];
    return {
      jobs: row.jobs,
      reservedEvents: row.reserved_events,
      confirmedEvents: row.confirmed_events,
      confirmedProfiles: row.confirmed_profiles,
      successAudits: row.success_audits,
    };
  });
}

async function expectRateLimited(
  operation: Promise<unknown>,
): Promise<EnergyProfileRateLimitError> {
  const [outcome] = await Promise.allSettled([operation]);
  expect(outcome.status).toBe("rejected");
  if (outcome.status !== "rejected") {
    throw new Error("Eine neue Calculation-Reservation wurde trotz Limit angelegt.");
  }
  expect(outcome.reason).toBeInstanceOf(EnergyProfileRateLimitError);
  expect(outcome.reason).toMatchObject({
    code: "rate_limited",
    retryAfterSeconds: expect.any(Number),
  });
  const error = outcome.reason as EnergyProfileRateLimitError;
  expect(Number.isSafeInteger(error.retryAfterSeconds)).toBe(true);
  expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  return error;
}

async function expectServiceError(
  operation: Promise<unknown>,
  code: "prerequisites_missing" | "invalid_profile" | "stale",
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

function expectIdRevisionPayload(value: unknown): void {
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  expect(typeof value).toBe("object");
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;

  const allowed = new Set([
    "workspaceId",
    "projectId",
    "siteId",
    "profileId",
    "profileRevision",
    "revision",
    "addressRevision",
    "jobId",
    "state",
    "status",
  ]);
  expect(Object.keys(value).every((key) => allowed.has(key))).toBe(true);
  expect(Object.values(value).every(
    (entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry),
  )).toBe(true);
}

describe.sequential("M1-07 Energieprofil-Servicevertrag", () => {
  it("liefert Editor und Admin nur den validierten, minimierten Rechner-Kandidaten", async () => {
    const value = payload();
    const fixture = await createLead(value);
    await confirmPin(fixture);

    const editor = await requireCandidate(fixture, fixture.editorId);
    const admin = await requireCandidate(fixture, fixture.adminId);
    const projected = expectedProfile(value);

    expect(editor).toEqual({
      projectId: fixture.projectId,
      siteId: fixture.siteId,
      sourceSnapshotId: fixture.snapshotId,
      addressRevision: 1,
      expectedLatestRevision: 0,
      profile: projected,
    });
    expect(admin).toEqual(editor);

    const serialized = JSON.stringify(editor);
    for (const forbidden of [
      "market_estimate",
      "investmentCents",
      "amortizationYears",
      "requestedProducts",
      GOLDEN.customer.displayName,
      GOLDEN.customer.email,
      GOLDEN.customer.phoneRaw,
      GOLDEN.site.formattedAddress,
      String(GOLDEN.site.latitude),
      String(GOLDEN.site.longitude),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("laesst einen echten Admin speichern, bestaetigen und als Bearbeiter binden", async () => {
    const fixture = await createLead();
    await confirmPin(fixture, fixture.adminId);
    const candidate = await requireCandidate(fixture, fixture.adminId);

    const saved = await saveProfile(
      fixture,
      fixture.adminId,
      saveInput(fixture, candidate),
    );
    const confirmed = await confirmProfile(
      fixture,
      fixture.adminId,
      saved.revision,
      saved.addressRevision,
    );

    expect(saved).toMatchObject({ revision: 1, addressRevision: 1 });
    expect(confirmed).toMatchObject({
      profileId: saved.profileId,
      profileRevision: 1,
      addressRevision: 1,
    });
    const actors = await asActor(fixture, fixture.adminId, (tx) => tx.execute<{
      confirmed_by: string;
      created_by: string;
      [key: string]: unknown;
    }>(sql`
      select profile.confirmed_by, job.created_by
      from site_energy_profile profile
      join project_calculation_job job
        on job.workspace_id = profile.workspace_id
       and job.profile_id = profile.id
      where profile.id = ${saved.profileId}::uuid
        and job.id = ${confirmed.jobId}::uuid
    `));
    expect(actors.rows[0]).toEqual({
      confirmed_by: fixture.adminId,
      created_by: fixture.adminId,
    });
  });

  it("verweigert Viewer und external_only alle drei Servicegrenzen ohne Seiteneffekt", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const input = saveInput(fixture, candidate);
    const baseline = await footprint(fixture);

    for (const actorId of [fixture.viewerId, fixture.externalId]) {
      await expect(getCandidate(fixture, actorId)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(saveProfile(fixture, actorId, input)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(confirmProfile(fixture, actorId, 1)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    }
    await expect(getCandidate(fixture, fixture.externalId)).rejects.toMatchObject({
      reason: "external_only_without_assignment",
    });
    expect(await footprint(fixture)).toEqual(baseline);
  });

  it("bindet die Membership an den Tenant und behandelt fremde Objekte wie nicht vorhanden", async () => {
    const owner = await createLead();
    await confirmPin(owner);
    const candidate = await requireCandidate(owner);
    const foreign = await createMembers("Fremder M1-07 Workspace");

    const foreignCandidate = await asActor(foreign, foreign.editorId, async (tx, ctx) => {
      const result = await getProjectEnergyProfileCandidate(tx, ctx, owner.projectId);
      return result as EnergyProfileCandidate | null;
    });
    expect(foreignCandidate).toBeNull();
    await expectServiceError(
      asActor(foreign, foreign.editorId, (tx, ctx) => saveProjectEnergyProfile(tx, ctx, {
        ...saveInput(owner, candidate),
        projectId: owner.projectId,
      })),
      "prerequisites_missing",
    );
    await expectServiceError(
      asActor(foreign, foreign.editorId, (tx, ctx) => confirmProjectEnergyProfile(tx, ctx, {
        projectId: owner.projectId,
        expectedAddressRevision: 1,
        expectedProfileRevision: 1,
      })),
      "prerequisites_missing",
    );
    await expect(asActor(owner, owner.outsiderId, async () => null)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect((await footprint(owner)).profiles).toBe(0);
  });

  it("verlangt die aktuelle Hausadresse und deren bestaetigten Pin fuer Save und Confirm", async () => {
    const fixture = await createLead();
    const candidate = await requireCandidate(fixture);

    await expectServiceError(
      saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate)),
      "prerequisites_missing",
    );
    expect((await footprint(fixture)).profiles).toBe(0);

    await confirmPin(fixture);
    const saved = await saveProfile(
      fixture,
      fixture.editorId,
      saveInput(fixture, candidate),
    );
    const beforeAddressChange = await footprint(fixture);

    await asActor(fixture, fixture.editorId, (tx) => tx.execute(sql`
      update site
      set address_revision = address_revision + 1,
          pin_confirmed = false,
          pin_confirmed_address_revision = null,
          updated_at = now()
      where id = ${fixture.siteId}::uuid
    `));

    await expectServiceError(
      confirmProfile(fixture, fixture.editorId, saved.revision, 1),
      "stale",
    );
    await expectServiceError(
      saveProfile(fixture, fixture.editorId, {
        ...saveInput(fixture, candidate),
        expectedLatestRevision: saved.revision,
      }),
      "stale",
    );
    const staleState = await footprint(fixture);
    expect(staleState.jobs).toBe(0);
    expect(staleState.confirmedEvents).toBe(0);
    expect(staleState.successAuditIds).toEqual(beforeAddressChange.successAuditIds);

    await confirmPin(fixture, fixture.editorId, 2);
    const current = await saveProfile(fixture, fixture.editorId, {
      ...saveInput(fixture, candidate),
      expectedAddressRevision: 2,
      expectedLatestRevision: 1,
    });
    expect(current).toMatchObject({ revision: 2, addressRevision: 2 });
  });

  it("weist unbekannte Felder, leere Daecher und nicht-endliche Zahlen strikt zurueck", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const baseline = await footprint(fixture);

    const invalidProfiles: unknown[] = [
      { ...candidate.profile, browserTrust: true },
      { ...candidate.profile, roofs: [] },
      {
        ...candidate.profile,
        consumption: {
          ...candidate.profile.consumption,
          householdKwhPerYear: {
            status: "known",
            value: Number.POSITIVE_INFINITY,
            source: "operator_reviewed",
          },
        },
      },
    ];
    for (const profile of invalidProfiles) {
      await expectServiceError(
        saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate, { profile })),
        "invalid_profile",
      );
      expect(await footprint(fixture)).toEqual(baseline);
    }
  });

  it("ignoriert gefaelschte Browser-Quellen und leitet Provenienz serverseitig ab", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const forged = structuredClone(candidate.profile);
    const household = forged.consumption.householdKwhPerYear;
    if (household.status !== "known") throw new Error("Golden-Verbrauch muss bekannt sein.");
    household.source = "operator_reviewed";
    forged.roofs[0].source = "operator_reviewed";

    await saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate, {
      profile: forged,
      roofAcknowledgements: [],
    }));
    const stored = await readProfile(fixture);
    expect(stored?.profile.consumption.householdKwhPerYear).toEqual(
      candidate.profile.consumption.householdKwhPerYear,
    );
    expect(stored?.profile.roofs[0].source).toBe(candidate.profile.roofs[0].source);
    expect(JSON.stringify(stored?.profile)).not.toContain("browserTrust");
  });

  it("speichert zuerst Revision 1, erhoeht danach exakt N+1 und leert die Confirmation", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const first = await saveProfile(
      fixture,
      fixture.editorId,
      saveInput(fixture, candidate),
    );

    expect(first).toMatchObject({ revision: 1, addressRevision: 1 });
    expect(await readProfile(fixture)).toMatchObject({
      id: first.profileId,
      revision: 1,
      address_revision: 1,
      source_kind: "rechner_snapshot",
      source_snapshot_id: fixture.snapshotId,
      source_project_id: fixture.projectId,
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
      confirmed_by: null,
      confirmed_at: null,
    });
    expect((await readProfile(fixture))?.profile_sha256_hex).toMatch(/^[0-9a-f]{64}$/);

    await confirmProfile(fixture, fixture.editorId, 1);
    const second = await saveProfile(fixture, fixture.editorId, {
      ...saveInput(fixture, candidate),
      expectedLatestRevision: 1,
      profile: changedConsumption(candidate.profile, 4_321),
    });
    expect(second).toMatchObject({
      profileId: first.profileId,
      revision: 2,
      addressRevision: 1,
    });
    const stored = await readProfile(fixture);
    expect(stored).toMatchObject({
      id: first.profileId,
      revision: 2,
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
      confirmed_by: null,
      confirmed_at: null,
    });
    expect(stored?.profile.consumption.householdKwhPerYear).toEqual({
      status: "known",
      value: 4_321,
      source: "operator_reviewed",
    });
    const state = await footprint(fixture);
    expect(state.savedEvents).toBe(2);
    expect(state.confirmedEvents).toBe(1);
  });

  it("serialisiert zwei Saves derselben erwarteten Revision auf einen Gewinner", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const baseline = await footprint(fixture);
    const attempt = (value: number) => saveProfile(fixture, fixture.editorId, {
      ...saveInput(fixture, candidate),
      profile: changedConsumption(candidate.profile, value),
    });

    const outcomes = await Promise.allSettled([attempt(4_401), attempt(4_402)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "stale" });

    const state = await footprint(fixture);
    expect(state).toMatchObject({
      profiles: 1,
      jobs: 0,
      savedEvents: 1,
      confirmedEvents: 0,
    });
    expect(state.successAuditIds).toHaveLength(baseline.successAuditIds.length + 1);
    expect((await readProfile(fixture))?.revision).toBe(1);
  });

  it("trennt Confirm von Save und reserviert bei Parallelaufruf exakt einen Job", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const saved = await saveProfile(
      fixture,
      fixture.editorId,
      saveInput(fixture, candidate),
    );
    const afterSave = await footprint(fixture);
    expect(await readProfile(fixture)).toMatchObject({
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
    });
    expect(afterSave.jobs).toBe(0);
    expect(afterSave.confirmedEvents).toBe(0);

    const [left, right] = await Promise.all([
      confirmProfile(fixture, fixture.editorId, 1),
      confirmProfile(fixture, fixture.editorId, 1),
    ]);
    const replay = await confirmProfile(fixture, fixture.editorId, 1);
    expect(left).toMatchObject({
      profileId: saved.profileId,
      profileRevision: 1,
      addressRevision: 1,
    });
    expect(right.jobId).toBe(left.jobId);
    expect(replay.jobId).toBe(left.jobId);

    const state = await footprint(fixture);
    expect(state.jobs).toBe(1);
    expect(state.confirmedEvents).toBe(1);
    expect(state.successAuditIds).toHaveLength(afterSave.successAuditIds.length + 1);
    expect(await readProfile(fixture)).toMatchObject({
      confirmed_profile_revision: 1,
      confirmed_address_revision: 1,
      confirmed_by: fixture.editorId,
    });

    const jobs = await asActor(fixture, fixture.editorId, (tx) => tx.execute<{
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
      source_snapshot_id: string | null;
      reservation_bytes: number;
      state: string;
      attempt_count: number;
      input_sha256: Buffer | null;
      input_snapshot: unknown;
      provider_snapshot: unknown;
      created_by: string;
      [key: string]: unknown;
    }>(sql`
      select id, project_id, site_id, address_revision,
             pin_confirmed_address_revision, profile_id, profile_revision,
             confirmed_profile_revision, confirmed_address_revision,
             requirement_id, requirement_revision, source_snapshot_id,
             octet_length(reservation_key) as reservation_bytes,
             state, attempt_count, input_sha256, input_snapshot,
             provider_snapshot, created_by
      from project_calculation_job
      where project_id = ${fixture.projectId}::uuid
    `));
    expect(jobs.rows).toEqual([{
      id: left.jobId,
      project_id: fixture.projectId,
      site_id: fixture.siteId,
      address_revision: 1,
      pin_confirmed_address_revision: 1,
      profile_id: saved.profileId,
      profile_revision: 1,
      confirmed_profile_revision: 1,
      confirmed_address_revision: 1,
      requirement_id: fixture.requirementId,
      requirement_revision: 1,
      source_snapshot_id: fixture.snapshotId,
      reservation_bytes: 32,
      state: "queued",
      attempt_count: 0,
      input_sha256: null,
      input_snapshot: null,
      provider_snapshot: null,
      created_by: fixture.editorId,
    }]);
  });

  it("reserviert bei unbekannter Dachverschattung keinen Calculation-Job", async () => {
    const value = payload();
    value.calculation.inputs.answeredFieldIds =
      value.calculation.inputs.answeredFieldIds.filter((field) => field !== "verschattung");
    const fixture = await createLead(value);
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    expect(candidate.profile.roofs[0].shading.status).toBe("unknown");
    await saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate));
    const beforeConfirm = await footprint(fixture);

    await expectServiceError(
      confirmProfile(fixture, fixture.editorId, 1),
      "prerequisites_missing",
    );

    expect(await footprint(fixture)).toEqual(beforeConfirm);
    expect(beforeConfirm).toMatchObject({ jobs: 0, confirmedEvents: 0 });
    expect(await readProfile(fixture)).toMatchObject({
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
    });
  });

  it("blockiert Default-Daecher bis zu einer klaren manuellen Ersatzgeometrie", async () => {
    const value = payload();
    value.calculation.provenance.roof = "default";
    const fixture = await createLead(value);
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    expect(candidate.profile.roofs[0].source).toBe("default");

    await saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate, {
      roofAcknowledgements: [],
    }));
    const afterDraft = await footprint(fixture);
    await expectServiceError(
      confirmProfile(fixture, fixture.editorId, 1),
      "prerequisites_missing",
    );
    expect(await footprint(fixture)).toEqual(afterDraft);
    expect(await readProfile(fixture)).toMatchObject({
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
    });

    await expectServiceError(
      saveProfile(fixture, fixture.editorId, {
        ...saveInput(fixture, candidate),
        expectedLatestRevision: 1,
        roofAcknowledgements: [candidate.profile.roofs[0].id],
      }),
      "prerequisites_missing",
    );
    expect(await footprint(fixture)).toEqual(afterDraft);

    const replacement = structuredClone(candidate.profile);
    replacement.roofs[0].id = `${replacement.roofs[0].id}-manual`;
    await saveProfile(fixture, fixture.editorId, {
      ...saveInput(fixture, candidate),
      expectedLatestRevision: 1,
      profile: replacement,
      roofAcknowledgements: [replacement.roofs[0].id],
    });
    expect((await readProfile(fixture))?.profile.roofs[0].source).toBe(
      "operator_reviewed",
    );
    await expect(confirmProfile(fixture, fixture.editorId, 2)).resolves.toMatchObject({
      profileRevision: 2,
    });
  });

  it("weist ein stale Confirm ohne Job, Event oder Erfolgs-Audit zurueck", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    await saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate));
    await saveProfile(fixture, fixture.editorId, {
      ...saveInput(fixture, candidate),
      expectedLatestRevision: 1,
      profile: changedConsumption(candidate.profile, 4_500),
    });
    const baseline = await footprint(fixture);

    await expectServiceError(
      confirmProfile(fixture, fixture.editorId, 1),
      "stale",
    );
    expect(await footprint(fixture)).toEqual(baseline);
    expect(await readProfile(fixture)).toMatchObject({
      revision: 2,
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
    });
  });

  it("schreibt nur ID-/Revisionsdaten in Profil-Events und Erfolgs-Audits", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const before = await asActor(fixture, fixture.editorId, (tx) => tx.execute<{
      id: string;
      [key: string]: unknown;
    }>(sql`select id from audit_log where actor = ${fixture.editorId}`));
    const beforeIds = new Set(before.rows.map((row) => row.id));
    const edited = changedConsumption(candidate.profile, 54_321);
    const saved = await saveProfile(fixture, fixture.editorId, saveInput(fixture, candidate, {
      profile: edited,
    }));
    const confirmed = await confirmProfile(fixture, fixture.editorId, saved.revision);

    const records = await asActor(fixture, fixture.editorId, async (tx) => {
      const events = await tx.execute<{
        kind: string;
        payload: unknown;
        [key: string]: unknown;
      }>(sql`
        select event_type as kind, payload
        from domain_events
        where aggregate_id = ${fixture.siteId}::uuid
          and event_type in (
            'site.energy_profile_saved',
            'site.energy_profile_confirmed'
          )
        order by event_type
      `);
      const audits = await tx.execute<{
        id: string;
        kind: string;
        details: unknown;
        [key: string]: unknown;
      }>(sql`
        select id, resource as kind, details
        from audit_log
        where actor = ${fixture.editorId}
          and allowed = true
        order by id
      `);
      return {
        events: events.rows,
        audits: audits.rows.filter((audit) => !beforeIds.has(audit.id)),
      };
    });

    expect(records.events.map((event) => event.kind).sort()).toEqual([
      "site.energy_profile_confirmed",
      "site.energy_profile_saved",
    ]);
    expect(records.audits).toHaveLength(2);
    for (const record of records.events) expectIdRevisionPayload(record.payload);
    for (const record of records.audits) expectIdRevisionPayload(record.details);

    const serialized = JSON.stringify(records);
    expect(serialized).toContain(fixture.projectId);
    expect(serialized).toContain(fixture.siteId);
    expect(serialized).toContain(saved.profileId);
    expect(serialized).toContain(confirmed.jobId);
    for (const forbidden of [
      GOLDEN.customer.displayName,
      GOLDEN.customer.email,
      GOLDEN.customer.phoneRaw,
      GOLDEN.site.formattedAddress,
      GOLDEN.site.street,
      GOLDEN.site.postalCode,
      GOLDEN.site.city,
      String(GOLDEN.site.latitude),
      String(GOLDEN.site.longitude),
      "54321",
      "householdKwhPerYear",
      "electricityPriceCentsPerKwh",
      "areaM2",
      "azimuthDeg",
      "tiltDeg",
      "market_estimate",
      "\"profile\":",
      "consumption",
      "roofs",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rollt Profil/Event/Audit sowie Confirmation/Reservation gemeinsam zurueck", async () => {
    const fixture = await createLead();
    await confirmPin(fixture);
    const candidate = await requireCandidate(fixture);
    const initial = await footprint(fixture);

    await expect(asActor(fixture, fixture.editorId, async (tx, ctx) => {
      await saveProjectEnergyProfile(tx, ctx, saveInput(fixture, candidate));
      throw new Error("force-save-rollback");
    })).rejects.toThrow("force-save-rollback");
    expect(await footprint(fixture)).toEqual(initial);

    const saved = await saveProfile(
      fixture,
      fixture.editorId,
      saveInput(fixture, candidate),
    );
    const afterSave = await footprint(fixture);
    await expect(asActor(fixture, fixture.editorId, async (tx, ctx) => {
      await confirmProjectEnergyProfile(tx, ctx, {
        projectId: fixture.projectId,
        expectedAddressRevision: 1,
        expectedProfileRevision: saved.revision,
      });
      throw new Error("force-confirm-rollback");
    })).rejects.toThrow("force-confirm-rollback");

    expect(await footprint(fixture)).toEqual(afterSave);
    expect(await readProfile(fixture)).toMatchObject({
      revision: 1,
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
      confirmed_by: null,
      confirmed_at: null,
    });
  });
});

describe.sequential("M1-07 Calculation-Reservation-Rate-Limit v1", () => {
  it("pinnt die konservative v1-Policy und isoliert Actor sowie Workspace", async () => {
    expect(CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1).toEqual({
      id: "project-calculation-reservation-rate-limit.v1",
      actorCooldownSeconds: 10,
      actorMaxPerRollingHour: 30,
      workspaceMaxPerRollingHour: 300,
    });

    const members = await createMembers("M1-07 Rate Actor Isolation");
    const first = await prepareReservationLead(members, 11);
    const second = await prepareReservationLead(members, 12);
    await confirmProfile(
      first.fixture,
      members.editorId,
      first.saved.revision,
    );

    const beforeRejected = await workspaceReservationFootprint(second.fixture);
    const cooldown = await expectRateLimited(confirmProfile(
      second.fixture,
      members.editorId,
      second.saved.revision,
    ));
    expect(cooldown.retryAfterSeconds).toBeLessThanOrEqual(10);
    expect(cooldown.message).toBe("project calculation reservation is rate limited");
    expect(await workspaceReservationFootprint(second.fixture)).toEqual(beforeRejected);
    expect(await readProfile(second.fixture)).toMatchObject({
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
      confirmed_by: null,
      confirmed_at: null,
    });

    // Derselbe Workspace zaehlt den Admin getrennt vom Editor.
    await expect(confirmProfile(
      second.fixture,
      members.adminId,
      second.saved.revision,
    )).resolves.toMatchObject({ replayed: false });

    // Ein unabhaengiger Tenant sieht keine Reservation des ersten Workspace.
    const isolatedMembers = await createWorkspaceForExistingEditor(
      members.editorId,
      "M1-07 Rate Tenant Isolation",
    );
    const isolated = await prepareReservationLead(isolatedMembers, 13);
    await expect(confirmProfile(
      isolated.fixture,
      isolatedMembers.editorId,
      isolated.saved.revision,
    )).resolves.toMatchObject({ replayed: false });
  });

  it("zaehlt failed_final-Reservations zur Actor-Quota und rollt die ganze Mutation zurueck", async () => {
    const members = await createMembers("M1-07 Rate Actor Quota");
    const target = await prepareReservationLead(members, 21);
    await seedTerminalReservations(
      target.fixture,
      target.saved.profileId,
      members.editorId,
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.actorMaxPerRollingHour,
    );
    const before = await workspaceReservationFootprint(target.fixture);

    const error = await expectRateLimited(confirmProfile(
      target.fixture,
      members.editorId,
      target.saved.revision,
    ));
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    expect(await workspaceReservationFootprint(target.fixture)).toEqual(before);
    expect(await readProfile(target.fixture)).toMatchObject({
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
      confirmed_by: null,
      confirmed_at: null,
    });
  });

  it("zaehlt alle Actor gemeinsam zur Workspace-Quota, ohne den neuen Actor zu belasten", async () => {
    const members = await createMembers("M1-07 Rate Workspace Quota");
    const target = await prepareReservationLead(members, 31);
    await seedTerminalReservations(
      target.fixture,
      target.saved.profileId,
      members.editorId,
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.workspaceMaxPerRollingHour,
    );
    const before = await workspaceReservationFootprint(target.fixture);

    const error = await expectRateLimited(confirmProfile(
      target.fixture,
      members.adminId,
      target.saved.revision,
    ));
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    expect(await workspaceReservationFootprint(target.fixture)).toEqual(before);
    expect(await readProfile(target.fixture)).toMatchObject({
      confirmed_profile_revision: null,
      confirmed_address_revision: null,
    });
  });

  it("laesst bei einer echten parallelen Actor-Quota-Race nur eine neue Reservation durch", async () => {
    const members = await createMembers("M1-07 Rate Actor Race");
    const left = await prepareReservationLead(members, 41);
    const right = await prepareReservationLead(members, 42);
    await seedTerminalReservations(
      left.fixture,
      left.saved.profileId,
      members.editorId,
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.actorMaxPerRollingHour - 1,
    );
    const before = await workspaceReservationFootprint(left.fixture);

    const outcomes = await Promise.allSettled([
      confirmProfile(left.fixture, members.editorId, left.saved.revision),
      confirmProfile(right.fixture, members.editorId, right.saved.revision),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(EnergyProfileRateLimitError);
    expect(rejected[0].reason).toMatchObject({ code: "rate_limited" });

    const after = await workspaceReservationFootprint(left.fixture);
    expect(after).toEqual({
      jobs: before.jobs + 1,
      reservedEvents: before.reservedEvents + 1,
      confirmedEvents: before.confirmedEvents + 1,
      confirmedProfiles: before.confirmedProfiles + 1,
      successAudits: before.successAudits + 1,
    });
  });

  it("laesst bei einer echten parallelen Workspace-Quota-Race nur eine neue Reservation durch", async () => {
    const members = await createMembers("M1-07 Rate Workspace Race");
    const left = await prepareReservationLead(members, 51);
    const right = await prepareReservationLead(members, 52);
    await seedTerminalReservations(
      left.fixture,
      left.saved.profileId,
      members.viewerId,
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.workspaceMaxPerRollingHour - 1,
    );
    const before = await workspaceReservationFootprint(left.fixture);

    const outcomes = await Promise.allSettled([
      confirmProfile(left.fixture, members.editorId, left.saved.revision),
      confirmProfile(right.fixture, members.adminId, right.saved.revision),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(EnergyProfileRateLimitError);
    expect(rejected[0].reason).toMatchObject({ code: "rate_limited" });

    const after = await workspaceReservationFootprint(left.fixture);
    expect(after).toEqual({
      jobs: before.jobs + 1,
      reservedEvents: before.reservedEvents + 1,
      confirmedEvents: before.confirmedEvents + 1,
      confirmedProfiles: before.confirmedProfiles + 1,
      successAudits: before.successAudits + 1,
    });
  });

  it("umgeht Limits nur beim exakten Replay und erreicht die queued-Dispatch-Reparatur", async () => {
    const members = await createMembers("M1-07 Rate Replay");
    const target = await prepareReservationLead(members, 61);
    const first = await confirmProfile(
      target.fixture,
      members.editorId,
      target.saved.revision,
    );
    await seedTerminalReservations(
      target.fixture,
      target.saved.profileId,
      members.editorId,
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.actorMaxPerRollingHour - 1,
    );
    await seedTerminalReservations(
      target.fixture,
      target.saved.profileId,
      members.adminId,
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.workspaceMaxPerRollingHour
        - CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.actorMaxPerRollingHour,
    );
    const before = await workspaceReservationFootprint(target.fixture);
    expect(before.jobs).toBe(
      CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1.workspaceMaxPerRollingHour,
    );

    const replayAndProbe = await asActor(
      target.fixture,
      members.editorId,
      async (tx, ctx) => {
        const precondition = await tx.execute<{
          dispatch_signature: string | null;
          [key: string]: unknown;
        }>(sql`
          select pg_catalog.to_regprocedure(
            'pgboss.enqueue_project_calculation(uuid,uuid)'
          )::text as dispatch_signature
        `);
        expect(precondition.rows[0]?.dispatch_signature).toBeNull();

        // Test-only Probe in derselben Transaktion: CREATE und DROP werden nie
        // ausserhalb dieser Callback-Grenze sichtbar. Der gesetzte lokale GUC
        // beweist, dass der queued Replay den Dispatchpfad wirklich erreicht.
        await tx.execute(sql`create schema pgboss`);
        await tx.execute(sql`
          create function pgboss.enqueue_project_calculation(
            workspace_id uuid,
            job_id uuid
          ) returns void
          language plpgsql
          as $m107_rate_dispatch_probe$
          begin
            perform pg_catalog.set_config(
              'm107.rate_limit_dispatch_job',
              job_id::text,
              true
            );
          end
          $m107_rate_dispatch_probe$
        `);
        try {
          const replay = await confirmProjectEnergyProfile(tx, ctx, {
            projectId: target.fixture.projectId,
            expectedAddressRevision: target.saved.addressRevision,
            expectedProfileRevision: target.saved.revision,
          });
          const probe = await tx.execute<{
            job_id: string | null;
            [key: string]: unknown;
          }>(sql`
            select pg_catalog.current_setting(
              'm107.rate_limit_dispatch_job',
              true
            ) as job_id
          `);
          return { replay, dispatchedJobId: probe.rows[0]?.job_id ?? null };
        } finally {
          await tx.execute(sql`drop schema pgboss cascade`);
        }
      },
    );

    expect(replayAndProbe).toEqual({
      replay: {
        profileId: target.saved.profileId,
        profileRevision: target.saved.revision,
        addressRevision: target.saved.addressRevision,
        jobId: first.jobId,
        reservationKey: first.reservationKey,
        replayed: true,
      },
      dispatchedJobId: first.jobId,
    });
    expect(await workspaceReservationFootprint(target.fixture)).toEqual(before);
  });
});
