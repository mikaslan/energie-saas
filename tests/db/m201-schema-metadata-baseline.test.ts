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
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { expect, it } from "vitest";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

const PRE_BASELINE_INDEX = 30;
const BASELINE_INDEX = 31;
const PRE_BASELINE_HISTORY_SHA256 =
  "83c0513c367119531d78cecac1db734bee1150116454c058884defa438f2d697";

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
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m201-baseline-"));
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

async function schemaFingerprint(pool: Pool): Promise<string> {
  const result = await pool.query<{ fingerprint: string }>(`
    with objects as (
      select 'column'::text as kind,
             table_schema || '.' || table_name || '.' || column_name || ':' ||
             data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as value
        from information_schema.columns
       where table_schema = 'public'
      union all
      select 'constraint', conrelid::regclass::text || ':' || conname || ':' ||
             pg_catalog.pg_get_constraintdef(oid, true)
        from pg_catalog.pg_constraint
       where connamespace = 'public'::regnamespace
      union all
      select 'index', schemaname || '.' || indexname || ':' || indexdef
        from pg_catalog.pg_indexes
       where schemaname = 'public'
      union all
      select 'policy', schemaname || '.' || tablename || '.' || policyname || ':' ||
             permissive || ':' || roles::text || ':' || coalesce(qual, '') || ':' ||
             coalesce(with_check, '')
        from pg_catalog.pg_policies
       where schemaname = 'public'
    )
    select coalesce(jsonb_agg(jsonb_build_array(kind, value) order by kind, value), '[]')::text
             as fingerprint
      from objects
  `);
  return result.rows[0]?.fingerprint ?? "[]";
}

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
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

it("schliesst die fehlende Post-0024-Metadatenstrecke ohne alte SQL-Historie zu aendern", () => {
  const journal = migrationJournal();
  expect(journal.entries.slice(0, BASELINE_INDEX + 1).map((entry) => entry.idx)).toEqual(
    Array.from({ length: BASELINE_INDEX + 1 }, (_, index) => index),
  );
  expect(prefixHistorySha256(PRE_BASELINE_INDEX)).toBe(PRE_BASELINE_HISTORY_SHA256);
  expect(journal.entries[BASELINE_INDEX]?.tag).toBe("0031_schema_metadata_baseline");

  const sql = readFileSync(resolve("drizzle/0031_schema_metadata_baseline.sql"), "utf8");
  expect(sql).toMatch(/select\s+1\s*;/iu);
  expect(sql).not.toMatch(/\b(create|alter|drop|insert|update|delete|truncate)\b\s+(table|index|policy|role|into|from)?/iu);

  const snapshot = JSON.parse(
    readFileSync(resolve("drizzle/meta/0031_snapshot.json"), "utf8"),
  ) as { id: string; prevId: string; version: string; tables: Record<string, unknown> };
  const previous = JSON.parse(
    readFileSync(resolve("drizzle/meta/0024_snapshot.json"), "utf8"),
  ) as { id: string };
  expect(snapshot.version).toBe("7");
  expect(snapshot.prevId).toBe(previous.id);
  expect(snapshot.id).not.toBe(previous.id);
  expect(Object.keys(snapshot.tables)).toEqual(expect.arrayContaining([
    "public.catalog_component",
    "public.catalog_component_revision",
    "public.contact_legal_hold",
    "public.erasure_operation_locator",
    "public.erasure_tombstone",
    "public.project_catalog_resolution",
    "public.project_catalog_resolution_line",
  ]));
});

it("laesst ein echtes 0030-Upgrade fachlich und strukturell unveraendert", async () => {
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 2 });
  let prefix: string | undefined;
  let baselinePrefix: string | undefined;
  const workspaceId = randomUUID();
  try {
    prefix = migrationPrefixThrough(PRE_BASELINE_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: prefix });
    await tenantQuery(
      pool,
      workspaceId,
      "insert into workspace (id, name) values ($1::uuid, 'Metadaten-Baseline Bestand')",
      [workspaceId],
    );
    const beforeSchema = await schemaFingerprint(pool);
    const beforeData = await tenantQuery<{ name: string }>(
      pool,
      workspaceId,
      "select name from workspace where id = $1::uuid order by name",
      [workspaceId],
    );

    baselinePrefix = migrationPrefixThrough(BASELINE_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: baselinePrefix });

    expect(await schemaFingerprint(pool)).toBe(beforeSchema);
    expect((await tenantQuery<{ name: string }>(
      pool,
      workspaceId,
      "select name from workspace where id = $1::uuid order by name",
      [workspaceId],
    )).rows).toEqual(beforeData.rows);
    const applied = await pool.query<{ n: number }>(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    expect(applied.rows[0]?.n).toBe(BASELINE_INDEX + 1);
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
    if (baselinePrefix) rmSync(baselinePrefix, { recursive: true, force: true });
  }
}, 120_000);
