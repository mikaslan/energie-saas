import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION } from "@/lib/integrations/invoicing/contract";
import { createDocumentGroup, listDocumentGroups } from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

// F8-23c (F823C-DB-01/02): Status-Counts je Gruppe.
type Fixture = { workspaceId: string; editorId: string };

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F823C')`);
    await tx.execute(sql`insert into user_identity (id, email) values (${editorId}::uuid, ${`ed-${editorId}@f823c.test`})`);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

async function seedDoc(
  fixture: Fixture,
  groupId: string,
  doc: { name: string; status: "draft" | "issued" | "voided"; sentAt?: string; sequence: number },
): Promise<void> {
  const id = randomUUID();
  const issued = doc.status !== "draft";
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into commercial_document (
        id, workspace_id, type, status, name, created_by, created_at, group_id,
        issued_at, issued_snapshot, snapshot_sha256, issued_by,
        goebd_retention_until, number, number_year, number_sequence, sent_at,
        due_date, voided_at, void_reason
      ) values (
        ${id}::uuid, ${fixture.workspaceId}::uuid, 'invoice', ${doc.status},
        ${doc.name}, ${fixture.editorId}::uuid, '2026-09-10T10:00:00+02:00'::timestamptz,
        ${groupId}::uuid,
        ${issued ? sql`'2026-09-10T10:00:00+02:00'::timestamptz` : sql`null`},
        ${issued ? sql`'{"schemaVersion":"document-snapshot.v1"}'::jsonb` : sql`null`},
        ${issued ? sql`decode(${ZERO_HASH}, 'hex')` : sql`null`},
        ${issued ? sql`${fixture.editorId}::uuid` : sql`null`},
        ${issued ? sql`'2036-12-31'::date` : sql`null`},
        ${issued ? sql`${`RE-823C-${doc.sequence}`}` : sql`null`},
        ${issued ? 2026 : null}, ${issued ? doc.sequence : null},
        ${doc.sentAt === undefined ? sql`null` : sql`${doc.sentAt}::timestamptz`},
        '2026-10-01'::date,
        ${doc.status === "voided" ? sql`'2026-09-16T10:00:00+02:00'::timestamptz` : sql`null`},
        ${doc.status === "voided" ? "cancelled" : null}
      )
    `);
  });
}

describe("F823C-DB Gruppen-Status-Counts", () => {
  let fixture: Fixture;
  let fullGroupId = "";
  let emptyGroupId = "";

  beforeEach(async () => {
    fixture = await seedFixture();
    fullGroupId = await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      createDocumentGroup(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
        name: "Volle Gruppe",
      })).then((r) => r.id);
    emptyGroupId = await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      createDocumentGroup(tx, ctx, {
        schemaVersion: COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
        name: "Leere Gruppe",
      })).then((r) => r.id);
    await seedDoc(fixture, fullGroupId, { name: "E", status: "draft", sequence: 1 });
    await seedDoc(fixture, fullGroupId, { name: "A", status: "issued", sequence: 2 });
    await seedDoc(fixture, fullGroupId, { name: "V", status: "issued", sentAt: "2026-09-15T10:00:00+02:00", sequence: 3 });
    await seedDoc(fixture, fullGroupId, { name: "S", status: "voided", sequence: 4 });
  });

  async function groups() {
    return withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      listDocumentGroups(tx, ctx));
  }

  it("DB-01: Counts stimmen je Gruppe", async () => {
    const result = await groups();
    const full = result.find((g) => g.id === fullGroupId);
    expect(full?.documentCount).toBe(4);
    expect(full?.draftCount).toBe(1);
    expect(full?.issuedCount).toBe(2);
    expect(full?.sentCount).toBe(1);
    expect(full?.voidedCount).toBe(1);
  });

  it("DB-02: leere Gruppe → alle Counts 0", async () => {
    const result = await groups();
    const empty = result.find((g) => g.id === emptyGroupId);
    expect(empty?.documentCount).toBe(0);
    expect(empty?.draftCount).toBe(0);
    expect(empty?.issuedCount).toBe(0);
    expect(empty?.sentCount).toBe(0);
    expect(empty?.voidedCount).toBe(0);
  });
});
