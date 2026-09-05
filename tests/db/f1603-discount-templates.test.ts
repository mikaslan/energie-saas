import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { DISCOUNT_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/discounts/contract";
import {
  archiveDiscountTemplate,
  createDiscountTemplate,
  DiscountTemplateConflictError,
  DiscountTemplateNotFoundError,
  DiscountTemplateValidationError,
  listDiscountTemplates,
  restoreDiscountTemplate,
  updateDiscountTemplate,
} from "@/modules/discounts";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  plainEditorId: string;
  viewerId: string;
  externalId: string;
};

async function seedWorkspace(label: string, withDiscounts: boolean): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const plainEditorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const caps = withDiscounts ? '{"discounts":true}' : '{}';
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1603.test`}),
             (${plainEditorId}::uuid, ${`plain-${plainEditorId}@f1603.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1603.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f1603.test`})
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

describe("F16.3 Slice A Rabatt-Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F16.3 Rabatt", true);
  });

  it("F1603-DB-01: Fix + Prozent anlegen, Liste sortiert, DTO vollständig", async () => {
    const fix = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
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
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
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
      (tx, ctx) => listDiscountTemplates(tx, ctx, {}),
    );
    expect(list.map((t) => t.name)).toEqual(["Messeschluss", "Stammkunden-Fix"]);
    expect(list[0]!.permissions.canWrite).toBe(false);
  });

  it("F1603-DB-02: Doppel-Name Conflict, Archiv erlaubt Re-Create, kind-Bruch Validation", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Doppelt",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "doppelt",
        kind: "fix_cents",
        amountCents: 200,
        percentBps: null,
        capCents: null,
      }),
    )).rejects.toBeInstanceOf(DiscountTemplateConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveDiscountTemplate(tx, ctx, created.id),
    );
    const recreated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Doppelt",
        kind: "percent_bps",
        amountCents: null,
        percentBps: 1000,
        capCents: null,
      }),
    );
    expect(recreated.active).toBe(true);

    // Restore auf belegten Namen kollidiert (Konvention F703-DB-02):
    // erst Beleger archivieren, dann gelingt Restore.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreDiscountTemplate(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(DiscountTemplateConflictError);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveDiscountTemplate(tx, ctx, recreated.id),
    );
    const restored = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => restoreDiscountTemplate(tx, ctx, created.id),
    );
    expect(restored.active).toBe(true);

    // kind-Bruch: Fix mit percentBps + Cap.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Bruch",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: 500,
        capCents: 1000,
      }),
    )).rejects.toBeInstanceOf(DiscountTemplateValidationError);

    // Update mit fremder ID.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        id: randomUUID(),
        name: "Geist",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
        position: 0,
      }),
    )).rejects.toBeInstanceOf(DiscountTemplateNotFoundError);
  });

  it("F1603-DB-03: Capability-Gate, Viewer/Extern, Tenant-Trennung", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.plainEditorId, fixture.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Ohne Cap",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const viewerList = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listDiscountTemplates(tx, ctx, {}),
    );
    expect(viewerList).toEqual([]);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => listDiscountTemplates(tx, ctx, {}),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const foreign = await seedWorkspace("F16.3 Fremd", true);
    await withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Fremd",
        kind: "fix_cents",
        amountCents: 100,
        percentBps: null,
        capCents: null,
      }),
    );
    const own = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listDiscountTemplates(tx, ctx, {}),
    );
    expect(own).toEqual([]);
  });
});
