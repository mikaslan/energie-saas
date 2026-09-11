import { randomUUID } from "node:crypto";
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
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";
import { tenantFixtures } from "../setup/tenant-fixtures";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type AcceptanceRow = QueryResultRow & {
  requestId: string;
  attestationId: string;
  projectId: string;
  offerId: string;
  variantId: string;
  mode: string;
  signedAt: string;
  phase: string;
  outcome: string;
  outcomeRevision: number;
  closedAt: string | null;
  boardId: string;
  columnId: string;
};

type PendingSignatureRow = QueryResultRow & {
  requestId: string;
  projectId: string;
  offerId: string;
  variantId: string;
  actorId: string;
  signerName: string;
  contentSha256: Buffer;
};

const PRE_F208B_MIGRATION_INDEX = 75;
const F208B_MIGRATION_INDEX = 76;

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-f208b-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  const journal = migrationJournal();
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

async function tenantTransaction<T>(
  pool: Pool,
  workspaceId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function acceptance(pool: Pool, workspaceId: string): Promise<AcceptanceRow> {
  return tenantTransaction(pool, workspaceId, async (client) => {
    const actor = await client.query<{ actorId: string }>(`
      select created_by as "actorId" from offer
       where workspace_id = $1::uuid order by created_at limit 1
    `, [workspaceId]);
    if (!actor.rows[0]?.actorId) throw new Error("F2.8b Upgrade-Actor fehlt.");
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [actor.rows[0].actorId],
    );
    const result = await client.query<AcceptanceRow>(`
      select request_record.id as "requestId",
             attestation.id as "attestationId",
             request_record.project_id as "projectId",
             request_record.offer_id as "offerId",
             request_record.variant_id as "variantId",
             attestation.mode,
             request_record.signed_at::text as "signedAt",
             project_record.phase,
             project_record.outcome,
             project_record.outcome_revision as "outcomeRevision",
             project_record.closed_at::text as "closedAt",
             project_record.kanban_board_id as "boardId",
             project_record.kanban_column_id as "columnId"
        from signature_request as request_record
        join signature_attestation as attestation
          on attestation.workspace_id = request_record.workspace_id
         and attestation.signature_request_id = request_record.id
        join project as project_record
          on project_record.workspace_id = request_record.workspace_id
         and project_record.id = request_record.project_id
       where request_record.workspace_id = $1::uuid
       limit 1
    `, [workspaceId]);
    const row = result.rows[0];
    if (!row) throw new Error("F2.8b Upgrade-Akzeptanz fehlt.");
    return row;
  });
}

async function waitForBackendLock(
  observer: PoolClient,
  backendPid: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await observer.query<{ waitEventType: string | null }>(`
      select wait_event_type as "waitEventType"
        from pg_catalog.pg_stat_activity
       where pid = $1
    `, [backendPid]);
    if (state.rows[0]?.waitEventType === "Lock") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`F2.8b: ${label} wurde nicht als Lock-Wait sichtbar.`);
}

async function waitForRolloutRetry(
  observer: PoolClient,
  backendPid: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await observer.query<{
      query: string;
      waitEvent: string | null;
    }>(`
      select query, wait_event as "waitEvent"
        from pg_catalog.pg_stat_activity
       where pid = $1
    `, [backendPid]);
    const row = state.rows[0];
    if (row?.query.includes("f208b_rollout_lock") && row.waitEvent === "PgSleep") {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("F2.8b: Migration wurde nicht im NOWAIT-Retry sichtbar.");
}

async function seedPendingSignature(
  pool: Pool,
  workspaceId: string,
): Promise<PendingSignatureRow> {
  return tenantTransaction(pool, workspaceId, async (client) => {
    await client.query(
      "insert into workspace (id, name) values ($1::uuid, 'F2.8b Race')",
      [workspaceId],
    );
    await tenantFixtures.signature_request(
      drizzle(client) as unknown as TenantTx,
      workspaceId,
    );
    const result = await client.query<PendingSignatureRow>(`
      select request_record.id as "requestId",
             request_record.project_id as "projectId",
             request_record.offer_id as "offerId",
             request_record.variant_id as "variantId",
             request_record.created_by as "actorId",
             contact_record.display_name as "signerName",
             request_record.content_sha256 as "contentSha256"
        from signature_request as request_record
        join offer as offer_record
          on offer_record.workspace_id = request_record.workspace_id
         and offer_record.id = request_record.offer_id
        join contact as contact_record
          on contact_record.workspace_id = offer_record.workspace_id
         and contact_record.id = offer_record.contact_id
       where request_record.workspace_id = $1::uuid
       limit 1
    `, [workspaceId]);
    const row = result.rows[0];
    if (!row) throw new Error("F2.8b Race-Request fehlt.");
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [row.actorId],
    );
    await client.query(`
      update project
         set phase = 'offer', updated_at = pg_catalog.clock_timestamp()
       where workspace_id = $1::uuid and id = $2::uuid
    `, [workspaceId, row.projectId]);
    return row;
  });
}

async function markRequestSignedWithoutAttestation(
  client: PoolClient,
  workspaceId: string,
  row: PendingSignatureRow,
): Promise<void> {
  await client.query(
    `select pg_catalog.set_config('app.workspace_id', $1, true),
            pg_catalog.set_config('app.actor_id', $2, true)`,
    [workspaceId, row.actorId],
  );
  await client.query(`
    update signature_request
       set status = 'signed',
           signer_name = $3,
           signed_variant_id = variant_id,
           signed_at = pg_catalog.clock_timestamp()
     where workspace_id = $1::uuid and id = $2::uuid and status = 'pending'
  `, [workspaceId, row.requestId, row.signerName]);
}

describe.sequential("F2.8b Signaturakzeptanz Migration-Upgrade", () => {
  it("zieht signierten 0075-Bestand atomar auf Won nach und erfindet keine Installation", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    try {
      const journal = migrationJournal();
      expect(journal.entries[F208B_MIGRATION_INDEX]).toMatchObject({
        idx: F208B_MIGRATION_INDEX,
        tag: "0076_f2_08b_signature_acceptance_won",
      });
      prefix = migrationPrefixThrough(PRE_F208B_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });

      const workspaceId = randomUUID();
      await tenantTransaction(pool, workspaceId, async (client) => {
        await client.query(
          "insert into workspace (id, name) values ($1::uuid, 'F2.8b Upgrade')",
          [workspaceId],
        );
        await tenantFixtures.signature_attestation(
          drizzle(client) as unknown as TenantTx,
          workspaceId,
        );
      });
      const before = await acceptance(pool, workspaceId);
      expect(before).toMatchObject({
        phase: "offer",
        outcome: "open",
        outcomeRevision: 0,
        closedAt: null,
        mode: "analog",
      });

      // Der Locator ist nur ein Token-Index, kein kanonisches Inventar. Auch
      // historische Analog-/Direktpfade ohne Locator muessen erfasst werden.
      await tenantTransaction(pool, workspaceId, async (client) => {
        await client.query(
          "delete from signature_token_locator where signature_request_id = $1::uuid",
          [before.requestId],
        );
      });

      // Ein alter Analog-Service schrieb diese Aktivitaet bereits selbst.
      // 0076 darf den Bestand nicht duplizieren.
      await tenantTransaction(pool, workspaceId, async (client) => {
        await client.query(
          `insert into domain_events (
             workspace_id, aggregate_type, aggregate_id, event_type, actor, payload,
             occurred_at
           ) values ($1::uuid, 'offer', $2::uuid, 'signature.signed', 'legacy',
             $3::jsonb, $4::timestamptz)`,
          [
            workspaceId,
            before.offerId,
            JSON.stringify({
              requestId: before.requestId,
              offerId: before.offerId,
              mode: before.mode,
            }),
            before.signedAt,
          ],
        );
      });

      // Upgrade in zwei Commits (Produktions-Treue): 0076-Nachzug zuerst.
      // drizzle-migrate() bündelt alle ausstehenden Migrationen in EINER
      // Transaktion; der 0076-Backfill (UPDATE project) hinterlässt sonst
      // pending Events des deferred Integritäts-Triggers, an denen der
      // spätere ALTER TABLE project (0101 follow_up_at) derselben
      // Transaktion scheitert („pending trigger events"). Reale Deployments
      // committeten je Stand — ein 0075→HEAD-Einzelsprung kam nie vor.
      // Keine Abschwächung: alle Nachweise unten laufen gegen HEAD.
      const prefix76 = migrationPrefixThrough(F208B_MIGRATION_INDEX);
      try {
        await migrate(drizzle(pool), { migrationsFolder: prefix76 });
        await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      } finally {
        rmSync(prefix76, { recursive: true, force: true });
      }
      const after = await acceptance(pool, workspaceId);
      expect(after).toMatchObject({
        requestId: before.requestId,
        attestationId: before.attestationId,
        projectId: before.projectId,
        offerId: before.offerId,
        variantId: before.variantId,
        signedAt: before.signedAt,
        phase: before.phase,
        outcome: "won",
        outcomeRevision: 1,
        closedAt: before.signedAt,
        boardId: before.boardId,
        columnId: before.columnId,
      });

      const proof = await tenantTransaction(pool, workspaceId, (client) =>
        client.query<{
          installations: number;
          tokenLocators: number;
          signatureEvents: number;
          outcomeEvents: number;
          outcomeAudits: number;
          actor: string;
          payload: Record<string, unknown>;
        }>(`
          select
            (select count(*)::integer from installation
              where workspace_id = $1::uuid and project_id = $2::uuid) as installations,
            (select count(*)::integer from signature_token_locator
              where workspace_id = $1::uuid
                and signature_request_id = $4::uuid) as "tokenLocators",
            (select count(*)::integer from domain_events
              where workspace_id = $1::uuid and aggregate_id = $3::uuid
                and event_type = 'signature.signed') as "signatureEvents",
            (select count(*)::integer from domain_events
              where workspace_id = $1::uuid and aggregate_id = $2::uuid
                and event_type = 'project.outcome_won') as "outcomeEvents",
            (select count(*)::integer from audit_log
              where workspace_id = $1::uuid and resource = 'project'
                and action = 'project.outcome.write'
                and details->>'projectId' = $2::text) as "outcomeAudits",
            event.actor,
            event.payload
          from domain_events as event
          where event.workspace_id = $1::uuid
            and event.aggregate_id = $2::uuid
            and event.event_type = 'project.outcome_won'
        `, [workspaceId, before.projectId, before.offerId, before.requestId]),
      );
      expect(proof.rows[0]).toMatchObject({
        installations: 0,
        tokenLocators: 0,
        signatureEvents: 1,
        outcomeEvents: 1,
        outcomeAudits: 1,
        actor: "system",
        payload: {
          source: "signature",
          projectId: before.projectId,
          signatureRequestId: before.requestId,
          signatureAttestationId: before.attestationId,
          signatureMode: "analog",
          offerId: before.offerId,
          variantId: before.variantId,
        },
      });
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F2.8b-Migrations-Upgrade-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("weist historischen Signed-plus-Won-Bestand in der Request-Phase atomar zurueck", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    try {
      prefix = migrationPrefixThrough(PRE_F208B_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = randomUUID();
      await tenantTransaction(pool, workspaceId, async (client) => {
        await client.query(
          "insert into workspace (id, name) values ($1::uuid, 'F2.8b Won Request')",
          [workspaceId],
        );
        await tenantFixtures.signature_attestation(
          drizzle(client) as unknown as TenantTx,
          workspaceId,
        );
        const actor = await client.query<{ actorId: string; projectId: string }>(`
          select request_record.created_by as "actorId",
                 request_record.project_id as "projectId"
            from signature_request as request_record
           where request_record.workspace_id = $1::uuid
           limit 1
        `, [workspaceId]);
        const row = actor.rows[0];
        if (!row) throw new Error("F2.8b Won/Request-Bestand fehlt.");
        await client.query(
          "select pg_catalog.set_config('app.actor_id', $1, true)",
          [row.actorId],
        );
        // Dieser Zustand war vor 0076 ueber zwei jeweils gueltige Altpfade
        // erreichbar: Signatur in Offer, danach reine Phase-Korrektur und die
        // damalige Request-Outcome-Kante.
        await client.query(`
          update project
             set phase = 'request', updated_at = pg_catalog.clock_timestamp()
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]);
        await client.query(`
          update project
             set outcome = 'won', outcome_revision = outcome_revision + 1
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]);
      });
      const before = await acceptance(pool, workspaceId);
      expect(before).toMatchObject({
        phase: "request",
        outcome: "won",
        outcomeRevision: 1,
        mode: "analog",
      });

      await expect(migrate(drizzle(pool), {
        migrationsFolder: resolve("drizzle"),
      })).rejects.toThrow(/F2\.8b:/);

      const journal = await pool.query<{ count: number }>(
        "select count(*)::integer as count from drizzle.__drizzle_migrations",
      );
      expect(journal.rows[0]?.count).toBe(PRE_F208B_MIGRATION_INDEX + 1);
      const unchanged = await acceptance(pool, workspaceId);
      expect(unchanged).toMatchObject({
        phase: "request",
        outcome: "won",
        outcomeRevision: 1,
        closedAt: before.closedAt,
      });
      const forceRls = await pool.query<{ forced: boolean }>(`
        select relforcerowsecurity as forced
          from pg_catalog.pg_class
         where oid = 'public.signature_request'::regclass
      `);
      expect(forceRls.rows[0]?.forced).toBe(true);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F2.8b-Won-Request-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("quiesziert alte FOR-UPDATE-Pfade per NOWAIT-Retry ohne Upgrade-Deadlock", async () => {
    const migrationSource = readFileSync(
      resolve("drizzle/0076_f2_08b_signature_acceptance_won.sql"),
      "utf8",
    );
    const rolloutLock = /DO \$f208b_rollout_lock\$[\s\S]*?\$f208b_rollout_lock\$;/i
      .exec(migrationSource);
    expect(rolloutLock?.index).toBeTypeOf("number");
    expect(rolloutLock?.index).toBeGreaterThan(
      migrationSource.indexOf("$f208b_preflight$;"),
    );
    expect(rolloutLock?.index).toBeLessThan(
      migrationSource.indexOf("DO $f208b_owner_prepare$"),
    );
    expect(rolloutLock?.[0]).toMatch(
      /LOCK TABLE public\.project IN EXCLUSIVE MODE NOWAIT;[\s\S]*LOCK TABLE public\.signature_request IN ACCESS EXCLUSIVE MODE NOWAIT;[\s\S]*LOCK TABLE public\.signature_attestation IN SHARE ROW EXCLUSIVE MODE NOWAIT;/i,
    );
    expect(migrationSource.indexOf("ACCESS EXCLUSIVE MODE NOWAIT")).toBeLessThan(
      migrationSource.indexOf("NO FORCE ROW LEVEL SECURITY"),
    );
    expect(migrationSource).not.toMatch(/CREATE\s+TEMP(?:ORARY)?\s+TABLE/i);
    expect(migrationSource).toMatch(
      /DO \$f208b_stage_inventory\$[\s\S]*app\.f208b_terminal_workspace_ids/i,
    );

    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 4 });
    let prefix: string | undefined;
    const migrator = await pool.connect();
    const legacyWriter = await pool.connect();
    const observer = await pool.connect();
    let migrationPromise: Promise<void> | undefined;
    try {
      prefix = migrationPrefixThrough(PRE_F208B_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = randomUUID();
      const pending = await seedPendingSignature(pool, workspaceId);

      // Der alte Analogpfad aus 0075 startet mit Request FOR UPDATE und
      // eskaliert erst beim spaeteren UPDATE auf ROW EXCLUSIVE.
      await legacyWriter.query("begin");
      await legacyWriter.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [workspaceId, pending.actorId],
      );
      await legacyWriter.query(`
        select id from signature_request
         where workspace_id = $1::uuid and id = $2::uuid
         for update
      `, [workspaceId, pending.requestId]);
      const migrationBackend = await migrator.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const migrationPid = migrationBackend.rows[0]?.pid;
      if (!migrationPid) throw new Error("F2.8b: Migrations-Backend fehlt.");

      migrationPromise = migrate(drizzle(migrator), {
        migrationsFolder: resolve("drizzle"),
      });
      await waitForRolloutRetry(observer, migrationPid);

      // Der fehlgeschlagene NOWAIT-Versuch haelt keinen Project-/Request-Lock
      // fest. Der Altpfad kann deshalb ohne Queue-Zyklus eskalieren und enden.
      await expect(legacyWriter.query(
        "lock table signature_request in row exclusive mode nowait",
      )).resolves.toMatchObject({ rowCount: null });
      await legacyWriter.query("rollback");
      await migrationPromise;
    } catch (error) {
      if (migrationPromise) await migrationPromise.catch(() => undefined);
      await legacyWriter.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      observer.release();
      legacyWriter.release();
      migrator.release();
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F2.8b-Migrations-Lock-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("bricht bei locatorlosem terminalem Request ohne Attestierung vollstaendig zurueck", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    try {
      prefix = migrationPrefixThrough(PRE_F208B_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = randomUUID();
      const row = await seedPendingSignature(pool, workspaceId);
      await tenantTransaction(pool, workspaceId, async (client) => {
        await markRequestSignedWithoutAttestation(client, workspaceId, row);
        await client.query(
          "delete from signature_token_locator where signature_request_id = $1::uuid",
          [row.requestId],
        );
      });

      await expect(migrate(drizzle(pool), {
        migrationsFolder: resolve("drizzle"),
      })).rejects.toThrow(/signierter Request ohne passende Attestierung/);

      const journal = await pool.query<{ count: number }>(
        "select count(*)::integer as count from drizzle.__drizzle_migrations",
      );
      expect(journal.rows[0]?.count).toBe(PRE_F208B_MIGRATION_INDEX + 1);
      const unchanged = await tenantTransaction(pool, workspaceId, (client) =>
        client.query<{ outcome: string; outcomeRevision: number }>(`
          select outcome, outcome_revision as "outcomeRevision"
            from project
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]),
      );
      expect(unchanged.rows[0]).toEqual({ outcome: "open", outcomeRevision: 0 });
      const forceRls = await pool.query<{ forced: boolean }>(`
        select relforcerowsecurity as forced
          from pg_catalog.pg_class
         where oid = 'public.signature_request'::regclass
      `);
      expect(forceRls.rows[0]?.forced).toBe(true);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F2.8b-Fail-Closed-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("weist bereits-Won-Bestand mit falsch gebundener Attestierung atomar zurueck", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    try {
      prefix = migrationPrefixThrough(PRE_F208B_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = randomUUID();
      await tenantTransaction(pool, workspaceId, async (client) => {
        await client.query(
          "insert into workspace (id, name) values ($1::uuid, 'F2.8b Mismatch')",
          [workspaceId],
        );
        await tenantFixtures.signature_attestation(
          drizzle(client) as unknown as TenantTx,
          workspaceId,
        );
        const actor = await client.query<{ actorId: string; projectId: string }>(`
          select request_record.created_by as "actorId",
                 request_record.project_id as "projectId"
            from signature_request as request_record
           where request_record.workspace_id = $1::uuid
           limit 1
        `, [workspaceId]);
        const row = actor.rows[0];
        if (!row) throw new Error("F2.8b Mismatch-Bestand fehlt.");
        await client.query(
          "select pg_catalog.set_config('app.actor_id', $1, true)",
          [row.actorId],
        );
        await client.query(`
          update project
             set phase = 'request', updated_at = pg_catalog.clock_timestamp()
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]);
        await client.query(`
          update project
             set outcome = 'won', outcome_revision = outcome_revision + 1
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]);
        await client.query(`
          update project
             set phase = 'offer', updated_at = pg_catalog.clock_timestamp()
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]);
      });
      const before = await acceptance(pool, workspaceId);
      expect(before).toMatchObject({ phase: "offer", outcome: "won", outcomeRevision: 1 });

      await pool.query(
        "alter table signature_attestation disable trigger signature_attestation_mutation_guard",
      );
      try {
        const corrupted = await tenantTransaction(pool, workspaceId, async (client) => {
          const actor = await client.query<{ actorId: string }>(`
            select created_by as "actorId"
              from offer
             where workspace_id = $1::uuid and id = $2::uuid
          `, [workspaceId, before.offerId]);
          if (!actor.rows[0]?.actorId) throw new Error("F2.8b Mismatch-Actor fehlt.");
          await client.query(
            "select pg_catalog.set_config('app.actor_id', $1, true)",
            [actor.rows[0].actorId],
          );
          return client.query(`
            update signature_attestation
               set signer_name = signer_name || ' mismatch',
                   content_sha256 = pg_catalog.sha256(
                     pg_catalog.convert_to('f208b-mismatch', 'UTF8')
                   ),
                   signed_at = signed_at + interval '1 second'
             where workspace_id = $1::uuid and id = $2::uuid
          `, [workspaceId, before.attestationId]);
        });
        expect(corrupted.rowCount).toBe(1);
      } finally {
        await pool.query(
          "alter table signature_attestation enable trigger signature_attestation_mutation_guard",
        );
      }

      await expect(migrate(drizzle(pool), {
        migrationsFolder: resolve("drizzle"),
      })).rejects.toThrow(/signierter Request ohne passende Attestierung/);

      const journal = await pool.query<{ count: number }>(
        "select count(*)::integer as count from drizzle.__drizzle_migrations",
      );
      expect(journal.rows[0]?.count).toBe(PRE_F208B_MIGRATION_INDEX + 1);
      const unchanged = await acceptance(pool, workspaceId);
      expect(unchanged).toMatchObject({
        phase: "offer",
        outcome: "won",
        outcomeRevision: 1,
        closedAt: before.closedAt,
      });
      expect(unchanged).toMatchObject({
        mode: before.mode,
      });
      expect(unchanged.signedAt).toBe(before.signedAt);
      const forceRls = await pool.query<{ forced: boolean }>(`
        select relforcerowsecurity as forced
          from pg_catalog.pg_class
         where oid = 'public.signature_request'::regclass
      `);
      expect(forceRls.rows[0]?.forced).toBe(true);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F2.8b-Mismatch-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("nimmt beim direkten Attestation-Insert den Project-Lock vor dem Request-Lock", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 5 });
    const projectBlocker = await pool.connect();
    const inserter = await pool.connect();
    const requestProbe = await pool.connect();
    const observer = await pool.connect();
    let insertPromise: Promise<unknown> | undefined;
    try {
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      const workspaceId = randomUUID();
      const row = await seedPendingSignature(pool, workspaceId);
      // Diese Probe braucht absichtlich den Zwischenstand, den der neue
      // deferred COMMIT-Guard produktiv verbietet. Nur der Embedded-Superuser
      // setzt das Fixture, danach ist der Guard vor der eigentlichen Lockprobe
      // sofort wieder aktiv.
      await pool.query(
        "alter table signature_request disable trigger signature_request_terminal_integrity",
      );
      try {
        await tenantTransaction(pool, workspaceId, (client) =>
          markRequestSignedWithoutAttestation(client, workspaceId, row),
        );
      } finally {
        await pool.query(
          "alter table signature_request enable trigger signature_request_terminal_integrity",
        );
      }

      for (const client of [projectBlocker, inserter, requestProbe]) {
        await client.query("begin");
        await client.query(
          `select pg_catalog.set_config('app.workspace_id', $1, true),
                  pg_catalog.set_config('app.actor_id', $2, true)`,
          [workspaceId, row.actorId],
        );
      }
      await projectBlocker.query(`
        select id from project
         where workspace_id = $1::uuid and id = $2::uuid
         for update
      `, [workspaceId, row.projectId]);

      const insertBackend = await inserter.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const insertPid = insertBackend.rows[0]?.pid;
      if (!insertPid) throw new Error("F2.8b: Attestation-Backend fehlt.");
      const artifact = Buffer.from("%PDF-1.7\nf208b-lock-order\n%%EOF", "latin1");
      insertPromise = inserter.query(`
        insert into signature_attestation (
          id, workspace_id, signature_request_id, mode, signer_name,
          content_sha256, signing_date, artifact_mime_type,
          artifact_sha256, artifact_size_bytes, artifact_bytes
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'analog', $4, $5::bytea,
          pg_catalog.clock_timestamp(), 'application/pdf',
          pg_catalog.sha256($6::bytea), pg_catalog.octet_length($6::bytea),
          $6::bytea
        )
      `, [
        randomUUID(), workspaceId, row.requestId, row.signerName,
        row.contentSha256, artifact,
      ]);
      await waitForBackendLock(observer, insertPid, "direkter Attestation-Insert");

      // Solange der Insert am Project wartet, darf er den Request noch nicht
      // sperren. NOWAIT macht eine invertierte Reihenfolge deterministisch rot.
      await expect(requestProbe.query(`
        select id from signature_request
         where workspace_id = $1::uuid and id = $2::uuid
         for update nowait
      `, [workspaceId, row.requestId])).resolves.toMatchObject({ rowCount: 1 });
      await requestProbe.query("rollback");
      await projectBlocker.query("commit");
      await insertPromise;
      await inserter.query("commit");

      const project = await tenantTransaction(pool, workspaceId, (client) =>
        client.query<{ outcome: string; outcomeRevision: number }>(`
          select outcome, outcome_revision as "outcomeRevision"
            from project
           where workspace_id = $1::uuid and id = $2::uuid
        `, [workspaceId, row.projectId]),
      );
      expect(project.rows[0]).toEqual({ outcome: "won", outcomeRevision: 1 });
    } catch (error) {
      await requestProbe.query("rollback").catch(() => undefined);
      await projectBlocker.query("rollback").catch(() => undefined);
      if (insertPromise) await insertPromise.catch(() => undefined);
      await inserter.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      observer.release();
      requestProbe.release();
      inserter.release();
      projectBlocker.release();
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F2.8b-Attestation-Lock-Teardown fehlgeschlagen",
      );
    }
  }, 120_000);
});
