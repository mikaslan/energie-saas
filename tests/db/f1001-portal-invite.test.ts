import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import {
  createPortalInvite,
  getPortalStatus,
  PortalNotFoundError,
  PortalValidationError,
  resolvePortalByToken,
  withdrawPortalInvite,
} from "@/modules/portal";
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
      values (${editorId}::uuid, ${`editor-${editorId}@f1001.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1001.test`})
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
        ${`${contactId}@f1001.test`}, ${`${contactId}@f1001.test`})
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

function createCommand(fixture: Fixture, ttlDays: number) {
  return {
    schemaVersion: PORTAL_INVITE_CREATE_VERSION,
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    ttlDays,
  } as const;
}

describe("F10.1 portal invite service", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F10.1 ${randomUUID()}`);
  });

  it("erzeugt genau einen aktiven Invite und liefert das Token genau einmal", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    );
    expect(created.projectId).toBe(fixture.projectId);
    expect(created.token.length).toBeGreaterThan(40);
    const status = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getPortalStatus(tx, ctx, {
        workspaceId: fixture.workspaceId, projectId: fixture.projectId,
      }),
    );
    expect(status.active?.inviteId).toBe(created.inviteId);
    expect(status.active?.viewCount).toBe(0);
  });

  it("zweites Create zieht das erste atomar zurueck (superseded)", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    );
    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 30)),
    );
    expect(second.inviteId).not.toBe(first.inviteId);
    // Alter Link ist tot (NotFound-Union, kein Orakel).
    await expect(resolvePortalByToken(testPool, { token: first.token }))
      .rejects.toBeInstanceOf(PortalNotFoundError);
    const view = await resolvePortalByToken(testPool, { token: second.token });
    expect(view.project.id).toBe(fixture.projectId);
    expect(view.documents).toEqual([]);
  });

  it("validiert TTL vor Supersede (Fail-fast, alter Invite bleibt aktiv)", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 0)),
    )).rejects.toBeInstanceOf(PortalValidationError);
    const status = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getPortalStatus(tx, ctx, {
        workspaceId: fixture.workspaceId, projectId: fixture.projectId,
      }),
    );
    expect(status.active?.inviteId).toBe(first.inviteId);
  });

  it("emittiert Events in derselben Transaktion (SVC-04)", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    );
    await resolvePortalByToken(testPool, { token: created.token });
    const events = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const rows = (await tx.execute(sql`
        select event_type from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_id = ${fixture.projectId}::uuid
           and event_type in ('portal.invite_created', 'portal.viewed')
         order by occurred_at
      `)).rows as Array<{ event_type: string }>;
      return rows.map((row) => row.event_type);
    });
    expect(events).toEqual(["portal.invite_created", "portal.viewed"]);
  });

  it("Withdraw entzieht, Doppel-Withdraw ist NotFound-Union", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    );
    const withdrawn = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId: created.inviteId,
        reason: "user_request",
      }),
    );
    expect(withdrawn.status).toBe("withdrawn");
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId: created.inviteId,
        reason: "user_request",
      }),
    )).rejects.toBeInstanceOf(PortalNotFoundError);
    await expect(resolvePortalByToken(testPool, { token: created.token }))
      .rejects.toBeInstanceOf(PortalNotFoundError);
  });

  it("Viewer liest Status, darf aber weder erzeugen noch entziehen", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    const status = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getPortalStatus(tx, ctx, {
        workspaceId: fixture.workspaceId, projectId: fixture.projectId,
      }),
    );
    expect(status.active).toBeNull();
  });

  it("deformiert/unbekannt -> identische NotFound-Union ohne Orakel", async () => {
    await expect(resolvePortalByToken(testPool, { token: "!!!deformiert!!!" }))
      .rejects.toBeInstanceOf(PortalNotFoundError);
    await expect(resolvePortalByToken(testPool, { token: Buffer.alloc(32).toString("base64url") }))
      .rejects.toBeInstanceOf(PortalNotFoundError);
  });

  it("Guard weist direktes UPDATE terminaler Zeilen ab (DB-Trigger)", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, createCommand(fixture, 14)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId: created.inviteId,
        reason: "other",
      }),
    );
    // Mit Actor (RLS passiert), damit exakt der Guard-Trigger prueft.
    // Drizzle wrapt Postgres-Fehler in DrizzleQueryError — die eigentliche
    // Fehlermeldung steckt in .cause, nicht in .message (Muster tests/db/
    // events.test.ts, empirisch verifiziert).
    let caught: unknown;
    try {
      await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        async (tx) => {
          await tx.execute(sql`
            update public.portal_invite set withdraw_reason = 'user_request'
             where workspace_id = ${fixture.workspaceId}::uuid and id = ${created.inviteId}::uuid
          `);
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as { cause?: unknown }).cause;
    expect(String(cause)).toMatch(/terminaler Zustand ist immutable/);
  });
});
