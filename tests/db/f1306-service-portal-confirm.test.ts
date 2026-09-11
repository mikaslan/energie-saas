import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  confirmServiceCaseByToken,
  createServiceCase,
  listServiceCases,
  ServiceCaseNotFoundError,
  setServiceCaseStatus,
} from "@/modules/service-cases";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-06 Serviceportal')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1306.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("F13-06 Service-Sicht + Kundenbestätigung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Service Lead", phone: "+49 171 5555555" }),
    );
    return lead.projectId;
  };

  const seedInvite = async (fx: Fixture, projectId: string) =>
    asEditor(fx, (tx, ctx) =>
      createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fx.workspaceId,
        projectId,
        ttlDays: 14,
      }));

  const finishCase = async (fx: Fixture, id: string) => {
    await asEditor(fx, (tx, ctx) => setServiceCaseStatus(tx, ctx, { id, status: "in_progress" }));
    return asEditor(fx, (tx, ctx) => setServiceCaseStatus(tx, ctx, { id, status: "done" }));
  };

  it("F1306-DB-01: Resolve projiziert offene/erledigte Vorgänge ohne description/cancelled", async () => {
    const projectId = await seedProject(fixture);
    const open = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Zähler prüfen", description: "Interne Notiz" }));
    const doneCase = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Wechselrichter prüfen" }));
    await finishCase(fixture, doneCase.id);
    const cancelled = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Altlast" }));
    await asEditor(fixture, (tx, ctx) =>
      setServiceCaseStatus(tx, ctx, { id: cancelled.id, status: "cancelled" }));

    const created = await seedInvite(fixture, projectId);
    const view = await resolvePortalByToken(testPool, { token: created.token });
    expect(view.service).toHaveLength(2);
    const titles = view.service.map((item) => item.title).sort();
    expect(titles).toEqual(["Wechselrichter prüfen", "Zähler prüfen"]);
    const done = view.service.find((item) => item.title === "Wechselrichter prüfen");
    expect(done).toMatchObject({ status: "done", confirmedAt: null });
    expect(done?.completedAt).not.toBeNull();
    // Internes bleibt intern: keine description, kein cancelled.
    expect(JSON.stringify(view.service)).not.toContain("Interne Notiz");
    expect(JSON.stringify(view.service)).not.toContain("description");
    expect(JSON.stringify(view.service)).not.toContain("cancelled");
    expect(JSON.stringify(view.service)).not.toContain(cancelled.id);
    expect(open.id).not.toBe("");
  });

  it("F1306-DB-02: Confirm an done ist ok, idempotent already, sonst uniform NotFound", async () => {
    const projectId = await seedProject(fixture);
    const doneCase = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Anlage abnehmen" }));
    await finishCase(fixture, doneCase.id);
    const openCase = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Später prüfen" }));

    const created = await seedInvite(fixture, projectId);
    const first = await confirmServiceCaseByToken(testPool, {
      token: created.token, caseId: doneCase.id,
    });
    expect(first).toEqual({ outcome: "ok", caseId: doneCase.id });

    const again = await confirmServiceCaseByToken(testPool, {
      token: created.token, caseId: doneCase.id,
    });
    expect(again.outcome).toBe("already");

    // Offen, fremd und unbekannt: uniform NotFound (kein Orakel).
    await expect(confirmServiceCaseByToken(testPool, {
      token: created.token, caseId: openCase.id,
    })).rejects.toBeInstanceOf(ServiceCaseNotFoundError);
    await expect(confirmServiceCaseByToken(testPool, {
      token: created.token, caseId: randomUUID(),
    })).rejects.toBeInstanceOf(ServiceCaseNotFoundError);
    await expect(confirmServiceCaseByToken(testPool, {
      token: "definitiv-kein-token", caseId: doneCase.id,
    })).rejects.toBeInstanceOf(ServiceCaseNotFoundError);

    // Intern ist die Bestätigung sichtbar (Liste + Projektion).
    const listed = await asEditor(fixture, (tx, ctx) => listServiceCases(tx, ctx, { projectId }));
    expect(listed.find((item) => item.id === doneCase.id)?.confirmedAt).not.toBeNull();
    expect(listed.find((item) => item.id === openCase.id)?.confirmedAt).toBeNull();
    const view = await resolvePortalByToken(testPool, { token: created.token });
    expect(view.service.find((item) => item.id === doneCase.id)?.confirmedAt).not.toBeNull();
  });
});
