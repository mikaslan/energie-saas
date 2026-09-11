import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// F10-10: lokales Backend je Worker (Muster f1004 — kein S3 in Tests).
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1010-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import {
  createFileRequest,
  FileRequestConflictError,
  FileRequestNotFoundError,
  fulfillFileRequestByToken,
  listFileRequests,
  transitionFileRequest,
} from "@/modules/file-requests";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1010.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1010.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${`${contactId}@f1010.test`}, ${`${contactId}@f1010.test`})
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
  return { workspaceId, editorId, viewerId, projectId };
}

const FIRST_BYTES = Buffer.from("%PDF-1.4 F1010-Erst-Beleg\n", "utf8");
const SECOND_BYTES = Buffer.from("%PDF-1.4 F1010-Zweit-Beleg\n", "utf8");

describe("F10-10 Datei-Anfragen Allow-many (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F1010 ${randomUUID()}`);
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  async function seedInvite(fx: Fixture): Promise<string> {
    const created = await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        ttlDays: 14,
      }),
    );
    return created.token;
  }

  it("F1010-DB-01: Allow-many nimmt Erst- + Folge-Beleg an, Duplikat → Konflikt", async () => {
    const request = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Zaehlerfotos",
        description: null,
        allowMany: true,
      }),
    );
    expect(request.allowMany).toBe(true);
    expect(request.uploads).toEqual([]);
    const token = await seedInvite(fixture);

    const first = await fulfillFileRequestByToken(testPool, {
      token,
      requestId: request.id,
      filename: "zaehler-1.pdf",
      contentType: "application/pdf",
      bytes: FIRST_BYTES,
    });
    expect(first.requestId).toBe(request.id);

    // Gleicher Dateiname, andere Bytes → eigener Key, eigener Beleg.
    const second = await fulfillFileRequestByToken(testPool, {
      token,
      requestId: request.id,
      filename: "zaehler-1.pdf",
      contentType: "application/pdf",
      bytes: SECOND_BYTES,
    });
    expect(second.sha256).not.toBe(first.sha256);

    // Gleiche Datei erneut → Duplikat → Konflikt (kein dritter Beleg).
    await expect(
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: request.id,
        filename: "zaehler-1.pdf",
        contentType: "application/pdf",
        bytes: SECOND_BYTES,
      }),
    ).rejects.toBeInstanceOf(FileRequestConflictError);

    const listed = await asEditor(fixture, (tx, ctx) => listFileRequests(tx, ctx, fixture.projectId));
    const row = listed.find((entry) => entry.id === request.id);
    expect(row?.status).toBe("hochgeladen");
    expect(row?.allowMany).toBe(true);
    expect(row?.uploads).toHaveLength(1);
    expect(row?.uploads[0]?.originalFilename).toBe("zaehler-1.pdf");

    const view = await resolvePortalByToken(testPool, { token });
    const projected = view.fileRequests.find((entry) => entry.id === request.id);
    expect(projected).toMatchObject({
      status: "hochgeladen",
      allowMany: true,
      uploadCount: 1,
      filenames: ["zaehler-1.pdf"],
    });
    // Kein interner Beleg austritt ins Portal (Allowlist-Vertrag).
    expect(JSON.stringify(view)).not.toContain("storage_key");
    expect(JSON.stringify(view)).not.toContain(second.sha256);
  });

  it("F1010-DB-02: Single/Erledigt/Storniert/Fremd lehnen Folge-Belege ab", async () => {
    const single = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Single",
        description: null,
      }),
    );
    expect(single.allowMany).toBe(false);
    const multi = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Multi",
        description: null,
        allowMany: true,
      }),
    );
    const token = await seedInvite(fixture);
    const fulfill = (requestId: string, bytes: Buffer) =>
      fulfillFileRequestByToken(testPool, {
        token,
        requestId,
        filename: "beleg.pdf",
        contentType: "application/pdf",
        bytes,
      });

    await fulfill(single.id, FIRST_BYTES);
    // Single-Anfrage: Zweit-Beleg → Konflikt.
    await expect(fulfill(single.id, SECOND_BYTES)).rejects.toBeInstanceOf(
      FileRequestConflictError,
    );

    await fulfill(multi.id, FIRST_BYTES);
    await asEditor(fixture, (tx, ctx) =>
      transitionFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        requestId: multi.id,
        status: "erledigt",
      }),
    );
    // Erledigte Allow-many-Anfrage: Folge-Beleg → Konflikt.
    await expect(fulfill(multi.id, SECOND_BYTES)).rejects.toBeInstanceOf(
      FileRequestConflictError,
    );

    // Fremde Request-ID unter gültigem Token: kein Orakel-Unterschied.
    await expect(fulfill(randomUUID(), FIRST_BYTES)).rejects.toBeInstanceOf(
      FileRequestNotFoundError,
    );

    // Fremder Mandant sieht keine Uploads.
    const foreign = await seedFixture(`F1010 fremd ${randomUUID()}`);
    const foreignList = await withAuthorizedTenantOn(
      testPool,
      foreign.editorId,
      foreign.workspaceId,
      (tx, ctx) => listFileRequests(tx, ctx, foreign.projectId),
    );
    expect(foreignList).toEqual([]);
  });
});
