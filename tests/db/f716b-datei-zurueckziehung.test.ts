import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f716b-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  downloadProjectFile,
  listProjectFiles,
  ProjectFileNotFoundError,
  readPortalProjectFileByToken,
  setProjectFileVisibility,
  uploadProjectFile,
  withdrawProjectFile,
} from "@/modules/project-files";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { testPool } from "../setup/test-db";

/**
 * F7-16b Datei-Zurückziehung (Katalog F7.1) — DB-Vertrag D-01..D-09
 * (withdrawn-Flag + Resolver-WHERE + Kapsel-BEIDE-WHEREs + Service-Op, 0184).
 * Fixture nach F1017 (seedFixture), tenantQuery + Log-Helfer nach F1018.
 */

const PDF_MINIMAL = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n",
  "utf8",
);

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f716b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f716b.test`}),
             (${externalId}::uuid, ${`extern-${externalId}@f716b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'viewer', '{"external_only": true}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F7', 'Fixture',
        ${`${contactId}@f716b.test`}, ${`${contactId}@f716b.test`})
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
  return { workspaceId, editorId, viewerId, externalId, projectId };
}

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
) {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
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

async function inviteToken(fx: Fixture): Promise<string> {
  const invite = await withAuthorizedTenantOn(
    testPool, fx.editorId, fx.workspaceId,
    (tx, serviceCtx) => createPortalInvite(tx, serviceCtx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      ttlDays: 14,
    }),
  );
  return invite.token;
}

async function downloadCount(workspaceId: string): Promise<number> {
  const result = await tenantQuery<{ portal_invite_id: string }>(
    workspaceId,
    null,
    `select portal_invite_id from portal_download_log where workspace_id = $1::uuid`,
    [workspaceId],
  );
  return result.rows.length;
}

async function uploadVisibleFile(fx: Fixture, filename: string): Promise<string> {
  const { fileId } = await withAuthorizedTenantOn(
    testPool, fx.editorId, fx.workspaceId,
    (tx, ctx) => uploadProjectFile(tx, ctx, {
      projectId: fx.projectId,
      bytes: PDF_MINIMAL,
      filename,
      contentType: "application/pdf",
    }),
  );
  await withAuthorizedTenantOn(
    testPool, fx.editorId, fx.workspaceId,
    (tx, ctx) => setProjectFileVisibility(tx, ctx, {
      projectId: fx.projectId,
      fileId,
      visible: true,
    }),
  );
  return fileId;
}

describe("F7-16b Datei-Zurückziehung (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F716b ${randomUUID()}`);
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asExternal = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, fn as never) as Promise<T>;

  it("D-01: INSERT ohne Flag liest withdrawn = false (Default aktiv)", async () => {
    const fileId = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project_file (
          id, workspace_id, project_id, storage_key, file_sha256,
          content_type, byte_size, original_filename, created_by
        )
        values (
          ${fileId}::uuid, ${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid,
          ${`immutable/${fixture.projectId}/project-files/${fileId}_a1b2c3d4.pdf`},
          ${createHash("sha256").update(PDF_MINIMAL).digest("hex")},
          'application/pdf', ${PDF_MINIMAL.byteLength}, 'Plan.pdf',
          ${fixture.editorId}::uuid
        )
      `);
    });
    const seen = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ withdrawn: boolean }>(sql`
        select withdrawn from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fileId}::uuid
      `),
    );
    expect(seen.rows[0]?.withdrawn).toBe(false);
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.withdrawn).toBe(false);
  });

  it("D-02: Withdraw flipt false→true, visible_to_customer + Rest unberührt", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, { projectId: fixture.projectId, fileId, visible: true }),
    );
    const before = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<Record<string, unknown>>(sql`
        select * from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fileId}::uuid
      `),
    );
    const beforeRow = { ...before.rows[0] };
    delete beforeRow.withdrawn;

    const result = await asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    );
    expect(result).toEqual({ fileId, withdrawn: true });

    const after = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<Record<string, unknown>>(sql`
        select * from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fileId}::uuid
      `),
    );
    const afterRow = { ...after.rows[0] };
    expect(afterRow.withdrawn).toBe(true);
    delete afterRow.withdrawn;
    expect(afterRow).toEqual(beforeRow);
    // Orthogonalität: Sichtbarkeit bleibt gesetzt.
    expect(afterRow.visible_to_customer).toBe(true);

    const audits = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ action: string; details: unknown }>(sql`
        select action, details from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'project_file.withdrawn'
         order by occurred_at, id
      `),
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.details).toEqual({ projectId: fixture.projectId, fileId });
  });

  it("D-03: Withdraw fremde ID / fremdes Projekt → uniform NotFound", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId: randomUUID() }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: randomUUID(), fileId }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    // Kein Flip passiert: Flag bleibt false, kein Audit.
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed[0]?.withdrawn).toBe(false);
    const audits = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'project_file.withdrawn'
      `),
    );
    expect(audits.rows).toHaveLength(0);
  });

  it("D-04: Idempotenz — zweiter Withdraw Erfolg ohne Audit", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    );
    const retry = await asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    );
    expect(retry).toEqual({ fileId, withdrawn: true });
    const audits = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'project_file.withdrawn'
      `),
    );
    expect(audits.rows).toHaveLength(1);
  });

  it("D-05: Resolver projiziert Zurückgezogene NICHT (DTO ohne Key/Hash)", async () => {
    const withdrawnId = await uploadVisibleFile(fixture, "wird-entfernt.pdf");
    const activeId = await uploadVisibleFile(fixture, "bleibt.pdf");
    await asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId: withdrawnId }),
    );
    const token = await inviteToken(fixture);
    const view = await resolvePortalByToken(testPool, { token });
    expect(view.projectFiles.map((entry) => entry.id)).toEqual([activeId]);
    expect(Object.keys(view.projectFiles[0] ?? {}).sort()).toEqual([
      "byteSize",
      "contentType",
      "createdAt",
      "id",
      "originalFilename",
    ]);
  });

  it("D-06: Kapsel — zurückgezogen-sichtbar → NotFound ohne Log, aktiv → Bytes + 1 Log", async () => {
    const withdrawnId = await uploadVisibleFile(fixture, "wird-entfernt.pdf");
    const activeId = await uploadVisibleFile(fixture, "bleibt.pdf");
    await asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId: withdrawnId }),
    );
    const token = await inviteToken(fixture);
    // Zurückgezogen trotz Sichtbarkeit: als gäbe es sie nicht (kein Orakel).
    await expect(readPortalProjectFileByToken(testPool, { token, fileId: withdrawnId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    expect(await downloadCount(fixture.workspaceId)).toBe(0);
    // Regression: aktiv-sichtbar liefert Bytes + genau 1 Log-Zeile.
    const artifact = await readPortalProjectFileByToken(testPool, { token, fileId: activeId });
    expect(artifact.bytes.equals(PDF_MINIMAL)).toBe(true);
    expect(await downloadCount(fixture.workspaceId)).toBe(1);
  });

  it("D-07: intern — Liste enthält Zurückgezogene mit Flag, Download bytegleich", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await asEditor(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    );
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.withdrawn).toBe(true);
    const downloaded = await asEditor(fixture, (tx, ctx) =>
      downloadProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    );
    expect(downloaded.body.equals(PDF_MINIMAL)).toBe(true);
  });

  it("D-08: RLS — fremder Workspace withdrawt/listet nichts", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    const other = await seedFixture(`F716b-rls ${randomUUID()}`);
    await expect(
      withAuthorizedTenantOn(testPool, other.editorId, other.workspaceId, (tx, ctx) =>
        withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
      ),
    ).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    const seen = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId, (tx, ctx) =>
        listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(seen).toHaveLength(0);
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed[0]?.withdrawn).toBe(false);
  });

  it("D-09: Externer scheitert an Withdraw, Liste und internem Download", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(asExternal(fixture, (tx, ctx) =>
      withdrawProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asExternal(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asExternal(fixture, (tx, ctx) =>
      downloadProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
