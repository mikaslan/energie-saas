import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  AppointmentNotFoundError,
  AppointmentValidationError,
  archiveCalendar,
  createTenancyCalendar,
  ensurePersonalCalendar,
  listVisibleCalendars,
} from "@/modules/calendar";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  adminId: string;
  tenancyCalendarId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@m115b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@m115b.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@m115b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
  });
  const tenancyCalendarId = randomUUID();
  await withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
    insert into calendar (id, workspace_id, name, calendar_type, created_by)
    values (${tenancyCalendarId}::uuid, ${workspaceId}::uuid, 'Unternehmen', 'tenancy', ${adminId}::uuid)
  `));
  return { workspaceId, editorId, editorMembershipId, viewerId, adminId, tenancyCalendarId };
}

describe("M1-15b Kalender-Scopes (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("M1-15b Scopes");
  });

  it("M115B-DB-01: Sichtbarkeit je Scope — Viewer/Editor sehen tenancy, Editor zusätzlich eigenen User-Kalender", async () => {
    // Persönlicher Kalender des Editors (lazy provisioniert).
    const personalId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => ensurePersonalCalendar(tx, ctx, fixture.editorMembershipId),
    );
    expect(personalId).toBeTruthy();

    const editorView = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    expect(editorView.map((c) => c.id).sort()).toEqual(
      [fixture.tenancyCalendarId, personalId].sort(),
    );

    const viewerView = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    // Viewer sieht nur tenancy — NICHT den persönlichen Kalender des Editors.
    expect(viewerView.map((c) => c.id)).toEqual([fixture.tenancyCalendarId]);
  });

  it("M115B-DB-02: Admin-CRUD — createTenancyCalendar + archiveCalendar; Editor blockiert", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTenancyCalendar(tx, ctx, { name: "Editor-Versuch" }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    const created = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => createTenancyCalendar(tx, ctx, { name: "Außendienst", color: "#3B82F6" }),
    );
    expect(created.type).toBe("tenancy");
    expect(created.color).toBe("#3B82F6");

    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => archiveCalendar(tx, ctx, created.id),
    );
    const afterArchive = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    expect(afterArchive.map((c) => c.id)).not.toContain(created.id);

    // Ungültige Farbe → Validation.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => createTenancyCalendar(tx, ctx, { name: "Rot", color: "rot" }),
    )).rejects.toBeInstanceOf(AppointmentValidationError);

    // Unbekannte Id archivieren → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => archiveCalendar(tx, ctx, randomUUID()),
    )).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });

  it("M115B-DB-03: ensurePersonalCalendar ist idempotent (1:1) und namensbasiert eindeutig", async () => {
    const first = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => ensurePersonalCalendar(tx, ctx, fixture.editorMembershipId),
    );
    const second = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => ensurePersonalCalendar(tx, ctx, fixture.editorMembershipId),
    );
    expect(first).toBe(second);

    // Unbekannte Membership → NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => ensurePersonalCalendar(tx, ctx, randomUUID()),
    )).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });

  it("M115B-DB-05: Persönliche Kalender sind nicht archivierbar (Kimi-P1-2)", async () => {
    const personalId = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => ensurePersonalCalendar(tx, ctx, fixture.editorMembershipId),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => archiveCalendar(tx, ctx, personalId),
    )).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("M115B-DB-06: Client-Kalender erscheint NIE (auch nicht für Admin) (Kimi-P2-4)", async () => {
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      insert into calendar (id, workspace_id, name, calendar_type, created_by)
      values (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, 'Kundenportal', 'client', ${fixture.adminId}::uuid)
    `));
    const adminView = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    expect(adminView.some((c) => c.type === "client")).toBe(false);
  });

  it("M115B-DB-07: ensure_personal_calendar ist race-sicher (parallele Erst-Provisionierung, Kimi-P2-2)", async () => {
    const provision = () => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => ensurePersonalCalendar(tx, ctx, fixture.editorMembershipId),
    );
    const results = await Promise.all([provision(), provision()]);
    expect(results[0]).toBe(results[1]);
    const all = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    const personal = all.filter((c) => c.type === "user");
    expect(personal).toHaveLength(1);
  });

  it("M115B-DB-04: Cross-Workspace-Isolation der Kalender", async () => {
    const other = await seedWorkspace("M1-15b Fremd");
    const foreign = await withAuthorizedTenantOn(
      testPool, other.viewerId, other.workspaceId,
      (tx, ctx) => listVisibleCalendars(tx, ctx),
    );
    expect(foreign.map((c) => c.id)).not.toContain(fixture.tenancyCalendarId);
  });
});
