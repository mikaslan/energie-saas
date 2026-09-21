import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION } from "@/lib/integrations/invoicing/contract";
import { listDocuments } from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

// F8-23a (F823A-DB-01/02): sent-Filter-Semantik in listDocuments.
type Fixture = { workspaceId: string; editorId: string };

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F823A')`);
    await tx.execute(sql`insert into user_identity (id, email) values (${editorId}::uuid, ${`ed-${editorId}@f823a.test`})`);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

async function seedDoc(
  fixture: Fixture,
  doc: { name: string; status: "draft" | "issued"; sentAt?: string; sequence: number },
): Promise<string> {
  const id = randomUUID();
  const issued = doc.status === "issued";
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into commercial_document (
        id, workspace_id, type, status, name, created_by, created_at,
        issued_at, issued_snapshot, snapshot_sha256, issued_by,
        goebd_retention_until, number, number_year, number_sequence, sent_at, due_date
      ) values (
        ${id}::uuid, ${fixture.workspaceId}::uuid, 'invoice', ${doc.status},
        ${doc.name}, ${fixture.editorId}::uuid, '2026-09-10T10:00:00+02:00'::timestamptz,
        ${issued ? sql`'2026-09-10T10:00:00+02:00'::timestamptz` : sql`null`},
        ${issued ? sql`'{"schemaVersion":"document-snapshot.v1"}'::jsonb` : sql`null`},
        ${issued ? sql`decode(${ZERO_HASH}, 'hex')` : sql`null`},
        ${issued ? sql`${fixture.editorId}::uuid` : sql`null`},
        ${issued ? sql`'2036-12-31'::date` : sql`null`},
        ${issued ? sql`${`RE-823A-${doc.sequence}`}` : sql`null`},
        ${issued ? 2026 : null}, ${issued ? doc.sequence : null},
        ${doc.sentAt === undefined ? sql`null` : sql`${doc.sentAt}::timestamptz`},
        '2026-10-01'::date
      )
    `);
  });
  return id;
}

describe("F823A-DB sent-Filter", () => {
  let fixture: Fixture;
  let sentId = "";
  let unsentId = "";
  let draftId = "";

  beforeEach(async () => {
    fixture = await seedFixture();
    sentId = await seedDoc(fixture, { name: "Versendet", status: "issued", sentAt: "2026-09-15T10:00:00+02:00", sequence: 1 });
    unsentId = await seedDoc(fixture, { name: "Offen", status: "issued", sequence: 2 });
    draftId = await seedDoc(fixture, { name: "Entwurf", status: "draft", sequence: 3 });
  });

  async function list(filters: Record<string, unknown>) {
    return withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx, ctx) =>
      listDocuments(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
        type: "invoice",
        filters,
      }),
    );
  }

  it("DB-01: sent liefert nur versendete", async () => {
    const result = await list({ sent: "sent" });
    expect(result.items.map((d) => d.id).sort()).toEqual([sentId]);
  });

  it("DB-01: unsent liefert Dokumente ohne sent_at (issued + draft)", async () => {
    const result = await list({ sent: "unsent" });
    expect(result.items.map((d) => d.id).sort()).toEqual([draftId, unsentId].sort());
  });

  it("DB-02: sent + status=issued schraenkt korrekt ein", async () => {
    const result = await list({ sent: "sent", status: "issued" });
    expect(result.items.map((d) => d.id)).toEqual([sentId]);
  });

  it("DB-02: sent + status=draft ist leer", async () => {
    const result = await list({ sent: "sent", status: "draft" });
    expect(result.items).toEqual([]);
  });

  it("DB-01: ohne sent-Filter alle drei", async () => {
    const result = await list({});
    expect(result.items).toHaveLength(3);
  });
});
