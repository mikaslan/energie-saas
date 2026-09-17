import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1017-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  downloadProjectFile,
  listProjectFiles,
  ProjectFileNotFoundError,
  ProjectFileValidationError,
  readPortalProjectFileByToken,
  setProjectFileVisibility,
  uploadProjectFile,
} from "@/modules/project-files";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { testPool } from "../setup/test-db";

/**
 * F10-17 Portal My-Files (Katalog F10.2) — DB-Vertrag D-01..D-07
 * (Visible-Flag + Resolver-Projektion + Download-Kapsel, 0182).
 * Fixture nach F7-16, Invite-Builder nach F10-07.
 */

const PDF_MINIMAL = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n",
  "utf8",
);
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
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
      values (${editorId}::uuid, ${`editor-${editorId}@f1017.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1017.test`}),
             (${externalId}::uuid, ${`extern-${externalId}@f1017.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${`${contactId}@f1017.test`}, ${`${contactId}@f1017.test`})
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

describe("F10-17 Portal My-Files (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F1017 ${randomUUID()}`);
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;
  const asExternal = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, fn as never) as Promise<T>;

  it("D-01: INSERT ohne Flag liest visible_to_customer = false (sicherer Default)", async () => {
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
      tx.execute<{ visible_to_customer: boolean }>(sql`
        select visible_to_customer from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fileId}::uuid
      `),
    );
    expect(seen.rows[0]?.visible_to_customer).toBe(false);
    // Service-Liste traegt das Flag (Default unsichtbar).
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.visibleToCustomer).toBe(false);
  });

  it("D-02: Toggle flip false→true→false, Rest unberuehrt, Audit je Flip", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    const before = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<Record<string, unknown>>(sql`
        select * from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fileId}::uuid
      `),
    );
    const beforeRow = { ...before.rows[0] };
    delete beforeRow.visible_to_customer;

    await asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, { projectId: fixture.projectId, fileId, visible: true }),
    );
    let listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed[0]?.visibleToCustomer).toBe(true);

    await asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, { projectId: fixture.projectId, fileId, visible: false }),
    );
    listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed[0]?.visibleToCustomer).toBe(false);

    const after = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<Record<string, unknown>>(sql`
        select * from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fileId}::uuid
      `),
    );
    const afterRow = { ...after.rows[0] };
    delete afterRow.visible_to_customer;
    expect(afterRow).toEqual(beforeRow);

    const audits = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ action: string; details: unknown }>(sql`
        select action, details from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'project_file.visibility_set'
         order by occurred_at, id
      `),
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows[0]?.details).toEqual({
      projectId: fixture.projectId,
      fileId,
      visible: true,
    });
    expect(audits.rows[1]?.details).toEqual({
      projectId: fixture.projectId,
      fileId,
      visible: false,
    });
  });

  it("D-03: Toggle fremde ID / fremdes Projekt → uniform NotFound, deformiert → Validation", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: fixture.projectId,
        fileId: randomUUID(),
        visible: true,
      }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: randomUUID(),
        fileId,
        visible: true,
      }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: "keine-uuid",
        fileId,
        visible: true,
      }),
    )).rejects.toBeInstanceOf(ProjectFileValidationError);
    await expect(asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: fixture.projectId,
        fileId,
        visible: "ja" as unknown as boolean,
      }),
    )).rejects.toBeInstanceOf(ProjectFileValidationError);
    // Kein Flip passiert: Flag bleibt false, kein Audit.
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed[0]?.visibleToCustomer).toBe(false);
  });

  it("D-04: Resolver projiziert NUR sichtbare (DTO ohne Key/Hash, newest-first)", async () => {
    const hidden = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PNG_1X1,
        filename: "intern.png",
        contentType: "image/png",
      }),
    );
    const shown = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "freigabe.pdf",
        contentType: "application/pdf",
      }),
    );
    await asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: fixture.projectId,
        fileId: shown.fileId,
        visible: true,
      }),
    );
    const token = await inviteToken(fixture);
    const view = await resolvePortalByToken(testPool, { token });
    expect(view.projectFiles).toHaveLength(1);
    expect(view.projectFiles[0]?.id).toBe(shown.fileId);
    expect(view.projectFiles[0]?.id).not.toBe(hidden.fileId);
    expect(Object.keys(view.projectFiles[0] ?? {}).sort()).toEqual([
      "byteSize",
      "contentType",
      "createdAt",
      "id",
      "originalFilename",
    ]);
    expect(view.projectFiles[0]).toMatchObject({
      originalFilename: "freigabe.pdf",
      contentType: "application/pdf",
      byteSize: PDF_MINIMAL.byteLength,
    });

    // Zweite sichtbare Datei → newest-first oben.
    const second = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PNG_1X1,
        filename: "zweite.png",
        contentType: "image/png",
      }),
    );
    await asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: fixture.projectId,
        fileId: second.fileId,
        visible: true,
      }),
    );
    const refreshed = await resolvePortalByToken(testPool, { token });
    expect(refreshed.projectFiles.map((entry) => entry.id)).toEqual([
      second.fileId,
      shown.fileId,
    ]);
  });

  it("D-05: Download-Kapsel unsichtbar → NotFound, sichtbar → Bytes/SHA/Groesse", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    const token = await inviteToken(fixture);

    // Unsichtbar: als gaebe es sie nicht (kein Orakel).
    await expect(readPortalProjectFileByToken(testPool, { token, fileId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(readPortalProjectFileByToken(testPool, { token, fileId: randomUUID() }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(readPortalProjectFileByToken(testPool, { token: "toter-token-f1017", fileId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);

    await asEditor(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, { projectId: fixture.projectId, fileId, visible: true }),
    );
    const artifact = await readPortalProjectFileByToken(testPool, { token, fileId });
    expect(artifact.fileId).toBe(fileId);
    expect(artifact.filename).toBe("Plan.pdf");
    expect(artifact.mimeType).toBe("application/pdf");
    expect(artifact.sizeBytes).toBe(PDF_MINIMAL.byteLength);
    expect(artifact.sha256).toBe(createHash("sha256").update(PDF_MINIMAL).digest("hex"));
    expect(artifact.bytes.equals(PDF_MINIMAL)).toBe(true);

    // Fremdes Projekt-Token sieht die Datei nicht.
    const other = await seedFixture(`F1017-fremd ${randomUUID()}`);
    const otherToken = await inviteToken(other);
    await expect(readPortalProjectFileByToken(testPool, { token: otherToken, fileId }))
      .rejects.toBeInstanceOf(ProjectFileNotFoundError);
  });

  it("D-06: RLS — fremder Workspace toggelt/listent nichts", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    const other = await seedFixture(`F1017-rls ${randomUUID()}`);
    await expect(
      withAuthorizedTenantOn(testPool, other.editorId, other.workspaceId, (tx, ctx) =>
        setProjectFileVisibility(tx, ctx, {
          projectId: fixture.projectId,
          fileId,
          visible: true,
        }),
      ),
    ).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    const seen = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId, (tx, ctx) =>
        listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(seen).toHaveLength(0);
    // Original-Flag unberuehrt.
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed[0]?.visibleToCustomer).toBe(false);
  });

  it("D-07: Externer scheitert an Toggle, Liste und internem Download", async () => {
    const { fileId } = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(asExternal(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, { projectId: fixture.projectId, fileId, visible: true }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asExternal(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asExternal(fixture, (tx, ctx) =>
      downloadProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    // Interner Viewer liest inkl. Flag, toggelt aber nicht (project.write).
    const listed = await asViewer(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.visibleToCustomer).toBe(false);
    await expect(asViewer(fixture, (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, { projectId: fixture.projectId, fileId, visible: true }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
