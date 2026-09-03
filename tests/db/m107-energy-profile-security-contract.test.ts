import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import { PermissionDeniedError } from "@/lib/permissions";
import { projectRechnerSnapshotToEnergyProfile } from "@/lib/integrations/calculation/rechner-profile";
import type { SiteEnergyProfileV1 } from "@/lib/integrations/calculation/contract";
import type { RechnerIntakeV1 } from "@/lib/integrations/rechner/types";
import {
  confirmProjectEnergyProfile,
  EnergyProfileInvalidError,
  getProjectEnergyProfileCandidate,
  saveProjectEnergyProfile,
  type ConfirmProjectEnergyProfileInput,
  type SaveProjectEnergyProfileInput,
} from "@/modules/energy";
import { testPool } from "../setup/test-db";

const GOLDEN = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
  "utf8",
)) as RechnerIntakeV1;

type Fixture = {
  workspaceId: string;
  actorId: string;
  projectId: string;
  siteId: string;
  profile: SiteEnergyProfileV1;
};

type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

type MembershipRace<T> = {
  serialization: "revocation_committed_first" | "actor_context_locked_first";
  actorOperation: Settled<T>;
  postRevocationOperation: Settled<T> | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle<T>(operation: Promise<T>): Promise<Settled<T>> {
  try {
    return { status: "fulfilled", value: await operation };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function postgresCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = error as { code?: unknown; cause?: unknown };
  if (typeof direct.code === "string") return direct.code;
  if (typeof direct.cause !== "object" || direct.cause === null) return undefined;
  const cause = direct.cause as { code?: unknown };
  return typeof cause.code === "string" ? cause.code : undefined;
}

function projectedProfile(): SiteEnergyProfileV1 {
  const projected = projectRechnerSnapshotToEnergyProfile(GOLDEN.calculation!);
  if (!projected.ok) throw new Error(`Golden-Profil nicht projizierbar: ${projected.code}`);
  return structuredClone(projected.value);
}

function trustedEditorCtx(): ServiceCtx {
  return {
    workspaceId: randomUUID(),
    actor: randomUUID(),
    role: "editor",
    capabilities: {},
    featureFlags: {},
  };
}

async function invokeBeforeSql(
  operation: (tx: TenantTx, ctx: ServiceCtx) => Promise<unknown>,
): Promise<{ outcome: Settled<unknown>; sqlCalls: number }> {
  let sqlCalls = 0;
  const tx = {
    execute: async () => {
      sqlCalls += 1;
      throw new Error("fach-sql-was-reached");
    },
  } as unknown as TenantTx;
  return {
    outcome: await settle(operation(tx, trustedEditorCtx())),
    sqlCalls,
  };
}

function expectTypedInvalidBeforeSql(result: {
  outcome: Settled<unknown>;
  sqlCalls: number;
}): void {
  expect(result.outcome.status).toBe("rejected");
  if (result.outcome.status === "fulfilled") return;
  expect(result.outcome.reason).toBeInstanceOf(EnergyProfileInvalidError);
  expect(result.outcome.reason).toMatchObject({ code: "invalid_profile" });
  expect(result.sqlCalls).toBe(0);
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();
  const receiptId = randomUUID();
  const snapshotId = randomUUID();
  const requirementId = randomUUID();
  const profile = projectedProfile();
  const requestedProducts = GOLDEN.calculation!.inputs.requestedProducts;
  const requirements = {
    schemaVersion: "project-requirements.rechner.v1",
    source: "wmee-rechner-v3",
    branch: GOLDEN.calculation!.branch,
    requestedProducts: {
      targetStorageKwh: requestedProducts.targetStorageKwh,
      wallbox: requestedProducts.wallbox,
      bidirectionalCharging: requestedProducts.bidirectionalCharging,
      backupPower: requestedProducts.backupPower,
    },
  };

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M1-07 Security Contract')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${actorId}::uuid, ${`${actorId}@m107-security.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${workspaceId}::uuid, ${actorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'M1-07 Security Contact', 'Fixture', 'Contact',
        ${`${contactId}@m107-security.test`}, ${`${contactId}@m107-security.test`}
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
        ${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
        'M1-07 Security Site', 'Testweg 7, 10115 Berlin',
        decode(repeat('7a', 32), 'hex'), 1, 'selected',
        'Testweg', '7', '10115', 'Berlin', 'DE', 52.52, 13.405,
        'photon', 'house', false, 1, true, 1
      )
    `);
    const insertedProject = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id,
             'M1-07 Security Project', 'wmee-rechner-v3'
      from kanban_board board
      join kanban_column intake
        on intake.workspace_id = board.workspace_id
       and intake.board_id = board.id
       and intake.is_intake = true
       and intake.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
      returning id
    `);
    if (insertedProject.rows.length !== 1) throw new Error("Fixture-Projekt fehlt.");
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose,
        privacy_legal_basis, privacy_notice_version, privacy_notice_url,
        contact_resolution, contact_id, site_id, project_id
      ) values (
        ${receiptId}::uuid, ${workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('42', 32), 'hex'), 'm107-security-key',
        now(), now(), now(), 'wmee-rechner-v3', ${"2".repeat(40)},
        'development', 'wmee-solar.v1', '{}'::jsonb, 'offer_request',
        'art_6_1_b_precontractual', 'm107-security.v1',
        'https://example.test/privacy', 'created', ${contactId}::uuid,
        ${siteId}::uuid, ${projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${snapshotId}::uuid, ${workspaceId}::uuid, ${receiptId}::uuid,
        ${projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate',
        ${new Date(GOLDEN.calculation!.calculatedAt)},
        ${JSON.stringify(GOLDEN.calculation)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${requirementId}::uuid, ${workspaceId}::uuid, ${projectId}::uuid, 1,
        'project-requirements.rechner.v1', ${snapshotId}::uuid,
        ${JSON.stringify(requirements)}::jsonb
      )
    `);
  });

  return { workspaceId, actorId, projectId, siteId, profile };
}

function saveInput(fixture: Fixture): SaveProjectEnergyProfileInput {
  return {
    projectId: fixture.projectId,
    expectedAddressRevision: 1,
    expectedLatestRevision: 0,
    profile: structuredClone(fixture.profile),
    roofAcknowledgements: fixture.profile.roofs.map((roof) => roof.id),
  };
}

async function energyFootprint(fixture: Fixture): Promise<{
  profiles: number;
  events: number;
  audits: number;
}> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{
      profiles: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from site_energy_profile
          where workspace_id = ${fixture.workspaceId}::uuid
            and site_id = ${fixture.siteId}::uuid) as profiles,
        (select count(*)::int from domain_events
          where workspace_id = ${fixture.workspaceId}::uuid
            and event_type like 'site.energy_profile_%') as events,
        (select count(*)::int from audit_log
          where workspace_id = ${fixture.workspaceId}::uuid
            and resource = 'energy_profile') as audits
    `);
    return result.rows[0];
  });
}

async function runAfterMembershipMutation<T>(
  fixture: Fixture,
  mutateMembership: (tx: TenantTx) => Promise<unknown>,
  operation: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<MembershipRace<T>> {
  const contextReady = deferred<void>();
  const continueActor = deferred<void>();
  const actorOperation = withAuthorizedTenantOn(
    testPool,
    fixture.actorId,
    fixture.workspaceId,
    async (tx, ctx) => {
      contextReady.resolve();
      await continueActor.promise;
      return operation(tx, ctx);
    },
  );

  await contextReady.promise;
  const firstMutation = await settle(withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`set local lock_timeout = '300ms'`);
    await tx.execute(sql`set local statement_timeout = '1500ms'`);
    await mutateMembership(tx);
  }));
  continueActor.resolve();
  const actorOutcome = await settle(actorOperation);

  if (firstMutation.status === "fulfilled") {
    return {
      serialization: "revocation_committed_first",
      actorOperation: actorOutcome,
      postRevocationOperation: null,
    };
  }
  if (postgresCode(firstMutation.reason) !== "55P03") throw firstMutation.reason;

  // Der zentrale Tenant-Vertrag darf den Actor-Context stattdessen bis Commit
  // durch einen Workspace-Lock stabilisieren. Dann muss die erste Mutation
  // kontrolliert am lock_timeout scheitern, nach Actor-Commit deadlockfrei
  // gelingen und jeder NEUE Zugriff den entzogenen Zustand sehen.
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`set local statement_timeout = '1500ms'`);
    await mutateMembership(tx);
  });
  const postRevocationOperation = await settle(withAuthorizedTenantOn(
    testPool,
    fixture.actorId,
    fixture.workspaceId,
    operation,
  ));
  return {
    serialization: "actor_context_locked_first",
    actorOperation: actorOutcome,
    postRevocationOperation,
  };
}

describe("M1-07 Energy-Service-Sicherheitsvertrag", () => {
  describe("strikte öffentliche Input-Envelopes", () => {
    const invalidCandidateInputs: Array<[string, unknown]> = [
      ["malformed UUID", "kein-uuid"],
      ["null", null],
      ["extra keys", { projectId: randomUUID(), extra: true }],
      ["NaN", Number.NaN],
    ];

    it.each(invalidCandidateInputs)(
      "Candidate lehnt %s typed vor Fach-SQL ab",
      async (_label, input) => {
        const candidateBoundary = getProjectEnergyProfileCandidate as unknown as (
          tx: TenantTx,
          ctx: ServiceCtx,
          input: unknown,
        ) => Promise<unknown>;
        expectTypedInvalidBeforeSql(await invokeBeforeSql(
          (tx, ctx) => candidateBoundary(tx, ctx, input),
        ));
      },
    );

    const validSave = (): SaveProjectEnergyProfileInput => {
      const profile = projectedProfile();
      return {
        projectId: randomUUID(),
        expectedAddressRevision: 1,
        expectedLatestRevision: 0,
        profile,
        roofAcknowledgements: profile.roofs.map((roof) => roof.id),
      };
    };
    const invalidSaveInputs: Array<[string, unknown]> = [
      ["malformed UUID", { ...validSave(), projectId: "kein-uuid" }],
      ["null", null],
      ["extra keys", { ...validSave(), extra: true }],
      ["NaN", { ...validSave(), expectedAddressRevision: Number.NaN }],
    ];

    it.each(invalidSaveInputs)(
      "Save lehnt %s typed vor Fach-SQL ab",
      async (_label, input) => {
        const saveBoundary = saveProjectEnergyProfile as unknown as (
          tx: TenantTx,
          ctx: ServiceCtx,
          input: unknown,
        ) => Promise<unknown>;
        expectTypedInvalidBeforeSql(await invokeBeforeSql(
          (tx, ctx) => saveBoundary(tx, ctx, input),
        ));
      },
    );

    const validConfirm = (): ConfirmProjectEnergyProfileInput => ({
      projectId: randomUUID(),
      expectedAddressRevision: 1,
      expectedProfileRevision: 1,
    });
    const invalidConfirmInputs: Array<[string, unknown]> = [
      ["malformed UUID", { ...validConfirm(), projectId: "kein-uuid" }],
      ["null", null],
      ["extra keys", { ...validConfirm(), extra: true }],
      ["NaN", { ...validConfirm(), expectedAddressRevision: Number.NaN }],
    ];

    it.each(invalidConfirmInputs)(
      "Confirm lehnt %s typed vor Fach-SQL ab",
      async (_label, input) => {
        const confirmBoundary = confirmProjectEnergyProfile as unknown as (
          tx: TenantTx,
          ctx: ServiceCtx,
          input: unknown,
        ) => Promise<unknown>;
        expectTypedInvalidBeforeSql(await invokeBeforeSql(
          (tx, ctx) => confirmBoundary(tx, ctx, input),
        ));
      },
    );
  });

  it("Candidate-Read blockiert keine parallele Site-Adressmutation", async () => {
    const fixture = await createFixture();
    const readComplete = deferred<void>();
    const releaseReader = deferred<void>();
    const reader = withAuthorizedTenantOn(
      testPool,
      fixture.actorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const candidate = await getProjectEnergyProfileCandidate(tx, ctx, fixture.projectId);
        readComplete.resolve();
        await releaseReader.promise;
        return candidate;
      },
    );

    await readComplete.promise;
    const mutation = await settle(withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`set local lock_timeout = '300ms'`);
      await tx.execute(sql`
        update site
        set formatted_address = 'Testweg 7A, 10115 Berlin', updated_at = now()
        where workspace_id = ${fixture.workspaceId}::uuid
          and id = ${fixture.siteId}::uuid
      `);
    }));
    releaseReader.resolve();
    const readOutcome = await settle(reader);

    expect(readOutcome.status).toBe("fulfilled");
    expect(mutation.status).toBe("fulfilled");
  });

  it("Candidate liest nach committed Membership-Entzug nicht mit stale Actor-Context", async () => {
    const fixture = await createFixture();
    const before = await energyFootprint(fixture);
    const race = await runAfterMembershipMutation(
      fixture,
      (tx) => tx.execute(sql`
        delete from membership
        where workspace_id = ${fixture.workspaceId}::uuid
          and user_id = ${fixture.actorId}::uuid
      `),
      (tx, ctx) => getProjectEnergyProfileCandidate(tx, ctx, fixture.projectId),
    );
    const after = await energyFootprint(fixture);

    if (race.serialization === "revocation_committed_first") {
      expect(race.actorOperation.status).toBe("rejected");
      if (race.actorOperation.status === "rejected") {
        expect(race.actorOperation.reason).toBeInstanceOf(PermissionDeniedError);
      }
    } else {
      expect(race.actorOperation.status).toBe("fulfilled");
      expect(race.postRevocationOperation?.status).toBe("rejected");
      if (race.postRevocationOperation?.status === "rejected") {
        expect(race.postRevocationOperation.reason).toBeInstanceOf(PermissionDeniedError);
      }
    }
    expect(after).toEqual(before);
  });

  it("Save mutiert nach committed Editor-Downgrade weder Profil noch Event/Audit", async () => {
    const fixture = await createFixture();
    const before = await energyFootprint(fixture);
    const race = await runAfterMembershipMutation(
      fixture,
      (tx) => tx.execute(sql`
        update membership
        set role = 'viewer'
        where workspace_id = ${fixture.workspaceId}::uuid
          and user_id = ${fixture.actorId}::uuid
      `),
      (tx, ctx) => saveProjectEnergyProfile(tx, ctx, saveInput(fixture)),
    );
    const after = await energyFootprint(fixture);

    if (race.serialization === "revocation_committed_first") {
      expect(race.actorOperation.status).toBe("rejected");
      if (race.actorOperation.status === "rejected") {
        expect(race.actorOperation.reason).toBeInstanceOf(PermissionDeniedError);
      }
      expect(after).toEqual(before);
    } else {
      // Der erste Save lag in diesem erlaubten Serialisierungszweig vor dem
      // Downgrade. Entscheidend: der danach ausgeführte Zugriff bleibt still.
      expect(race.actorOperation.status).toBe("fulfilled");
      expect(race.postRevocationOperation?.status).toBe("rejected");
      if (race.postRevocationOperation?.status === "rejected") {
        expect(race.postRevocationOperation.reason).toBeInstanceOf(PermissionDeniedError);
      }
      expect(after).toEqual({
        profiles: before.profiles + 1,
        events: before.events + 1,
        audits: before.audits + 1,
      });
    }
  });
});
