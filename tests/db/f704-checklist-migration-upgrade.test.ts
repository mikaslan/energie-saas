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
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { startEmbeddedPostgres } from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type LegacyFixture = {
  workspaceId: string;
  projectId: string;
  checklistId: string;
  actorId: string;
};

type ChecklistRow = QueryResultRow & {
  id: string;
  phase: string;
  title: string;
  blocks: Array<Record<string, unknown>>;
};

const PRE_F704_MIGRATION_INDEX = 76;
const F704_MIGRATION_INDEX = 77;

const LEGACY_BLOCKS = [
  {
    name: "Dach",
    position: 7,
    segments: [
      {
        name: "Vorbereitung",
        position: 3,
        items: [
          { title: "Foto Zähler", done: true },
          { title: "Potentialausgleich", done: false },
        ],
      },
      { name: "Montage", position: 9, items: [] },
    ],
  },
  {
    name: "Abnahme",
    position: 11,
    segments: [
      {
        name: "Messungen",
        position: 4,
        items: [{ title: "VDE-Protokoll", done: true }],
      },
    ],
  },
] as const;

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-f704-upgrade-"));
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
    const value = await callback(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedLegacyChecklist(
  pool: Pool,
  blocks: unknown,
): Promise<LegacyFixture> {
  const fixture: LegacyFixture = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    checklistId: randomUUID(),
    actorId: randomUUID(),
  };
  const contactId = randomUUID();
  const siteId = randomUUID();

  await tenantTransaction(pool, fixture.workspaceId, async (client) => {
    await client.query(
      "insert into workspace (id, name) values ($1::uuid, 'F7.4 Legacy Upgrade')",
      [fixture.workspaceId],
    );
    await client.query(
      "insert into user_identity (id, email) values ($1::uuid, $2)",
      [fixture.actorId, `${fixture.actorId}@f704.test`],
    );
    await client.query(`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized
      ) values ($1::uuid, $2::uuid, 'F7.4 Legacy', 'F7.4', 'Legacy', $3, $3)
    `, [contactId, fixture.workspaceId, `${contactId}@f704.test`]);
    await client.query(`
      insert into site (id, workspace_id, contact_id, label)
      values ($1::uuid, $2::uuid, $3::uuid, 'F7.4 Legacy Site')
    `, [siteId, fixture.workspaceId, contactId]);
    const project = await client.query(`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             board.id, intake_column.id, 'F7.4 Legacy Project', 'f704-upgrade'
        from kanban_board as board
        join kanban_column as intake_column
          on intake_column.workspace_id = board.workspace_id
         and intake_column.board_id = board.id
         and intake_column.is_intake = true
         and intake_column.archived_at is null
       where board.workspace_id = $2::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
      returning id
    `, [fixture.projectId, fixture.workspaceId, contactId, siteId]);
    if (project.rowCount !== 1) throw new Error("F7.4 Legacy-Projekt fehlt.");
    await client.query(`
      insert into project_checklist (
        id, workspace_id, project_id, version, blocks, created_by
      ) values ($1::uuid, $2::uuid, $3::uuid, 4, $4::jsonb, $5::uuid)
    `, [
      fixture.checklistId,
      fixture.workspaceId,
      fixture.projectId,
      JSON.stringify(blocks),
      fixture.actorId,
    ]);
  });
  return fixture;
}

function expectedStableId(checklistId: string, treePath: string): string {
  const hash = createHash("md5").update(`${checklistId}:${treePath}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function expectedV2Blocks(checklistId: string): Array<Record<string, unknown>> {
  return [
    {
      id: expectedStableId(checklistId, "block:1"),
      name: "Dach",
      position: 7,
      visible: true,
      segments: [
        {
          id: expectedStableId(checklistId, "block:1:segment:1"),
          name: "Vorbereitung",
          position: 3,
          visible: true,
          items: [
            {
              id: expectedStableId(checklistId, "block:1:segment:1:item:1"),
              title: "Foto Zähler",
              done: true,
              required: false,
              visible: true,
            },
            {
              id: expectedStableId(checklistId, "block:1:segment:1:item:2"),
              title: "Potentialausgleich",
              done: false,
              required: false,
              visible: true,
            },
          ],
        },
        {
          id: expectedStableId(checklistId, "block:1:segment:2"),
          name: "Montage",
          position: 9,
          visible: true,
          items: [],
        },
      ],
    },
    {
      id: expectedStableId(checklistId, "block:2"),
      name: "Abnahme",
      position: 11,
      visible: true,
      segments: [
        {
          id: expectedStableId(checklistId, "block:2:segment:1"),
          name: "Messungen",
          position: 4,
          visible: true,
          items: [
            {
              id: expectedStableId(checklistId, "block:2:segment:1:item:1"),
              title: "VDE-Protokoll",
              done: true,
              required: false,
              visible: true,
            },
          ],
        },
      ],
    },
  ];
}

function collectTreeIds(blocks: Array<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    ids.push(String(block.id));
    for (const segment of block.segments as Array<Record<string, unknown>>) {
      ids.push(String(segment.id));
      for (const item of segment.items as Array<Record<string, unknown>>) {
        ids.push(String(item.id));
      }
    }
  }
  return ids;
}

async function migrationCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::integer as count from drizzle.__drizzle_migrations",
  );
  return result.rows[0]?.count ?? -1;
}

describe("F7.4 Checklisten-Migrationsupgrade", () => {
  it("migriert F7.2-Bestand verlustfrei auf stabile v2-Identitaeten und mehrere Checklisten", async () => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 2 });
    let prefix: string | undefined;
    try {
      const journal = migrationJournal();
      expect(journal.entries[F704_MIGRATION_INDEX]?.tag).toBe(
        "0077_f7_04_segment_completion",
      );
      prefix = migrationPrefixThrough(PRE_F704_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      expect(await migrationCount(pool)).toBe(PRE_F704_MIGRATION_INDEX + 1);

      const fixture = await seedLegacyChecklist(pool, LEGACY_BLOCKS);
      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
      expect(await migrationCount(pool)).toBe(journal.entries.length);

      const upgraded = await tenantTransaction(
        pool,
        fixture.workspaceId,
        async (client) => client.query<ChecklistRow>(`
          select id, phase, title, blocks
            from project_checklist
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.checklistId]),
      );
      expect(upgraded.rows).toHaveLength(1);
      expect(upgraded.rows[0]).toEqual({
        id: fixture.checklistId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        blocks: expectedV2Blocks(fixture.checklistId),
      });
      const ids = collectTreeIds(upgraded.rows[0]!.blocks);
      expect(ids).toHaveLength(8);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);

      const stableRead = await tenantTransaction(
        pool,
        fixture.workspaceId,
        (client) => client.query<{ blocks: Array<Record<string, unknown>> }>(`
          select blocks from project_checklist
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.checklistId]),
      );
      expect(stableRead.rows[0]?.blocks).toEqual(upgraded.rows[0]!.blocks);

      const schemaProof = await pool.query<{
        oldConstraint: string | null;
        oldIndex: string | null;
        completionTable: string | null;
        v2Constraint: boolean;
      }>(`
        select to_regclass('public.project_checklist_ws_project_uq')::text
                 as "oldConstraint",
               to_regclass('public.project_checklist_ws_project_idx')::text
                 as "oldIndex",
               to_regclass('public.project_checklist_segment_completion')::text
                 as "completionTable",
               exists (
                 select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.project_checklist'::regclass
                    and conname = 'project_checklist_blocks_v2_ck'
               ) as "v2Constraint"
      `);
      expect(schemaProof.rows[0]).toEqual({
        oldConstraint: null,
        oldIndex: null,
        completionTable: "project_checklist_segment_completion",
        v2Constraint: true,
      });

      const secondChecklistId = randomUUID();
      await tenantTransaction(pool, fixture.workspaceId, async (client) => {
        await client.query(`
          insert into project_checklist (
            id, workspace_id, project_id, phase, title, blocks, created_by
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'site_documentation',
            'Zweite Baustellendokumentation', $4::jsonb, $5::uuid
          )
        `, [
          secondChecklistId,
          fixture.workspaceId,
          fixture.projectId,
          JSON.stringify([]),
          fixture.actorId,
        ]);
        const count = await client.query<{ count: number }>(`
          select count(*)::integer as count from project_checklist
           where workspace_id = $1::uuid and project_id = $2::uuid
        `, [fixture.workspaceId, fixture.projectId]);
        expect(count.rows[0]?.count).toBe(2);
      });

      const duplicateId = randomUUID();
      const invalidBlocks = [{
        id: duplicateId,
        name: "Block",
        position: 0,
        visible: true,
        segments: [{
          id: duplicateId,
          name: "Segment",
          position: 0,
          visible: true,
          items: [],
        }],
      }];
      await expect(tenantTransaction(pool, fixture.workspaceId, (client) =>
        client.query(`
          update project_checklist set blocks = $3::jsonb
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.checklistId, JSON.stringify(invalidBlocks)]),
      )).rejects.toMatchObject({ code: "23514" });
      await expect(tenantTransaction(pool, fixture.workspaceId, (client) =>
        client.query(`
          update project_checklist set phase = 'unknown'
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.checklistId]),
      )).rejects.toMatchObject({ code: "23514" });
      await expect(tenantTransaction(pool, fixture.workspaceId, (client) =>
        client.query(`
          update project_checklist set title = ' nicht-getrimmt '
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.checklistId]),
      )).rejects.toMatchObject({ code: "23514" });

      const firstSegmentId = ids[1]!;
      await tenantTransaction(pool, fixture.workspaceId, async (client) => {
        await client.query(`
          insert into project_checklist_segment_completion (
            workspace_id, checklist_id, segment_id, completed_by
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        `, [fixture.workspaceId, fixture.checklistId, firstSegmentId, fixture.actorId]);
      });
      await expect(tenantTransaction(pool, fixture.workspaceId, (client) =>
        client.query(`
          insert into project_checklist_segment_completion (
            workspace_id, checklist_id, segment_id, completed_by
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        `, [fixture.workspaceId, fixture.checklistId, firstSegmentId, fixture.actorId]),
      )).rejects.toMatchObject({ code: "23505" });
      await expect(tenantTransaction(pool, fixture.workspaceId, (client) =>
        client.query(`
          insert into project_checklist_segment_completion (
            workspace_id, checklist_id, segment_id, completed_by
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        `, [fixture.workspaceId, randomUUID(), randomUUID(), fixture.actorId]),
      )).rejects.toMatchObject({ code: "23503" });
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F7.4-Migrations-Upgrade-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    ["unbekanntem Legacy-Key", [{
      name: "Legacy",
      position: 0,
      segments: [],
      futureFlag: true,
    }]],
    ["explizit ungueltiger ID", [{
      id: "definitely-not-a-uuid",
      name: "Legacy",
      position: 0,
      segments: [],
    }]],
  ])("bleibt bei %s fail-closed und laesst 0077 unapplied", async (_label, blocks) => {
    const embedded = await startEmbeddedPostgres();
    const pool = createDrainTrackedPool({ connectionString: embedded.url, max: 1 });
    let prefix: string | undefined;
    try {
      prefix = migrationPrefixThrough(PRE_F704_MIGRATION_INDEX);
      await migrate(drizzle(pool), { migrationsFolder: prefix });
      const fixture = await seedLegacyChecklist(pool, blocks);

      await expect(migrate(drizzle(pool), {
        migrationsFolder: resolve("drizzle"),
      })).rejects.toMatchObject({ cause: { code: "23514" } });
      expect(await migrationCount(pool)).toBe(PRE_F704_MIGRATION_INDEX + 1);

      const rollbackProof = await pool.query<{
        completionTable: string | null;
        addedColumns: number;
      }>(`
        select to_regclass('public.project_checklist_segment_completion')::text
                 as "completionTable",
               (
                 select count(*)::integer
                   from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'project_checklist'
                    and column_name in ('phase', 'title')
               ) as "addedColumns"
      `);
      expect(rollbackProof.rows[0]).toEqual({ completionTable: null, addedColumns: 0 });
      const unchanged = await tenantTransaction(
        pool,
        fixture.workspaceId,
        (client) => client.query<{ blocks: unknown }>(`
          select blocks from project_checklist
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.checklistId]),
      );
      expect(unchanged.rows[0]?.blocks).toEqual(blocks);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F7.4-Fail-Closed-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);
});
