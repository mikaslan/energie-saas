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
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startEmbeddedPostgres } from "../setup/embedded-postgres";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-m1-05-upgrade-"));
  mkdirSync(join(target, "meta"), { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(source, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  if (entries.length !== maxIndex + 1 || entries.at(-1)?.idx !== maxIndex) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Migrationspräfix 0..${maxIndex} ist nicht lückenlos.`);
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

it("migriert einen befüllten M1-04-Bestand verlustfrei in das Anfrage-Board", async () => {
  const embedded = await startEmbeddedPostgres();
  const pool = new Pool({ connectionString: embedded.url, max: 1 });
  let prefix: string | undefined;
  const workspaceId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();

  try {
    prefix = migrationPrefixThrough(21);
    await migrate(drizzle(pool), { migrationsFolder: prefix });

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [workspaceId, "Bestandsworkspace"],
      );
      await client.query(
        `insert into contact (
           id, workspace_id, display_name, email_primary, email_normalized
         ) values ($1::uuid, $2::uuid, $3, $4, $4)`,
        [contactId, workspaceId, "M1-04 Bestand", "bestand@example.test"],
      );
      await client.query(
        `insert into site (id, workspace_id, contact_id, label)
         values ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [siteId, workspaceId, contactId, "Bestandsstandort"],
      );
      await client.query(
        `insert into project (
           id, workspace_id, contact_id, site_id, name, phase, outcome, source_key
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'request', 'open', $6)`,
        [projectId, workspaceId, contactId, siteId, "Bestehende Anfrage", "wmee-rechner-v3"],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

    const verifyClient = await pool.connect();
    try {
      await verifyClient.query("begin");
      await verifyClient.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      const upgraded = await verifyClient.query<{
        id: string;
        name: string;
        board_name: string;
        column_name: string;
      }>(`
        select project_row.id, project_row.name,
               board_row.name as board_name, column_row.name as column_name
        from project project_row
        join kanban_board board_row
          on board_row.workspace_id = project_row.workspace_id
         and board_row.id = project_row.kanban_board_id
        join kanban_column column_row
          on column_row.workspace_id = project_row.workspace_id
         and column_row.board_id = project_row.kanban_board_id
         and column_row.id = project_row.kanban_column_id
        where project_row.id = $1::uuid
      `, [projectId]);
      expect(upgraded.rows).toEqual([{
        id: projectId,
        name: "Bestehende Anfrage",
        board_name: "Anfragen",
        column_name: "Eingang",
      }]);
      await verifyClient.query("rollback");
    } finally {
      verifyClient.release();
    }

    const forceRls = await pool.query<{ relname: string; forced: boolean }>(`
      select relname, relforcerowsecurity as forced
      from pg_catalog.pg_class
      where relname in ('workspace', 'project')
      order by relname
    `);
    expect(forceRls.rows).toEqual([
      { relname: "project", forced: true },
      { relname: "workspace", forced: true },
    ]);

    const newWorkspaceId = randomUUID();
    const insertClient = await pool.connect();
    try {
      await insertClient.query("begin");
      await insertClient.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [newWorkspaceId],
      );
      await insertClient.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [newWorkspaceId, "Workspace nach Upgrade"],
      );
      const provisioned = await insertClient.query<{
        boards: number;
        columns: number;
        intake_columns: number;
      }>(`
        select count(distinct board_row.id)::int as boards,
               count(column_row.id)::int as columns,
               count(column_row.id) filter (where column_row.is_intake)::int
                 as intake_columns
        from kanban_board board_row
        join kanban_column column_row
          on column_row.workspace_id = board_row.workspace_id
         and column_row.board_id = board_row.id
        where board_row.workspace_id = $1::uuid
      `, [newWorkspaceId]);
      expect(provisioned.rows[0]).toEqual({
        boards: 1,
        columns: 4,
        intake_columns: 1,
      });
      await insertClient.query("rollback");
    } finally {
      insertClient.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
    if (prefix) rmSync(prefix, { recursive: true, force: true });
  }
}, 120_000);
