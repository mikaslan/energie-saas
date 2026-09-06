import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES,
  CHECKLIST_NODES_MAX,
  CHECKLIST_POSITION_MAX,
  CHECKLIST_SCHEMA_VERSION,
  checklistProgress,
  editableChecklistBlocksSchema,
  segmentItemProgress,
  toEditableChecklistBlocks,
  withOpenSegmentMetadata,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistSegmentIncompleteError,
  ChecklistValidationError,
  completeChecklistSegment,
  getProjectChecklist,
  saveProjectChecklist,
  unlockChecklistSegment,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  projectId: string;
};

type TreeIds = {
  blockId: string;
  segmentId: string;
  firstItemId: string;
  secondItemId: string;
};

function treeIds(): TreeIds {
  return {
    blockId: randomUUID(),
    segmentId: randomUUID(),
    firstItemId: randomUUID(),
    secondItemId: randomUUID(),
  };
}

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f704.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f704.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f704.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
  });
  const projectId = await seedProject(workspaceId, "F7.4 Projekt");
  return { workspaceId, editorId, viewerId, adminId, projectId };
}

async function seedProject(workspaceId: string, name: string): Promise<string> {
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${name}, 'F7', 'Fixture',
        ${`${contactId}@f704.test`}, ${`${contactId}@f704.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${name} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${name}, 'fixture'
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
  return projectId;
}

async function activateInstallation(fixture: Fixture, createRow = true): Promise<void> {
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      update project set phase = 'installation', updated_at = statement_timestamp()
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `);
    if (createRow) {
      await tx.execute(sql`
        insert into installation (workspace_id, project_id, source, status)
        values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', 'active')
      `);
    }
  });
}

function blocks(
  ids: TreeIds = treeIds(),
  options: {
    firstDone?: boolean;
    firstRequired?: boolean;
    secondVisible?: boolean;
    secondRequired?: boolean;
  } = {},
): EditableChecklistBlocksV2 {
  return [{
    id: ids.blockId,
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: ids.segmentId,
      name: "Basis",
      position: 0,
      visible: true,
      items: [
        {
          id: ids.firstItemId,
          title: "Dach geprüft",
          done: options.firstDone ?? false,
          required: options.firstRequired ?? false,
          visible: true,
        },
        {
          id: ids.secondItemId,
          title: "Zählerschrank dokumentiert",
          done: false,
          required: options.secondRequired ?? false,
          visible: options.secondVisible ?? true,
        },
      ],
    }],
  }];
}

function denseChecklistTree(totalNodes: number): EditableChecklistBlocksV2 {
  if (totalNodes < 1) throw new Error("dense checklist needs at least one node");

  const tree: EditableChecklistBlocksV2 = [{
    id: randomUUID(),
    name: "Grossprojekt",
    position: 0,
    visible: true,
    segments: [],
  }];
  let remainingNodes = totalNodes - 1;
  let segmentPosition = 0;
  while (remainingNodes > 0) {
    const itemCount = Math.min(500, remainingNodes - 1);
    tree[0]!.segments.push({
      id: randomUUID(),
      name: `Abschnitt ${segmentPosition + 1}`,
      position: segmentPosition,
      visible: true,
      items: Array.from({ length: itemCount }, (_, itemPosition) => ({
        id: randomUUID(),
        title: `Pruefpunkt ${segmentPosition + 1}.${itemPosition + 1}`,
        done: false,
        required: false,
        visible: true,
      })),
    });
    remainingNodes -= itemCount + 1;
    segmentPosition += 1;
  }
  return tree;
}

function transportBoundaryChecklistTree(): EditableChecklistBlocksV2 {
  const itemCount = CHECKLIST_NODES_MAX - 2;
  return [{
    id: randomUUID(),
    name: "漢".repeat(200),
    position: CHECKLIST_POSITION_MAX,
    visible: false,
    segments: [{
      id: randomUUID(),
      name: "漢".repeat(200),
      position: CHECKLIST_POSITION_MAX,
      visible: false,
      items: Array.from({ length: itemCount }, () => ({
        id: randomUUID(),
        title: "漢".repeat(500),
        done: false,
        required: false,
        visible: false,
      })),
    }],
  }];
}

function command(
  projectId: string,
  baseVersion: number,
  value: EditableChecklistBlocksV2,
  checklistId: string | null = null,
): SaveProjectChecklistCommand {
  return {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId,
    projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion,
    blocks: value,
  };
}

function updateCommand(
  checklist: ProjectChecklistDto,
  value = toEditableChecklistBlocks(checklist.blocks),
): SaveProjectChecklistCommand {
  return command(checklist.projectId, checklist.version, value, checklist.checklistId);
}

describe("F7.2/F7.4 Projekt-Checklisten (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7.4 Checklisten");
  });

  it("F702-DB-01: Leer-Read, stabile IDs, Answer-Save und CAS", async () => {
    const ids = treeIds();
    const empty = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(empty).toMatchObject({ version: 0, checklistId: null, blocks: [] });

    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks(ids))),
    );
    expect(created.version).toBe(1);
    expect(created.checklistId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.blocks[0]!.id).toBe(ids.blockId);
    expect(created.blocks[0]!.segments[0]!.id).toBe(ids.segmentId);

    const answers = toEditableChecklistBlocks(created.blocks);
    answers[0]!.segments[0]!.items[0]!.done = true;
    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, updateCommand(created, answers)),
    );
    expect(updated.version).toBe(2);
    expect(updated.blocks[0]!.segments[0]!.items[0]!.done).toBe(true);
    expect(updated.blocks[0]!.segments[0]!.id).toBe(ids.segmentId);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, updateCommand(created)),
    )).rejects.toBeInstanceOf(ChecklistConflictError);
  });

  it("F702-DB-02: tiefe Validierung, eindeutige IDs und Admin-Konfiguration", async () => {
    const ids = treeIds();
    const valid = command(fixture.projectId, 0, blocks(ids));
    const invalidCommands: SaveProjectChecklistCommand[] = [
      { ...valid, title: "  " },
      { ...valid, blocks: [{ ...blocks(ids)[0]!, name: "x".repeat(201) }] },
      { ...valid, blocks: [{ ...blocks(ids)[0]!, position: -1 }] },
      {
        ...valid,
        blocks: [{
          ...blocks(ids)[0]!,
          segments: [{
            ...blocks(ids)[0]!.segments[0]!,
            items: [
              blocks(ids)[0]!.segments[0]!.items[0]!,
              { ...blocks(ids)[0]!.segments[0]!.items[1]!, id: ids.firstItemId },
            ],
          }],
        }],
      },
    ];
    for (const invalid of invalidCommands) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx, ctx) => saveProjectChecklist(tx, ctx, invalid),
      )).rejects.toBeInstanceOf(ChecklistValidationError);
    }

    const requiredTree = blocks(ids, { firstRequired: true });
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, requiredTree)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        ...command(fixture.projectId, 0, blocks()),
        phase: "qualification",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const configured = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, requiredTree)),
    );
    expect(configured.permissions.canConfigure).toBe(true);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        ...updateCommand(configured),
        title: "Editor-Strukturänderung",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(randomUUID(), 0, blocks())),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into project_checklist (workspace_id, project_id, blocks, created_by)
      values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, '{}'::jsonb, ${fixture.editorId}::uuid)
    `))).rejects.toThrow();
  });

  it("F702-DB-02a: globales Knotenlimit gilt in Zod und direkt im DB-Capsule", async () => {
    const atLimit = denseChecklistTree(CHECKLIST_NODES_MAX);
    const overLimit = denseChecklistTree(CHECKLIST_NODES_MAX + 1);
    const transportBoundary = transportBoundaryChecklistTree();
    const positionOverflow = blocks();
    positionOverflow[0]!.position = CHECKLIST_POSITION_MAX + 1;
    const segmentPositionOverflow = blocks();
    segmentPositionOverflow[0]!.segments[0]!.position = CHECKLIST_POSITION_MAX + 1;
    expect(editableChecklistBlocksSchema.safeParse(atLimit).success).toBe(true);
    expect(editableChecklistBlocksSchema.safeParse(overLimit).success).toBe(false);
    expect(editableChecklistBlocksSchema.safeParse(transportBoundary).success).toBe(true);
    expect(editableChecklistBlocksSchema.safeParse(positionOverflow).success).toBe(false);
    expect(editableChecklistBlocksSchema.safeParse(segmentPositionOverflow).success).toBe(false);
    const boundaryBytes = new TextEncoder().encode(JSON.stringify(transportBoundary)).byteLength;
    expect(boundaryBytes).toBeGreaterThan(750_000);
    expect(boundaryBytes).toBeLessThanOrEqual(CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES);

    const duplicate = blocks();
    duplicate[0]!.segments[0]!.items[1]!.id = duplicate[0]!.id;
    for (const rejected of [overLimit, duplicate, positionOverflow, segmentPositionOverflow]) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx) => tx.execute(sql`
          select public.save_project_checklist_v2(
            ${fixture.workspaceId}::uuid,
            ${fixture.projectId}::uuid,
            null::uuid,
            'site_documentation'::text,
            'Baustellendokumentation'::text,
            0,
            ${JSON.stringify(rejected)}::jsonb
          )
        `),
      )).rejects.toMatchObject({ cause: { code: "23514" } });
    }

    const countAfterRejects = await withTenantOn(
      testPool, fixture.workspaceId,
      (tx) => tx.execute<{ count: string }>(sql`
        select pg_catalog.count(*)::text as count
          from public.project_checklist
         where workspace_id = ${fixture.workspaceId}::uuid
           and project_id = ${fixture.projectId}::uuid
      `),
    );
    expect(countAfterRejects.rows[0]?.count).toBe("0");

    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx) => tx.execute(sql`
        select public.save_project_checklist_v2(
          ${fixture.workspaceId}::uuid,
          ${fixture.projectId}::uuid,
          null::uuid,
          'site_documentation'::text,
          'Baustellendokumentation'::text,
          0,
          ${JSON.stringify(atLimit)}::jsonb
        )
      `),
    )).resolves.toBeDefined();

    const boundaryProjectId = await seedProject(fixture.workspaceId, "F7.4 Transportgrenze");
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx) => tx.execute(sql`
        select public.save_project_checklist_v2(
          ${fixture.workspaceId}::uuid,
          ${boundaryProjectId}::uuid,
          null::uuid,
          'site_documentation'::text,
          'Baustellendokumentation'::text,
          0,
          ${JSON.stringify(transportBoundary)}::jsonb
        )
      `),
    )).resolves.toBeDefined();
  });

  it("F702-DB-02b: DB-Capsule akzeptiert exakt den kanonischen Zod-Textvertrag", async () => {
    const defaultTitle = "Baustellendokumentation";
    const zeroWidthTree = blocks();
    zeroWidthTree[0]!.name = "PV\u200B";
    const nonCanonicalTree = blocks();
    nonCanonicalTree[0]!.segments[0]!.name = "A\u030A";
    const utf16OverflowTree = blocks();
    utf16OverflowTree[0]!.name = "😀".repeat(101);
    const itemUtf16OverflowTree = blocks();
    itemUtf16OverflowTree[0]!.segments[0]!.items[0]!.title = "😀".repeat(251);
    const unicodeTrimTree = blocks();
    unicodeTrimTree[0]!.segments[0]!.items[0]!.title = "\u1680Dach geprüft";
    const postgresNfkcGapTree = blocks();
    postgresNfkcGapTree[0]!.name = "\uA7F1";
    for (const loneSurrogate of ["\uD800", "\uDC00", "A\uD800B"]) {
      const malformed = blocks();
      malformed[0]!.segments[0]!.items[0]!.title = loneSurrogate;
      expect(editableChecklistBlocksSchema.safeParse(malformed).success).toBe(false);
      await expect(withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx, ctx) => saveProjectChecklist(
          tx,
          ctx,
          command(fixture.projectId, 0, malformed),
        ),
      )).rejects.toBeInstanceOf(ChecklistValidationError);
    }
    const invalidRawInputs = [
      { title: `Baustellen\u202Edokumentation`, value: blocks() },
      { title: `Baustellen\u00ADdokumentation`, value: blocks() },
      { title: "Baustellen\u0001dokumentation", value: blocks() },
      { title: "Baustellen\u0085dokumentation", value: blocks() },
      { title: "Ａ", value: blocks() },
      { title: "ﬁ", value: blocks() },
      { title: defaultTitle, value: zeroWidthTree },
      { title: defaultTitle, value: nonCanonicalTree },
      { title: defaultTitle, value: utf16OverflowTree },
      { title: defaultTitle, value: itemUtf16OverflowTree },
      { title: defaultTitle, value: unicodeTrimTree },
      { title: defaultTitle, value: postgresNfkcGapTree },
      { title: "\u2028Baustellendokumentation", value: blocks() },
      { title: "Baustellendokumentation\u2029", value: blocks() },
    ];

    for (const input of invalidRawInputs) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx) => tx.execute(sql`
          select public.save_project_checklist_v2(
            ${fixture.workspaceId}::uuid,
            ${fixture.projectId}::uuid,
            null::uuid,
            'site_documentation'::text,
            ${input.title}::text,
            0,
            ${JSON.stringify(input.value)}::jsonb
          )
        `),
      )).rejects.toMatchObject({ cause: { code: "23514" } });
    }

    const countAfterRejects = await withTenantOn(
      testPool, fixture.workspaceId,
      (tx) => tx.execute<{ count: string }>(sql`
        select count(*)::text as count
          from project_checklist
         where workspace_id = ${fixture.workspaceId}::uuid
           and project_id = ${fixture.projectId}::uuid
      `),
    );
    expect(countAfterRejects.rows[0]?.count).toBe("0");

    const exactUtf16Boundary = blocks();
    exactUtf16Boundary[0]!.name = "😀".repeat(100);
    exactUtf16Boundary[0]!.segments[0]!.name = "Innen\u1680Abstand";
    exactUtf16Boundary[0]!.segments[0]!.items[0]!.title = "😀".repeat(250);
    exactUtf16Boundary[0]!.segments[0]!.items[1]!.title = "Innen\u2028Umbruch";
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(
        tx,
        ctx,
        command(fixture.projectId, 0, exactUtf16Boundary),
      ),
    )).resolves.toMatchObject({ version: 1 });

    const normalizedByZod = blocks();
    normalizedByZod[0]!.name = "\uA7F1";
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(
        tx,
        ctx,
        command(fixture.projectId, 0, normalizedByZod),
      ),
    )).resolves.toMatchObject({ blocks: [{ name: "S" }] });

    const nodeNormalizationCases: Array<{
      codepoint: number;
      rawValue: string;
      nodeValue: string;
    }> = [];
    for (let codepoint = 1; codepoint <= 0x10FFFF; codepoint += 1) {
      if (codepoint >= 0xD800 && codepoint <= 0xDFFF) continue;
      const rawValue = String.fromCodePoint(codepoint);
      const nodeValue = rawValue.normalize("NFKC");
      if (rawValue !== nodeValue) {
        nodeNormalizationCases.push({ codepoint, rawValue, nodeValue });
      }
    }
    const normalizationDrift = await withTenantOn(
      testPool, fixture.workspaceId,
      (tx) => tx.execute<{ codepoint: number }>(sql`
        select candidate.codepoint
          from pg_catalog.jsonb_to_recordset(
            ${JSON.stringify(nodeNormalizationCases)}::jsonb
          ) as candidate(codepoint integer, "rawValue" text, "nodeValue" text)
         where normalize(candidate."rawValue", NFKC)
               is distinct from candidate."nodeValue"
         order by candidate.codepoint
      `),
    );
    const knownPostgresUnicodeGaps = new Set([0xA7F1]);
    expect(normalizationDrift.rows
      .map((row) => row.codepoint)
      .filter((codepoint) => !knownPostgresUnicodeGaps.has(codepoint)))
      .toEqual([]);
  });

  it("F702-DB-02c: Editor darf done nur auf durchgehend sichtbaren Pfaden ändern", async () => {
    const hiddenVariants = [
      (value: EditableChecklistBlocksV2) => { value[0]!.visible = false; },
      (value: EditableChecklistBlocksV2) => { value[0]!.segments[0]!.visible = false; },
      (value: EditableChecklistBlocksV2) => { value[0]!.segments[0]!.items[0]!.visible = false; },
    ];

    for (const hide of hiddenVariants) {
      const configuredTree = blocks();
      hide(configuredTree);
      const created = await withAuthorizedTenantOn(
        testPool, fixture.adminId, fixture.workspaceId,
        (tx, ctx) => saveProjectChecklist(
          tx,
          ctx,
          command(fixture.projectId, 0, configuredTree),
        ),
      );
      const forged = toEditableChecklistBlocks(created.blocks);
      forged[0]!.segments[0]!.items[0]!.done = true;

      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx) => tx.execute(sql`
          select public.save_project_checklist_v2(
            ${fixture.workspaceId}::uuid,
            ${fixture.projectId}::uuid,
            ${created.checklistId}::uuid,
            'site_documentation'::text,
            'Baustellendokumentation'::text,
            ${created.version},
            ${JSON.stringify(forged)}::jsonb
          )
        `),
      )).rejects.toMatchObject({ cause: { code: "42501" } });

      const persisted = await withTenantOn(
        testPool, fixture.workspaceId,
        (tx) => tx.execute<{ done: string }>(sql`
          select blocks #>> '{0,segments,0,items,0,done}' as done
            from project_checklist
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${created.checklistId}::uuid
        `),
      );
      expect(persisted.rows[0]?.done).toBe("false");
    }
  });

  it("F702-DB-03: mehrere Checklisten je Phase und Cross-Workspace-Isolation", async () => {
    const other = await seedWorkspace("F7.4 Fremd");
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks())),
    );
    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks())),
    );
    expect(second.checklistId).not.toBe(first.checklistId);

    const selected = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(selected.checklistId).toBe(first.checklistId);

    const foreign = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(foreign.version).toBe(0);
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks())),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F702-DB-03b: parallele Creates bleiben getrennte Checklisten", async () => {
    const save = () => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks())),
    );
    const [first, second] = await Promise.all([save(), save()]);
    expect(first.checklistId).not.toBe(second.checklistId);
  });

  it("F702-DB-03c: External-Ctx fail-closed vor Projekt-Lookup", async () => {
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update membership set capabilities = '{"external_only":true}'::jsonb
         where workspace_id = ${fixture.workspaceId}::uuid
           and user_id = ${fixture.viewerId}::uuid
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks())),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F702-DB-04: Rollen und getrennte Item-/Segmentfortschritte", async () => {
    const editable = blocks(treeIds(), { firstDone: true });
    const open = withOpenSegmentMetadata(editable);
    expect(segmentItemProgress(open[0]!.segments[0]!)).toEqual({ done: 1, total: 2 });
    expect(checklistProgress(open)).toEqual({ done: 0, total: 1 });
    open[0]!.segments[0]!.completedAt = new Date().toISOString();
    open[0]!.segments[0]!.completedById = fixture.editorId;
    expect(checklistProgress(open)).toEqual({ done: 1, total: 1 });

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks())),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    const viewerRead = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(viewerRead.permissions).toEqual({
      canWrite: false,
      canConfigure: false,
      canComplete: false,
      canUnlock: false,
    });
  });

  it("F704-DB-01: Required-Gate, Replay, Segment-Lock und Admin-Unlock", async () => {
    await activateInstallation(fixture);
    const ids = treeIds();
    const configured = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks(ids, {
        firstRequired: true,
        secondRequired: true,
        secondVisible: false,
      }))),
    );

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: configured.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: configured.version,
      }),
    )).rejects.toMatchObject({
      name: ChecklistSegmentIncompleteError.name,
      remainingRequired: 1,
    });

    const answers = toEditableChecklistBlocks(configured.blocks);
    answers[0]!.segments[0]!.items[0]!.done = true;
    const answered = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, updateCommand(configured, answers)),
    );
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: answered.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: answered.version,
      }),
    );
    expect(completed.version).toBe(3);
    expect(completed.blocks[0]!.segments[0]).toMatchObject({
      completedById: fixture.editorId,
      items: [expect.objectContaining({ done: true }), expect.objectContaining({ done: false })],
    });
    expect(completed.blocks[0]!.segments[0]!.completedAt).not.toBeNull();

    const replayed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: answered.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: answered.version,
      }),
    );
    expect(replayed.version).toBe(3);
    expect(replayed.blocks[0]!.segments[0]!.completedAt)
      .toBe(completed.blocks[0]!.segments[0]!.completedAt);

    const changedCompleted = toEditableChecklistBlocks(completed.blocks);
    changedCompleted[0]!.segments[0]!.items[0]!.done = false;
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, updateCommand(completed, changedCompleted)),
    )).rejects.toBeInstanceOf(ChecklistValidationError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unlockChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: completed.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: completed.version,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const unlocked = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => unlockChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: completed.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: completed.version,
      }),
    );
    expect(unlocked.version).toBe(4);
    expect(unlocked.blocks[0]!.segments[0]!.completedAt).toBeNull();
    expect(toEditableChecklistBlocks(unlocked.blocks)).toEqual(toEditableChecklistBlocks(completed.blocks));

    const unlockReplay = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => unlockChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: completed.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: completed.version,
      }),
    );
    expect(unlockReplay.version).toBe(4);

    const evidence = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      event_type: string;
      count: string;
    }>(sql`
      select event_type, count(*)::text as count
        from domain_events
       where workspace_id = ${fixture.workspaceId}::uuid
         and aggregate_id = ${completed.checklistId}::uuid
         and event_type in ('checklist.segment_completed', 'checklist.segment_unlocked')
       group by event_type
       order by event_type
    `));
    expect(evidence.rows).toEqual([
      { event_type: "checklist.segment_completed", count: "1" },
      { event_type: "checklist.segment_unlocked", count: "1" },
    ]);
  });

  it("F704-DB-02: Baustellendokumentation verlangt Projektphase und Installation", async () => {
    const ids = treeIds();
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, command(fixture.projectId, 0, blocks(ids))),
    );
    const mutate = () => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: created.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: created.version,
      }),
    );
    await expect(mutate()).rejects.toBeInstanceOf(ChecklistValidationError);
    await activateInstallation(fixture, false);
    await expect(mutate()).rejects.toBeInstanceOf(ChecklistValidationError);

    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into installation (workspace_id, project_id, source, status)
      values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', 'active')
    `));
    await expect(mutate()).resolves.toMatchObject({ version: 2 });
  });
});
