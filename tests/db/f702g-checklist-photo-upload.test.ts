import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f702g-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type EditableChecklistBlocksV2,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistNotFoundError,
  ChecklistValidationError,
  readChecklistItemPhoto,
  saveProjectChecklist,
  uploadChecklistItemPhoto,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02G Foto-Upload/-Lesen (Service): JPEG/PNG bis 10 MiB nur am
 * Bild-Punkt, projekt-skoped Keys, Beleg-Integritaet, kein Key-Leak.
 */

// 1x1-PNG (68 Byte), kleinstes gueltiges Fixture.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function sha8(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
  checklistId: string;
  blockId: string;
  segmentId: string;
  imageId: string;
  taskId: string;
};

function savedBlocksWithPhoto(fixture: Fixture, photo: string): EditableChecklistBlocksV2 {
  return [{
    id: fixture.blockId,
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: fixture.segmentId,
      name: "Protokoll",
      position: 0,
      visible: true,
      items: [
        { id: fixture.imageId, title: "Zaehlerfoto", done: false, required: true, visible: true, kind: "image", photo },
        { id: fixture.taskId, title: "Dach geprüft", done: false, required: false, visible: true },
      ],
    }],
  }];
}

async function seedChecklist(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const blockId = randomUUID();
  const segmentId = randomUUID();
  const imageId = randomUUID();
  const taskId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-02G Upload')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702g.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702g.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7-02G Upload', 'F7', 'Fixture',
        ${`${contactId}@f702g.test`}, ${`${contactId}@f702g.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7-02G Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F7-02G Upload', 'fixture'
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
  const blocks: EditableChecklistBlocksV2 = [{
    id: blockId,
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: segmentId,
      name: "Protokoll",
      position: 0,
      visible: true,
      items: [
        { id: imageId, title: "Zaehlerfoto", done: false, required: true, visible: true, kind: "image", photo: null },
        { id: taskId, title: "Dach geprüft", done: false, required: false, visible: true },
      ],
    }],
  }];
  const command: SaveProjectChecklistCommand = {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: null,
    projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion: 0,
    blocks,
  };
  const created = await withAuthorizedTenantOn(
    testPool, adminId, workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, command),
  );
  return { workspaceId, editorId, adminId, projectId, checklistId: created.checklistId!, blockId, segmentId, imageId, taskId };
}

describe("F7-02G Foto-Upload/-Lesen (Service)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedChecklist();
  });

  it("F702G-SVC-01: Upload legt projekt-skoped Key an; Save+Lesen liefern Bytes", async () => {
    const uploaded = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: fixture.checklistId,
        itemId: fixture.imageId,
        bytes: new Uint8Array(PNG_1X1),
        filename: "zaehler.png",
        contentType: "image/png",
      }),
    );
    expect(uploaded.photoKey).toMatch(
      new RegExp(`^immutable/${fixture.projectId}/checklist-photos/${fixture.imageId}_[0-9a-f]{8}\\.png$`),
    );
    // Vor dem Save liegt kein Foto am Punkt.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: fixture.checklistId,
        itemId: fixture.imageId,
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
    // Key im Tree speichern (Version 1), dann lesen.
    const saved = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: fixture.checklistId,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 1,
        blocks: savedBlocksWithPhoto(fixture, uploaded.photoKey),
      }),
    );
    expect(saved.version).toBe(2);
    const readBack = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: fixture.checklistId,
        itemId: fixture.imageId,
      }),
    );
    expect(readBack.contentType).toBe("image/png");
    expect(Buffer.from(readBack.body)).toEqual(PNG_1X1);
  });

  it("F702G-SVC-02: Fehltyp, Endungsmismatch, Uebergroesse und Leere scheitern", async () => {
    const upload = (bytes: Uint8Array, filename: string, contentType: string) =>
      withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
          projectId: fixture.projectId,
          checklistId: fixture.checklistId,
          itemId: fixture.imageId,
          bytes,
          filename,
          contentType,
        }),
      );
    await expect(upload(new Uint8Array(PNG_1X1), "zaehler.pdf", "application/pdf"))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(upload(new Uint8Array(PNG_1X1), "zaehler.jpg", "image/png"))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(upload(new Uint8Array(10_485_761), "gross.png", "image/png"))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(upload(new Uint8Array(0), "leer.png", "image/png"))
      .rejects.toBeInstanceOf(ChecklistValidationError);
  });

  it("F702G-SVC-03: Upload an Aufgabe, Fremd-Punkt und Fremd-Checkliste scheitern", async () => {
    const uploadTo = (checklistId: string, itemId: string) =>
      withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
          projectId: fixture.projectId,
          checklistId,
          itemId,
          bytes: new Uint8Array(PNG_1X1),
          filename: "zaehler.png",
          contentType: "image/png",
        }),
      );
    await expect(uploadTo(fixture.checklistId, fixture.taskId))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(uploadTo(fixture.checklistId, randomUUID()))
      .rejects.toBeInstanceOf(ChecklistNotFoundError);
    await expect(uploadTo(randomUUID(), fixture.imageId))
      .rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F702G-SVC-04: Upload vor dem ersten Save (checklistId null) gelingt", async () => {
    const preSaveItemId = randomUUID();
    const uploadPreSave = () => withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: null,
        itemId: preSaveItemId,
        bytes: new Uint8Array(PNG_1X1),
        filename: "vorab.png",
        contentType: "image/png",
      }),
    );
    const uploaded = await uploadPreSave();
    expect(uploaded.photoKey).toBe(
      `immutable/${fixture.projectId}/checklist-photos/${preSaveItemId}_${sha8(PNG_1X1)}.png`,
    );
    // Gleiche Bytes erneut = idempotenter Erfolg (gleicher Key).
    const repeated = await uploadPreSave();
    expect(repeated.photoKey).toBe(uploaded.photoKey);
  });

  it("F702G-SVC-05: Fehler enthalten keinen Storage-Key", async () => {
    const failure = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: fixture.checklistId,
        itemId: fixture.imageId,
        bytes: new Uint8Array(PNG_1X1),
        filename: "zaehler.pdf",
        contentType: "application/pdf",
      }).then(() => null, (error: unknown) => error),
    );
    expect(String(failure)).not.toContain("immutable/");
    expect(String(failure)).not.toContain("checklist-photos");
  });
});
