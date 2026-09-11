import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { createFileRequest } from "@/modules/file-requests";
import { getFileRequestDashboardStats } from "@/modules/file-requests";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import {
  createServiceCase,
  getServiceDashboardStats,
  setServiceCaseStatus,
} from "@/modules/service-cases";
import {
  ensureSubsidyCase,
  getSubsidyDashboardStats,
  transitionSubsidyCase,
} from "@/modules/subsidy-cases";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'DASH-09')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@dash09.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("DASH-09 Service & Förderung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Dash Lead", phone: "+49 171 7777777" }),
    );
    return lead.projectId;
  };

  it("DASH09-DB-01: leere Kennzahlen sind ehrlich null", async () => {
    const service = await asEditor(fixture, (tx, ctx) => getServiceDashboardStats(tx, ctx));
    expect(service).toEqual({ open: 0, inProgress: 0, overdue: 0, doneUnconfirmed: 0 });
    const subsidy = await asEditor(fixture, (tx, ctx) => getSubsidyDashboardStats(tx, ctx));
    expect(subsidy).toEqual({ total: 0, byStatus: [] });
    const belege = await asEditor(fixture, (tx, ctx) => getFileRequestDashboardStats(tx, ctx));
    expect(belege).toEqual({ offen: 0, hochgeladen: 0, erledigt: 0, total: 0 });
  });

  it("DASH09-DB-02: Zähler spiegeln Vorgänge, Akten und Belege", async () => {
    const projectId = await seedProject(fixture);
    // Service: 1 offen (überfällig), 1 in Arbeit, 1 done unbestätigt.
    const overdue = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Alt", dueDate: "2020-01-01" }));
    expect(overdue.status).toBe("open");
    const active = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Laufend" }));
    await asEditor(fixture, (tx, ctx) =>
      setServiceCaseStatus(tx, ctx, { id: active.id, status: "in_progress" }));
    const done = await asEditor(fixture, (tx, ctx) =>
      createServiceCase(tx, ctx, { projectId, title: "Fertig" }));
    await asEditor(fixture, (tx, ctx) =>
      setServiceCaseStatus(tx, ctx, { id: done.id, status: "in_progress" }));
    await asEditor(fixture, (tx, ctx) =>
      setServiceCaseStatus(tx, ctx, { id: done.id, status: "done" }));
    // Förderung: 1 Akte in Vorbereitung.
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    // Belege: 1 offen.
    await asEditor(fixture, (tx, ctx) =>
      createFileRequest(tx, ctx, { projectId, title: "Beleg", description: null }));

    const service = await asEditor(fixture, (tx, ctx) => getServiceDashboardStats(tx, ctx));
    expect(service).toEqual({ open: 1, inProgress: 1, overdue: 1, doneUnconfirmed: 1 });
    const subsidy = await asEditor(fixture, (tx, ctx) => getSubsidyDashboardStats(tx, ctx));
    expect(subsidy).toEqual({
      total: 1,
      byStatus: [{ status: "vorbereitung", count: 1 }],
    });
    const belege = await asEditor(fixture, (tx, ctx) => getFileRequestDashboardStats(tx, ctx));
    expect(belege).toEqual({ offen: 1, hochgeladen: 0, erledigt: 0, total: 1 });

    // Übergang ändert die Zähler (BzA eingereicht statt Vorbereitung).
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    const subsidy2 = await asEditor(fixture, (tx, ctx) => getSubsidyDashboardStats(tx, ctx));
    expect(subsidy2.byStatus).toEqual([{ status: "bza_eingereicht", count: 1 }]);
  });
});
