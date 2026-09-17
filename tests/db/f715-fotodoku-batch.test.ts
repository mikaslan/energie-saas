import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.STORAGE_BACKEND = "local";
process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "f715-storage-"));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
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
 * F7-15 Fotodoku-Batch (Katalog F7.8) — bis zu 8 Fotos je Bild-Punkt als
 * `photos`-Array (Antwort-Nutzlast wie `photo`); `photo` bleibt das Cover
 * (= photos[0]). Validator 0180 + Zod + Service-Index.
 * Key-Schema/sha8/PNG-Fixture nach F7-02G.
 */

// 1x1-PNGs (02g transparent + rot; blau lokal aus IHDR/IDAT gebaut).
const PNG_1X1_TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1X1_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1X1_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

function sha8(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

function photoKey(projectId: string, itemId: string, digest = "a1b2c3d4"): string {
  return `immutable/${projectId}/checklist-photos/${itemId}_${digest}.jpg`;
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-15 Batch')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f715.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f715.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7-15 Batch', 'F7', 'Fixture',
        ${`${contactId}@f715.test`}, ${`${contactId}@f715.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7-15 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F7-15 Batch', 'fixture'
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

// Absichtlich ungetypt: Negativfaelle + das neue photos-Feld tragen Werte,
// die der alte Vertrag nicht kennt (TDD-RED laeuft ohne tsc-Bruch).
function patchedBlocks(
  fixture: Fixture,
  index: number,
  patch: Record<string, unknown>,
): EditableChecklistBlocksV2 {
  const blocks: EditableChecklistBlocksV2 = [{
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
        { id: fixture.imageId, title: "Zaehlerfoto", done: false, required: true, visible: true, kind: "image", photo: null },
        { id: fixture.taskId, title: "Dach geprüft", done: false, required: false, visible: true },
      ],
    }],
  }];
  Object.assign(blocks[0]!.segments[0]!.items[index]!, patch);
  return blocks;
}

function saveAs(
  fixture: Fixture,
  blocks: EditableChecklistBlocksV2,
  checklistId: string | null = null,
  baseVersion = 0,
): Promise<ProjectChecklistDto> {
  const command: SaveProjectChecklistCommand = {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId,
    projectId: fixture.projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion,
    blocks,
  };
  return withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, command),
  );
}

async function directValid(
  fixture: Fixture,
  blocks: EditableChecklistBlocksV2,
): Promise<boolean> {
  const result = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
    select public._f704_valid_checklist_blocks(${JSON.stringify(blocks)}::jsonb) as valid
  `));
  return (result.rows[0] as { valid: boolean }).valid;
}

async function structureOf(
  fixture: Fixture,
  blocks: EditableChecklistBlocksV2,
): Promise<string> {
  const result = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
    select public._f704_checklist_structure(${JSON.stringify(blocks)}::jsonb) as structure
  `));
  return JSON.stringify((result.rows[0] as { structure: unknown }).structure);
}

type PhotoReadArgs = Parameters<typeof readChecklistItemPhoto>[2];

function photoReadInput(
  fixture: Fixture,
  checklistId: string,
  itemId: string,
  index?: number,
): PhotoReadArgs {
  const base = { projectId: fixture.projectId, checklistId, itemId };
  return (index === undefined ? base : { ...base, index }) as PhotoReadArgs;
}

function photosOf(item: unknown): unknown {
  return (item as { photos?: unknown }).photos;
}

describe("F7-15 Fotodoku-Batch (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedChecklist();
  });

  it("F715-DB-01: Bildpunkt mit photos[2 Keys] persistiert (Save + Re-Read)", async () => {
    const keyA = photoKey(fixture.projectId, fixture.imageId, "a1b2c3d4");
    const keyB = photoKey(fixture.projectId, fixture.imageId, "e5f60718");
    const created = await saveAs(fixture, patchedBlocks(fixture, 0, {
      photo: keyA,
      photos: [keyA, keyB],
    }));
    expect(created.version).toBe(1);
    const items = created.blocks[0]!.segments[0]!.items;
    expect(items.find((item) => item.id === fixture.imageId)?.photo).toBe(keyA);
    expect(photosOf(items.find((item) => item.id === fixture.imageId))).toEqual([keyA, keyB]);
    expect(await directValid(fixture, patchedBlocks(fixture, 0, {
      photo: keyA,
      photos: [keyA, keyB],
    }))).toBe(true);
  });

  it("F715-DB-02: photos an Aufgabe und Signatur verletzt den CHECK", async () => {
    const key = photoKey(fixture.projectId, fixture.taskId);
    const taskBlocks = patchedBlocks(fixture, 1, { photos: [key] });
    await expect(saveAs(fixture, taskBlocks)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, taskBlocks)).toBe(false);
    const signatureBlocks = patchedBlocks(fixture, 0, {
      kind: "signature",
      photo: photoKey(fixture.projectId, fixture.imageId),
      photos: [photoKey(fixture.projectId, fixture.imageId)],
    });
    await expect(saveAs(fixture, signatureBlocks)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, signatureBlocks)).toBe(false);
  });

  it("F715-DB-03: Element mit ungueltigem Key verletzt", async () => {
    const key = photoKey(fixture.projectId, fixture.imageId);
    const blocks = patchedBlocks(fixture, 0, {
      photo: key,
      photos: [key, "immutable/x/y.png"],
    });
    await expect(saveAs(fixture, blocks)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, blocks)).toBe(false);
  });

  it("F715-DB-04: 0 oder 9 Elemente verletzen (1..8)", async () => {
    const key = photoKey(fixture.projectId, fixture.imageId);
    const digests = ["a1b2c3d4", "b2c3d4e5", "c3d4e5f6", "d4e5f607", "e5f60718", "f6071829", "0718293a", "18293a4b", "293a4b5c"];
    const nine = digests.map((digest) => photoKey(fixture.projectId, fixture.imageId, digest));
    const tooMany = patchedBlocks(fixture, 0, { photo: nine[0], photos: nine });
    await expect(saveAs(fixture, tooMany)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, tooMany)).toBe(false);
    const empty = patchedBlocks(fixture, 0, { photo: key, photos: [] });
    await expect(saveAs(fixture, empty)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, empty)).toBe(false);
  });

  it("F715-DB-05: Duplikat-Key verletzt", async () => {
    const key = photoKey(fixture.projectId, fixture.imageId);
    const blocks = patchedBlocks(fixture, 0, { photo: key, photos: [key, key] });
    await expect(saveAs(fixture, blocks)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, blocks)).toBe(false);
  });

  it("F715-DB-06: photos ohne photo / photo ungleich photos[0] verletzt", async () => {
    const keyA = photoKey(fixture.projectId, fixture.imageId, "a1b2c3d4");
    const keyB = photoKey(fixture.projectId, fixture.imageId, "e5f60718");
    const missingCover = patchedBlocks(fixture, 0, { photos: [keyA, keyB] });
    await expect(saveAs(fixture, missingCover)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, missingCover)).toBe(false);
    const wrongCover = patchedBlocks(fixture, 0, { photo: keyB, photos: [keyA, keyB] });
    await expect(saveAs(fixture, wrongCover)).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, wrongCover)).toBe(false);
  });

  it("F715-DB-07: photos-Wechsel ist keine Struktur", async () => {
    const keyA = photoKey(fixture.projectId, fixture.imageId, "a1b2c3d4");
    const keyB = photoKey(fixture.projectId, fixture.imageId, "e5f60718");
    const keyC = photoKey(fixture.projectId, fixture.imageId, "0718293a");
    const withTwo = await structureOf(fixture, patchedBlocks(fixture, 0, {
      photo: keyA,
      photos: [keyA, keyB],
    }));
    const withThree = await structureOf(fixture, patchedBlocks(fixture, 0, {
      photo: keyA,
      photos: [keyA, keyB, keyC],
    }));
    const coverOnly = await structureOf(fixture, patchedBlocks(fixture, 0, { photo: keyA }));
    expect(withTwo).toBe(withThree);
    expect(withTwo).toBe(coverOnly);
  });

  it("F715-DB-08: Legacy (photo ohne photos) bleibt gueltig", async () => {
    const key = photoKey(fixture.projectId, fixture.imageId);
    const created = await saveAs(fixture, patchedBlocks(fixture, 0, { photo: key }));
    expect(created.version).toBe(1);
    expect(await directValid(fixture, patchedBlocks(fixture, 0, { photo: key }))).toBe(true);
  });
});

describe("F7-15 Fotodoku-Batch (Service)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedChecklist();
  });

  async function upload(bytes: Buffer, filename: string): Promise<string> {
    const uploaded = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: fixture.checklistId,
        itemId: fixture.imageId,
        bytes: new Uint8Array(bytes),
        filename,
        contentType: "image/png",
      }),
    );
    return uploaded.photoKey;
  }

  async function saveGallery(checklistId: string, baseVersion: number, photo: string, photos: string[]): Promise<void> {
    const blocks = patchedBlocks(fixture, 0, { photo, photos });
    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion,
        blocks,
      }),
    );
  }

  it("F715-SVC-01: Lesen mit Index 0/1/2 liefert Cover + Folge (Default = Cover)", async () => {
    const keyA = await upload(PNG_1X1_TRANSPARENT, "a.png");
    const keyB = await upload(PNG_1X1_RED, "b.png");
    const keyC = await upload(PNG_1X1_BLUE, "c.png");
    expect(new Set([keyA, keyB, keyC]).size).toBe(3);
    await saveGallery(fixture.checklistId, 1, keyA, [keyA, keyB, keyC]);
    const readAt = (index?: number) => withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, photoReadInput(fixture, fixture.checklistId, fixture.imageId, index)),
    );
    const cover = await readAt();
    expect(cover.contentType).toBe("image/png");
    expect(Buffer.from(cover.body)).toEqual(PNG_1X1_TRANSPARENT);
    expect(Buffer.from((await readAt(0)).body)).toEqual(PNG_1X1_TRANSPARENT);
    expect(Buffer.from((await readAt(1)).body)).toEqual(PNG_1X1_RED);
    expect(Buffer.from((await readAt(2)).body)).toEqual(PNG_1X1_BLUE);
  });

  it("F715-SVC-02: Out-of-bounds-Index ist NotFound (kein Orakel)", async () => {
    const keyA = await upload(PNG_1X1_TRANSPARENT, "a.png");
    const keyB = await upload(PNG_1X1_RED, "b.png");
    await saveGallery(fixture.checklistId, 1, keyA, [keyA, keyB]);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, photoReadInput(fixture, fixture.checklistId, fixture.imageId, 2)),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F715-SVC-03: Legacy-Einzelfoto liest ohne Index", async () => {
    const key = await upload(PNG_1X1_TRANSPARENT, "zaehler.png");
    const blocks = patchedBlocks(fixture, 0, { photo: key });
    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: fixture.checklistId,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 1,
        blocks,
      }),
    );
    const readBack = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, photoReadInput(fixture, fixture.checklistId, fixture.imageId)),
    );
    expect(Buffer.from(readBack.body)).toEqual(PNG_1X1_TRANSPARENT);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, photoReadInput(fixture, fixture.checklistId, fixture.imageId, 1)),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F715-SVC-04: Fehlendes Storage-Objekt ist NotFound", async () => {
    const ghostA = photoKey(fixture.projectId, fixture.imageId, "a1b2c3d4");
    const ghostB = photoKey(fixture.projectId, fixture.imageId, "e5f60718");
    await saveGallery(fixture.checklistId, 1, ghostA, [ghostA, ghostB]);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(tx, ctx, photoReadInput(fixture, fixture.checklistId, fixture.imageId, 1)),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F715-SVC-05: Upload-Pfad unveraendert (Key-Schema, sha8, Idempotenz)", async () => {
    const first = await upload(PNG_1X1_TRANSPARENT, "zaehler.png");
    expect(first).toBe(
      `immutable/${fixture.projectId}/checklist-photos/${fixture.imageId}_${sha8(PNG_1X1_TRANSPARENT)}.png`,
    );
    const repeated = await upload(PNG_1X1_TRANSPARENT, "zaehler.png");
    expect(repeated).toBe(first);
  });

  it("F715-SVC-06: Fehler enthalten keinen Storage-Key", async () => {
    const uploadFailure = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => uploadChecklistItemPhoto(tx, ctx, {
        projectId: fixture.projectId,
        checklistId: fixture.checklistId,
        itemId: fixture.imageId,
        bytes: new Uint8Array(PNG_1X1_TRANSPARENT),
        filename: "zaehler.pdf",
        contentType: "application/pdf",
      }).then(() => null, (error: unknown) => error),
    );
    expect(String(uploadFailure)).not.toContain("immutable/");
    expect(String(uploadFailure)).not.toContain("checklist-photos");
    const keyA = await upload(PNG_1X1_TRANSPARENT, "a.png");
    await saveGallery(fixture.checklistId, 1, keyA, [keyA]);
    const readFailure = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => readChecklistItemPhoto(
        tx, ctx, photoReadInput(fixture, fixture.checklistId, fixture.imageId, 5),
      ).then(() => null, (error: unknown) => error),
    );
    expect(String(readFailure)).not.toContain("immutable/");
    expect(String(readFailure)).not.toContain("checklist-photos");
  });
});
