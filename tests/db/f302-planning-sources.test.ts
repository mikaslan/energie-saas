import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

// F3-02 Dachquellen-Registry (TDD-RED, Batch-1 F3-BATCH-1-vertrag):
// Alle Tests sprechen `planning_source` (Migration 0270) direkt per SQL an.
// Die Tabelle existiert noch NICHT — jeder Test muss ROT sein mit
// `relation "planning_source" does not exist` (PG 42P01).

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  siteId: string;
  foreignProjectId: string;
};

// Drizzle kapselt PG-Fehler (Code steckt in .cause): direkter
// rejects.toMatchObject({code}) greift nicht — Codekette lesen.
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function pgCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return pgCode(error);
  }
}

async function seedWorkspace(label: string): Promise<{
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  siteId: string;
}> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f302.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f302.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F3', 'Fixture',
        ${`${contactId}@f302.test`}, ${`${contactId}@f302.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${label} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${label}, 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
        and intake_column.board_id = board.id
        and intake_column.is_intake = true
        and intake_column.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
  });
  return { workspaceId, editorId, viewerId, projectId, siteId };
}

const sha256Hex = (seed: string): string =>
  `${seed}${"0".repeat(64)}`.slice(0, 64);

describe("F3-02 planning_source Registry (DB, RED: Tabelle fehlt)", () => {
  let fx: Fixture;

  beforeEach(async () => {
    const label = `F302 ${randomUUID()}`;
    const own = await seedWorkspace(label);
    const foreign = await seedWorkspace(`${label} Fremd`);
    fx = {
      workspaceId: own.workspaceId,
      otherWorkspaceId: foreign.workspaceId,
      editorId: own.editorId,
      viewerId: own.viewerId,
      projectId: own.projectId,
      siteId: own.siteId,
      foreignProjectId: foreign.projectId,
    };
  });

  it("F302-DB-01: Upload-Quelle anlegen + lesen", async () => {
    const sha = sha256Hex("ab");
    const created = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_source
          (workspace_id, project_id, site_id, kind, storage_key, sha256, byte_size,
           scale_ref_json, created_by)
        values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid, ${fx.siteId}::uuid,
          'upload', ${`immutable/f302/${sha}.jpg`}, ${sha}, 123456,
          ${JSON.stringify({ meters: 10.5, pixelLength: 840 })}::jsonb,
          ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(created.rows).toHaveLength(1);

    const row = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ kind: string; sha256: string; byte_size: number }>(sql`
        select kind, sha256, byte_size from planning_source
        where workspace_id = ${fx.workspaceId}::uuid and id = ${created.rows[0].id}::uuid
      `),
    );
    expect(row.rows).toEqual([{ kind: "upload", sha256: sha, byte_size: 123456 }]);
  });

  it("F302-DB-02: self_drawn anlegen; Feld-CHECKs (upload verlangt Storage, self_drawn verbietet ihn)", async () => {
    const created = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_source
          (workspace_id, project_id, site_id, kind, created_by)
        values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid, ${fx.siteId}::uuid,
          'self_drawn', ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(created.rows).toHaveLength(1);

    // Upload OHNE Storage-Felder -> CHECK-Reject (23514).
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_source (workspace_id, project_id, kind, created_by)
            values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid,
              'upload', ${fx.editorId}::uuid)
          `),
        ),
      ),
    ).toBe("23514");

    // self_drawn MIT Storage-Feldern -> CHECK-Reject (23514).
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_source
              (workspace_id, project_id, kind, storage_key, sha256, byte_size, created_by)
            values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid, 'self_drawn',
              'immutable/f302/x.jpg', ${sha256Hex("cd")}, 10, ${fx.editorId}::uuid)
          `),
        ),
      ),
    ).toBe("23514");
  });

  it("F302-DB-03: RESERVED kinds (Adapter) werden rejectet, kein stiller Fallback", async () => {
    for (const kind of ["ortho", "google_solar", "earth_3d", "building_ai", "drone"]) {
      expect(
        await pgCodeOf(
          withTenantOn(testPool, fx.workspaceId, (tx) =>
            tx.execute(sql`
              insert into planning_source (workspace_id, project_id, kind, created_by)
              values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid,
                ${kind}, ${fx.editorId}::uuid)
            `),
          ),
        ),
        `kind ${kind} muss rejectet werden`,
      ).toBe("23514");
    }
  });

  it("F302-DB-04: Duplikat-Idempotenz per (project_id, sha256) -> genau eine Zeile", async () => {
    const sha = sha256Hex("ef");
    const insert = () =>
      withTenantOn(testPool, fx.workspaceId, (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into planning_source
            (workspace_id, project_id, kind, storage_key, sha256, byte_size, created_by)
          values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid, 'upload',
            ${`immutable/f302/${sha}.png`}, ${sha}, 42, ${fx.editorId}::uuid)
          on conflict (project_id, sha256) do nothing
          returning id
        `),
      );
    await insert();
    await insert();
    const count = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from planning_source
        where workspace_id = ${fx.workspaceId}::uuid
          and project_id = ${fx.projectId}::uuid and sha256 = ${sha}
      `),
    );
    expect(count.rows).toEqual([{ n: 1 }]);
  });

  it("F302-DB-05: Fremdprojekt-NotFound (Projekt aus anderem Workspace) -> Reject", async () => {
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_source (workspace_id, project_id, kind, created_by)
            values (${fx.workspaceId}::uuid, ${fx.foreignProjectId}::uuid,
              'self_drawn', ${fx.editorId}::uuid)
          `),
        ),
      ),
    ).toBe("23503");
  });

  it("F302-DB-06: RBAC read/manage (Viewer liest, Viewer schreibt nicht)", async () => {
    // Manage (editor): Anlage gelingt.
    const created = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_source (workspace_id, project_id, kind, created_by)
        values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid,
          'self_drawn', ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(created.rows).toHaveLength(1);

    // Read (viewer): Liste des Projekts ist lesbar.
    const listed = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_source
        where workspace_id = ${fx.workspaceId}::uuid
          and project_id = ${fx.projectId}::uuid
      `),
    );
    expect(listed.rows.map((r) => r.id)).toContain(created.rows[0].id);

    // Manage (viewer): Schreibrecht fehlt — der GREEN-Service wirft
    // PermissionDeniedError (Service-Layer-Recht, F3-BATCH-1-vertrag;
    // die SQL-Ebene allein kann Rollen nicht unterscheiden).
    // API-Pin für GREEN: createSource(tx, ctx, {projectId, siteId?, kind}).
    const sources = await import("@/modules/planning/" + "sources");
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        sources.createSource(tx, ctx, {
          projectId: fx.projectId,
          siteId: fx.siteId,
          kind: "self_drawn",
        })),
      "Viewer-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  it("F302-DB-07: Fremdtenant-Leere (Isolation je Workspace)", async () => {
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_source (workspace_id, project_id, kind, created_by)
        values (${fx.workspaceId}::uuid, ${fx.projectId}::uuid,
          'self_drawn', ${fx.editorId}::uuid)
      `),
    );
    const foreign = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_source where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreign.rows).toHaveLength(0);
  });
});
