import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  createPortalInvite,
  resolvePortalByToken,
} from "@/modules/portal";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import {
  ensureGridRegistration,
  getGridRegistration,
  setGridRegistrationDetails,
  transitionGridRegistration,
} from "@/modules/grid-registration";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-09 Netzstand')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1309.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("F13-09 Netzstand im Kundenportal (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Netzstand Lead", phone: "+49 171 5555555" }),
    );
    return lead.projectId;
  };

  const inviteFor = async (fx: Fixture, projectId: string): Promise<string> => {
    const invite = await asEditor(fx, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fx.workspaceId,
        projectId,
        ttlDays: 14,
      }));
    return invite.token;
  };

  it("F1309-DB-01: Portal projiziert Netzstand mit Betreiber, nie Zaehlernummer", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId,
      operatorName: "Netz E2E GmbH",
      meterNumber: "1EZ1234567890",
    }));
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }));

    const view = await resolvePortalByToken(testPool, { token: await inviteFor(fixture, projectId) });
    expect(view.gridRegistration).not.toBeNull();
    expect(view.gridRegistration?.status).toBe("eingereicht");
    expect(view.gridRegistration?.operatorName).toBe("Netz E2E GmbH");
    expect(view.gridRegistration?.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(view.gridRegistration).not.toHaveProperty("meterNumber");
  });

  it("F1309-DB-02: ohne Netzanmeldung ehrlich null; fremder Mandant unsichtbar", async () => {
    const projectId = await seedProject(fixture);
    const view = await resolvePortalByToken(testPool, { token: await inviteFor(fixture, projectId) });
    expect(view.gridRegistration).toBeNull();

    const foreign = await (async () => {
      const workspaceId = randomUUID();
      const editorId = randomUUID();
      await withTenantOn(testPool, workspaceId, async (tx) => {
        await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-09 fremd')`);
        await tx.execute(sql`
          insert into user_identity (id, email)
          values (${editorId}::uuid, ${`editor-${editorId}@f1309f.test`})
        `);
        await tx.execute(sql`
          insert into membership (id, workspace_id, user_id, role, capabilities)
          values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
        `);
      });
      return { workspaceId, editorId };
    })();
    const foreignView = await withAuthorizedTenantOn(
      testPool,
      foreign.editorId,
      foreign.workspaceId,
      ((tx: never, ctx: never) => getGridRegistration(tx, ctx, projectId)) as never,
    );
    expect(foreignView).toBeNull();
  });
});
