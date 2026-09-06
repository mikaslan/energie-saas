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
import { Pool, type PoolClient, type QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import {
  canonicalizeLegacySnapshotV3MigrationTimestamp,
  verifyAppliedMigrationHistory,
} from "../../scripts/migration-history.mjs";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    tag: string;
    when: number;
    [key: string]: unknown;
  }>;
};

type LegacyProject = {
  id: string;
  outcome: "open" | "won" | "lost" | "cannot_fulfill";
  updatedAt: string;
};

const PRE_M111A_MIGRATION_INDEX = 38;
const M111A_MIGRATION_INDEX = 39;
const PRE_SNAPSHOT_V3_MIGRATION_INDEX = 65;
const SNAPSHOT_V3_MIGRATION_INDEX = 66;
const PRE_F301_MIGRATION_INDEX = 74;
const LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP = 1_788_565_894_444;
const SNAPSHOT_V3_MIGRATION_TIMESTAMP = 1_788_567_623_493;
const SNAPSHOT_V3_MIGRATION_SHA256 =
  "d95c615f131572c12008cc42bcd0d5cce663c3a2a30d255f16fbb3394994e98d";
// Integrierte Kette: … → M2-04 (0044) → M3-00 (0045) → M3-01 (0046) →
// F4.6 (0047) → v5-Leadquelle (0048); Gesamtbestand: 49 Migrationen (idx 0..48).
// wave-02-Integration: 0055 (F2.2) + 0056 (F10.1) => 57 Migrationen (idx 0..56).
// 0055-0056 + Welle-03-Nachzug 0057-0060 => 61 Migrationen (idx 0..60).
// 0055-0056 + Welle-03-Nachzug bis 0065 => 66 Migrationen (idx 0..65).
// + F16.3-E (0066), F1-09 (0067), F2-05 (0068), F7-01 (0069/0070),
// M115-Grants (0071/0072), Derive-Cap (0073), F2.5-Write-Vertrag (0074),
// F3.1-Planungsmodi (0075), F2.8b Signatur->Won (0076)
// => 77 Migrationen (idx 0..76).
const TOTAL_MIGRATION_COUNT = 77;
const PRE_M111A_HISTORY_SHA256 =
  "c8e46bb9d71fe5f24b8e6075f45feb41b755b40b023dce0d4c8a08accab2af7e";

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function historyHashThrough(maxIndex: number): string {
  const material = migrationJournal().entries
    .filter((entry) => entry.idx <= maxIndex)
    .map((entry) => (
      `${entry.idx}\0${entry.when}\0${entry.tag}\0${readFileSync(resolve("drizzle", `${entry.tag}.sql`), "utf8")}`
    ))
    .join("\0");
  return createHash("sha256").update(material).digest("hex");
}

function migrationPrefixThrough(
  maxIndex: number,
  whenOverrides: ReadonlyMap<number, number> = new Map(),
): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m111a-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });

  const journal = migrationJournal();
  const entries = journal.entries
    .filter((entry) => entry.idx <= maxIndex)
    .map((entry) => ({
      ...entry,
      when: whenOverrides.get(entry.idx) ?? entry.when,
    }));
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

async function tenantQuery<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  pool: Pool,
  workspaceId: string,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    const result = await client.query<Row>(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedLegacyProjects(
  pool: Pool,
  projects: LegacyProject[],
): Promise<string> {
  const workspaceId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();

  await tenantQuery(
    pool,
    workspaceId,
    "insert into workspace (id, name) values ($1::uuid, 'M1-11a Upgrade-Bestand')",
    [workspaceId],
  );
  await tenantQuery(pool, workspaceId, `
    insert into contact (
      id, workspace_id, display_name, email_primary, email_normalized
    ) values ($1::uuid, $2::uuid, 'M1-11a Bestand', $3, $3)
  `, [contactId, workspaceId, `m111a-${contactId}@example.test`]);
  await tenantQuery(pool, workspaceId, `
    insert into site (id, workspace_id, contact_id, label)
    values ($1::uuid, $2::uuid, $3::uuid, 'M1-11a Bestandsstandort')
  `, [siteId, workspaceId, contactId]);

  const lane = await tenantQuery<{
    board_id: string;
    column_id: string;
    [key: string]: unknown;
  }>(pool, workspaceId, `
    select board.id as board_id, column_row.id as column_id
      from kanban_board board
      join kanban_column column_row
        on column_row.workspace_id = board.workspace_id
       and column_row.board_id = board.id
     where board.workspace_id = $1::uuid
       and board.scope = 'residential'
       and board.is_default = true
       and board.archived_at is null
       and column_row.is_intake = true
       and column_row.archived_at is null
  `, [workspaceId]);
  const boardId = lane.rows[0]?.board_id;
  const columnId = lane.rows[0]?.column_id;
  if (!boardId || !columnId) {
    throw new Error("Default-Anfrageboard fuer Upgrade-Fixture fehlt.");
  }

  for (const project of projects) {
    await tenantQuery(pool, workspaceId, `
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key,
        created_at, updated_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        $6::uuid, $7, 'request', $8, 'm111a-upgrade-test',
        '2026-08-01T00:00:00.000Z'::timestamptz, $9::timestamptz
      )
    `, [
      project.id,
      workspaceId,
      contactId,
      siteId,
      boardId,
      columnId,
      `Bestandsprojekt ${project.outcome}`,
      project.outcome,
      project.updatedAt,
    ]);
  }

  return workspaceId;
}

async function migrationCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from drizzle.__drizzle_migrations",
  );
  return result.rows[0]!.count;
}

async function appliedMigrationTimestamps(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ created_at: string }>(`
    select created_at::text
      from drizzle.__drizzle_migrations
     order by id
  `);
  return result.rows.map((row) => row.created_at);
}

async function migrationMarker(
  pool: Pool,
  hash: string,
): Promise<Array<{ created_at: string; hash: string }>> {
  const result = await pool.query<{ created_at: string; hash: string }>(`
    select created_at::text, hash
      from drizzle.__drizzle_migrations
     where hash = $1
     order by id
  `, [hash]);
  return result.rows;
}

async function canonicalizeAndVerifyMigrationHistory(pool: Pool): Promise<{
  correction: Awaited<
    ReturnType<typeof canonicalizeLegacySnapshotV3MigrationTimestamp>
  >;
  appliedCount: number;
}> {
  const client: PoolClient = await pool.connect();
  let locked = false;
  try {
    await client.query("select pg_catalog.pg_advisory_lock(1701734769, 3)");
    locked = true;
    await client.query("begin");
    try {
      const correction =
        await canonicalizeLegacySnapshotV3MigrationTimestamp(client);
      const verified = await verifyAppliedMigrationHistory(client);
      await client.query("commit");
      return { correction, appliedCount: verified.appliedCount };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    if (locked) {
      await client.query(
        "select pg_catalog.pg_advisory_unlock(1701734769, 3)",
      );
    }
    client.release();
  }
}

async function offerVariantRevisionVersionConstraint(pool: Pool): Promise<{
  definition: string;
  validated: boolean;
}> {
  const result = await pool.query<{ definition: string; validated: boolean }>(`
    select pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition,
           constraint_row.convalidated as validated
      from pg_catalog.pg_constraint constraint_row
     where constraint_row.conrelid = 'public.offer_variant_revision'::regclass
       and constraint_row.conname = 'offer_variant_revision_version_ck'
  `);
  const constraint = result.rows[0];
  if (!constraint || result.rows.length !== 1) {
    throw new Error("offer_variant_revision_version_ck fehlt oder ist mehrdeutig.");
  }
  return constraint;
}

async function closeUpgradeDatabase(
  pool: Pool,
  embedded: Awaited<ReturnType<typeof startEmbeddedPostgres>>,
): Promise<void> {
  await endPoolsAndStopEmbeddedPostgres(
    [pool],
    embedded,
    "Migrations-Upgrade-Teardown fehlgeschlagen",
  );
}

async function projectForceRls(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ forced: boolean }>(`
    select relforcerowsecurity as forced
      from pg_catalog.pg_class
     where oid = 'public.project'::regclass
  `);
  return result.rows[0]!.forced;
}

async function m111aSchemaRolledBack(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ rolled_back: boolean }>(`
    select pg_catalog.to_regclass('public.project_loss_reason') is null
       and not exists (
         select 1
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'project'
            and column_name = 'closed_at'
       ) as rolled_back
  `);
  return result.rows[0]!.rolled_back;
}

function rejectionText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string") messages.push(candidate.message);
    current = candidate.cause;
  }
  return messages.join("\n");
}

async function rejected(work: Promise<unknown>): Promise<unknown> {
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeDefined();
  return error;
}

describe.sequential("M1-11a Project-Outcome Migration-Upgrade", () => {
  it("pinnt die unveraenderte Historie 0000 bis 0038 und deklariert 0039 additiv", () => {
    const journal = migrationJournal();
    expect(
      journal.entries.slice(0, M111A_MIGRATION_INDEX + 1).map((entry) => entry.idx),
    ).toEqual(Array.from({ length: M111A_MIGRATION_INDEX + 1 }, (_, index) => index));
    expect(historyHashThrough(PRE_M111A_MIGRATION_INDEX)).toBe(
      PRE_M111A_HISTORY_SHA256,
    );
    expect(journal.entries[M111A_MIGRATION_INDEX]?.tag).toBe(
      "0039_m1_11a_project_outcome",
    );
  });

  it("migriert einen echten 0065-Bestand lueckenlos bis HEAD samt v3/v4-Constraint", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;

    try {
      const journal = migrationJournal();
      expect(journal.entries).toHaveLength(TOTAL_MIGRATION_COUNT);
      expect(journal.entries.map((entry) => entry.idx)).toEqual(
        Array.from({ length: TOTAL_MIGRATION_COUNT }, (_, index) => index),
      );
      expect(journal.entries[SNAPSHOT_V3_MIGRATION_INDEX]).toMatchObject({
        idx: SNAPSHOT_V3_MIGRATION_INDEX,
        tag: "0066_f16_03_snapshot_v3_check",
        when: SNAPSHOT_V3_MIGRATION_TIMESTAMP,
      });
      expect(journal.entries.at(-1)).toMatchObject({
        idx: 76,
        tag: "0076_f2_08b_signature_acceptance_won",
      });
      expect(SNAPSHOT_V3_MIGRATION_TIMESTAMP).toBe(
        journal.entries[PRE_SNAPSHOT_V3_MIGRATION_INDEX]!.when + 1,
      );
      for (const [index, entry] of journal.entries.entries()) {
        if (index === 0) continue;
        expect(
          entry.when,
          `Migration ${entry.idx} muss strikt nach Migration ${index - 1} liegen.`,
        ).toBeGreaterThan(journal.entries[index - 1]!.when);
      }

      prefix = migrationPrefixThrough(PRE_SNAPSHOT_V3_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      expect(await migrationCount(pool)).toBe(PRE_SNAPSHOT_V3_MIGRATION_INDEX + 1);
      expect(await appliedMigrationTimestamps(pool)).toEqual(
        journal.entries
          .slice(0, PRE_SNAPSHOT_V3_MIGRATION_INDEX + 1)
          .map((entry) => String(entry.when)),
      );
      expect((await offerVariantRevisionVersionConstraint(pool)).definition)
        .not.toContain("offer-variant-snapshot.v3");

      const preflight = await canonicalizeAndVerifyMigrationHistory(pool);
      expect(preflight).toEqual({
        correction: null,
        appliedCount: PRE_SNAPSHOT_V3_MIGRATION_INDEX + 1,
      });
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);
      expect(await appliedMigrationTimestamps(pool)).toEqual(
        journal.entries.map((entry) => String(entry.when)),
      );
      const v3Constraint = await offerVariantRevisionVersionConstraint(pool);
      expect(v3Constraint.validated).toBe(true);
      expect(v3Constraint.definition).toContain("offer-variant-snapshot.v1");
      expect(v3Constraint.definition).toContain("offer-variant-snapshot.v2");
      expect(v3Constraint.definition).toContain("offer-variant-snapshot.v3");
      expect(v3Constraint.definition).toContain("offer-variant-snapshot.v4");
      expect(v3Constraint.definition).toContain("offer-jcs.v1");
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("kanonisiert einen exakt unter altem 0066-Marker beendeten Bestand", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;

    try {
      prefix = migrationPrefixThrough(
        SNAPSHOT_V3_MIGRATION_INDEX,
        new Map([[
          SNAPSHOT_V3_MIGRATION_INDEX,
          LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP,
        ]]),
      );
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      expect(await migrationCount(pool)).toBe(SNAPSHOT_V3_MIGRATION_INDEX + 1);
      expect(await migrationMarker(pool, SNAPSHOT_V3_MIGRATION_SHA256)).toEqual([{
        created_at: String(LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        hash: SNAPSHOT_V3_MIGRATION_SHA256,
      }]);

      // Selbst am bekannten alten Timestamp darf ein fremder Hash niemals
      // repariert werden. Der gesamte Preflight rollt ohne Teilkorrektur ab.
      await pool.query(`
        update drizzle.__drizzle_migrations
           set hash = repeat('0', 64)
         where created_at = $1::bigint
      `, [LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP]);
      await expect(canonicalizeAndVerifyMigrationHistory(pool)).rejects.toThrow(
        "Angewandte Migrationen müssen ein lückenloses, unverändertes Präfix",
      );
      const drifted = await pool.query<{ created_at: string; hash: string }>(`
        select created_at::text, hash
          from drizzle.__drizzle_migrations
         where created_at = $1::bigint
      `, [LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP]);
      expect(drifted.rows).toEqual([{
        created_at: String(LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        hash: "0".repeat(64),
      }]);
      await pool.query(`
        update drizzle.__drizzle_migrations
           set hash = $1
         where created_at = $2::bigint
      `, [SNAPSHOT_V3_MIGRATION_SHA256, LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP]);

      const preflight = await canonicalizeAndVerifyMigrationHistory(pool);
      expect(preflight).toMatchObject({
        correction: {
          action: "timestamp_corrected",
          migrationIndex: SNAPSHOT_V3_MIGRATION_INDEX,
          hash: SNAPSHOT_V3_MIGRATION_SHA256,
          fromCreatedAt: String(LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP),
          toCreatedAt: String(SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        },
        appliedCount: SNAPSHOT_V3_MIGRATION_INDEX + 1,
      });
      expect(await migrationMarker(pool, SNAPSHOT_V3_MIGRATION_SHA256)).toEqual([{
        created_at: String(SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        hash: SNAPSHOT_V3_MIGRATION_SHA256,
      }]);

      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);
      expect((await offerVariantRevisionVersionConstraint(pool)).definition)
        .toContain("offer-variant-snapshot.v3");
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("kanonisiert alten 0066 samt bereits angewendeter spaeterer Historie", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let legacyHead: string | undefined;

    try {
      legacyHead = migrationPrefixThrough(
        TOTAL_MIGRATION_COUNT - 1,
        new Map([[
          SNAPSHOT_V3_MIGRATION_INDEX,
          LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP,
        ]]),
      );
      // Ohne vorhandenen DB-Marker führt Drizzle den ganzen Ordner aus; damit
      // wurde der alte 0066-Marker trotz seiner Nicht-Monotonie gespeichert.
      await migrate(drizzle(pool), { migrationsFolder: legacyHead });
      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);

      const preflight = await canonicalizeAndVerifyMigrationHistory(pool);
      expect(preflight).toMatchObject({
        correction: {
          action: "timestamp_corrected",
          migrationIndex: SNAPSHOT_V3_MIGRATION_INDEX,
          fromCreatedAt: String(LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP),
          toCreatedAt: String(SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        },
        appliedCount: TOTAL_MIGRATION_COUNT,
      });
      expect(await migrationMarker(pool, SNAPSHOT_V3_MIGRATION_SHA256)).toEqual([{
        created_at: String(SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        hash: SNAPSHOT_V3_MIGRATION_SHA256,
      }]);
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      if (legacyHead) rmSync(legacyHead, { recursive: true, force: true });
    }
  }, 120_000);

  it("replayt exakt 0066, wenn das alte Journal es vor spaeteren Migrationen uebersprang", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    const temporaryFolders: string[] = [];

    try {
      const through65 = migrationPrefixThrough(PRE_SNAPSHOT_V3_MIGRATION_INDEX);
      temporaryFolders.push(through65);
      await migrate(drizzle(pool), { migrationsFolder: through65 });

      const legacyHead = migrationPrefixThrough(
        // Der historisch mögliche defekte Kopf endet bei 0074. Ein regulärer
        // 0075-Lauf passiert den Preflight zuerst und kann 0066 daher nicht
        // mehr überspringen oder den fehlenden v3-Constraint verdecken.
        PRE_F301_MIGRATION_INDEX,
        new Map([[
          SNAPSHOT_V3_MIGRATION_INDEX,
          LEGACY_SNAPSHOT_V3_MIGRATION_TIMESTAMP,
        ]]),
      );
      temporaryFolders.push(legacyHead);
      await migrate(drizzle(pool), { migrationsFolder: legacyHead });
      expect(await migrationCount(pool)).toBe(PRE_F301_MIGRATION_INDEX);
      expect(await migrationMarker(pool, SNAPSHOT_V3_MIGRATION_SHA256)).toEqual([]);
      expect((await offerVariantRevisionVersionConstraint(pool)).definition)
        .not.toContain("offer-variant-snapshot.v3");

      const preflight = await canonicalizeAndVerifyMigrationHistory(pool);
      expect(preflight).toMatchObject({
        correction: {
          action: "skipped_migration_replayed",
          migrationIndex: SNAPSHOT_V3_MIGRATION_INDEX,
          hash: SNAPSHOT_V3_MIGRATION_SHA256,
          toCreatedAt: String(SNAPSHOT_V3_MIGRATION_TIMESTAMP),
          previousLastMigrationIndex: PRE_F301_MIGRATION_INDEX,
        },
        appliedCount: PRE_F301_MIGRATION_INDEX + 1,
      });
      expect(await migrationMarker(pool, SNAPSHOT_V3_MIGRATION_SHA256)).toEqual([{
        created_at: String(SNAPSHOT_V3_MIGRATION_TIMESTAMP),
        hash: SNAPSHOT_V3_MIGRATION_SHA256,
      }]);
      const v3Constraint = await offerVariantRevisionVersionConstraint(pool);
      expect(v3Constraint.validated).toBe(true);
      expect(v3Constraint.definition).toContain("offer-variant-snapshot.v3");

      // Der normale Drizzle-Lauf bleibt danach ein No-op; kein zweiter Marker.
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);
      expect(await migrationMarker(pool, SNAPSHOT_V3_MIGRATION_SHA256)).toHaveLength(1);
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      for (const folder of temporaryFolders) {
        rmSync(folder, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("backfillt befuellte Won/Cannot-Fulfill-Projekte exakt und stellt FORCE RLS wieder her", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    const wonId = randomUUID();
    const cannotId = randomUUID();
    const openId = randomUUID();
    const wonAt = "2026-08-20T10:15:30.000Z";
    const cannotAt = "2026-08-21T11:16:31.000Z";

    try {
      prefix = migrationPrefixThrough(PRE_M111A_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = await seedLegacyProjects(pool, [
        { id: wonId, outcome: "won", updatedAt: wonAt },
        { id: cannotId, outcome: "cannot_fulfill", updatedAt: cannotAt },
        { id: openId, outcome: "open", updatedAt: "2026-08-22T12:17:32.000Z" },
      ]);

      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      const upgraded = await tenantQuery<{
        id: string;
        outcome: string;
        outcome_revision: number;
        closed_at: Date | null;
        exact_backfill: boolean;
        finite_close: boolean | null;
        [key: string]: unknown;
      }>(pool, workspaceId, `
        select id, outcome, outcome_revision, closed_at,
               closed_at = updated_at as exact_backfill,
               case when closed_at is null then null
                    else pg_catalog.isfinite(closed_at) end as finite_close
          from project
         where id = any($1::uuid[])
         order by outcome, id
      `, [[wonId, cannotId, openId]]);
      const byId = new Map(upgraded.rows.map((row) => [row.id, row]));
      expect(byId.get(wonId)).toMatchObject({
        outcome: "won",
        outcome_revision: 0,
        exact_backfill: true,
        finite_close: true,
      });
      expect(byId.get(wonId)?.closed_at?.toISOString()).toBe(wonAt);
      expect(byId.get(cannotId)).toMatchObject({
        outcome: "cannot_fulfill",
        outcome_revision: 0,
        exact_backfill: true,
        finite_close: true,
      });
      expect(byId.get(cannotId)?.closed_at?.toISOString()).toBe(cannotAt);
      expect(byId.get(openId)).toMatchObject({
        outcome: "open",
        outcome_revision: 0,
        closed_at: null,
        exact_backfill: null,
        finite_close: null,
      });
      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);
      expect(await projectForceRls(pool)).toBe(true);
      const reasonRls = await pool.query<{
        enabled: boolean;
        forced: boolean;
      }>(`
        select relrowsecurity as enabled, relforcerowsecurity as forced
          from pg_catalog.pg_class
         where oid = 'public.project_loss_reason'::regclass
      `);
      expect(reasonRls.rows).toEqual([{ enabled: true, forced: true }]);
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("bricht bei bestehendem Lost fail-closed ab und laesst nach Reparatur einen sicheren Retry zu", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    const projectId = randomUUID();

    try {
      prefix = migrationPrefixThrough(PRE_M111A_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = await seedLegacyProjects(pool, [{
        id: projectId,
        outcome: "lost",
        updatedAt: "2026-08-23T13:18:33.000Z",
      }]);

      const error = await rejected(
        migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") }),
      );
      expect(rejectionText(error)).toContain(
        "M1-11a kann bestehende Lost-Projects ohne strukturierten Grund nicht migrieren",
      );
      expect(await migrationCount(pool)).toBe(PRE_M111A_MIGRATION_INDEX + 1);
      expect(await m111aSchemaRolledBack(pool)).toBe(true);
      expect(await projectForceRls(pool)).toBe(true);

      await tenantQuery(
        pool,
        workspaceId,
        "update project set outcome = 'open' where id = $1::uuid",
        [projectId],
      );
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      const repaired = await tenantQuery<{
        outcome: string;
        outcome_revision: number;
        closed_at: Date | null;
        [key: string]: unknown;
      }>(pool, workspaceId, `
        select outcome, outcome_revision, closed_at
          from project
         where id = $1::uuid
      `, [projectId]);
      expect(repaired.rows).toEqual([{
        outcome: "open",
        outcome_revision: 0,
        closed_at: null,
      }]);
      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);
      expect(await projectForceRls(pool)).toBe(true);
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("bricht bei nicht-endlichem updated_at fail-closed ab und backfillt nach Reparatur beim Retry", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    const projectId = randomUUID();
    const repairedAt = "2026-08-24T14:19:34.000Z";

    try {
      prefix = migrationPrefixThrough(PRE_M111A_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const workspaceId = await seedLegacyProjects(pool, [{
        id: projectId,
        outcome: "won",
        updatedAt: "infinity",
      }]);

      const error = await rejected(
        migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") }),
      );
      expect(rejectionText(error)).toContain(
        "M1-11a kann geschlossene Bestandsprojects mit nicht-endlichem updated_at nicht migrieren",
      );
      expect(await migrationCount(pool)).toBe(PRE_M111A_MIGRATION_INDEX + 1);
      expect(await m111aSchemaRolledBack(pool)).toBe(true);
      expect(await projectForceRls(pool)).toBe(true);

      await tenantQuery(
        pool,
        workspaceId,
        "update project set updated_at = $2::timestamptz where id = $1::uuid",
        [projectId, repairedAt],
      );
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      const repaired = await tenantQuery<{
        outcome: string;
        outcome_revision: number;
        closed_at: Date;
        exact_backfill: boolean;
        [key: string]: unknown;
      }>(pool, workspaceId, `
        select outcome, outcome_revision, closed_at,
               closed_at = updated_at as exact_backfill
          from project
         where id = $1::uuid
      `, [projectId]);
      expect(repaired.rows[0]).toMatchObject({
        outcome: "won",
        outcome_revision: 0,
        exact_backfill: true,
      });
      expect(repaired.rows[0]?.closed_at.toISOString()).toBe(repairedAt);
      expect(await migrationCount(pool)).toBe(TOTAL_MIGRATION_COUNT);
      expect(await projectForceRls(pool)).toBe(true);
    } finally {
      await closeUpgradeDatabase(pool, embedded);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);
});
