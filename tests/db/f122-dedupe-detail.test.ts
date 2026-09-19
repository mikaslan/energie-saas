import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { DedupeNotFoundError } from "@/modules/dedupe/errors";
import { getDedupeDetail } from "@/modules/dedupe/service";
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
  siteId: string;
  projectFlagged: string;
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
    siteId: randomUUID(),
    projectFlagged: randomUUID(),
  };
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${fx.workspaceId}::uuid, 'F1-22 Detail')`);
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
          'greta@f122.test', 'greta@f122.test', '0151 2222222', '+491512222222', true),
        (${fx.contactTwinPhone}::uuid, ${fx.workspaceId}::uuid,
          'Greta Anschluss', 'Greta', 'Anschluss',
          'anschluss@f122.test', 'anschluss@f122.test', '0151 1111111', '+491511111111', false)
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label, formatted_address)
      values (${fx.siteId}::uuid, ${fx.workspaceId}::uuid, ${fx.contactFlagged}::uuid,
              'F122 Standort', 'Prüfweg 1, 10115 Berlin')
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

describe("F1-22 Dedupe-Detail (PostgreSQL)", () => {
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

  it("F122-DB-05: Kontakt-Detail stellt höchstens 10 Kandidaten gegenüber", async () => {
    const detail = await asEditor(fixture, (tx, ctx) =>
      getDedupeDetail(tx, ctx, { entity: "contact", id: fixture.contactFlagged }));
    expect(detail.entity).toBe("contact");
    if (detail.entity !== "contact") throw new Error("unreachable");
    expect(detail.subject).toMatchObject({
      id: fixture.contactFlagged,
      displayName: "Greta Gemeldet",
      email: "greta@f122.test",
      phoneE164: "+491511111111",
      revision: 1,
    });
    expect(detail.candidates).toHaveLength(2);
    // Subjekt ist nie sein eigener Kandidat.
    expect(detail.candidates.find((candidate) => candidate.id === fixture.contactFlagged))
      .toBeUndefined();
    const emailTwin = detail.candidates.find((candidate) => candidate.id === fixture.contactTwinEmail);
    expect(emailTwin).toMatchObject({ matchEmail: true, matchPhone: false, flagged: true });
    const phoneTwin = detail.candidates.find((candidate) => candidate.id === fixture.contactTwinPhone);
    expect(phoneTwin).toMatchObject({ matchEmail: false, matchPhone: true, flagged: false });
    expect(detail.permissions).toEqual({ canMarkReviewed: true, canLink: false });
  });

  it("F122-DB-06: Projekt-Detail zeigt Kontakt- und Standort-Kontext", async () => {
    const detail = await asViewer(fixture, (tx, ctx) =>
      getDedupeDetail(tx, ctx, { entity: "project", id: fixture.projectFlagged }));
    expect(detail.entity).toBe("project");
    if (detail.entity !== "project") throw new Error("unreachable");
    expect(detail.subject).toMatchObject({
      id: fixture.projectFlagged,
      name: "F122 Prüfprojekt",
      sourceKey: "manual",
    });
    expect(detail.subject.contact).toMatchObject({
      id: fixture.contactFlagged,
      displayName: "Greta Gemeldet",
    });
    expect(detail.subject.site).toMatchObject({
      id: fixture.siteId,
      formattedAddress: "Prüfweg 1, 10115 Berlin",
    });
    expect(detail.candidates).toHaveLength(2);
    // Viewer: lesen ja, handeln nein.
    expect(detail.permissions).toEqual({ canMarkReviewed: false, canLink: false });
  });

  it("F122-DB-07: Lesen ändert NICHTS (Flags, Revisionen, Zeitstempel, Events)", async () => {
    const snapshot = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const contacts = await tx.execute(sql`
        select id, dedupe_review_required, revision, created_at, updated_at
          from contact where workspace_id = ${fixture.workspaceId}::uuid order by id
      `);
      const projects = await tx.execute(sql`
        select id, dedupe_review_required, created_at, updated_at
          from project where workspace_id = ${fixture.workspaceId}::uuid order by id
      `);
      const events = await tx.execute(sql`
        select count(*)::int as n from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
      `);
      return { contacts: contacts.rows, projects: projects.rows, events: events.rows };
    });

    await asEditor(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "contact", id: fixture.contactFlagged }));
    await asEditor(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "project", id: fixture.projectFlagged }));
    await asViewer(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "contact", id: fixture.contactFlagged }));

    const after = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const contacts = await tx.execute(sql`
        select id, dedupe_review_required, revision, created_at, updated_at
          from contact where workspace_id = ${fixture.workspaceId}::uuid order by id
      `);
      const projects = await tx.execute(sql`
        select id, dedupe_review_required, created_at, updated_at
          from project where workspace_id = ${fixture.workspaceId}::uuid order by id
      `);
      const events = await tx.execute(sql`
        select count(*)::int as n from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
      `);
      return { contacts: contacts.rows, projects: projects.rows, events: events.rows };
    });
    expect(after).toEqual(snapshot);
  });

  it("F122-DB-08: Detail fail-closed — erledigt/fremd/unsichtbar ohne Leck", async () => {
    // Bereinigte Einträge sind kein Triage-Subjekt mehr.
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update contact set dedupe_review_required = false
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.contactFlagged}::uuid
      `);
    });
    await expect(
      asEditor(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "contact", id: fixture.contactFlagged })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);
    await expect(
      asEditor(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "contact", id: randomUUID() })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);

    // Extern: Kontakt-Detail immer 403, Projekt-Detail ohne Zuweisung
    // ununterscheidbar von inexistent.
    await expect(
      asExternal(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "contact", id: fixture.contactTwinEmail })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asExternal(fixture, (tx, ctx) => getDedupeDetail(tx, ctx, { entity: "project", id: fixture.projectFlagged })),
    ).rejects.toBeInstanceOf(DedupeNotFoundError);

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project_assignment (workspace_id, project_id, membership_id, assignment_role)
        values (${fixture.workspaceId}::uuid, ${fixture.projectFlagged}::uuid,
                ${fixture.externalMembershipId}::uuid, 'key_account')
      `);
    });
    const assigned = await asExternal(fixture, (tx, ctx) =>
      getDedupeDetail(tx, ctx, { entity: "project", id: fixture.projectFlagged }));
    expect(assigned.entity).toBe("project");
    if (assigned.entity !== "project") throw new Error("unreachable");
    expect(assigned.permissions).toEqual({ canMarkReviewed: false, canLink: false });
  });
});
