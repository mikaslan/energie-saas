import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { SUBSIDY_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/subsidies/contract";
import {
  archiveSubsidyTemplate,
  createSubsidyTemplate,
  SubsidyTemplateConflictError,
  SubsidyTemplateNotFoundError,
  SubsidyTemplateValidationError,
  listSubsidyTemplates,
  restoreSubsidyTemplate,
  updateSubsidyTemplate,
} from "@/modules/subsidies";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  plainEditorId: string;
  viewerId: string;
  externalId: string;
};

async function seedWorkspace(label: string, withSubsidies: boolean): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const plainEditorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const caps = withSubsidies ? '{"discounts":true}' : '{}';
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1603b.test`}),
             (${plainEditorId}::uuid, ${`plain-${plainEditorId}@f1603b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1603b.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f1603b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', ${caps}::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${plainEditorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId, plainEditorId, viewerId, externalId };
}

describe("F16.3 Slice B Foerder-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F16.3 Foerderung", true);
  });

  it("F1603B-DB-01: Fix + Prozent anlegen, Liste sortiert, DTO vollständig", async () => {
    const fix = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Stammkunden-Fix",
        kind: "fix_cents",
        amountCents: 1250,
        percentBps: null,
        capCents: null,
        position: 1,
      }),
    );
    expect(fix.kind).toBe("fix_cents");
    expect(fix.amountCents).toBe(1250);
    expect(fix.active).toBe(true);
    expect(fix.permissions.canWrite).toBe(true);

    const percent = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Messeschluss",
        kind: "percent_bps",
        amountCents: null,
        percentBps: 500,
        capCents: 10000,
        position: 0,
      }),
    );
    expect(percent.percentBps).toBe(500);
    expect(percent.capCents).toBe(10000);

    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listSubsidyTemplates(tx, ctx, {}),
    );
    expect(list.map((t) => t.name)).toEqual(["Messeschluss", "Stammkunden-Fix"]);
    expect(list[0]!.permissions.canWrite).toBe(false);
  });

  it("F1603B-DB-02: Doppel-Name Conflict, Archiv erlaubt Re-Create, kind-Bruch Validation", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Doppelt",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "doppelt",
        kind: "fix_cents",
        amountCents: 200,
        percentBps: null,
        capCents: null,
      }),
    )).rejects.toBeInstanceOf(SubsidyTemplateConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveSubsidyTemplate(tx, ctx, created.id),
    );
    const recreated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Doppelt",
        kind: "percent_bps",
        amountCents: null,
        percentBps: 1000,
        capCents: null,
      }),
    );
    expect(recreated.active).toBe(true);

    const restored = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreSubsidyTemplate(tx, ctx, created.id),
    );
    expect(restored.active).toBe(true);

    // kind-Bruch: Fix mit percentBps + Cap.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Bruch",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: 500,
        capCents: 1000,
      }),
    )).rejects.toBeInstanceOf(SubsidyTemplateValidationError);

    // Update mit fremder ID.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        id: randomUUID(),
        name: "Geist",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
        position: 0,
      }),
    )).rejects.toBeInstanceOf(SubsidyTemplateNotFoundError);
  });

  it("F1603B-DB-03: Capability-Gate, Viewer/Extern, Tenant-Trennung", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.plainEditorId, fixture.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Ohne Cap",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const viewerList = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listSubsidyTemplates(tx, ctx, {}),
    );
    expect(viewerList).toEqual([]);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => listSubsidyTemplates(tx, ctx, {}),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const foreign = await seedWorkspace("F16.3 Fremd", true);
    await withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Fremd",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
      }),
    );
    const own = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listSubsidyTemplates(tx, ctx, {}),
    );
    expect(own).toEqual([]);
  });
});
