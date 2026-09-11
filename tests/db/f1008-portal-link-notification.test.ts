import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import { createPortalInvite, withdrawPortalInvite } from "@/modules/portal";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  projectId: string;
};

async function seedFixture(label: string, contactEmail: string | null): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1008.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized, phone_raw)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${contactEmail}, ${contactEmail?.toLowerCase() ?? null},
        ${contactEmail === null ? "+49 30 901820" : null})
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
  return { workspaceId, editorId, projectId };
}

async function tenantQuery<Row extends QueryResultRow = QueryResultRow>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
) {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query<Row>(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function createInvite(fixture: Fixture) {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createPortalInvite(tx, ctx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      ttlDays: 14,
    }),
  );
}

describe("F10.08 portal-link notification", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F10.08 ${randomUUID()}`, `kunde-${randomUUID()}@f1008.test`);
  });

  it("queued die Portal-Link-Automatik atomar an den Projekt-Contact (ID-only)", async () => {
    const created = await createInvite(fixture);
    expect(created.notificationQueued).toBe(true);

    const outbox = await tenantQuery<{
      template_id: string; invite_id: string; idempotency_key: string; status: string;
    }>(
      fixture.workspaceId, null,
      `select template_id, invite_id::text, idempotency_key, status
         from customer_notification
        where workspace_id = $1::uuid and project_id = $2::uuid`,
      [fixture.workspaceId, fixture.projectId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      template_id: "portal-link.v1",
      invite_id: created.inviteId,
      idempotency_key: `portal-link:${created.inviteId}`,
      status: "queued",
    });

    // ID-only: Die Outbox traegt keine Empfaenger-PII (Aufloesung erst zum
    // Zustellzeitpunkt aus dem Contact-Graphen, ADR 0018).
    const columns = await tenantQuery<{ column_name: string }>(
      fixture.workspaceId, null,
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'customer_notification'`,
      [],
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("recipient_email");
    expect(names).not.toContain("email");
  });

  it("legt ohne Contact-E-Mail keine Outbox-Zeile an (fail-closed statt unzustellbar)", async () => {
    const noMail = await seedFixture(`F10.08-nomail ${randomUUID()}`, null);
    const created = await createInvite(noMail);
    expect(created.notificationQueued).toBe(false);
    const outbox = await tenantQuery<{ count: string }>(
      noMail.workspaceId, null,
      `select count(*)::text as count from customer_notification
        where workspace_id = $1::uuid and project_id = $2::uuid`,
      [noMail.workspaceId, noMail.projectId],
    );
    expect(outbox.rows[0]?.count).toBe("0");
  });

  it("loest den Contact-Empfaenger auf und liefert die Zeile als delivered aus", async () => {
    await createInvite(fixture);
    const notificationId = (await tenantQuery<{ id: string }>(
      fixture.workspaceId, null,
      `select id::text from customer_notification
        where workspace_id = $1::uuid and project_id = $2::uuid`,
      [fixture.workspaceId, fixture.projectId],
    )).rows[0]?.id;
    expect(notificationId).toBeDefined();

    const template = await tenantQuery<{ template_id: string }>(
      fixture.workspaceId, null,
      `select public._f1008_worker_notification_template($1::uuid, $2::uuid) as template_id`,
      [fixture.workspaceId, notificationId],
    );
    expect(template.rows[0]?.template_id).toBe("portal-link.v1");

    const resolved = await tenantQuery<{ email: string }>(
      fixture.workspaceId, fixture.editorId,
      `select public._m111b_worker_resolve_recipient($1::uuid, $2::uuid) as email`,
      [fixture.workspaceId, notificationId],
    );
    expect(typeof resolved.rows[0]?.email).toBe("string");
    expect(resolved.rows[0]?.email).toContain("@f1008.test");

    await tenantQuery(
      fixture.workspaceId, null,
      `select public._m111b_worker_deliver($1::uuid, $2::uuid, 1, 'delivered', null)`,
      [fixture.workspaceId, notificationId],
    );
    const status = await tenantQuery<{ status: string }>(
      fixture.workspaceId, null,
      `select status from customer_notification where workspace_id = $1::uuid and id = $2::uuid`,
      [fixture.workspaceId, notificationId],
    );
    expect(status.rows[0]?.status).toBe("delivered");
  });

  it("storniert bei Rotation die alte Automatik atomar (nie Dead-Links)", async () => {
    const createdFirst = await createInvite(fixture);
    expect(createdFirst.notificationQueued).toBe(true);
    // Rotation: zweite Einladung zieht die erste zurueck (superseded) und
    // ersetzt deren Automatik — ohne Storno wuerde der Template-Singleton
    // (ws, Projekt, Template) den zweiten Insert abweisen.
    const createdSecond = await createInvite(fixture);
    expect(createdSecond.notificationQueued).toBe(true);
    expect(createdSecond.inviteId).not.toBe(createdFirst.inviteId);
    const rows = await tenantQuery<{ invite_id: string; status: string }>(
      fixture.workspaceId, null,
      `select invite_id::text, status from customer_notification
        where workspace_id = $1::uuid and project_id = $2::uuid
          and template_id = 'portal-link.v1'
        order by created_at asc`,
      [fixture.workspaceId, fixture.projectId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      invite_id: createdFirst.inviteId,
      status: "cancelled_manual",
    });
    expect(rows.rows[1]).toMatchObject({
      invite_id: createdSecond.inviteId,
      status: "queued",
    });
  });

  it("storniert bei Entzug die aktive Automatik in derselben Transaktion", async () => {
    const created = await createInvite(fixture);
    expect(created.notificationQueued).toBe(true);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId: created.inviteId,
        reason: "user_request",
      }),
    );
    const rows = await tenantQuery<{ status: string; cancelled_at: string | null }>(
      fixture.workspaceId, null,
      `select status, cancelled_at::text from customer_notification
        where workspace_id = $1::uuid and project_id = $2::uuid
          and template_id = 'portal-link.v1'`,
      [fixture.workspaceId, fixture.projectId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe("cancelled_manual");
    expect(rows.rows[0]?.cancelled_at).not.toBeNull();
  });

  it("weist Template- und Idempotenz-Verletzungen fail-closed ab", async () => {
    const created = await createInvite(fixture);
    // Falscher Idempotenzschluessel (Guard-Branch, kein RLS-Artefakt).
    await expect(tenantQuery(
      fixture.workspaceId, fixture.editorId,
      `insert into customer_notification (workspace_id, project_id, template_id, invite_id, idempotency_key)
       values ($1::uuid, $2::uuid, 'portal-link.v1', $3::uuid, 'portal-link:falsch')`,
      [fixture.workspaceId, fixture.projectId, created.inviteId],
    )).rejects.toThrow(/Invite-Idempotenzschluessel/);
    // Unbekanntes Template (Guard-Branch, kein RLS-Artefakt).
    await expect(tenantQuery(
      fixture.workspaceId, fixture.editorId,
      `insert into customer_notification (workspace_id, project_id, template_id, idempotency_key)
       values ($1::uuid, $2::uuid, 'newsletter.v9', 'newsletter:x')`,
      [fixture.workspaceId, fixture.projectId],
    )).rejects.toThrow(/unbekanntes Template/);
  });
});
