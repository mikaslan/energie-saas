import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  checkPlanningRequestOverdue,
  isPlanningRequestOverdue,
  listPlanningRequests,
  PlanningRequestConflictError,
  PlanningRequestNotFoundError,
  PlanningRequestValidationError,
  requestPlanning,
  setPlanningStatus,
} from "@/modules/planning-requests";
import {
  createPlanningRequestRevision,
  listPlanningRequestRevisions,
  PlanningRequestRevisionNotFoundError,
  PlanningRequestRevisionValidationError,
  signPlanningRequestRevision,
} from "@/modules/planning-request-revisions";
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-14 Planung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f1314.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f1314.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@f1314.test`})
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

describe("F13-14 Planungsservice-Revision (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  async function backdateRequest(fx: Fixture, requestId: string, days: number): Promise<void> {
    // CHECK-konform (deadline_at >= created_at): beide zurück, Frist 1 Tag
    // nach Anlage — ab days >= 2 ist die Frist überschritten.
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      await tx.execute(sql`
        update planning_request
           set created_at = statement_timestamp() - make_interval(days => ${days}),
               deadline_at = statement_timestamp() - make_interval(days => ${days}) + make_interval(days => 1)
         where workspace_id = ${fx.workspaceId}::uuid
           and id = ${requestId}::uuid
      `);
    });
  }

  async function countOverdueEvents(fx: Fixture, requestId: string): Promise<number> {
    return withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const result = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from domain_events
         where workspace_id = ${fx.workspaceId}::uuid
           and aggregate_type = 'planning_request'
           and aggregate_id = ${requestId}::uuid
           and event_type = 'planning_request.overdue'
      `);
      return result.rows[0]!.n;
    });
  }

  async function requestOn(fx: Fixture, offerId: string) {
    return asEditor(fx, (tx, ctx) => requestPlanning(tx, ctx, {
      projectId: fx.projectId,
      offerId,
      deadlineKind: "standard_48h",
    }));
  }

  it("F1314-DB-01: finished_at wird beim finished-Uebergang gesetzt, Kette intakt", async () => {
    const created = await requestOn(fixture, fixture.offerId);
    expect(created.finishedAt).toBeNull();

    const progress = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "in_progress",
    }));
    expect(progress.finishedAt).toBeNull();

    const before = Date.now();
    const finished = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "finished",
    }));
    expect(finished.status).toBe("finished");
    expect(finished.finishedAt).not.toBeNull();
    expect(new Date(finished.finishedAt!).getTime()).toBeGreaterThanOrEqual(before - 5_000);

    const accepted = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "accepted",
    }));
    expect(accepted.finishedAt).toBe(finished.finishedAt);

    // Kette endet terminal in accepted (Pin): kein Reopen.
    await expect(asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "finished",
    }))).rejects.toBeInstanceOf(PlanningRequestValidationError);

    // UNIQUE bleibt (workspace_id, offer_id) (Pin): Zweit-Anfrage → Conflict.
    await expect(requestOn(fixture, fixture.offerId)).rejects.toBeInstanceOf(
      PlanningRequestConflictError,
    );

    // Liste trägt finished_at ebenfalls.
    const listed = await asEditor(fixture, (tx, ctx) => listPlanningRequests(tx, ctx, {
      projectId: fixture.projectId,
    }));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.finishedAt).toBe(finished.finishedAt);
  });

  it("F1314-DB-02: Ueberfaellig-Erkennung + idempotentes Event", async () => {
    const daysAgo = (days: number): string =>
      new Date(Date.now() - days * 86_400_000).toISOString();
    const daysAhead = (days: number): string =>
      new Date(Date.now() + days * 86_400_000).toISOString();

    // Reine Probe (kein Event, keine Automatik): deadline_at überschritten
    // → true (requested/in_progress), sonst false; finished/accepted nie
    // überfällig; fehlende Frist fail-closed.
    expect(isPlanningRequestOverdue({ status: "requested", deadlineAt: daysAgo(2) })).toBe(true);
    expect(isPlanningRequestOverdue({ status: "in_progress", deadlineAt: daysAgo(2) })).toBe(true);
    expect(isPlanningRequestOverdue({ status: "requested", deadlineAt: daysAhead(1) })).toBe(false);
    expect(isPlanningRequestOverdue({ status: "finished", deadlineAt: daysAgo(2) })).toBe(false);
    expect(isPlanningRequestOverdue({ status: "accepted", deadlineAt: daysAgo(2) })).toBe(false);
    expect(() => isPlanningRequestOverdue({ status: "requested" })).toThrow(
      PlanningRequestValidationError,
    );

    // Frische Anfrage: check → Validation (nicht ueberfaellig), kein Event.
    const fresh = await requestOn(fixture, fixture.offerId);
    await expect(asEditor(fixture, (tx, ctx) => checkPlanningRequestOverdue(tx, ctx, {
      requestId: fresh.id,
    }))).rejects.toBeInstanceOf(PlanningRequestValidationError);
    expect(await countOverdueEvents(fixture, fresh.id)).toBe(0);

    // Unbekannte Anfrage → NotFound.
    await expect(asEditor(fixture, (tx, ctx) => checkPlanningRequestOverdue(tx, ctx, {
      requestId: randomUUID(),
    }))).rejects.toBeInstanceOf(PlanningRequestNotFoundError);

    // 31 Tage alte Anfrage: check emittiert genau 1 Event (idempotent).
    await backdateRequest(fixture, fresh.id, 31);
    const checked = await asEditor(fixture, (tx, ctx) => checkPlanningRequestOverdue(tx, ctx, {
      requestId: fresh.id,
    }));
    expect(checked.id).toBe(fresh.id);
    expect(await countOverdueEvents(fixture, fresh.id)).toBe(1);
    await asEditor(fixture, (tx, ctx) => checkPlanningRequestOverdue(tx, ctx, {
      requestId: fresh.id,
    }));
    expect(await countOverdueEvents(fixture, fresh.id)).toBe(1);

    // Fertige Anfrage ist nie ueberfaellig — auch nicht mit altem Datum
    // (eigener Workspace: der Seed traegt einen Graphen je Workspace).
    const fx2 = await seedFixture();
    const old = await requestOn(fx2, fx2.offerId);
    await asEditor(fx2, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: old.id, status: "in_progress",
    }));
    await asEditor(fx2, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: old.id, status: "finished",
    }));
    await backdateRequest(fx2, old.id, 60);
    await expect(asEditor(fx2, (tx, ctx) => checkPlanningRequestOverdue(tx, ctx, {
      requestId: old.id,
    }))).rejects.toBeInstanceOf(PlanningRequestValidationError);
  });

  it("F1314-DB-02b: finished-Uebergang emittiert overdue bei alter Anfrage", async () => {
    const created = await requestOn(fixture, fixture.offerId);
    await backdateRequest(fixture, created.id, 45);
    await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "in_progress",
    }));
    // Lesepfad emittiert nichts.
    await asEditor(fixture, (tx, ctx) => listPlanningRequests(tx, ctx, {
      projectId: fixture.projectId,
    }));
    expect(await countOverdueEvents(fixture, created.id)).toBe(0);
    // Erst der finished-Uebergang stellt die Ueberschreitung fest.
    const finished = await asEditor(fixture, (tx, ctx) => setPlanningStatus(tx, ctx, {
      id: created.id, status: "finished",
    }));
    expect(finished.finishedAt).not.toBeNull();
    expect(await countOverdueEvents(fixture, created.id)).toBe(1);
  });

  it("F1314-DB-03: Revisionsnotizen — Anlage, Chronologie, Click-Signatur", async () => {
    const created = await requestOn(fixture, fixture.offerId);
    const scope = { projectId: fixture.projectId, planningRequestId: created.id };

    const first = await asEditor(fixture, (tx, ctx) => createPlanningRequestRevision(tx, ctx, {
      ...scope, note: "  Erste Notiz  ",
    }));
    expect(first.signedAt).toBeNull();
    expect(first.note).toBe("Erste Notiz");
    expect(first.createdBy).toBe(fixture.editorId);
    expect(first.permissions.canWrite).toBe(true);

    const second = await asEditor(fixture, (tx, ctx) => createPlanningRequestRevision(tx, ctx, {
      ...scope, note: "Zweite Notiz",
    }));

    // Mehrere Notizen erlaubt, Liste chronologisch.
    const listed = await asEditor(fixture, (tx, ctx) => listPlanningRequestRevisions(tx, ctx, scope));
    expect(listed.map((entry) => entry.id)).toEqual([first.id, second.id]);

    // Click-Signatur: einmalig, danach unveraenderlich.
    const signed = await asEditor(fixture, (tx, ctx) => signPlanningRequestRevision(tx, ctx, {
      id: first.id,
    }));
    expect(signed.signedAt).not.toBeNull();
    await expect(asEditor(fixture, (tx, ctx) => signPlanningRequestRevision(tx, ctx, {
      id: first.id,
    }))).rejects.toBeInstanceOf(PlanningRequestRevisionValidationError);

    // Notiz-Validierung: leer, nur Spaces, zu lang, Steuerzeichen.
    for (const note of ["", "   ", "x".repeat(2001), "Notiz\nmit Umbruch"]) {
      await expect(asEditor(fixture, (tx, ctx) => createPlanningRequestRevision(tx, ctx, {
        ...scope, note,
      }))).rejects.toBeInstanceOf(PlanningRequestRevisionValidationError);
    }

    // Fremde Anfrage → NotFound (fail-closed).
    const foreign = { projectId: fixture.projectId, planningRequestId: randomUUID() };
    await expect(asEditor(fixture, (tx, ctx) => createPlanningRequestRevision(tx, ctx, {
      ...foreign, note: "x",
    }))).rejects.toBeInstanceOf(PlanningRequestRevisionNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) => listPlanningRequestRevisions(tx, ctx, foreign)))
      .rejects.toBeInstanceOf(PlanningRequestRevisionNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) => signPlanningRequestRevision(tx, ctx, {
      id: randomUUID(),
    }))).rejects.toBeInstanceOf(PlanningRequestRevisionNotFoundError);

    // RBAC: Viewer liest, schreibt/signiert nicht.
    const viewed = await asViewer(fixture, (tx, ctx) => listPlanningRequestRevisions(tx, ctx, scope));
    expect(viewed).toHaveLength(2);
    expect(viewed[0]!.permissions.canWrite).toBe(false);
    await expect(asViewer(fixture, (tx, ctx) => createPlanningRequestRevision(tx, ctx, {
      ...scope, note: "Viewer-Notiz",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(asViewer(fixture, (tx, ctx) => signPlanningRequestRevision(tx, ctx, {
      id: second.id,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F1314-DB-04: RLS-Vertrag planning_request_revision (tenant_isolation + FORCE)", async () => {
    const flags = await testPool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'planning_request_revision'`,
    );
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await testPool.query<{ policyname: string; cmd: string }>(
      `select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'planning_request_revision'`,
    );
    expect(policies.rows).toEqual([{ policyname: "tenant_isolation", cmd: "ALL" }]);
  });
});
