import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  BoardColumnConflictError,
  BoardColumnValidationError,
  getBoardPipelineSummary,
  setColumnConversionRatio,
} from "@/modules/boards/service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  boardId: string;
  intakeColumnId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-05b Pipeline')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f105b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f105b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  const ids = await withTenantOn(testPool, workspaceId, async (tx) => {
    const found = await tx.execute<{ board_id: string; intake_id: string }>(sql`
      select board.id as board_id,
             (select intake.id from kanban_column intake
               where intake.workspace_id = board.workspace_id
                 and intake.board_id = board.id
                 and intake.is_intake = true
                 and intake.archived_at is null
               limit 1) as intake_id
        from kanban_board board
       where board.workspace_id = ${workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
       limit 1
    `);
    return found.rows[0];
  });
  if (!ids) throw new Error("F1-05b: Default-Board fehlt in der Fixture.");
  return { workspaceId, editorId, viewerId, boardId: ids.board_id, intakeColumnId: ids.intake_id };
}

async function seedCard(tx: TenantTx, workspaceId: string, columnId: string): Promise<void> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  const board = await tx.execute<{ board_id: string }>(sql`
    select board_id from kanban_column
     where workspace_id = ${workspaceId}::uuid and id = ${columnId}::uuid
  `);
  const boardId = board.rows[0]?.board_id;
  if (!boardId) throw new Error("F1-05b: Spalte fehlt in der Fixture.");
  await tx.execute(sql`
    insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
    values (${contactId}::uuid, ${workspaceId}::uuid, 'F105b Karte', 'F10', 'Karte',
      ${`${contactId}@f105b.test`}, ${`${contactId}@f105b.test`})
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F105b Standort')
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    )
    values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
            ${siteId}::uuid, ${boardId}::uuid,
            ${columnId}::uuid, 'F105b Projekt', 'fixture')
  `);
}

describe("F1-05b Conversion-Ratio + Pipeline (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F105B-DB-01: Ratio setzen/löschen, Summary zählt ohne Angebote", async () => {
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await seedCard(tx, fixture.workspaceId, fixture.intakeColumnId);
      await seedCard(tx, fixture.workspaceId, fixture.intakeColumnId);
    });

    const empty = await asEditor(fixture, (tx, ctx) => getBoardPipelineSummary(tx, ctx, {
      boardId: fixture.boardId,
    }));
    expect(empty.projectCount).toBe(2);
    expect(empty.totalNetCents).toBe(0);
    expect(empty.weightedTotalNetCents).toBeNull();
    expect(empty.columns.find((column) => column.id === fixture.intakeColumnId))
      .toMatchObject({ projectCount: 2, totalNetCents: 0, conversionRatioBps: null, weightedNetCents: null });

    const set = await asEditor(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: fixture.intakeColumnId, ratioBps: 2_500,
    }));
    expect(set).toEqual({ id: fixture.intakeColumnId, ratioBps: 2_500 });

    const weighted = await asEditor(fixture, (tx, ctx) => getBoardPipelineSummary(tx, ctx, {
      boardId: fixture.boardId,
    }));
    expect(weighted.weightedTotalNetCents).toBe(0);
    expect(weighted.columns.find((column) => column.id === fixture.intakeColumnId))
      .toMatchObject({ conversionRatioBps: 2_500, weightedNetCents: 0 });

    const cleared = await asEditor(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: fixture.intakeColumnId, ratioBps: null,
    }));
    expect(cleared.ratioBps).toBeNull();

    // Viewer liest, schreibt aber nicht.
    const seen = await asViewer(fixture, (tx, ctx) => getBoardPipelineSummary(tx, ctx, {
      boardId: fixture.boardId,
    }));
    expect(seen.projectCount).toBe(2);
    await expect(asViewer(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: fixture.intakeColumnId, ratioBps: 100,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F105B-DB-02: Ratio-Guards", async () => {
    await expect(asEditor(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: fixture.intakeColumnId, ratioBps: -1,
    }))).rejects.toBeInstanceOf(BoardColumnValidationError);
    await expect(asEditor(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: fixture.intakeColumnId, ratioBps: 10_001,
    }))).rejects.toBeInstanceOf(BoardColumnValidationError);
    await expect(asEditor(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: fixture.intakeColumnId, ratioBps: 12.5,
    }))).rejects.toBeInstanceOf(BoardColumnValidationError);
    await expect(asEditor(fixture, (tx, ctx) => setColumnConversionRatio(tx, ctx, {
      columnId: randomUUID(), ratioBps: 100,
    }))).rejects.toBeInstanceOf(BoardColumnConflictError);
  });
});
