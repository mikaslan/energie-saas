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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { OFFER_CREATE_COMMAND_VERSION } from "@/lib/integrations/offers/contract";
import {
  getRequestBoard,
  moveProjectCard,
  ProjectMoveConflictError,
} from "@/modules/boards";
import { createOfferFromRequest } from "@/modules/offers";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

type EmbeddedBoard = QueryResultRow & {
  id: string;
  workspace_id: string;
  name: string;
  scope: string;
  is_default: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type EmbeddedBoardColumn = QueryResultRow & {
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

type StageExpectation = {
  name: string;
  type: string;
  position: number;
  color: string;
  isIntake: boolean;
};

// F15-02 (0290): eigene Gewerbe-Workflow-Stufen — Kontraktwechsel weg von
// der F15-01-Wohnbau-Kopie (ESTIMATE, keine Reonic-Referenz). Intake- und
// Angebots-Lane behalten Namen/Typen (Lane-Verträge F1-11/M2-01 bleiben
// stabil), nur die mittleren Qualifizierungsstufen sind Gewerbe-eigen.
const COMMERCIAL_STAGES_0290: readonly StageExpectation[] = [
  { name: "Eingang", type: "lead", position: 1, color: "blue", isIntake: true },
  { name: "Bedarfsanalyse", type: "lead", position: 2, color: "amber", isIntake: false },
  { name: "Planung", type: "lead", position: 3, color: "green", isIntake: false },
  { name: "Angebote", type: "offer", position: 4, color: "blue", isIntake: false },
];

const RESIDENTIAL_STAGES: readonly StageExpectation[] = [
  { name: "Eingang", type: "lead", position: 1, color: "blue", isIntake: true },
  { name: "In Prüfung", type: "lead", position: 2, color: "amber", isIntake: false },
  { name: "Qualifiziert", type: "lead", position: 3, color: "green", isIntake: false },
  { name: "Angebote", type: "offer", position: 4, color: "blue", isIntake: false },
];

// F15-01 (0088): Gewerbe-Board als Wohnbau-Kopie — die 0290-Backfill-
// Signatur für „unberührt" (exakt diese vier Spalten → migrieren, jede
// Abweichung → stehenlassen).
const LEGACY_COMMERCIAL_0088: readonly StageExpectation[] = RESIDENTIAL_STAGES;

type Fixture = { workspaceId: string; operatorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const operatorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F15-02 Stufen')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${operatorId}::uuid, ${`operator-${operatorId}@f1502.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${operatorId}::uuid, 'editor',
        '{"convert_phase": true, "edit_prices": true}'::jsonb)
    `);
  });
  return { workspaceId, operatorId };
}

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function requireF1502Migration(): { idx: number; tag: string } {
  const entry = migrationJournal().entries.find((candidate) => candidate.tag.startsWith("0290_"));
  if (!entry) {
    throw new Error("F15-02 (0290): Migration 0290 fehlt im Journal — RED bis der Migrations-Slice landet.");
  }
  return entry;
}

function migrationPrefixThrough(maxIndex: number): string {
  const source = resolve("drizzle");
  const target = mkdtempSync(join(tmpdir(), "energie-saas-f1502-upgrade-"));
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

async function defaultCommercialBoardId(client: PoolClient, workspaceId: string): Promise<string> {
  const found = await client.query<{ id: string }>(`
    select id
      from kanban_board
     where workspace_id = $1::uuid
       and scope = 'commercial'
       and is_default = true
       and archived_at is null
  `, [workspaceId]);
  const id = found.rows[0]?.id;
  if (!id) throw new Error("F15-02: Default-Gewerbe-Board fehlt.");
  return id;
}

async function readEmbeddedColumns(
  client: PoolClient,
  workspaceId: string,
  scope: "residential" | "commercial",
): Promise<EmbeddedBoardColumn[]> {
  const found = await client.query<EmbeddedBoardColumn>(`
    select column_row.id, column_row.workspace_id, column_row.board_id,
           column_row.name, column_row.column_type, column_row.position,
           column_row.color, column_row.is_intake, column_row.archived_at,
           column_row.created_at, column_row.updated_at
      from kanban_column column_row
      join kanban_board board
        on board.workspace_id = column_row.workspace_id
       and board.id = column_row.board_id
     where board.workspace_id = $1::uuid
       and board.scope = $2
       and board.is_default = true
       and board.archived_at is null
       and column_row.archived_at is null
     order by column_row.position, column_row.id
  `, [workspaceId, scope]);
  return found.rows;
}

function stageShape(rows: readonly EmbeddedBoardColumn[]): StageExpectation[] {
  return rows.map((row) => ({
    name: row.name,
    type: row.column_type,
    position: row.position,
    color: row.color,
    isIntake: row.is_intake,
  }));
}

async function snapshotCommercialBoard(
  client: PoolClient,
  workspaceId: string,
): Promise<{ board: EmbeddedBoard[]; columns: EmbeddedBoardColumn[] }> {
  const boardId = await defaultCommercialBoardId(client, workspaceId);
  const board = await client.query<EmbeddedBoard>(`
    select id, workspace_id, name, scope, is_default, archived_at,
           created_at, updated_at
      from kanban_board
     where workspace_id = $1::uuid
       and id = $2::uuid
  `, [workspaceId, boardId]);
  const columns = await client.query<EmbeddedBoardColumn>(`
    select id, workspace_id, board_id, name, column_type, position, color,
           is_intake, archived_at, created_at, updated_at
      from kanban_column
     where workspace_id = $1::uuid
       and board_id = $2::uuid
     order by id
  `, [workspaceId, boardId]);
  return { board: board.rows, columns: columns.rows };
}

async function seedCommercialCard(
  client: PoolClient,
  workspaceId: string,
  displayName: string,
  position: number,
): Promise<{ projectId: string; columnId: string }> {
  const lane = await client.query<{ board_id: string; column_id: string }>(`
    select board.id as board_id, lane.id as column_id
      from kanban_board board
      join kanban_column lane
        on lane.workspace_id = board.workspace_id
       and lane.board_id = board.id
     where board.workspace_id = $1::uuid
       and board.scope = 'commercial'
       and board.is_default = true
       and board.archived_at is null
       and lane.position = $2
       and lane.archived_at is null
  `, [workspaceId, position]);
  const target = lane.rows[0];
  if (!target) throw new Error(`F15-02: Gewerbe-Lane auf Position ${position} fehlt.`);
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();
  await client.query(`
    insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
    values ($1::uuid, $2::uuid, $3, 'F1502', 'Backfill', $4, $4)
  `, [contactId, workspaceId, displayName, `f1502-${contactId}@f1502.test`]);
  await client.query(`
    insert into site (id, workspace_id, contact_id, label)
    values ($1::uuid, $2::uuid, $3::uuid, 'F1502 Backfill-Standort')
  `, [siteId, workspaceId, contactId]);
  await client.query(`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'manual'
    )
  `, [projectId, workspaceId, contactId, siteId, target.board_id, target.column_id, displayName]);
  return { projectId, columnId: target.column_id };
}

describe("F15-02 Gewerbe-Stufen (PostgreSQL)", () => {
  const run = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.operatorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F1502-DB-01: neue Workspaces erhalten die eigenen Gewerbe-Stufen, Wohnbau bleibt", async () => {
    const fixture = await seedFixture();
    const commercial = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" }));
    expect(commercial.name).toBe("Anfragen Gewerbe");
    expect(commercial.scope).toBe("commercial");
    expect(commercial.columns.map((column) => ({
      name: column.name,
      type: column.type,
      position: column.position,
      color: column.color,
      isIntake: column.isIntake,
    }))).toEqual([...COMMERCIAL_STAGES_0290]);

    const residential = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    expect(residential.name).toBe("Anfragen");
    expect(residential.columns.map((column) => ({
      name: column.name,
      type: column.type,
      position: column.position,
      color: column.color,
      isIntake: column.isIntake,
    }))).toEqual([...RESIDENTIAL_STAGES]);
  });

  it("F1502-DB-02: Backfill migriert unberührte Gewerbe-Boards mit Karten positionsgetreu", async () => {
    const entry = requireF1502Migration();
    let embedded: EmbeddedTestDatabase | undefined;
    let pool: Pool | undefined;
    let prefix: string | undefined;
    try {
      embedded = await startEmbeddedPostgres();
      pool = createDrainTrackedPool({ connectionString: embedded.url, max: 1 });
      prefix = migrationPrefixThrough(entry.idx - 1);
      await migrate(drizzle(pool), { migrationsFolder: prefix });

      const workspaceId = randomUUID();
      const seed = await tenantTransaction(pool, workspaceId, async (client) => {
        await client.query(
          "insert into workspace (id, name) values ($1::uuid, 'F15-02 Backfill')",
          [workspaceId],
        );
        // Setup-Guard: Der Prefix-Stand provisioniert noch die 0088-Kopie.
        const before = await readEmbeddedColumns(client, workspaceId, "commercial");
        expect(stageShape(before)).toEqual([...LEGACY_COMMERCIAL_0088]);
        const intake = await seedCommercialCard(client, workspaceId, "F1502 Backfill Intake", 1);
        const qualified = await seedCommercialCard(client, workspaceId, "F1502 Backfill Pos2", 2);
        return { intake, qualified };
      });

      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      await tenantTransaction(pool, workspaceId, async (client) => {
        const after = await readEmbeddedColumns(client, workspaceId, "commercial");
        expect(stageShape(after)).toEqual([...COMMERCIAL_STAGES_0290]);

        const cards = await client.query<{
          project_id: string;
          column_name: string;
          column_position: number;
        }>(`
          select project.id as project_id, lane.name as column_name,
                 lane.position as column_position
            from project
            join kanban_column lane
              on lane.workspace_id = project.workspace_id
             and lane.id = project.kanban_column_id
           where project.workspace_id = $1::uuid
        `, [workspaceId]);
        expect(cards.rows).toHaveLength(2);
        const byId = new Map(cards.rows.map((row) => [row.project_id, row]));
        expect(byId.get(seed.intake.projectId)).toMatchObject({
          column_name: "Eingang",
          column_position: 1,
        });
        expect(byId.get(seed.qualified.projectId)).toMatchObject({
          column_name: "Bedarfsanalyse",
          column_position: 2,
        });

        const residential = await readEmbeddedColumns(client, workspaceId, "residential");
        expect(stageShape(residential)).toEqual([...RESIDENTIAL_STAGES]);
      });
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F15-02-Backfill-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("F1502-DB-03: angepasste Gewerbe-Boards (Umbenennung, Zusatzspalte) bleiben bytegenau stehen", async () => {
    const entry = requireF1502Migration();
    let embedded: EmbeddedTestDatabase | undefined;
    let pool: Pool | undefined;
    let prefix: string | undefined;
    try {
      embedded = await startEmbeddedPostgres();
      pool = createDrainTrackedPool({ connectionString: embedded.url, max: 1 });
      prefix = migrationPrefixThrough(entry.idx - 1);
      await migrate(drizzle(pool), { migrationsFolder: prefix });

      const renamedWorkspaceId = randomUUID();
      const extraWorkspaceId = randomUUID();
      const beforeRenamed = await tenantTransaction(pool, renamedWorkspaceId, async (client) => {
        await client.query(
          "insert into workspace (id, name) values ($1::uuid, 'F15-02 Angepasst-Umbenannt')",
          [renamedWorkspaceId],
        );
        const boardId = await defaultCommercialBoardId(client, renamedWorkspaceId);
        await client.query(`
          update kanban_column
             set name = 'Eigene Prüfung', updated_at = now()
           where workspace_id = $1::uuid
             and board_id = $2::uuid
             and position = 2
             and archived_at is null
        `, [renamedWorkspaceId, boardId]);
        return snapshotCommercialBoard(client, renamedWorkspaceId);
      });
      const beforeExtra = await tenantTransaction(pool, extraWorkspaceId, async (client) => {
        await client.query(
          "insert into workspace (id, name) values ($1::uuid, 'F15-02 Angepasst-Zusatz')",
          [extraWorkspaceId],
        );
        const boardId = await defaultCommercialBoardId(client, extraWorkspaceId);
        await client.query(`
          insert into kanban_column (
            id, workspace_id, board_id, name, column_type, position, color, is_intake
          ) values (
            $1::uuid, $2::uuid, $3::uuid, 'Sonderstufe', 'lead', 5, 'neutral', false
          )
        `, [randomUUID(), extraWorkspaceId, boardId]);
        return snapshotCommercialBoard(client, extraWorkspaceId);
      });

      await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });

      const afterRenamed = await tenantTransaction(pool, renamedWorkspaceId, (client) =>
        snapshotCommercialBoard(client, renamedWorkspaceId));
      expect(afterRenamed).toEqual(beforeRenamed);
      const afterExtra = await tenantTransaction(pool, extraWorkspaceId, (client) =>
        snapshotCommercialBoard(client, extraWorkspaceId));
      expect(afterExtra).toEqual(beforeExtra);
    } finally {
      await endPoolsAndStopEmbeddedPostgres(
        [pool],
        embedded,
        "F15-02-Custom-Teardown fehlgeschlagen",
      );
      if (prefix) rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it("F1502-DB-04: Cross-Board-Move wird je Richtung als Konflikt verweigert", async () => {
    const fixture = await seedFixture();
    const commercialLead = await run(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "commercial",
      displayName: "F1502 Gewerbe-Move",
      phone: "+49 30 111222",
    }));
    const residentialLead = await run(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F1502 Wohnbau-Move",
      phone: "+49 30 333444",
    }));
    const commercial = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" }));
    const residential = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const commercialIntakeId = commercial.columns.find((column) => column.isIntake)?.id;
    const commercialTargetId = commercial.columns.find((column) => column.position === 2)?.id;
    const residentialIntakeId = residential.columns.find((column) => column.isIntake)?.id;
    const residentialTargetId = residential.columns.find((column) => column.position === 2)?.id;
    if (!commercialIntakeId || !commercialTargetId || !residentialIntakeId || !residentialTargetId) {
      throw new Error("F15-02: Board-Lanes unvollständig.");
    }

    // Gewerbe → Wohnbau-Ziel (Lead-Typ, fremdes Board).
    await expect(run(fixture, (tx, ctx) => moveProjectCard(tx, ctx, {
      projectId: commercialLead.projectId,
      expectedColumnId: commercialIntakeId,
      targetColumnId: residentialTargetId,
    }))).rejects.toBeInstanceOf(ProjectMoveConflictError);
    // Wohnbau → Gewerbe-Ziel (Lead-Typ, fremdes Board).
    await expect(run(fixture, (tx, ctx) => moveProjectCard(tx, ctx, {
      projectId: residentialLead.projectId,
      expectedColumnId: residentialIntakeId,
      targetColumnId: commercialTargetId,
    }))).rejects.toBeInstanceOf(ProjectMoveConflictError);

    // Beide Karten bleiben ohne Seiteneffekt auf ihrer Intake-Lane.
    const commercialAfter = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" }));
    const residentialAfter = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const commercialCards = commercialAfter.columns.flatMap((column) => column.cards).map((card) => card.id.toLowerCase());
    const residentialCards = residentialAfter.columns.flatMap((column) => column.cards).map((card) => card.id.toLowerCase());
    expect(commercialCards).toContain(commercialLead.projectId.toLowerCase());
    expect(commercialCards).not.toContain(residentialLead.projectId.toLowerCase());
    expect(residentialCards).toContain(residentialLead.projectId.toLowerCase());
    expect(residentialCards).not.toContain(commercialLead.projectId.toLowerCase());
  });

  it("F1502-DB-05: Scope bleibt fail-closed, genau ein Default-Board je Bereich", async () => {
    const fixture = await seedFixture();
    await expect(run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "industrie" as never })))
      .rejects.toThrow(/unknown board scope/);

    // 0290-Backfill darf keine Duplikate anlegen (Partial-Unique-Index).
    const boards = await withTenantOn(testPool, fixture.workspaceId, async (tx) => tx.execute<{
      scope: string;
      count: number;
    }>(sql`
      select scope, count(*)::int as count
        from kanban_board
       where workspace_id = ${fixture.workspaceId}::uuid
         and is_default = true
         and archived_at is null
       group by scope
       order by scope
    `));
    expect(boards.rows).toEqual([
      { scope: "commercial", count: 1 },
      { scope: "residential", count: 1 },
    ]);
  });

  it("F1502-DB-06: Offer-Gate bleibt residential — Gewerbe-Angebot blockiert, Wohnbau-Spalte intakt", async () => {
    const fixture = await seedFixture();
    const lead = await run(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "commercial",
      displayName: "F1502 Gewerbe-Angebot",
      phone: "+49 30 555666",
    }));
    await expect(run(fixture, (tx, ctx) => createOfferFromRequest(tx, ctx, {
      schemaVersion: OFFER_CREATE_COMMAND_VERSION,
      projectId: lead.projectId,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      expectedResolutionRevision: 1,
      forecastValueNetCents: 1_250_000,
      priceAudience: "b2c",
      priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
      taxTreatment: "standard_19",
    }))).rejects.toMatchObject({ name: "OfferBlockedError", code: "project_not_eligible" });

    const offers = await withTenantOn(testPool, fixture.workspaceId, async (tx) => tx.execute<{
      count: number;
    }>(sql`
      select count(*)::int as count
        from offer
       where workspace_id = ${fixture.workspaceId}::uuid
    `));
    expect(offers.rows[0]?.count).toBe(0);

    // Wohnbau-Angebotsspalte: 0290 berührt Residential nicht.
    const residentialOffers = await withTenantOn(testPool, fixture.workspaceId, async (tx) => tx.execute<{
      count: number;
    }>(sql`
      select count(*)::int as count
        from kanban_column column_state
        join kanban_board board
          on board.workspace_id = column_state.workspace_id
         and board.id = column_state.board_id
       where board.workspace_id = ${fixture.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
         and column_state.archived_at is null
         and column_state.column_type = 'offer'
    `));
    expect(residentialOffers.rows[0]?.count).toBe(1);
  });
});
