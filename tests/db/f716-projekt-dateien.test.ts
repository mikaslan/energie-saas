import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// F7-16: steuerbarer Storage — Standard delegiert ans echte lokale
// Backend, U-04/U-05 injizieren Beleg-Fehler (kein anderer Weg: der Key
// enthaelt eine frische UUID und ist nicht vorbesetzbar).
const storageOverride = vi.hoisted(() => ({
  put: null as null | ((
    key: string,
    body: Buffer,
    contentType: string,
  ) => Promise<{ key: string; sha256: string }>),
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    resolveObjectStorage: () => {
      const real = actual.resolveObjectStorage();
      if (!storageOverride.put) return real;
      const put = storageOverride.put;
      return { ...real, putImmutable: put };
    },
  };
});

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f716-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  downloadProjectFile,
  listProjectFiles,
  PROJECT_FILE_MAX_BYTES,
  ProjectFileNotFoundError,
  ProjectFileValidationError,
  uploadProjectFile,
} from "@/modules/project-files";
import { testPool } from "../setup/test-db";

/**
 * F7-16 Projekt-Dateien-Kern (Katalog F7.1/F10.2-Vorstufe) — DB-Vertrag
 * D-01..D-10 (Tabelle project_file, Migration 0181) + Service-Units
 * U-02..U-07 (U-01 liegt als reiner Contract-Test in
 * tests/unit/f716-projekt-dateien.test.ts). Fixture nach F10-04.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
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
      values (${editorId}::uuid, ${`editor-${editorId}@f716.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f716.test`}),
             (${externalId}::uuid, ${`extern-${externalId}@f716.test`})
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
        ${`${contactId}@f716.test`}, ${`${contactId}@f716.test`})
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

function validRow(fx: Fixture, overrides: Record<string, unknown> = {}): Record<string, string | number> {
  const fileId = randomUUID();
  return {
    id: fileId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    storageKey: `immutable/${fx.projectId}/project-files/${fileId}_a1b2c3d4.pdf`,
    fileSha256: createHash("sha256").update(PDF_MINIMAL).digest("hex"),
    contentType: "application/pdf",
    byteSize: PDF_MINIMAL.byteLength,
    originalFilename: "Plan.pdf",
    createdBy: fx.editorId,
    ...overrides,
  } as Record<string, string | number>;
}

async function insertRow(fx: Fixture, row: Record<string, string | number>): Promise<void> {
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into project_file (
        id, workspace_id, project_id, storage_key, file_sha256,
        content_type, byte_size, original_filename, created_by
      )
      values (
        ${row.id}::uuid, ${row.workspaceId}::uuid, ${row.projectId}::uuid,
        ${row.storageKey}, ${row.fileSha256}, ${row.contentType},
        ${row.byteSize}, ${row.originalFilename}, ${row.createdBy}::uuid
      )
    `);
  });
}

async function rowCount(fx: Fixture): Promise<number> {
  const result = await withTenantOn(testPool, fx.workspaceId, (tx) =>
    tx.execute<{ count: string }>(sql`
      select count(*)::text as count from project_file
       where workspace_id = ${fx.workspaceId}::uuid
    `),
  );
  return Number(result.rows[0]?.count ?? 0);
}

// Rekursiv: LocalStorage legt Unterverzeichnisse je Key an.
function storageFileCount(): number {
  const dir = process.env.STORAGE_LOCAL_DIR!;
  let count = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(path, entry.name));
      else count += 1;
    }
  };
  walk(dir);
  return count;
}

describe("F7-16 Projekt-Dateien (PostgreSQL + LocalStorage)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    storageOverride.put = null;
    fixture = await seedFixture(`F716 ${randomUUID()}`);
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;
  const asExternal = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, fn as never) as Promise<T>;

  it("D-01: gueltiger INSERT wird gelesen", async () => {
    await insertRow(fixture, validRow(fixture));
    expect(await rowCount(fixture)).toBe(1);
  });

  it("D-02: leerer oder zu langer Dateiname verletzt den CHECK", async () => {
    await expect(insertRow(fixture, validRow(fixture, { originalFilename: "   " })))
      .rejects.toThrow();
    await expect(insertRow(fixture, validRow(fixture, { originalFilename: "a".repeat(181) })))
      .rejects.toThrow();
    expect(await rowCount(fixture)).toBe(0);
  });

  it("D-03: MIME ausserhalb des Enums verletzt den CHECK", async () => {
    await expect(insertRow(fixture, validRow(fixture, { contentType: "text/plain" })))
      .rejects.toThrow();
    expect(await rowCount(fixture)).toBe(0);
  });

  it("D-04: byte_size 0 oder ueber 25 MiB verletzt den CHECK", async () => {
    await expect(insertRow(fixture, validRow(fixture, { byteSize: 0 }))).rejects.toThrow();
    await expect(insertRow(fixture, validRow(fixture, { byteSize: PROJECT_FILE_MAX_BYTES + 1 })))
      .rejects.toThrow();
    expect(await rowCount(fixture)).toBe(0);
  });

  it("D-05: Key mit fremder Domain verletzt den CHECK", async () => {
    const fileId = randomUUID();
    await expect(insertRow(fixture, validRow(fixture, {
      storageKey: `immutable/${fixture.projectId}/checklist-photos/${fileId}_a1b2c3d4.jpg`,
    }))).rejects.toThrow();
    expect(await rowCount(fixture)).toBe(0);
  });

  it("D-06: sha256 ausserhalb 64-hex verletzt den CHECK", async () => {
    await expect(insertRow(fixture, validRow(fixture, { fileSha256: "xyz" }))).rejects.toThrow();
    await expect(insertRow(fixture, validRow(fixture, {
      fileSha256: "A".repeat(64),
    }))).rejects.toThrow();
    expect(await rowCount(fixture)).toBe(0);
  });

  it("D-07: Fremdprojekt verletzt die FK", async () => {
    await expect(insertRow(fixture, validRow(fixture, { projectId: randomUUID() })))
      .rejects.toThrow();
    expect(await rowCount(fixture)).toBe(0);
  });

  it("D-08: RLS — fremder Workspace liest nichts", async () => {
    await insertRow(fixture, validRow(fixture));
    const other = await seedFixture(`F716-fremd ${randomUUID()}`);
    const seen = await withTenantOn(testPool, other.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`select id from project_file`),
    );
    expect(seen.rows).toHaveLength(0);
    expect(await rowCount(fixture)).toBe(1);
  });

  it("D-09: Zweit-Upload derselben Bytes = zweite Zeile (eigener Key, kein Dedupe)", async () => {
    const first = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PNG_1X1,
        filename: "Zaehler.png",
        contentType: "image/png",
      }),
    );
    const second = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PNG_1X1,
        filename: "Zaehler.png",
        contentType: "image/png",
      }),
    );
    expect(first.fileId).not.toBe(second.fileId);
    expect(await rowCount(fixture)).toBe(2);
    const keys = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute<{ storage_key: string }>(sql`
        select storage_key from project_file
         where workspace_id = ${fixture.workspaceId}::uuid
         order by storage_key
      `),
    );
    expect(keys.rows).toHaveLength(2);
    expect(keys.rows[0]?.storage_key).not.toBe(keys.rows[1]?.storage_key);
    // Download beider Zeilen liefert dieselben Bytes.
    for (const { fileId } of [first, second]) {
      const got = await asEditor(fixture, (tx, ctx) =>
        downloadProjectFile(tx, ctx, { projectId: fixture.projectId, fileId }),
      );
      expect(Buffer.from(got.body)).toEqual(PNG_1X1);
      expect(got.filename).toBe("Zaehler.png");
      expect(got.contentType).toBe("image/png");
    }
  });

  it("D-10: Externer (viewer + external_only) scheitert an Upload, Liste und Download", async () => {
    const seeded = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(asExternal(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Boese.pdf",
        contentType: "application/pdf",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asExternal(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asExternal(fixture, (tx, ctx) =>
      downloadProjectFile(tx, ctx, { projectId: fixture.projectId, fileId: seeded.fileId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    // Interner Viewer darf lesen, aber nicht schreiben.
    const listed = await asViewer(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed).toHaveLength(1);
    await expect(asViewer(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Viewer.pdf",
        contentType: "application/pdf",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("U-02: Fehltyp, Endungs-Mismatch, 0 Bytes und Uebergroesse scheitern VOR dem Put", async () => {
    const before = storageFileCount();
    const cases: Array<{ filename: string; contentType: string; bytes: Buffer }> = [
      { filename: "Notizen.txt", contentType: "text/plain", bytes: PDF_MINIMAL },
      { filename: "Plan.pdf", contentType: "image/png", bytes: PNG_1X1 },
      { filename: "Foto.bmp", contentType: "image/png", bytes: PNG_1X1 },
      { filename: "Leer.pdf", contentType: "application/pdf", bytes: Buffer.alloc(0) },
      {
        filename: "Riese.pdf",
        contentType: "application/pdf",
        bytes: Buffer.alloc(PROJECT_FILE_MAX_BYTES + 1),
      },
      { filename: "   ", contentType: "application/pdf", bytes: PDF_MINIMAL },
      { filename: "a".repeat(181), contentType: "application/pdf", bytes: PDF_MINIMAL },
    ];
    for (const input of cases) {
      await expect(asEditor(fixture, (tx, ctx) =>
        uploadProjectFile(tx, ctx, { projectId: fixture.projectId, ...input }),
      )).rejects.toBeInstanceOf(ProjectFileValidationError);
    }
    expect(storageFileCount()).toBe(before);
    expect(await rowCount(fixture)).toBe(0);
  });

  it("U-03: Fremdprojekt scheitert mit NotFound (ohne Storage-Orphan)", async () => {
    const before = storageFileCount();
    await expect(asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: randomUUID(),
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    expect(storageFileCount()).toBe(before);
  });

  it("U-04: Beleg-Hash-Mismatch scheitert mit ValidationError", async () => {
    storageOverride.put = async (key) => ({ key, sha256: "0".repeat(64) });
    await expect(asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    )).rejects.toBeInstanceOf(ProjectFileValidationError);
    expect(await rowCount(fixture)).toBe(0);
  });

  it("U-05: WORM-Konflikt scheitert fail-closed mit ValidationError", async () => {
    storageOverride.put = async (key) => {
      throw new Error(`Objekt existiert bereits (WORM): ${key}`);
    };
    await expect(asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    )).rejects.toBeInstanceOf(ProjectFileValidationError);
    expect(await rowCount(fixture)).toBe(0);
  });

  it("U-06: Liste traegt keine Keys und keine Pruefsummen (newest-first)", async () => {
    const first = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PNG_1X1,
        filename: "a.png",
        contentType: "image/png",
      }),
    );
    const second = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "b.pdf",
        contentType: "application/pdf",
      }),
    );
    const listed = await asEditor(fixture, (tx, ctx) =>
      listProjectFiles(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed.map((entry) => entry.id)).toEqual([second.fileId, first.fileId]);
    for (const entry of listed) {
      // F10-17: DTO traegt zusaetzlich visibleToCustomer (Default false).
      expect(Object.keys(entry).sort()).toEqual(
        ["byteSize", "contentType", "createdAt", "id", "originalFilename", "visibleToCustomer"],
      );
      expect(entry.visibleToCustomer).toBe(false);
    }
    expect(listed[0]).toMatchObject({
      originalFilename: "b.pdf",
      contentType: "application/pdf",
      byteSize: PDF_MINIMAL.byteLength,
    });
    expect(typeof listed[0]?.createdAt).toBe("string");
  });

  it("U-07: Download mit Fremdprojekt oder Fremd-ID scheitert uniform mit NotFound", async () => {
    const seeded = await asEditor(fixture, (tx, ctx) =>
      uploadProjectFile(tx, ctx, {
        projectId: fixture.projectId,
        bytes: PDF_MINIMAL,
        filename: "Plan.pdf",
        contentType: "application/pdf",
      }),
    );
    await expect(asEditor(fixture, (tx, ctx) =>
      downloadProjectFile(tx, ctx, { projectId: randomUUID(), fileId: seeded.fileId }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) =>
      downloadProjectFile(tx, ctx, { projectId: fixture.projectId, fileId: randomUUID() }),
    )).rejects.toBeInstanceOf(ProjectFileNotFoundError);
  });
});
