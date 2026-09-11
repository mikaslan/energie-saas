import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  archiveBoardColumn,
  BoardColumnConflictError,
  BoardColumnValidationError,
  createBoardColumn,
  listBoardColumnsForAdmin,
  moveBoardColumn,
  renameBoardColumn,
  restoreBoardColumn,
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-05a Spalten')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f105a.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f105a.test`})
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
  if (!ids) throw new Error("F1-05a: Default-Board fehlt in der Fixture.");
  return { workspaceId, editorId, viewerId, boardId: ids.board_id, intakeColumnId: ids.intake_id };
}

async function seedCard(tx: TenantTx, workspaceId: string, columnId: string): Promise<void> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  await tx.execute(sql`
    insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
    values (${contactId}::uuid, ${workspaceId}::uuid, 'F105a Karte', 'F10', 'Karte',
      ${`${contactId}@f105a.test`}, ${`${contactId}@f105a.test`})
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F105a Standort')
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    )
    values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
            ${siteId}::uuid, (select board_id from kanban_column
                              where workspace_id = ${workspaceId}::uuid and id = ${columnId}::uuid),
            ${columnId}::uuid, 'F105a Projekt', 'fixture')
  `);
}

describe("F1-05a Spaltenverwaltung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  async function positions(): Promise<Array<{ id: string; position: number; archived: boolean }>> {
    return asEditor(fixture, (tx, ctx) => listBoardColumnsForAdmin(tx, ctx, {
      boardId: fixture.boardId,
    })).then((rows) => rows.map((row) => ({
      id: row.id, position: row.position, archived: row.archived,
    })));
  }

  it("F105A-DB-01: anlegen, umbenennen, verschieben, Kante ohne Effekt", async () => {
    const before = await positions();
    const created = await asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "  E2E-Spalte Neu ", columnType: "offer", color: "amber",
    }));
    expect(created.position).toBe(Math.max(...before.map((row) => row.position)) + 1);

    const renamed = await asEditor(fixture, (tx, ctx) => renameBoardColumn(tx, ctx, {
      columnId: created.id, name: "E2E-Spalte",
    }));
    expect(renamed.name).toBe("E2E-Spalte");

    const moved = await asEditor(fixture, (tx, ctx) => moveBoardColumn(tx, ctx, {
      columnId: created.id, direction: "left",
    }));
    expect(moved.changed).toBe(true);
    const after = (await positions()).filter((row) => !row.archived);
    const ids = after.sort((a, b) => a.position - b.position).map((row) => row.id);
    expect(ids[ids.length - 2]).toBe(created.id);

    // Ganz links angekommen: Kante ohne Effekt statt Fehler.
    const first = after.sort((a, b) => a.position - b.position)[0]!;
    for (let step = 0; step < after.length; step += 1) {
      await asEditor(fixture, (tx, ctx) => moveBoardColumn(tx, ctx, {
        columnId: created.id, direction: "left",
      }));
    }
    const edge = await asEditor(fixture, (tx, ctx) => moveBoardColumn(tx, ctx, {
      columnId: created.id, direction: "left",
    }));
    expect(edge.changed).toBe(false);
    expect(first.id).not.toBe(created.id);
  });

  it("F105A-DB-02: Intake und belegte Spalten geschützt, Restore weicht aus", async () => {
    await expect(asEditor(fixture, (tx, ctx) => archiveBoardColumn(tx, ctx, {
      columnId: fixture.intakeColumnId,
    }))).rejects.toBeInstanceOf(BoardColumnValidationError);

    const filled = await asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "Belegt", columnType: "lead",
    }));
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await seedCard(tx, fixture.workspaceId, filled.id);
    });
    await expect(asEditor(fixture, (tx, ctx) => archiveBoardColumn(tx, ctx, {
      columnId: filled.id,
    }))).rejects.toBeInstanceOf(BoardColumnConflictError);

    // Belegte Spalte meldet Karten in der Verwaltung.
    const listed = await asEditor(fixture, (tx, ctx) => listBoardColumnsForAdmin(tx, ctx, {
      boardId: fixture.boardId,
    }));
    expect(listed.find((row) => row.id === filled.id)?.cardCount).toBe(1);

    // Restore-Kollision: letzte Position archivieren, neu anlegen (nimmt
    // dieselbe Position), dann Restore → ans Ende ausweichen.
    const tail = await asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "Schwanz", columnType: "lead",
    }));
    await asEditor(fixture, (tx, ctx) => archiveBoardColumn(tx, ctx, {
      columnId: tail.id,
    }));
    const replacement = await asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "Ersatz", columnType: "lead",
    }));
    expect(replacement.position).toBe(tail.position);
    const restored = await asEditor(fixture, (tx, ctx) => restoreBoardColumn(tx, ctx, {
      columnId: tail.id,
    }));
    expect(restored.changed).toBe(true);
    expect(restored.position).toBe(tail.position + 1);
    const relisted = await asEditor(fixture, (tx, ctx) => listBoardColumnsForAdmin(tx, ctx, {
      boardId: fixture.boardId,
    }));
    expect(relisted.find((row) => row.id === tail.id)?.archived).toBe(false);
  });

  it("F105A-DB-03: Validierung, NotFound, Viewer denied", async () => {
    await expect(asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "   ", columnType: "lead",
    }))).rejects.toBeInstanceOf(BoardColumnValidationError);
    await expect(asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "X", columnType: "kanban",
    }))).rejects.toBeInstanceOf(BoardColumnValidationError);
    await expect(asEditor(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: randomUUID(), name: "X", columnType: "lead",
    }))).rejects.toBeInstanceOf(BoardColumnConflictError);
    await expect(asEditor(fixture, (tx, ctx) => renameBoardColumn(tx, ctx, {
      columnId: randomUUID(), name: "Y",
    }))).rejects.toBeInstanceOf(BoardColumnConflictError);

    await expect(asViewer(fixture, (tx, ctx) => createBoardColumn(tx, ctx, {
      boardId: fixture.boardId, name: "Viewer", columnType: "lead",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) => listBoardColumnsForAdmin(tx, ctx, {
      boardId: fixture.boardId,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
