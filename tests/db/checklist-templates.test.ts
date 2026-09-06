import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_TEMPLATE_SCHEMA_VERSION,
  type ChecklistTemplateItemV1,
  type CreateChecklistTemplateCommand,
} from "@/lib/integrations/checklists/template-contract";
import {
  applyChecklistTemplate,
  archiveChecklistTemplate,
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistValidationError,
  createChecklistTemplate,
  listChecklistTemplates,
  restoreChecklistTemplate,
  updateChecklistTemplate,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  componentId: string;
  projectId: string;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const waiting = await testPool.query<{ wait_event_type: string | null }>(`
      select wait_event_type from pg_stat_activity where pid = $1
    `, [pid]);
    if (waiting.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Apply-Backend ${pid} wartete nicht auf den Projekt-Lock`);
}

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const componentId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f703.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f703.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
    // Eigener Katalog-Baustein (M1-08a) als Item-Referenz.
    await tx.execute(sql`
      insert into catalog_component (
        id, workspace_id, internal_sku, component_type, created_by
      ) values (
        ${componentId}::uuid, ${workspaceId}::uuid, 'WR-10K',
        'inverter', ${editorId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7.3 Projekt', 'F7', 'Drei',
        ${`${contactId}@f703.test`}, ${`${contactId}@f703.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7.3 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F7.3 Projekt', 'fixture'
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
  return { workspaceId, editorId, viewerId, componentId, projectId };
}

function item(overrides: Partial<ChecklistTemplateItemV1> = {}): ChecklistTemplateItemV1 {
  return {
    componentId: randomUUID(),
    quantity: 2,
    position: 0,
    visibleToCustomer: true,
    priceOverridesComponent: false,
    ...overrides,
  };
}

function templateCommand(
  fixture: Fixture,
  overrides: Partial<CreateChecklistTemplateCommand> = {},
): CreateChecklistTemplateCommand {
  return {
    schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
    name: "Standard-Montage",
    description: "Basisumfang",
    position: 0,
    targets: ["residential"],
    items: [item({ componentId: fixture.componentId })],
    ...overrides,
  };
}

describe("F7.3 Checklisten-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7.3 Vorlagen");
  });

  it("F703-DB-01: CRUD happy path, Normalisierung, Sortierung nach Position", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture)),
    );
    expect(created.name).toBe("Standard-Montage");
    expect(created.items).toHaveLength(1);
    expect(created.targets).toEqual(["residential"]);

    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listChecklistTemplates(tx, ctx),
    );
    expect(list).toHaveLength(1);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        id: created.id,
        name: "  Montage-Standard  ",
        description: null,
        position: 5,
        targets: [],
        items: [],
      }),
    );
    expect(updated.name).toBe("Montage-Standard");
    expect(updated.items).toEqual([]);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        id: randomUUID(),
        name: "neu",
        description: null,
        position: 0,
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F703-DB-02: Namenskollision aktiv; Name frei nach Archivierung; Restore-Konflikt", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, { name: "STANDARD-MONTAGE" })),
    )).rejects.toBeInstanceOf(ChecklistConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveChecklistTemplate(tx, ctx, first.id),
    );
    const recreated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, { name: "standard-montage" })),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreChecklistTemplate(tx, ctx, first.id),
    )).rejects.toBeInstanceOf(ChecklistConflictError);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveChecklistTemplate(tx, ctx, recreated.id),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreChecklistTemplate(tx, ctx, first.id),
    );
    const active = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listChecklistTemplates(tx, ctx),
    );
    expect(active.map((t) => t.id)).toEqual([first.id]);
  });

  it("F703-DB-03: Items-Validierung — unbekannte componentId, quantity-Grenzen, targets-Form", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        items: [item({ componentId: randomUUID() })],
      })),
    )).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        items: [item({ componentId: fixture.componentId, quantity: 0 })],
      })),
    )).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        targets: ["ok", "  "],
      })),
    )).rejects.toBeInstanceOf(ChecklistValidationError);
  });

  it("F703-DB-04: applyTemplate legt Checkliste an (ESTIMATE-Mapping), zweites Mal → Conflict", async () => {
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture)),
    );
    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    expect(applied.version).toBe(1);

    const checklist = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => tx.execute(sql`select blocks from project_checklist
        where workspace_id = ${ctx.workspaceId}::uuid
          and project_id = ${fixture.projectId}::uuid limit 1`),
    );
    const blocks = checklist.rows[0]!.blocks as Array<{ name: string }>;
    expect(blocks[0]!.name).toBe("Standard-Montage");

    // 1:1: zweite Anwendung → Conflict.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    )).rejects.toBeInstanceOf(ChecklistConflictError);

    // Archivierte Vorlage → NotFound.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveChecklistTemplate(tx, ctx, template.id),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: randomUUID(),
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F703-DB-04b: Multi-Komponenten-Zuordnung per ID (Kimi-P0-1-Regression)", async () => {
    // Zweite Komponente mit SKU, die NICHT der Item-Reihenfolge entspricht.
    const secondComponent = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by)
      values (${secondComponent}::uuid, ${fixture.workspaceId}::uuid, 'AAA-ZUERST', 'inverter', ${fixture.editorId}::uuid)
    `));
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        name: "Mehrfach",
        items: [
          item({ componentId: fixture.componentId, quantity: 3 }),
          item({ componentId: secondComponent, quantity: 1, position: 1 }),
        ],
      })),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    const checklist = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => tx.execute(sql`select blocks from project_checklist
        where workspace_id = ${ctx.workspaceId}::uuid
          and project_id = ${fixture.projectId}::uuid limit 1`),
    );
    const blocks = checklist.rows[0]!.blocks as Array<{
      segments: Array<{ items: Array<{ title: string }> }>;
    }>;
    const items = blocks[0]!.segments[0]!.items;
    expect(items.map((entry) => entry.title)).toEqual(["WR-10K × 3", "AAA-ZUERST × 1"]);
  });

  it("F703-DB-04c: paralleles Apply erzeugt genau eine atomare Checkliste", async () => {
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture)),
    );

    const releaseFirst = deferred<void>();
    const firstApplied = deferred<void>();
    const first = withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx, ctx) => {
        const result = await applyChecklistTemplate(tx, ctx, {
          templateId: template.id,
          projectId: fixture.projectId,
        });
        firstApplied.resolve();
        await releaseFirst.promise;
        return result;
      },
    );
    await Promise.race([
      firstApplied.promise,
      first.then(
        () => Promise.reject(new Error("Erstes Apply commitete vor der Race-Freigabe")),
        (error: unknown) => Promise.reject(error),
      ),
    ]);

    const secondBackend = deferred<number>();
    const second = withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      async (tx, ctx) => {
        const backend = await tx.execute<{ pid: number }>(sql`
          select pg_backend_pid()::int as pid
        `);
        secondBackend.resolve(backend.rows[0]!.pid);
        return applyChecklistTemplate(tx, ctx, {
          templateId: template.id,
          projectId: fixture.projectId,
        });
      },
    );
    const secondPid = await secondBackend.promise;
    let lockError: unknown;
    try {
      await waitForDatabaseLock(secondPid);
    } catch (error) {
      lockError = error;
    } finally {
      releaseFirst.resolve();
    }

    const outcomes = await Promise.allSettled([first, second]);
    if (lockError) throw lockError;
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{ projectId: string; version: number }> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toEqual({ projectId: fixture.projectId, version: 1 });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ChecklistConflictError);

    const persisted = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx) => tx.execute<{
        checklist_count: number;
        created_event_count: number;
        applied_event_count: number;
        created_audit_count: number;
        applied_audit_count: number;
      }>(sql`
        select
          (select count(*)::int
             from project_checklist checklist_record
            where checklist_record.workspace_id = ${fixture.workspaceId}::uuid
              and checklist_record.project_id = ${fixture.projectId}::uuid
              and checklist_record.phase = 'site_documentation') as checklist_count,
          (select count(*)::int
             from domain_events event_record
            where event_record.workspace_id = ${fixture.workspaceId}::uuid
              and event_record.aggregate_type = 'project_checklist'
              and event_record.event_type = 'checklist.created'
              and event_record.payload->>'projectId' = ${fixture.projectId}) as created_event_count,
          (select count(*)::int
             from domain_events event_record
            where event_record.workspace_id = ${fixture.workspaceId}::uuid
              and event_record.aggregate_type = 'project_checklist'
              and event_record.event_type = 'checklist.applied_from_template'
              and event_record.payload->>'templateId' = ${template.id}) as applied_event_count,
          (select count(*)::int
             from audit_log audit_record
            where audit_record.workspace_id = ${fixture.workspaceId}::uuid
              and audit_record.action = 'checklist.write'
              and audit_record.resource = 'project_checklist'
              and audit_record.details->>'projectId' = ${fixture.projectId}
              and NOT (audit_record.details ? 'templateId')) as created_audit_count,
          (select count(*)::int
             from audit_log audit_record
            where audit_record.workspace_id = ${fixture.workspaceId}::uuid
              and audit_record.action = 'checklist.write'
              and audit_record.resource = 'project_checklist'
              and audit_record.details->>'projectId' = ${fixture.projectId}
              and audit_record.details->>'templateId' = ${template.id}) as applied_audit_count
      `),
    );
    expect(persisted.rows).toEqual([{
      checklist_count: 1,
      created_event_count: 1,
      applied_event_count: 1,
      created_audit_count: 1,
      applied_audit_count: 1,
    }]);
  });

  it("F703-DB-05: Cross-Workspace-Isolation + Viewer schreib-blockiert", async () => {
    const other = await seedWorkspace("F7.3 Fremd");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture)),
    );
    const foreign = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => listChecklistTemplates(tx, ctx, { includeArchived: true }),
    );
    expect(foreign).toHaveLength(0);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, { name: "viewer" })),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
