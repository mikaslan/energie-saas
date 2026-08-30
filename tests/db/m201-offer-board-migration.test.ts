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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type BoardRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  name: string;
  scope: string;
  is_default: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ColumnRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  board_id: string;
  name: string;
  column_type: string;
  position: number;
  color: string;
  is_intake: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type BoardSnapshot = {
  boards: BoardRow[];
  columns: ColumnRow[];
};

const PRE_M2_INDEX = 31;
const FIXED_CREATED_AT = "2026-08-29T10:00:00.000Z";
const FIXED_UPDATED_AT = "2026-08-29T11:00:00.000Z";
const FIXED_ARCHIVED_AT = "2026-08-29T12:00:00.000Z";

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m2-01-board-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(source, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
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

async function defaultResidentialBoardId(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(`
    select id
      from kanban_board
     where workspace_id = $1::uuid
       and scope = 'residential'
       and is_default = true
       and archived_at is null
  `, [workspaceId]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Default-Wohngebaeude-Board fehlt.");
  return id;
}

async function snapshotWorkspaceBoards(
  pool: Pool,
  workspaceId: string,
): Promise<BoardSnapshot> {
  return tenantTransaction(pool, workspaceId, async (client) => {
    const boards = await client.query<BoardRow>(`
      select id, workspace_id, name, scope, is_default, archived_at,
             created_at, updated_at
        from kanban_board
       where workspace_id = $1::uuid
       order by id
    `, [workspaceId]);
    const columns = await client.query<ColumnRow>(`
      select id, workspace_id, board_id, name, column_type, position, color,
             is_intake, archived_at, created_at, updated_at
        from kanban_column
       where workspace_id = $1::uuid
       order by id
    `, [workspaceId]);
    return { boards: boards.rows, columns: columns.rows };
  });
}

describe.sequential("M2-01 Angebotsspalte: Upgrade und Provisionierung", () => {
  let embedded: EmbeddedTestDatabase;
  let pool: Pool;
  let prefix: string | undefined;
  const backfillWorkspaceId = randomUUID();
  const configuredWorkspaceId = randomUUID();
  let backfillBoardId: string;
  let configuredBoardId: string;
  let beforeBackfillWorkspace: BoardSnapshot;
  let beforeConfiguredWorkspace: BoardSnapshot;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    pool = new Pool({ connectionString: embedded.url, max: 1 });
    prefix = migrationPrefixThrough(PRE_M2_INDEX);
    await migrate(drizzle(pool), { migrationsFolder: prefix });

    await tenantTransaction(pool, backfillWorkspaceId, async (client) => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, 'M2-01 Board-Backfill')",
        [backfillWorkspaceId],
      );
      backfillBoardId = await defaultResidentialBoardId(client, backfillWorkspaceId);

      await client.query(`
        insert into kanban_column (
          id, workspace_id, board_id, name, column_type, position, color,
          is_intake, archived_at, created_at, updated_at
        ) values
          ($1::uuid, $2::uuid, $3::uuid, 'Gewonnen', 'won', 7, 'green', false,
           null, $6::timestamptz, $7::timestamptz),
          ($4::uuid, $2::uuid, $3::uuid, 'Altes Angebot', 'offer', 88, 'amber', false,
           $8::timestamptz, $6::timestamptz, $7::timestamptz),
          ($5::uuid, $2::uuid, $3::uuid, 'Alt verloren', 'lost', 99, 'neutral', false,
           $8::timestamptz, $6::timestamptz, $7::timestamptz)
      `, [
        randomUUID(),
        backfillWorkspaceId,
        backfillBoardId,
        randomUUID(),
        randomUUID(),
        FIXED_CREATED_AT,
        FIXED_UPDATED_AT,
        FIXED_ARCHIVED_AT,
      ]);

      const commercialBoardId = randomUUID();
      const customBoardId = randomUUID();
      const archivedBoardId = randomUUID();
      await client.query(`
        insert into kanban_board (
          id, workspace_id, name, scope, is_default, archived_at,
          created_at, updated_at
        ) values
          ($1::uuid, $4::uuid, 'Gewerbe', 'commercial', true, null,
           $5::timestamptz, $6::timestamptz),
          ($2::uuid, $4::uuid, 'Eigener Privatprozess', 'residential', false, null,
           $5::timestamptz, $6::timestamptz),
          ($3::uuid, $4::uuid, 'Archivierter Privatprozess', 'residential', false,
           $7::timestamptz, $5::timestamptz, $6::timestamptz)
      `, [
        commercialBoardId,
        customBoardId,
        archivedBoardId,
        backfillWorkspaceId,
        FIXED_CREATED_AT,
        FIXED_UPDATED_AT,
        FIXED_ARCHIVED_AT,
      ]);
      await client.query(`
        insert into kanban_column (
          id, workspace_id, board_id, name, column_type, position, color,
          is_intake, created_at, updated_at
        ) values
          ($1::uuid, $7::uuid, $4::uuid, 'Gewerbe Eingang', 'lead', 1, 'blue', true,
           $8::timestamptz, $9::timestamptz),
          ($2::uuid, $7::uuid, $5::uuid, 'Eigener Eingang', 'lead', 1, 'amber', true,
           $8::timestamptz, $9::timestamptz),
          ($3::uuid, $7::uuid, $6::uuid, 'Archiv Eingang', 'lead', 1, 'neutral', true,
           $8::timestamptz, $9::timestamptz)
      `, [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        commercialBoardId,
        customBoardId,
        archivedBoardId,
        backfillWorkspaceId,
        FIXED_CREATED_AT,
        FIXED_UPDATED_AT,
      ]);
    });

    await tenantTransaction(pool, configuredWorkspaceId, async (client) => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, 'M2-01 Board-konfiguriert')",
        [configuredWorkspaceId],
      );
      configuredBoardId = await defaultResidentialBoardId(client, configuredWorkspaceId);
      await client.query(`
        insert into kanban_column (
          id, workspace_id, board_id, name, column_type, position, color,
          is_intake, created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'Eigene Angebotsphase', 'offer', 9,
          'green', false, $4::timestamptz, $5::timestamptz
        )
      `, [
        randomUUID(),
        configuredWorkspaceId,
        configuredBoardId,
        FIXED_CREATED_AT,
        FIXED_UPDATED_AT,
      ]);
    });

    beforeBackfillWorkspace = await snapshotWorkspaceBoards(pool, backfillWorkspaceId);
    beforeConfiguredWorkspace = await snapshotWorkspaceBoards(pool, configuredWorkspaceId);
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  });

  it("ergaenzt nur das aktive Default-Wohngebaeude-Board ohne aktive Angebotsspalte", async () => {
    const offers = await tenantTransaction(pool, backfillWorkspaceId, (client) =>
      client.query<Pick<ColumnRow, "name" | "column_type" | "position" | "color" | "is_intake" | "archived_at">>(`
        select name, column_type, position, color, is_intake, archived_at
          from kanban_column
         where workspace_id = $1::uuid
           and board_id = $2::uuid
           and column_type = 'offer'
           and archived_at is null
         order by position, id
      `, [backfillWorkspaceId, backfillBoardId]));
    expect(offers.rows).toEqual([{
      name: "Angebote",
      column_type: "offer",
      position: 8,
      color: "blue",
      is_intake: false,
      archived_at: null,
    }]);
  });

  it("laesst Residential-, Commercial-, Archiv- und Custom-Bestand bytegenau stehen", async () => {
    const afterBackfillWorkspace = await snapshotWorkspaceBoards(pool, backfillWorkspaceId);
    const originalColumnIds = new Set(beforeBackfillWorkspace.columns.map((row) => row.id));
    expect(afterBackfillWorkspace.boards).toEqual(beforeBackfillWorkspace.boards);
    expect(
      afterBackfillWorkspace.columns.filter((row) => originalColumnIds.has(row.id)),
    ).toEqual(beforeBackfillWorkspace.columns);

    const afterConfiguredWorkspace = await snapshotWorkspaceBoards(pool, configuredWorkspaceId);
    expect(afterConfiguredWorkspace).toEqual(beforeConfiguredWorkspace);
    const activeOffers = afterConfiguredWorkspace.columns.filter(
      (row) =>
        row.board_id === configuredBoardId &&
        row.column_type === "offer" &&
        row.archived_at === null,
    );
    expect(activeOffers).toHaveLength(1);

    const nonTargetBoards = afterBackfillWorkspace.boards.filter(
      (row) => row.id !== backfillBoardId,
    );
    for (const board of nonTargetBoards) {
      expect(
        afterBackfillWorkspace.columns.filter(
          (row) =>
            row.board_id === board.id &&
            row.column_type === "offer" &&
            row.archived_at === null,
        ),
      ).toEqual([]);
    }
  });

  it("provisioniert neue Workspaces mit exakt vier geordneten Residential-Spalten", async () => {
    const workspaceId = randomUUID();
    const provisioned = await tenantTransaction(pool, workspaceId, async (client) => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, 'M2-01 Neu-Provisionierung')",
        [workspaceId],
      );
      return client.query<{
        board_name: string;
        scope: string;
        is_default: boolean;
        column_name: string;
        column_type: string;
        position: number;
        color: string;
        is_intake: boolean;
      }>(`
        select board.name as board_name, board.scope, board.is_default,
               column_row.name as column_name, column_row.column_type,
               column_row.position, column_row.color, column_row.is_intake
          from kanban_board as board
          join kanban_column as column_row
            on column_row.workspace_id = board.workspace_id
           and column_row.board_id = board.id
         where board.workspace_id = $1::uuid
           and board.archived_at is null
           and column_row.archived_at is null
         order by board.id, column_row.position
      `, [workspaceId]);
    });
    expect(provisioned.rows).toEqual([
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "Eingang",
        column_type: "lead",
        position: 1,
        color: "blue",
        is_intake: true,
      },
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "In Prüfung",
        column_type: "lead",
        position: 2,
        color: "amber",
        is_intake: false,
      },
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "Qualifiziert",
        column_type: "lead",
        position: 3,
        color: "green",
        is_intake: false,
      },
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "Angebote",
        column_type: "offer",
        position: 4,
        color: "blue",
        is_intake: false,
      },
    ]);
  });
});
