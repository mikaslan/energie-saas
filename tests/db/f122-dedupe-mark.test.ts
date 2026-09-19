import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { DedupeConflictError, DedupeNotFoundError } from "@/modules/dedupe/errors";
import { markDedupeReviewed } from "@/modules/dedupe/service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  contactFlagged: string;
  siteId: string;
  projectFlagged: string;
};

async function seedFixture(): Promise<Fixture> {
  const fx: Fixture = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    contactFlagged: randomUUID(),
    siteId: randomUUID(),
    projectFlagged: randomUUID(),
  };
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${fx.workspaceId}::uuid, 'F1-22 Mark')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values
        (${fx.editorId}::uuid, ${`editor-${fx.editorId}@f122.test`}),
        (${fx.viewerId}::uuid, ${`viewer-${fx.viewerId}@f122.test`}),
        (${fx.externalId}::uuid, ${`extern-${fx.externalId}@f122.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${fx.editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${fx.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${fx.externalId}::uuid,
          'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized, dedupe_review_required
      ) values (
        ${fx.contactFlagged}::uuid, ${fx.workspaceId}::uuid,
        'Greta Gemeldet', 'Greta', 'Gemeldet',
        'greta@f122.test', 'greta@f122.test', true
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${fx.siteId}::uuid, ${fx.workspaceId}::uuid, ${fx.contactFlagged}::uuid, 'F122 Standort')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id,
        name, source_key, dedupe_review_required
      )
      select ${fx.projectFlagged}::uuid, ${fx.workspaceId}::uuid,
             ${fx.contactFlagged}::uuid, ${fx.siteId}::uuid, board.id, intake.id,
             'F122 Prüfprojekt', 'manual', true
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${fx.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
    `);
  });
  return fx;
}

describe("F1-22 Als-geprüft-Markieren (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;
  const asExternal = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, fn as never) as Promise<T>;

  async function eventAndAuditCount(fx: Fixture): Promise<{ events: number; audits: number }> {
    return withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const events = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from domain_events
         where workspace_id = ${fx.workspaceId}::uuid
      `);
      const audits = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where workspace_id = ${fx.workspaceId}::uuid
      `);
      return { events: events.rows[0].n, audits: audits.rows[0].n };
    });
  }

  it("F122-DB-09: Kontakt-Flag→false mit Revisions-Bump, Event und Audit", async () => {
    const before = await eventAndAuditCount(fixture);
    const result = await asEditor(fixture, (tx, ctx) =>
      markDedupeReviewed(tx, ctx, {
        entity: "contact",
        id: fixture.contactFlagged,
        expectedRevision: 1,
      }));
    expect(result).toEqual({ changed: true, revision: 2 });

    const row = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{
        dedupe_review_required: boolean; revision: number; display_name: string;
      }>(sql`
        select dedupe_review_required, revision, display_name from contact
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.contactFlagged}::uuid
      `);
      return found.rows[0];
    });
    expect(row).toMatchObject({
      dedupe_review_required: false,
      revision: 2,
      display_name: "Greta Gemeldet",
    });

    const after = await eventAndAuditCount(fixture);
    expect(after.events).toBe(before.events + 1);
    expect(after.audits).toBe(before.audits + 1);
    const evidence = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ event_type: string; aggregate_id: string }>(sql`
        select event_type, aggregate_id::text from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid order by occurred_at desc limit 1
      `);
      const audits = await tx.execute<{ action: string; resource: string; allowed: boolean }>(sql`
        select action, resource, allowed from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid order by occurred_at desc limit 1
      `);
      return { event: events.rows[0], audit: audits.rows[0] };
    });
    expect(evidence.event).toMatchObject({
      event_type: "contact.dedupe_reviewed",
      aggregate_id: fixture.contactFlagged,
    });
    expect(evidence.audit).toMatchObject({
      action: "dedupe.mark_reviewed",
      resource: "contact",
      allowed: true,
    });
  });

  it("F122-DB-10: Markieren ist idempotent und meldet veraltete Revisionen", async () => {
    const first = await asEditor(fixture, (tx, ctx) =>
      markDedupeReviewed(tx, ctx, { entity: "project", id: fixture.projectFlagged }));
    expect(first).toEqual({ changed: true, revision: null });

    const before = await eventAndAuditCount(fixture);
    const second = await asEditor(fixture, (tx, ctx) =>
      markDedupeReviewed(tx, ctx, { entity: "project", id: fixture.projectFlagged }));
    expect(second).toEqual({ changed: false, revision: null });
    // Idempotenz ohne Writes: keine weiteren Events/Audits.
    expect(await eventAndAuditCount(fixture)).toEqual(before);

    const stale = asEditor(fixture, (tx, ctx) =>
      markDedupeReviewed(tx, ctx, {
        entity: "contact",
        id: fixture.contactFlagged,
        expectedRevision: 99,
      }));
    await expect(stale).rejects.toBeInstanceOf(DedupeConflictError);
    await expect(stale).rejects.toMatchObject({ currentRevision: 1 });

    await expect(
      asEditor(fixture, (tx, ctx) => markDedupeReviewed(tx, ctx, { entity: "project", id: randomUUID() })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);
  });

  it("F122-DB-11: Nur interne Editoren markieren (Viewer/Extern 403)", async () => {
    await expect(
      asViewer(fixture, (tx, ctx) => markDedupeReviewed(tx, ctx, { entity: "contact", id: fixture.contactFlagged })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asViewer(fixture, (tx, ctx) => markDedupeReviewed(tx, ctx, { entity: "project", id: fixture.projectFlagged })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asExternal(fixture, (tx, ctx) => markDedupeReviewed(tx, ctx, { entity: "contact", id: fixture.contactFlagged })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asExternal(fixture, (tx, ctx) => markDedupeReviewed(tx, ctx, { entity: "project", id: fixture.projectFlagged })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
