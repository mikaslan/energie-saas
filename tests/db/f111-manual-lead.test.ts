import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { LeadSourceNotFoundError } from "@/modules/lead-sources/errors";
import {
  createManualLead,
  ManualLeadValidationError,
} from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  sourceId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const sourceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-11 Manuell')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f111.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f111.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F111 Messe', 'f111 messe')
    `);
  });
  return { workspaceId, editorId, viewerId, sourceId };
}

describe("F1-11 Manuelle Anfrage (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F111-DB-01: vollständige Anlage mit Quelle und Notiz", async () => {
    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Manu Lead",
      email: "lead@f111.test",
      phone: "0151 23456789",
      street: "Musterweg",
      houseNumber: "7",
      postalCode: "10115",
      city: "Berlin",
      leadSourceId: fixture.sourceId,
      note: "Rückruf ab 18 Uhr",
    }));
    expect(result.contactReused).toBe(false);
    expect(result.dedupeReviewRequired).toBe(false);

    const rows = await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
      const project = await tx.execute<{
        source_key: string; phase: string; outcome: string; lead_source_id: string | null;
        board_scope: string; column_name: string; dedupe: boolean; contact_name: string;
      }>(sql`
        select p.source_key, p.phase, p.outcome, p.lead_source_id,
               b.scope as board_scope, c.name as column_name,
               p.dedupe_review_required as dedupe, contact.display_name as contact_name
          from project p
          join kanban_board b on b.workspace_id = p.workspace_id and b.id = p.kanban_board_id
          join kanban_column c on c.workspace_id = p.workspace_id and c.id = p.kanban_column_id
          join contact on contact.workspace_id = p.workspace_id and contact.id = p.contact_id
         where p.workspace_id = ${fixture.workspaceId}::uuid and p.id = ${result.projectId}::uuid
      `);
      const note = await tx.execute<{ id: string }>(sql`
        select id from project_note
         where workspace_id = ${fixture.workspaceId}::uuid and project_id = ${result.projectId}::uuid
      `);
      return { project: project.rows[0], notes: note.rows.length };
    });
    expect(rows.project).toMatchObject({
      source_key: "manual",
      phase: "request",
      outcome: "open",
      lead_source_id: fixture.sourceId.toLowerCase(),
      board_scope: "residential",
      column_name: "Eingang",
      dedupe: false,
      contact_name: "Manu Lead",
    });
    expect(rows.notes).toBe(1);
  });

  it("F111-DB-02: Telefon genügt, Gewerbe landet auf dem Gewerbe-Board", async () => {
    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "commercial",
      displayName: "Gewerbe Lead",
      phone: "+49 30 901820",
    }));
    const scope = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{ board_scope: string }>(sql`
        select b.scope as board_scope
          from project p
          join kanban_board b on b.workspace_id = p.workspace_id and b.id = p.kanban_board_id
         where p.workspace_id = ${fixture.workspaceId}::uuid and p.id = ${result.projectId}::uuid
      `);
      return found.rows[0]?.board_scope;
    });
    expect(scope).toBe("commercial");
  });

  it("F111-DB-03: Dedupe-Hinweis statt Blockade; ungültiges fail-closed; Viewer denied", async () => {
    const first = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Dedupe Lead",
      email: "dedupe@f111.test",
    }));
    const second = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Dedupe Lead Zweitprojekt",
      email: "DEDUPE@f111.test",
    }));
    expect(second.contactReused).toBe(true);
    expect(second.dedupeReviewRequired).toBe(true);
    expect(second.contactId).toBe(first.contactId.toLowerCase());
    expect(second.projectId).not.toBe(first.projectId.toLowerCase());

    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Ohne Weg",
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);

    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Falsches Telefon",
      phone: "kein-telefon",
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);

    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Falsche Quelle",
      email: "q@f111.test",
      leadSourceId: randomUUID(),
    }))).rejects.toBeInstanceOf(LeadSourceNotFoundError);

    await expect(asViewer(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Viewer Lead",
      email: "v@f111.test",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F111-DB-04: Dedupe bleibt Tenant-lokal (gleiche E-Mail, neuer Kontakt in B)", async () => {
    const other = await seedFixture();
    await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Tenant A",
      email: "same@f111.test",
    }));
    const inB = await asEditor(other, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Tenant B",
      email: "same@f111.test",
    }));
    expect(inB.contactReused).toBe(false);
  });
});
