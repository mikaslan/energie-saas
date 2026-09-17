import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// F10-13: lokales Backend je Worker (Muster f1010 — kein S3 in Tests).
process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f1013-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { FILE_REQUEST_TEMPLATE_SCHEMA_VERSION } from "@/lib/file-request-template";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import {
  applyFileRequestTemplate,
  createFileRequest,
  createFileRequestTemplate,
  FileRequestValidationError,
  fulfillFileRequestByToken,
  listFileRequests,
  updateFileRequestTemplate,
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
      values (${editorId}::uuid, ${`editor-${editorId}@f1013.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1013.test`})
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
        ${`${contactId}@f1013.test`}, ${`${contactId}@f1013.test`})
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

const PDF_BYTES = Buffer.from("%PDF-1.4 F1013-PDF-Beleg\n", "utf8");
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x46, 0x31, 0x30, 0x31, 0x33]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x46]);

describe("F10-13 Datei-Anfragen Dateityp (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F1013 ${randomUUID()}`);
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

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

  it("F1013-DB-01: Anlage mit Typ, Default any, Vorlage + Apply-Transport, Viewer liest", async () => {
    const pdf = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Stromrechnung",
        description: null,
        fileType: "pdf",
      }),
    );
    expect(pdf.fileType).toBe("pdf");

    const image = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Zaehlerfoto",
        description: null,
        fileType: "image",
      }),
    );
    expect(image.fileType).toBe("image");

    // Ohne Typ: ehrlicher Default 'any' (verhaltenserhaltend).
    const legacy = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Alt-Anfrage",
        description: null,
      }),
    );
    expect(legacy.fileType).toBe("any");

    // Fremder Typ fail-closed (kein stiller Fallback auf any).
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFileRequest(tx, ctx, {
          projectId: fixture.projectId,
          title: "Boese",
          description: null,
          fileType: "exe",
        }),
      ),
    ).rejects.toBeInstanceOf(FileRequestValidationError);

    // Vorlage: Contract V3 traegt fileType, Apply transportiert 1:1.
    expect(FILE_REQUEST_TEMPLATE_SCHEMA_VERSION).toBe(3);
    const template = await asEditor(fixture, (tx, ctx) =>
      createFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        name: "Rechnung",
        title: "Stromrechnung einreichen",
        description: null,
        allowMany: false,
        fileType: "pdf",
      }),
    );
    expect(template.fileType).toBe("pdf");
    const updated = await asEditor(fixture, (tx, ctx) =>
      updateFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        id: template.id,
        name: "Rechnung",
        title: "Stromrechnung einreichen",
        description: null,
        allowMany: false,
        position: template.position,
        fileType: "image",
      }),
    );
    expect(updated.fileType).toBe("image");
    const applied = await asEditor(fixture, (tx, ctx) =>
      applyFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    expect(applied.request.fileType).toBe("image");

    // Viewer liest den Typ, Fremdmandant sieht nichts.
    const viewed = await asViewer(fixture, (tx, ctx) =>
      listFileRequests(tx, ctx, fixture.projectId),
    );
    expect(viewed.find((entry) => entry.id === pdf.id)?.fileType).toBe("pdf");
    const foreign = await seedFixture(`F1013 fremd ${randomUUID()}`);
    const foreignList = await withAuthorizedTenantOn(
      testPool,
      foreign.editorId,
      foreign.workspaceId,
      (tx, ctx) => listFileRequests(tx, ctx, foreign.projectId),
    );
    expect(foreignList).toEqual([]);
    // Echter Cross-Tenant-Leseversuch: fremder Actor fragt das
    // Seed-Projekt — RLS/Mandantenscope liefern ehrlich nichts.
    const crossTenant = await withAuthorizedTenantOn(
      testPool,
      foreign.editorId,
      foreign.workspaceId,
      (tx, ctx) => listFileRequests(tx, ctx, fixture.projectId),
    );
    expect(crossTenant).toEqual([]);
  });

  it("F1013-DB-02: Token-Erfuellung je Typ, Folge-Beleg, Direkt-Kapsel fail-closed", async () => {
    const pdf = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Nur PDF",
        description: null,
        fileType: "pdf",
      }),
    );
    const image = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Nur Bild",
        description: null,
        fileType: "image",
        allowMany: true,
      }),
    );
    const token = await seedInvite(fixture);
    const fulfill = (requestId: string, filename: string, contentType: string, bytes: Buffer) =>
      fulfillFileRequestByToken(testPool, { token, requestId, filename, contentType, bytes });

    // Passender Typ → ok.
    const ok = await fulfill(pdf.id, "rechnung.pdf", "application/pdf", PDF_BYTES);
    expect(ok.requestId).toBe(pdf.id);

    // Fehltyp → Validation (ungueltig), kein Beleg, kein Statuswechsel.
    await expect(
      fulfill(image.id, "foto.pdf", "application/pdf", PDF_BYTES),
    ).rejects.toBeInstanceOf(FileRequestValidationError);
    const jpg = await fulfill(image.id, "zaehler.jpg", "image/jpeg", JPG_BYTES);
    expect(jpg.requestId).toBe(image.id);
    // Folge-Beleg (Allow-many) respektiert den Typ ebenfalls.
    await expect(
      fulfill(image.id, "zweit.pdf", "application/pdf", PDF_BYTES),
    ).rejects.toBeInstanceOf(FileRequestValidationError);
    const png = await fulfill(image.id, "zaehler.png", "image/png", PNG_BYTES);
    expect(png.requestId).toBe(image.id);

    // Direkt-Kapsel mit Fehltyp → 'invalid' (Defense in Depth, Autoritaet DB).
    const { hashPortalToken } = await import("@/lib/integrations/portal/portal-contract");
    const tokenHash = hashPortalToken(token);
    expect(tokenHash).not.toBeNull();
    const direct = await testPool.query(
      `select public.fulfill_file_request(
         $1::bytea, $2::uuid, $3::text, $4::text, $5::text, $6::integer, $7::text
       ) as result`,
      [tokenHash, image.id, "immutable/x.pdf", "0".repeat(64), "application/pdf", 4, "x.pdf"],
    );
    // image-Anfrage ist bereits 'hochgeladen' → Erst-Kapsel meldet conflict;
    // die Typ-Probe braucht eine offene Fehltyp-Anfrage:
    expect(direct.rows[0].result).toBe("conflict");
    const fresh = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Frisch PDF",
        description: null,
        fileType: "pdf",
      }),
    );
    const mistyped = await testPool.query(
      `select public.fulfill_file_request(
         $1::bytea, $2::uuid, $3::text, $4::text, $5::text, $6::integer, $7::text
       ) as result`,
      [tokenHash, fresh.id, "immutable/y.jpg", "1".repeat(64), "image/jpeg", 4, "y.jpg"],
    );
    expect(mistyped.rows[0].result).toBe("invalid");
    const followupMistyped = await testPool.query(
      `select public.fulfill_file_request_followup(
         $1::bytea, $2::uuid, $3::text, $4::text, $5::text, $6::integer, $7::text
       ) as result`,
      [tokenHash, image.id, "immutable/z.pdf", "2".repeat(64), "application/pdf", 4, "z.pdf"],
    );
    expect(followupMistyped.rows[0].result).toBe("invalid");
  });

  it("F1013-DB-03: Portal-Projektion traegt fileType, nie Interna", async () => {
    const pdf = await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: fixture.projectId,
        title: "Rechnung",
        description: null,
        fileType: "pdf",
      }),
    );
    const token = await seedInvite(fixture);
    const view = await resolvePortalByToken(testPool, { token });
    const projected = view.fileRequests.find((entry) => entry.id === pdf.id);
    expect(projected).toMatchObject({ fileType: "pdf" });
    expect(JSON.stringify(view)).not.toContain("storage_key");
  });
});
