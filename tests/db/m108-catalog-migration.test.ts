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
import { expect, it } from "vitest";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

const M1_07_LAST_MIGRATION_INDEX = 29;
const M1_08_MIGRATION_INDEX = 30;
const M1_07_HISTORY_SHA256 =
  "c2b98f91bc6e5dff61eaf5b11a73bf572f2b7167c47a4449e78636d1069449b4";
const CATALOG_TABLES = [
  "catalog_component",
  "catalog_component_revision",
  "project_catalog_resolution",
  "project_catalog_resolution_line",
] as const;

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function prefixHistorySha256(maxIndex: number): string {
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
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m1-08-upgrade-"));
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

async function tenantQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
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

it("deklariert M1-08 als additive 0030 und pinnt 0000 bis 0029 bytegenau", () => {
  const journal = migrationJournal();
  expect(journal.entries.map((entry) => entry.idx)).toEqual(
    Array.from({ length: M1_08_MIGRATION_INDEX + 1 }, (_, index) => index),
  );
  expect(prefixHistorySha256(M1_07_LAST_MIGRATION_INDEX)).toBe(M1_07_HISTORY_SHA256);
  expect(journal.entries[M1_08_MIGRATION_INDEX]?.tag).toBe("0030_m1_08_catalog");
  const migration = readFileSync(resolve("drizzle/0030_m1_08_catalog.sql"), "utf8");
  expect(migration).not.toMatch(/insert\s+into\s+public\.catalog_component\b/iu);
  expect(migration).not.toMatch(/reonic|vault/iu);
}, 10_000);

it("migriert einen befuellten 0029-Bestand ohne Produkte, Preise oder Aufloesungen zu erfinden", async () => {
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  let prefix: string | undefined;
  const workspaceId = randomUUID();
  try {
    prefix = migrationPrefixThrough(M1_07_LAST_MIGRATION_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: prefix });
    await tenantQuery(
      pool,
      workspaceId,
      "insert into workspace (id, name) values ($1::uuid, 'M1-08 Upgrade-Bestand')",
      [workspaceId],
    );
    const before = await tenantQuery<{ id: string; name: string }>(
      pool,
      workspaceId,
      "select id, name from workspace where id = $1::uuid",
      [workspaceId],
    );

    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const after = await tenantQuery<{ id: string; name: string }>(
      pool,
      workspaceId,
      "select id, name from workspace where id = $1::uuid",
      [workspaceId],
    );
    expect(after.rows).toEqual(before.rows);
    const empty = await tenantQuery<{
      components: number;
      revisions: number;
      resolutions: number;
      lines: number;
    }>(pool, workspaceId, `
      select (select count(*)::int from catalog_component) as components,
             (select count(*)::int from catalog_component_revision) as revisions,
             (select count(*)::int from project_catalog_resolution) as resolutions,
             (select count(*)::int from project_catalog_resolution_line) as lines
    `);
    expect(empty.rows).toEqual([{
      components: 0,
      revisions: 0,
      resolutions: 0,
      lines: 0,
    }]);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  }
}, 120_000);

it("installiert das Fresh-Schema mit Cascades, RLS und idempotenter Historie", async () => {
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    const relations = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname
    `, [CATALOG_TABLES]);
    expect(relations.rows).toEqual([...CATALOG_TABLES].sort().map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));

    const cascades = await pool.query<{ constraint_name: string }>(`
      select constraint_name
        from information_schema.referential_constraints
       where constraint_schema = 'public'
         and constraint_name = any($1::text[])
         and delete_rule = 'CASCADE'
       order by constraint_name
    `, [[
      "project_catalog_resolution_calculation_fk",
      "project_catalog_resolution_project_site_fk",
      "project_catalog_resolution_requirement_fk",
      "project_catalog_resolution_line_resolution_project_fk",
    ]]);
    expect(cascades.rows.map((row) => row.constraint_name)).toEqual([
      "project_catalog_resolution_calculation_fk",
      "project_catalog_resolution_line_resolution_project_fk",
      "project_catalog_resolution_project_site_fk",
      "project_catalog_resolution_requirement_fk",
    ]);

    const beforeRerun = await pool.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    const afterRerun = await pool.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    expect(afterRerun.rows).toEqual(beforeRerun.rows);
    expect(afterRerun.rows[0]?.n).toBe(M1_08_MIGRATION_INDEX + 1);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
  }
}, 120_000);
