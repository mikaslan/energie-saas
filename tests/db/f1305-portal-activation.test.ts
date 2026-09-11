import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  createPortalInvite,
  getPortalStatus,
  resolvePortalByToken,
} from "@/modules/portal";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import {
  ensureSubsidyCase,
  transitionSubsidyCase,
} from "@/modules/subsidy-cases";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-05 Aktivierung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1305.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("F13-05 Portal-Aktivierung bei BzA-Versand (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Aktivierung Lead", phone: "+49 171 4444444" }),
    );
    return lead.projectId;
  };

  const dispatchBza = (fx: Fixture, projectId: string) =>
    asEditor(fx, (tx, ctx) => transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));

  it("F1305-DB-01: Versand ohne Invite erzeugt aktiven Link mit auflösbarem Token", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));

    const changed = await dispatchBza(fixture, projectId);
    expect(changed.status).toBe("bza_eingereicht");
    expect(changed.portalActivation.outcome).toBe("created");
    expect(changed.portalActivation.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const status = await asEditor(fixture, (tx, ctx) =>
      getPortalStatus(tx, ctx, { workspaceId: fixture.workspaceId, projectId }));
    expect(status.active).not.toBeNull();

    // Das einmalige Token löst tatsächlich auf genau dieses Projekt auf.
    const view = await resolvePortalByToken(testPool, { token: changed.portalActivation.token });
    expect(view.project.id).toBe(projectId);
  });

  it("F1305-DB-02: Versand mit aktivem Invite behält Bestand ohne Token-Umlauf", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    const manual = await asEditor(fixture, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId,
        ttlDays: 14,
      }));

    const changed = await dispatchBza(fixture, projectId);
    expect(changed.portalActivation.outcome).toBe("already_active");
    expect(changed.portalActivation.token).toBeNull();

    const status = await asEditor(fixture, (tx, ctx) =>
      getPortalStatus(tx, ctx, { workspaceId: fixture.workspaceId, projectId }));
    expect(status.active?.inviteId).toBe(manual.inviteId);
  });

  it("F1305-DB-03: Storno aktiviert nichts", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));

    const changed = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "storniert" }));
    expect(changed.portalActivation.outcome).toBe("not_applicable");
    expect(changed.portalActivation.token).toBeNull();

    const status = await asEditor(fixture, (tx, ctx) =>
      getPortalStatus(tx, ctx, { workspaceId: fixture.workspaceId, projectId }));
    expect(status.active).toBeNull();
  });
});
