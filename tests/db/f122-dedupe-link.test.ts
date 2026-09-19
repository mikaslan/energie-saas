import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  DedupeConflictError,
  DedupeNotFoundError,
  DedupeValidationError,
} from "@/modules/dedupe/errors";
import { linkDedupeProject } from "@/modules/dedupe/service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  contactOld: string;
  contactCanonical: string;
  siteId: string;
  projectFlagged: string;
};

async function seedFixture(): Promise<Fixture> {
  const fx: Fixture = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    contactOld: randomUUID(),
    contactCanonical: randomUUID(),
    siteId: randomUUID(),
    projectFlagged: randomUUID(),
  };
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${fx.workspaceId}::uuid, 'F1-22 Link')`);
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
      ) values
        (${fx.contactOld}::uuid, ${fx.workspaceId}::uuid,
          'Greta Alt', 'Greta', 'Alt', 'greta@f122.test', 'greta@f122.test', false),
        (${fx.contactCanonical}::uuid, ${fx.workspaceId}::uuid,
          'Greta Kanon', 'Greta', 'Kanon', 'greta@f122.test', 'greta@f122.test', false)
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${fx.siteId}::uuid, ${fx.workspaceId}::uuid, ${fx.contactOld}::uuid, 'F122 Standort')
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

describe("F1-22 Projekt-Verknüpfen (PostgreSQL)", () => {
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

  it("F122-DB-12: Link zieht Projekt UND Standort atomar um, Flag→false", async () => {
    const result = await asEditor(fixture, (tx, ctx) =>
      linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: fixture.contactCanonical,
      }));
    expect(result).toEqual({ changed: true });

    const graph = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const project = await tx.execute<{
        contact_id: string; site_id: string; dedupe_review_required: boolean;
      }>(sql`
        select contact_id, site_id, dedupe_review_required from project
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.projectFlagged}::uuid
      `);
      const site = await tx.execute<{ contact_id: string }>(sql`
        select contact_id from site
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.siteId}::uuid
      `);
      const events = await tx.execute<{ event_type: string; aggregate_id: string }>(sql`
        select event_type, aggregate_id::text from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid order by occurred_at desc limit 1
      `);
      const audits = await tx.execute<{ action: string; resource: string; allowed: boolean }>(sql`
        select action, resource, allowed from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid order by occurred_at desc limit 1
      `);
      return {
        project: project.rows[0],
        site: site.rows[0],
        event: events.rows[0],
        audit: audits.rows[0],
      };
    });
    // FK-Falle bestanden: beide Seiten zeigen auf den Kanon-Kontakt.
    expect(graph.project).toMatchObject({
      contact_id: fixture.contactCanonical,
      site_id: fixture.siteId,
      dedupe_review_required: false,
    });
    expect(graph.site).toMatchObject({ contact_id: fixture.contactCanonical });
    expect(graph.event).toMatchObject({
      event_type: "project.dedupe_linked",
      aggregate_id: fixture.projectFlagged,
    });
    expect(graph.audit).toMatchObject({
      action: "dedupe.link_project",
      resource: "project",
      allowed: true,
    });
  });

  it("F122-DB-13: Link fail-closed — gleiche/fremde/fehlende Ziele", async () => {
    await expect(
      asEditor(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: fixture.contactOld,
      })),
    ).rejects.toBeInstanceOf(DedupeValidationError);

    await expect(
      asEditor(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: randomUUID(),
      })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);

    await expect(
      asEditor(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: randomUUID(),
        canonicalContactId: fixture.contactCanonical,
      })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);

    // Fremder Workspace: Kanon-Kontakt von dort ist unsichtbar.
    const foreign = await seedFixture();
    await expect(
      asEditor(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: foreign.contactCanonical,
      })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);
  });

  it("F122-DB-14: Adresskollision am Kanon-Kontakt blockiert den Link", async () => {
    const otherSiteId = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      // Beide Standorte bestätigt (selected) mit identischem Fingerprint.
      await tx.execute(sql`
        update site
           set address_mode = 'selected',
               formatted_address = 'Prüfweg 1, 10115 Berlin',
               street = 'Prüfweg', house_number = '1', postal_code = '10115', city = 'Berlin',
               lat = 52.52, lng = 13.405,
               geocode_source = 'photon', geocode_precision = 'house',
               address_fingerprint_version = 1,
               address_fingerprint = decode(repeat('ab', 32), 'hex'),
               address_follow_up_required = false
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.siteId}::uuid
      `);
      await tx.execute(sql`
        insert into site (
          id, workspace_id, contact_id, label, address_mode, formatted_address,
          street, house_number, postal_code, city, country, lat, lng,
          geocode_source, geocode_precision, address_fingerprint_version,
          address_fingerprint, address_follow_up_required
        ) values (
          ${otherSiteId}::uuid, ${fixture.workspaceId}::uuid, ${fixture.contactCanonical}::uuid,
          'F122 Kanon-Standort', 'selected', 'Prüfweg 1, 10115 Berlin',
          'Prüfweg', '1', '10115', 'Berlin', 'DE', 52.52, 13.405,
          'photon', 'house', 1, decode(repeat('ab', 32), 'hex'), false
        )
      `);
    });

    await expect(
      asEditor(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: fixture.contactCanonical,
      })),
    ).rejects.toBeInstanceOf(DedupeConflictError);

    // Blockade ohne Teilschaden: Verknüpfung und Flag unverändert.
    const graph = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const project = await tx.execute<{ contact_id: string; dedupe_review_required: boolean }>(sql`
        select contact_id, dedupe_review_required from project
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.projectFlagged}::uuid
      `);
      return project.rows[0];
    });
    expect(graph).toMatchObject({
      contact_id: fixture.contactOld,
      dedupe_review_required: true,
    });
  });

  it("F122-DB-15: Nur interne Editoren verknüpfen (Viewer/Extern 403)", async () => {
    await expect(
      asViewer(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: fixture.contactCanonical,
      })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asExternal(fixture, (tx, ctx) => linkDedupeProject(tx, ctx, {
        projectId: fixture.projectFlagged,
        canonicalContactId: fixture.contactCanonical,
      })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
