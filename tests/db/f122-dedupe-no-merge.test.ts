import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  getDedupeDetail,
  linkDedupeProject,
  listDedupeQueue,
  markDedupeReviewed,
} from "@/modules/dedupe/service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  contactOld: string;
  contactCanonical: string;
  siteId: string;
  projectFlagged: string;
  contactFlagged: string;
};

async function seedFixture(): Promise<Fixture> {
  const fx: Fixture = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    contactOld: randomUUID(),
    contactCanonical: randomUUID(),
    siteId: randomUUID(),
    projectFlagged: randomUUID(),
    contactFlagged: randomUUID(),
  };
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${fx.workspaceId}::uuid, 'F1-22 NoMerge')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values (${fx.editorId}::uuid, ${`editor-${fx.editorId}@f122.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${fx.editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized, phone_raw, phone_e164,
        address_street, address_house_number, address_postal_code, address_city,
        dedupe_review_required
      ) values
        (${fx.contactOld}::uuid, ${fx.workspaceId}::uuid,
          'Greta Alt', 'Greta', 'Alt', 'greta@f122.test', 'greta@f122.test',
          '0151 1111111', '+491511111111',
          'Altstraße', '3', '10115', 'Berlin', false),
        (${fx.contactCanonical}::uuid, ${fx.workspaceId}::uuid,
          'Greta Kanon', 'Greta', 'Kanon', 'greta@f122.test', 'greta@f122.test',
          '0151 9999999', '+491519999999',
          'Kanonstraße', '9', '10117', 'Berlin', false),
        (${fx.contactFlagged}::uuid, ${fx.workspaceId}::uuid,
          'Finn Markiert', 'Finn', 'Markiert', 'finn@f122.test', 'finn@f122.test',
          '0151 5555555', '+491515555555',
          'Finnweg', '5', '10115', 'Berlin', true)
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label, formatted_address)
      values (${fx.siteId}::uuid, ${fx.workspaceId}::uuid, ${fx.contactOld}::uuid,
              'F122 Standort', 'Altstraße 3, 10115 Berlin')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id,
        name, source_key, dedupe_review_required
      )
      select ${fx.projectFlagged}::uuid, ${fx.workspaceId}::uuid,
             ${fx.contactOld}::uuid, ${fx.siteId}::uuid, board.id, intake.id,
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

type ContactSnapshot = Record<string, unknown>;

async function snapshotContacts(fx: Fixture): Promise<ContactSnapshot[]> {
  return withTenantOn(testPool, fx.workspaceId, async (tx) => {
    const found = await tx.execute(sql`
      select id::text as id, display_name, first_name, last_name,
             email_primary, email_normalized, phone_raw, phone_e164, phone_mobile,
             address_street, address_house_number, address_postal_code, address_city,
             address_country, deleted_at, revision, dedupe_review_required
        from contact
       where workspace_id = ${fx.workspaceId}::uuid
       order by id
    `);
    return found.rows as ContactSnapshot[];
  });
}

describe("F1-22 Negativ: kein stiller Merge (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F122-DB-16: Link legt nichts zusammen — Kontakte byte-identisch, nur Verknüpfung wandert", async () => {
    const before = await snapshotContacts(fixture);
    expect(before).toHaveLength(3);

    await asEditor(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
      projectId: fixture.projectFlagged,
      canonicalContactId: fixture.contactCanonical,
    }));

    const after = await snapshotContacts(fixture);
    // Kein Kontakt angelegt, gelöscht, entleert oder angereichert.
    expect(after).toEqual(before);

    const graph = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const project = await tx.execute<{ contact_id: string; site_id: string }>(sql`
        select contact_id, site_id from project
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.projectFlagged}::uuid
      `);
      const site = await tx.execute<{ contact_id: string; formatted_address: string | null }>(sql`
        select contact_id, formatted_address from site
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.siteId}::uuid
      `);
      return { project: project.rows[0], site: site.rows[0] };
    });
    expect(graph.project.contact_id).toBe(fixture.contactCanonical);
    expect(graph.site.contact_id).toBe(fixture.contactCanonical);
    // Standort-Daten bleiben — nur der Eigentümer wandert.
    expect(graph.site.formatted_address).toBe("Altstraße 3, 10115 Berlin");
  });

  it("F122-DB-17: Markieren/Lesen fassen Stammdaten nicht an", async () => {
    const before = await snapshotContacts(fixture);

    await asEditor(fixture, (tx, ctx) => listDedupeQueue(tx, ctx, {}));
    await asEditor(fixture, (tx, ctx) =>
      getDedupeDetail(tx, ctx, { entity: "contact", id: fixture.contactFlagged }));
    await asEditor(fixture, (tx, ctx) =>
      markDedupeReviewed(tx, ctx, { entity: "contact", id: fixture.contactFlagged }));

    const after = await snapshotContacts(fixture);
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      const previous = before.find((candidate) => candidate.id === row.id);
      expect(previous).toBeDefined();
      if (!previous) throw new Error("unreachable");
      if (row.id === fixture.contactFlagged) {
        // Ausschließlich Flag + Revision wandern sich.
        expect({ ...row, dedupe_review_required: previous.dedupe_review_required, revision: previous.revision })
          .toEqual(previous);
        expect(row.dedupe_review_required).toBe(false);
      } else {
        expect(row).toEqual(previous);
      }
    }
  });
});
