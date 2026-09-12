import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  listPlanningRequests,
  PlanningRequestConflictError,
  PlanningRequestNotFoundError,
  PlanningRequestValidationError,
  requestPlanning,
  setPlanningStatus,
} from "@/modules/planning-requests";
import { testPool } from "../setup/test-db";
import { seedSignedGraphDirect } from "../setup/f806-offer-import-seed";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  projectId: string;
  offerId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-11 Planung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f1311.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f1311.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@f1311.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb)
    `);
  });
  const { graph } = await seedSignedGraphDirect(testPool, { workspaceId, adminId });
  return {
    workspaceId, editorId, viewerId, adminId,
    projectId: graph.projectId, offerId: graph.offerId,
  };
}

describe("F13-11 Planungsservice (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F1311-DB-01: Anlage + Kantenkette bis accepted", async () => {
    const created = await asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: fixture.offerId,
      deadlineKind: "standard_48h",
    }));
    expect(created.status).toBe("requested");
    expect(created.deadlineKind).toBe("standard_48h");
    expect(new Date(created.deadlineAt).getTime()).toBeGreaterThan(Date.now());
    expect(created.offerNumber).not.toBeNull();

    const progress = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "in_progress",
    }));
    expect(progress.status).toBe("in_progress");
    const finished = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "finished",
    }));
    expect(finished.status).toBe("finished");
    const accepted = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "accepted",
    }));
    expect(accepted.status).toBe("accepted");

    const listed = await asEditor(fixture, (tx, ctx) => listPlanningRequests(tx, ctx, {
      projectId: fixture.projectId,
    }));
    expect(listed.map((entry) => entry.id)).toEqual([created.id]);
    expect(listed[0]!.permissions.canWrite).toBe(true);
  });

  it("F1311-DB-02: Duplikat, Kantenspruenge, Fristen, Scope fail-closed", async () => {
    const created = await asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: fixture.offerId,
      deadlineKind: "express_24h",
    }));
    expect(created.deadlineKind).toBe("express_24h");

    // Zweite Anfrage zum selben Angebot → Conflict.
    await expect(asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: fixture.offerId,
      deadlineKind: "standard_48h",
    }))).rejects.toBeInstanceOf(PlanningRequestConflictError);

    // Kantensprung requested → finished → Validation.
    await expect(asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "finished",
    }))).rejects.toBeInstanceOf(PlanningRequestValidationError);

    // Unbekannte ID → NotFound.
    await expect(asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: randomUUID(), status: "in_progress",
    }))).rejects.toBeInstanceOf(PlanningRequestNotFoundError);

    // Fremdes Angebot (Scope) → NotFound.
    await expect(asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: randomUUID(),
      deadlineKind: "standard_48h",
    }))).rejects.toBeInstanceOf(PlanningRequestNotFoundError);

    // Datum-Art ohne Datum / mit Datum bei 48h → Validation.
    await expect(asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: fixture.offerId,
      deadlineKind: "date",
    }))).rejects.toBeInstanceOf(PlanningRequestValidationError);

    // Vergangenes Datum → Validation (Fristpruefung laeuft vor
    // Scope/Duplikat).
    await expect(asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: fixture.offerId,
      deadlineKind: "date",
      deadlineDate: "2020-01-01",
    }))).rejects.toBeInstanceOf(PlanningRequestValidationError);
  });

  it("F1311-RBAC-01: Viewer liest, schreibt nicht; Fremdtenant leer", async () => {
    await asEditor(fixture, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fixture.projectId,
      offerId: fixture.offerId,
      deadlineKind: "standard_48h",
    }));

    const listed = await asViewer(fixture, (tx, ctx) => listPlanningRequests(tx, ctx, {
      projectId: fixture.projectId,
    }));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.permissions.canWrite).toBe(false);
    await expect(asViewer(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: listed[0]!.id, status: "in_progress",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremdtenant (eigener Workspace mit Mitgliedschaft): leere Liste,
    // Statuswechsel → NotFound (kein Leak).
    const foreignWorkspaceId = randomUUID();
    await withTenantOn(testPool, foreignWorkspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${foreignWorkspaceId}::uuid, 'F13-11 Fremd')`);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${foreignWorkspaceId}::uuid, ${fixture.editorId}::uuid, 'editor', '{}'::jsonb)
      `);
    });
    const foreignList = await withAuthorizedTenantOn(
      testPool, fixture.editorId, foreignWorkspaceId,
      (tx, ctx) => listPlanningRequests(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(foreignList).toEqual([]);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, foreignWorkspaceId,
      (tx, ctx) => setPlanningStatus(tx, ctx, { id: listed[0]!.id, status: "in_progress" }),
    )).rejects.toBeInstanceOf(PlanningRequestNotFoundError);
  });
});
