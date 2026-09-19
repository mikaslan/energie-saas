import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { DedupeValidationError } from "@/modules/dedupe/errors";
import { listDedupeQueue } from "@/modules/dedupe/service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  externalMembershipId: string;
  contactFlagged: string;
  contactTwinEmail: string;
  contactTwinPhone: string;
  contactPlain: string;
  siteId: string;
  sitePlainId: string;
  projectFlagged: string;
  projectClean: string;
};

async function seedFixture(): Promise<Fixture> {
  const fx: Fixture = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    externalMembershipId: randomUUID(),
    contactFlagged: randomUUID(),
    contactTwinEmail: randomUUID(),
    contactTwinPhone: randomUUID(),
    contactPlain: randomUUID(),
    siteId: randomUUID(),
    sitePlainId: randomUUID(),
    projectFlagged: randomUUID(),
    projectClean: randomUUID(),
  };
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${fx.workspaceId}::uuid, 'F1-22 Queue')`);
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
        (${fx.externalMembershipId}::uuid, ${fx.workspaceId}::uuid, ${fx.externalId}::uuid,
          'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized, phone_raw, phone_e164, dedupe_review_required
      ) values
        (${fx.contactFlagged}::uuid, ${fx.workspaceId}::uuid,
          'Greta Gemeldet', 'Greta', 'Gemeldet',
          'greta@f122.test', 'greta@f122.test', '0151 1111111', '+491511111111', true),
        (${fx.contactTwinEmail}::uuid, ${fx.workspaceId}::uuid,
          'Greta Zwilling', 'Greta', 'Zwilling',
          'greta@f122.test', 'greta@f122.test', '0151 2222222', '+491512222222', false),
        (${fx.contactTwinPhone}::uuid, ${fx.workspaceId}::uuid,
          'Greta Anschluss', 'Greta', 'Anschluss',
          'anschluss@f122.test', 'anschluss@f122.test', '0151 1111111', '+491511111111', false),
        (${fx.contactPlain}::uuid, ${fx.workspaceId}::uuid,
          'Paul Unbeteiligt', 'Paul', 'Unbeteiligt',
          'paul@f122.test', 'paul@f122.test', '0151 3333333', '+491513333333', false)
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${fx.siteId}::uuid, ${fx.workspaceId}::uuid, ${fx.contactFlagged}::uuid, 'F122 Standort'),
             (${fx.sitePlainId}::uuid, ${fx.workspaceId}::uuid, ${fx.contactPlain}::uuid, 'F122 Standort plain')
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
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id,
        name, source_key, dedupe_review_required
      )
      select ${fx.projectClean}::uuid, ${fx.workspaceId}::uuid,
             ${fx.contactPlain}::uuid, ${fx.sitePlainId}::uuid, board.id, intake.id,
             'F122 Sauber', 'manual', false
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

describe("F1-22 Dedupe-Queue (PostgreSQL)", () => {
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

  it("F122-DB-01: Queue listet Kontakt- und Projekt-Flags mit Kandidatenzahl", async () => {
    const entries = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, {}));

    expect(entries).toHaveLength(2);
    const contact = entries.find((entry) => entry.entity === "contact");
    const project = entries.find((entry) => entry.entity === "project");
    expect(contact).toMatchObject({
      id: fixture.contactFlagged,
      displayName: "Greta Gemeldet",
      email: "greta@f122.test",
      sourceKey: null,
      candidateCount: 2,
    });
    expect(contact?.revision).toBe(1);
    // Projekt-Kandidaten: Zwillinge des Projekt-Kontakts ohne ihn selbst.
    expect(project).toMatchObject({
      id: fixture.projectFlagged,
      displayName: "F122 Prüfprojekt",
      contactName: "Greta Gemeldet",
      sourceKey: "manual",
      candidateCount: 2,
      revision: null,
    });
  });

  it("F122-DB-02: Filter entity/sourceKey/q greifen fail-closed", async () => {
    const contacts = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { entity: "contact" }));
    expect(contacts.map((entry) => entry.entity)).toEqual(["contact"]);

    const projects = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { entity: "project" }));
    expect(projects.map((entry) => entry.entity)).toEqual(["project"]);

    const manual = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { sourceKey: "manual" }));
    expect(manual.map((entry) => entry.entity)).toEqual(["project"]);

    const other = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { sourceKey: "wmee-rechner-v3" }));
    expect(other).toHaveLength(0);

    const byName = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { q: "Prüfprojekt" }));
    expect(byName.map((entry) => entry.id)).toEqual([fixture.projectFlagged]);

    const byMail = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { q: "greta@f122" }));
    expect(byMail).toHaveLength(2);

    // LIKE-Sonderzeichen suchen wörtlich, nicht als Wildcard.
    const wildcard = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { q: "%" }));
    expect(wildcard).toHaveLength(0);

    await expect(
      asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { entity: "offer" as never })),
    ).rejects.toBeInstanceOf(DedupeValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, { q: "x".repeat(201) })),
    ).rejects.toBeInstanceOf(DedupeValidationError);
  });

  it("F122-DB-03: RBAC zeilenweise — Viewer voll, Extern nur zugewiesene Projekte", async () => {
    const viewerEntries = await asViewer(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, {}));
    expect(viewerEntries).toHaveLength(2);

    // Ohne Zuweisung sieht Extern gar nichts (Kontakt-Zeilen nie).
    const externalEmpty = await asExternal(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, {}));
    expect(externalEmpty).toHaveLength(0);

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project_assignment (workspace_id, project_id, membership_id, assignment_role)
        values (${fixture.workspaceId}::uuid, ${fixture.projectFlagged}::uuid,
                ${fixture.externalMembershipId}::uuid, 'user')
      `);
    });

    const externalAssigned = await asExternal(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, {}));
    expect(externalAssigned.map((entry) => entry.entity)).toEqual(["project"]);
    expect(externalAssigned[0]?.id).toBe(fixture.projectFlagged);
  });

  it("F122-DB-04: Queue ist strikt mandantenscharf", async () => {
    const foreign = await seedFixture();
    const entries = await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, {}));
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.id === foreign.projectFlagged)).toBeUndefined();
    expect(entries.find((entry) => entry.id === foreign.contactFlagged)).toBeUndefined();
  });
});
