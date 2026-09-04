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
import { Pool, type QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type LegacyProject = {
  id: string;
  outcome: "open" | "won" | "lost" | "cannot_fulfill";
  updatedAt: string;
};

const PRE_M111A_MIGRATION_INDEX = 38;
const M111A_MIGRATION_INDEX = 39;
// Integrierte Kette: … → M2-04 (0044) → M3-00 (0045) → M3-01 (0046) →
// F4.6 (0047) → v5-Leadquelle (0048); Gesamtbestand: 49 Migrationen (idx 0..48).
// wave-02-Integration: 0055 (F2.2) + 0056 (F10.1) => 57 Migrationen (idx 0..56).
// 0055-0056 + Welle-03-Nachzug 0057-0060 => 61 Migrationen (idx 0..60).
const TOTAL_MIGRATION_COUNT = 61;
const PRE_M111A_HISTORY_SHA256 =
  "7b4df321a21420caee21fcc73dcdd2b1aa93fae91d97fe1bb1d979b6d2284d24";

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function historyHashThrough(maxIndex: number): string {
  const material = migrationJournal().entries
    .filter((entry) => entry.idx <= maxIndex)
    .map((entry) => (
      `${entry.idx}\0${entry.tag}\0${readFileSync(resolve("drizzle", `${entry.tag}.sql`), "utf8")}`
    ))
    .join("\0");
  return createHash("sha256").update(material).digest("hex");
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m111a-upgrade-"));
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

  it("backfillt befuellte Won/Cannot-Fulfill-Projekte exakt und stellt FORCE RLS wieder her", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = new Pool({ connectionString: embedded.url, max: 2 });
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
      await pool.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("bricht bei bestehendem Lost fail-closed ab und laesst nach Reparatur einen sicheren Retry zu", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = new Pool({ connectionString: embedded.url, max: 2 });
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
      await pool.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("bricht bei nicht-endlichem updated_at fail-closed ab und backfillt nach Reparatur beim Retry", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = new Pool({ connectionString: embedded.url, max: 2 });
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
      await pool.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);
});
