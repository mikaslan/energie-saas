import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  OVERDUE_SWEEP_BATCH_LIMIT,
  berlinTodayDate,
  sweepOverdueDocuments,
} from "@/modules/invoicing/overdue-service";
import {
  OVERDUE_SWEEP_QUEUE,
  OverdueSweepDispatchError,
  createOverdueSweepHandler,
  parseOverdueSweepDispatchPayload,
} from "@/worker/overdue-sweep";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DOC_A = "33333333-3333-4333-8333-333333333333";
const DOC_B = "44444444-4444-4334-8334-444444444444";

function adminCtx(): ServiceCtx {
  return {
    role: "admin",
    capabilities: {},
    featureFlags: {},
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
  };
}

function viewerCtx(): ServiceCtx {
  return {
    role: "viewer",
    capabilities: {},
    featureFlags: {},
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
  };
}

function transaction(responses: Array<{ rows: unknown[] }>) {
  let index = 0;
  const inserts: Record<string, unknown>[] = [];
  const execute = vi.fn(async () => responses[index++] ?? { rows: [] });
  const tx = {
    execute,
    insert: vi.fn(() => ({
      values: async (entry: Record<string, unknown>) => {
        inserts.push(entry);
      },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts };
}

function eventsOf(inserts: Record<string, unknown>[]) {
  return inserts.filter((entry) => "eventType" in entry);
}

function auditsOf(inserts: Record<string, unknown>[]) {
  return inserts.filter((entry) => "action" in entry);
}

describe("F8-24a overdue sweep (unit)", () => {
  it("F824A-U-01: berlinTodayDate folgt Europe/Berlin (Winter +1, Sommer +2, Mitternachtskante)", () => {
    expect(berlinTodayDate(new Date("2026-01-15T22:30:00.000Z"))).toBe("2026-01-15");
    expect(berlinTodayDate(new Date("2026-01-15T23:30:00.000Z"))).toBe("2026-01-16");
    expect(berlinTodayDate(new Date("2026-07-15T21:30:00.000Z"))).toBe("2026-07-15");
    expect(berlinTodayDate(new Date("2026-07-15T22:30:00.000Z"))).toBe("2026-07-16");
    expect(berlinTodayDate(new Date("2026-09-19T00:00:00.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("F824A-U-02: Sweep flippt Kandidaten auf overdue mit Event/Audit je Beleg (recordPayment-Spiegel)", async () => {
    const harness = transaction([
      { rows: [{ id: DOC_A, paid_cents: 0 }, { id: DOC_B, paid_cents: 5000 }] },
      { rows: [{ id: DOC_A, paid_cents: 0 }, { id: DOC_B, paid_cents: 5000 }] },
    ]);

    const result = await sweepOverdueDocuments(harness.tx, adminCtx(), { today: "2026-09-19" });

    expect(result).toEqual({ swept: 2, sweptDocumentIds: [DOC_A, DOC_B], truncated: false });
    expect(harness.execute).toHaveBeenCalledTimes(2);
    const sqlText = JSON.stringify(harness.execute.mock.calls);
    expect(sqlText).toContain("issued");
    expect(sqlText).toContain("unpaid");
    expect(sqlText).toContain("partially_paid");
    expect(sqlText).toContain("due_date");
    expect(sqlText).toContain(WORKSPACE_ID);

    const events = eventsOf(harness.inserts);
    const audits = auditsOf(harness.inserts);
    expect(events).toHaveLength(2);
    expect(audits).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        workspaceId: WORKSPACE_ID,
        aggregateType: "commercial_document",
        eventType: "commercial_document.payment_updated",
        actor: ACTOR_ID,
      });
      expect(event.payload).toMatchObject({ paymentStatus: "overdue" });
    }
    expect(events[0]).toMatchObject({
      aggregateId: DOC_A, payload: { documentId: DOC_A, paymentStatus: "overdue", paidCents: 0 },
    });
    expect(events[1]).toMatchObject({
      aggregateId: DOC_B, payload: { documentId: DOC_B, paymentStatus: "overdue", paidCents: 5000 },
    });
    for (const audit of audits) {
      expect(audit).toMatchObject({
        workspaceId: WORKSPACE_ID,
        actor: ACTOR_ID,
        action: "document.payment.write",
        resource: "commercial_document",
        allowed: true,
      });
    }
    expect(audits[0]).toMatchObject({
      details: { documentId: DOC_A, paymentStatus: "overdue", paidCents: 0 },
    });
  });

  it("F824A-U-03: ohne Kandidaten kein Rewrite, kein Event, kein Audit (idempotent)", async () => {
    const harness = transaction([{ rows: [] }]);

    const result = await sweepOverdueDocuments(harness.tx, adminCtx(), { today: "2026-09-19" });

    expect(result).toEqual({ swept: 0, sweptDocumentIds: [], truncated: false });
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.inserts).toHaveLength(0);
  });

  it("F824A-U-04: Mengen-Cap 10.000 — Ueberhang meldet truncated, Rest Folgelauf", async () => {
    expect(OVERDUE_SWEEP_BATCH_LIMIT).toBe(10_000);
    const harness = transaction([
      { rows: [{ id: DOC_A, paid_cents: 0 }, { id: DOC_B, paid_cents: 0 }] },
      { rows: [{ id: DOC_A, paid_cents: 0 }] },
    ]);

    const result = await sweepOverdueDocuments(harness.tx, adminCtx(), { today: "2026-09-19", limit: 1 });

    expect(result).toEqual({ swept: 1, sweptDocumentIds: [DOC_A], truncated: true });
    expect(eventsOf(harness.inserts)).toHaveLength(1);
    expect(auditsOf(harness.inserts)).toHaveLength(1);
  });

  it("F824A-U-05: ohne invoicing.write scheitert der Sweep fail-closed", async () => {
    const harness = transaction([{ rows: [{ id: DOC_A, paid_cents: 0 }] }]);

    await expect(
      sweepOverdueDocuments(harness.tx, viewerCtx(), { today: "2026-09-19" }),
    ).rejects.toThrow("permission denied");
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.inserts).toHaveLength(0);
  });

  it("F824A-U-06: Handler sweept gezielt bei workspaceId im Dispatch", async () => {
    const runner = {
      listWorkspaces: vi.fn(),
      sweepWorkspace: vi.fn(async () => ({ swept: 1, sweptDocumentIds: [DOC_A], truncated: false })),
    };
    const handler = createOverdueSweepHandler({ runner });

    await handler([{ data: { schemaVersion: "overdue-sweep-dispatch.v1", workspaceId: WORKSPACE_ID } }]);

    expect(runner.sweepWorkspace).toHaveBeenCalledTimes(1);
    expect(runner.sweepWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(runner.listWorkspaces).not.toHaveBeenCalled();
  });

  it("F824A-U-07: Handler ohne workspaceId paginiert alle Workspaces (invoice-pdf-Muster: jobs-Array)", async () => {
    const wsB = "55555555-5555-4555-8555-555555555555";
    const runner = {
      listWorkspaces: vi.fn()
        .mockResolvedValueOnce({ workspaceIds: [WORKSPACE_ID], nextAfterWorkspaceId: WORKSPACE_ID })
        .mockResolvedValueOnce({ workspaceIds: [wsB], nextAfterWorkspaceId: null }),
      sweepWorkspace: vi.fn(async () => ({ swept: 0, sweptDocumentIds: [], truncated: false })),
    };
    const handler = createOverdueSweepHandler({ runner });

    await handler([{ data: { schemaVersion: "overdue-sweep-dispatch.v1" } }]);

    expect(runner.listWorkspaces).toHaveBeenCalledTimes(2);
    expect(runner.listWorkspaces).toHaveBeenNthCalledWith(1, { afterWorkspaceId: null, limit: 100 });
    expect(runner.listWorkspaces).toHaveBeenNthCalledWith(2, { afterWorkspaceId: WORKSPACE_ID, limit: 100 });
    expect(runner.sweepWorkspace).toHaveBeenCalledTimes(2);
    expect(runner.sweepWorkspace).toHaveBeenNthCalledWith(1, WORKSPACE_ID);
    expect(runner.sweepWorkspace).toHaveBeenNthCalledWith(2, wsB);
  });

  it("F824A-U-08: Handler verwirft ungueltige Dispatches fail-closed, leere Batches sind No-Ops", async () => {
    const runner = { listWorkspaces: vi.fn(), sweepWorkspace: vi.fn() };
    const handler = createOverdueSweepHandler({ runner });

    await handler([]);
    expect(runner.sweepWorkspace).not.toHaveBeenCalled();

    await expect(handler([{ data: { schemaVersion: "falsch.v1" } }])).rejects.toBeInstanceOf(
      OverdueSweepDispatchError,
    );
    await expect(handler([{ data: null }])).rejects.toBeInstanceOf(OverdueSweepDispatchError);
    expect(runner.sweepWorkspace).not.toHaveBeenCalled();
    expect(OVERDUE_SWEEP_QUEUE).toBe("overdue.sweep");
    expect(parseOverdueSweepDispatchPayload({
      schemaVersion: "overdue-sweep-dispatch.v1",
      workspaceId: WORKSPACE_ID,
    })).toEqual({ schemaVersion: "overdue-sweep-dispatch.v1", workspaceId: WORKSPACE_ID });
  });
});
