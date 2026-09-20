import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import { sweepOverdueDocuments } from "@/modules/invoicing/overdue-service";
import {
  OVERDUE_SWEEP_DISPATCH_SCHEMA_VERSION,
  OVERDUE_SWEEP_QUEUE,
  OVERDUE_SWEEP_SCHEDULE_CRON,
  OVERDUE_SWEEP_SCHEDULE_TIMEZONE,
  OverdueSweepDispatchError,
  createOverdueSweepHandler,
  parseOverdueSweepDispatchPayload,
} from "@/worker/overdue-sweep";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

function adminCtx(): ServiceCtx {
  return {
    role: "admin",
    capabilities: {},
    featureFlags: {},
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
  };
}

describe("F8-24a overdue sweep (contracts)", () => {
  it("F824A-C-01: Queue-/Schedule-Vertrag gepinnt (Owner-Bootstrap: Queue + 06:00 Berlin)", () => {
    expect(OVERDUE_SWEEP_QUEUE).toBe("overdue.sweep");
    expect(OVERDUE_SWEEP_SCHEDULE_CRON).toBe("0 6 * * *");
    expect(OVERDUE_SWEEP_SCHEDULE_TIMEZONE).toBe("Europe/Berlin");
    expect(OVERDUE_SWEEP_DISPATCH_SCHEMA_VERSION).toBe("overdue-sweep-dispatch.v1");
  });

  it("F824A-C-02: Dispatch-Schema strikt — globaler Tick oder gezielte workspaceId, sonst Fehler", () => {
    expect(parseOverdueSweepDispatchPayload({
      schemaVersion: "overdue-sweep-dispatch.v1",
    })).toEqual({ schemaVersion: "overdue-sweep-dispatch.v1" });
    expect(parseOverdueSweepDispatchPayload({
      schemaVersion: "overdue-sweep-dispatch.v1",
      workspaceId: WORKSPACE_ID,
    })).toEqual({ schemaVersion: "overdue-sweep-dispatch.v1", workspaceId: WORKSPACE_ID });

    for (const bad of [
      undefined,
      null,
      {},
      { schemaVersion: "overdue-sweep-dispatch.v1", workspaceId: "keine-uuid" },
      { schemaVersion: "overdue-sweep-dispatch.v1", extra: true },
      { schemaVersion: "invoice-pdf-dispatch.v1" },
    ]) {
      expect(() => parseOverdueSweepDispatchPayload(bad)).toThrow(OverdueSweepDispatchError);
    }
  });

  it("F824A-C-03: Handler-Vertrag — (jobs) => Sweep via Runner, pg-boss-job.data-Huelle", async () => {
    const runner = {
      listWorkspaces: vi.fn(async () => ({ workspaceIds: [], nextAfterWorkspaceId: null })),
      sweepWorkspace: vi.fn(async () => ({ swept: 0, sweptDocumentIds: [], truncated: false })),
    };
    const handler = createOverdueSweepHandler({ runner });
    expect(typeof handler).toBe("function");
    expect(handler.length).toBe(1);

    await handler([
      { data: { schemaVersion: "overdue-sweep-dispatch.v1", workspaceId: WORKSPACE_ID } },
      { data: { schemaVersion: "overdue-sweep-dispatch.v1", workspaceId: WORKSPACE_ID } },
    ]);
    expect(runner.sweepWorkspace).toHaveBeenCalledTimes(2);
  });

  it("F824A-C-04: Sweep-Praedikat — nur issued + unbezahlte Achse + faellig (paid/uncollectable/Draft/voided nie)", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute, insert: vi.fn() } as unknown as TenantTx;

    await sweepOverdueDocuments(tx, adminCtx(), { today: "2026-09-19" });

    expect(execute).toHaveBeenCalledTimes(1);
    const sqlText = JSON.stringify(execute.mock.calls);
    expect(sqlText).toContain("commercial_document");
    expect(sqlText).toContain("issued");
    expect(sqlText).toContain("unpaid");
    expect(sqlText).toContain("partially_paid");
    expect(sqlText).toContain("due_date");
    expect(sqlText).toContain("2026-09-19");
    expect(sqlText).toContain(WORKSPACE_ID);
    expect(sqlText).not.toContain("'paid'");
    expect(sqlText).not.toContain("'overdue' = ");
    expect(sqlText).not.toContain("uncollectable");
    expect(sqlText).not.toContain("draft");
    expect(sqlText).not.toContain("voided");
  });

  it("F824A-C-05: Sweep-Evidenz — commercial_document.payment_updated + document.payment.write (recordPayment-Form)", async () => {
    const docId = "33333333-3333-4333-8333-333333333333";
    const seen: Array<{ table: string; entry: Record<string, unknown> }> = [];
    const tx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: docId, paid_cents: 1200 }] })
        .mockResolvedValueOnce({ rows: [{ id: docId, paid_cents: 1200 }] }),
      insert: vi.fn((table: { _: unknown }) => ({
        values: async (entry: Record<string, unknown>) => {
          seen.push({ table: table === null ? "null" : typeof table, entry });
        },
      })),
    } as unknown as TenantTx;

    const result = await sweepOverdueDocuments(tx, adminCtx(), { today: "2026-09-19" });

    expect(result).toEqual({ swept: 1, sweptDocumentIds: [docId], truncated: false });
    expect(seen).toHaveLength(2);
    const byKind = new Map(seen.map((item) =>
      "eventType" in item.entry ? ["event", item.entry] : ["audit", item.entry],
    ));
    expect(byKind.get("event")).toMatchObject({
      workspaceId: WORKSPACE_ID,
      aggregateType: "commercial_document",
      aggregateId: docId,
      eventType: "commercial_document.payment_updated",
      actor: ACTOR_ID,
      payload: { documentId: docId, paymentStatus: "overdue", paidCents: 1200 },
    });
    expect(byKind.get("audit")).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actor: ACTOR_ID,
      action: "document.payment.write",
      resource: "commercial_document",
      allowed: true,
      details: { documentId: docId, paymentStatus: "overdue", paidCents: 1200 },
    });
  });
});
