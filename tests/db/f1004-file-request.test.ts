import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// F10-04: lokales Backend je Worker (kein S3 in Tests; Factory liest
// die Umgebung je Aufruf, daher pro Datei umschaltbar).
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1004-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { createPortalInvite, resolvePortalByToken, withdrawPortalInvite } from "@/modules/portal";
import {
  createFileRequest,
  downloadFileRequest,
  FileRequestConflictError,
  FileRequestNotFoundError,
  FileRequestValidationError,
  fulfillFileRequestByToken,
  listFileRequests,
  nextFileRequestStatuses,
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
      values (${editorId}::uuid, ${`editor-${editorId}@f1004.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1004.test`})
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
        ${`${contactId}@f1004.test`}, ${`${contactId}@f1004.test`})
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

const PDF_BYTES = Buffer.from("%PDF-1.4 F1004-Beleg\n", "utf8");

async function seedInvite(fx: Fixture): Promise<{ token: string; inviteId: string }> {
  const created = await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
    createPortalInvite(tx, ctx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      ttlDays: 14,
    }),
  );
  return { token: created.token, inviteId: created.inviteId };
}

async function seedRequest(fx: Fixture, title = "Stromrechnung (letzte 12 Monate)") {
  return withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
    createFileRequest(tx, ctx, { projectId: fx.projectId, title, description: "Bitte als PDF." }),
  );
}

describe("F10-04 Datei-Anfragen (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F1004 ${randomUUID()}`);
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F1004-DB-01: Anlage/Liste, Viewer liest, Fremdzugriff fail-closed", async () => {
    const created = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Zaehlerfoto",
        description: null,
      }),
    );
    expect(created.status).toBe("offen");
    expect(created.storageKey).toBeNull();

    const listed = await asViewer(fixture, (tx, ctx) => listFileRequests(tx, ctx, fixture.projectId));
    expect(listed.map((entry) => entry.id)).toContain(created.id);

    await expect(
      asViewer(fixture, (tx, ctx) =>
        createFileRequest(tx, ctx, { projectId: fixture.projectId, title: "X", description: null }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFileRequest(tx, ctx, { projectId: fixture.projectId, title: "  ", description: null }),
      ),
    ).rejects.toBeInstanceOf(FileRequestValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFileRequest(tx, ctx, { projectId: randomUUID(), title: "X", description: null }),
      ),
    ).rejects.toBeInstanceOf(FileRequestNotFoundError);
    expect(nextFileRequestStatuses("offen")).toEqual(["storniert"]);
    expect(nextFileRequestStatuses("hochgeladen")).toEqual(["erledigt"]);
  });

  it("F1004-DB-02: Token-Erfüllung legt WORM-Beleg ab, Portal zeigt nur öffentliche Felder", async () => {
    const request = await seedRequest(fixture);
    const { token } = await seedInvite(fixture);

    const fulfilled = await fulfillFileRequestByToken(testPool, {
      token,
      requestId: request.id,
      filename: "stromrechnung.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    expect(fulfilled.requestId).toBe(request.id);
    expect(fulfilled.byteSize).toBe(PDF_BYTES.byteLength);
    expect(fulfilled.sha256).toMatch(/^[0-9a-f]{64}$/);

    const listed = await asEditor(fixture, (tx, ctx) => listFileRequests(tx, ctx, fixture.projectId));
    const row = listed.find((entry) => entry.id === request.id);
    expect(row?.status).toBe("hochgeladen");
    expect(row?.storageKey?.startsWith("immutable/")).toBe(true);
    expect(row?.fileSha256).toBe(fulfilled.sha256);
    expect(row?.uploadedAt).not.toBeNull();

    const view = await resolvePortalByToken(testPool, { token });
    expect(view.fileRequests).toHaveLength(1);
    const projected = view.fileRequests[0];
    expect(projected).toMatchObject({
      id: request.id,
      title: request.title,
      status: "hochgeladen",
      originalFilename: "stromrechnung.pdf",
    });
    // Kein interner Beleg austritt ins Portal (Allowlist-Vertrag).
    expect(JSON.stringify(view)).not.toContain("storage_key");
    expect(JSON.stringify(view)).not.toContain(fulfilled.sha256);

    const downloaded = await asEditor(fixture, (tx, ctx) =>
      downloadFileRequest(tx, ctx, { projectId: fixture.projectId, requestId: request.id }),
    );
    expect(downloaded.filename).toBe("stromrechnung.pdf");
    expect(downloaded.contentType).toBe("application/pdf");
    expect(Buffer.compare(downloaded.body, PDF_BYTES)).toBe(0);
  });

  it("F1004-DB-03: Doppel-Erfüllung, Fremd-Request, Withdraw und ungültige Dateien", async () => {
    const request = await seedRequest(fixture);
    const { token, inviteId } = await seedInvite(fixture);
    const fulfill = () =>
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: request.id,
        filename: "stromrechnung.pdf",
        contentType: "application/pdf",
        bytes: PDF_BYTES,
      });
    await fulfill();
    await expect(fulfill()).rejects.toBeInstanceOf(FileRequestConflictError);

    // Fremde Request-ID unter gültigem Token: kein Orakel-Unterschied.
    await expect(
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: randomUUID(),
        filename: "stromrechnung.pdf",
        contentType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(FileRequestNotFoundError);

    // Ungültiges Token, Typ, Größe, Endung.
    await expect(
      fulfillFileRequestByToken(testPool, {
        token: "definitiv-ungueltig",
        requestId: request.id,
        filename: "stromrechnung.pdf",
        contentType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(FileRequestNotFoundError);
    await expect(
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: request.id,
        filename: "rechnung.exe",
        contentType: "application/x-msdownload",
        bytes: PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(FileRequestValidationError);
    await expect(
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: request.id,
        filename: "bild.png",
        contentType: "image/png",
        bytes: Buffer.alloc(10_485_761),
      }),
    ).rejects.toBeInstanceOf(FileRequestValidationError);
    await expect(
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: request.id,
        filename: "foto.jpg",
        contentType: "image/png",
        bytes: PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(FileRequestValidationError);

    // Entzogener Link erfüllt nichts mehr.
    const second = await seedRequest(fixture, "Netzanschluss-Bestätigung");
    await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId,
        reason: "user_request",
      }),
    );
    await expect(
      fulfillFileRequestByToken(testPool, {
        token,
        requestId: second.id,
        filename: "bestaetigung.pdf",
        contentType: "application/pdf",
        bytes: PDF_BYTES,
      }),
    ).rejects.toBeInstanceOf(FileRequestNotFoundError);
  });

  it("F1004-DB-04: interne Übergänge erledigt/storniert, illegal fail-closed", async () => {
    const open = await seedRequest(fixture, "Offen");
    const stored = await seedRequest(fixture, "Hochgeladen-Test");
    const { token } = await seedInvite(fixture);
    await fulfillFileRequestByToken(testPool, {
      token,
      requestId: stored.id,
      filename: "beleg.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });

    // offen → erledigt ist illegal (kein Beleg vorhanden).
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionFileRequest(tx, ctx, { projectId: fixture.projectId, requestId: open.id, status: "erledigt" }),
      ),
    ).rejects.toBeInstanceOf(FileRequestValidationError);

    const done = await asEditor(fixture, (tx, ctx) =>
      transitionFileRequest(tx, ctx, { projectId: fixture.projectId, requestId: stored.id, status: "erledigt" }),
    );
    expect(done.status).toBe("erledigt");
    expect(done.completedAt).not.toBeNull();

    const cancelled = await asEditor(fixture, (tx, ctx) =>
      transitionFileRequest(tx, ctx, { projectId: fixture.projectId, requestId: open.id, status: "storniert" }),
    );
    expect(cancelled.status).toBe("storniert");
    await expect(
      asEditor(fixture, (tx, ctx) =>
        transitionFileRequest(tx, ctx, { projectId: fixture.projectId, requestId: open.id, status: "erledigt" }),
      ),
    ).rejects.toBeInstanceOf(FileRequestValidationError);

    // Erledigte/stornierte Anfragen verschwinden aus der Portal-Projektion.
    const view = await resolvePortalByToken(testPool, { token });
    expect(view.fileRequests).toHaveLength(0);
  });
});
