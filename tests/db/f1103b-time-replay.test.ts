// F11-03b Zeit-Outbox-Replay (PostgreSQL): clientKey-Idempotenz.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import { createTimeEntry, listTimeEntries } from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
};

async function seedFixture(label: string, emailDomain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1103b-CUSTOMER', 'Fixture', 'Contact', 'c@f1103b.test', 'c@f1103b.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1103b Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1103b Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId };
}

describe("F11-03b Zeit-Replay (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("F1103b Outbox", "f1103b.test");
  });

  const run = (fx: Fixture, command: CreateTimeEntryCommand) =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      createTimeEntry(tx, ctx, command));

  const createdEventCount = async (fx: Fixture): Promise<number> => {
    const found = await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from domain_events
         where workspace_id = ${fx.workspaceId}::uuid
           and event_type = 'time_entry.created'
      `);
      return rows.rows[0]?.n ?? "0";
    });
    return Number(found);
  };

  const command = (projectId: string, clientKey?: string): CreateTimeEntryCommand => ({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields: {
      typeId: null,
      startAt: "2026-09-04T08:00:00.000Z",
      endAt: "2026-09-04T10:00:00.000Z",
      workingTimeMinutes: 120,
      breakDurationMinutes: 0,
      comment: "Offline-Einsatz mit Schlüssel",
    },
    ...(clientKey === undefined ? {} : { clientKey }),
  });

  it("F1103b-DB-01: gleicher clientKey → ein Eintrag, ein Event", async () => {
    const clientKey = randomUUID();

    const first = await run(fixture, command(fixture.projectId, clientKey));
    const replay = await run(fixture, command(fixture.projectId, clientKey));
    expect(replay.id).toBe(first.id);
    const replayAgain = await run(fixture, command(fixture.projectId, clientKey));
    expect(replayAgain.id).toBe(first.id);

    const list = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(list.entries.filter((entry) => entry.id === first.id)).toHaveLength(1);
    expect(list.entries).toHaveLength(1);
    expect(await createdEventCount(fixture)).toBe(1);
  });

  it("F1103b-DB-02: klassischer Pfad ohne Schlüssel dupliziert wie bisher; Schlüssel sind mandantengebunden", async () => {
    const first = await run(fixture, command(fixture.projectId));
    const second = await run(fixture, command(fixture.projectId));
    expect(second.id).not.toBe(first.id);

    const foreign = await seedFixture("F1103b Foreign", "f1103b-foreign.test");
    const sharedKey = randomUUID();
    const home = await run(fixture, command(fixture.projectId, sharedKey));
    const away = await run(foreign, command(foreign.projectId, sharedKey));
    expect(away.id).not.toBe(home.id);
  });
});
