import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createLeadScoreRecomputeHandler,
  LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION,
  LEAD_SCORE_RECOMPUTE_QUEUE,
  parseLeadScoreRecomputeDispatch,
  startLeadScoreRecoverySweep,
} from "@/worker/lead-score";

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: LEAD_SCORE_RECOMPUTE_DISPATCH_SCHEMA_VERSION,
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    ...overrides,
  };
}

describe("F1-21 Lead-Score-Worker (Unit)", () => {
  it("F121-U-W-01: Queue- und Payloadvertrag (exklusiv, ID-only)", () => {
    expect(LEAD_SCORE_RECOMPUTE_QUEUE).toBe("lead.score.recompute.v1");
    const payload = dispatch();
    expect(parseLeadScoreRecomputeDispatch(payload)).toEqual(payload);
    // Fremde Schema-Version / IDs / Zusatzkeys brechen fail-closed ab.
    const invalid = [
      dispatch({ schemaVersion: "alt" }),
      dispatch({ workspaceId: "kein-uuid" }),
      dispatch({ projectId: "kein-uuid" }),
      dispatch({ extra: 1 }),
      { bogus: true },
      null,
    ];
    for (const value of invalid) {
      expect(() => parseLeadScoreRecomputeDispatch(value))
        .toThrow("lead score dispatch payload is invalid");
    }
  });

  it("F121-U-W-02: Handler ruft Recompute je Job mit IDs auf", async () => {
    const calls: Array<{ workspaceId: string; projectId: string }> = [];
    const database = {
      recompute: async (input: { workspaceId: string; projectId: string }) => {
        calls.push(input);
        return {
          value: 30,
          band: "cold" as const,
          signals: ["email", "phone", "address"],
          computedAt: new Date().toISOString(),
        };
      },
    };
    const first = dispatch();
    const second = dispatch();
    const handler = createLeadScoreRecomputeHandler({ database });
    await handler([
      { id: "job-1", data: first },
      { id: "job-2", data: second },
    ]);
    expect(calls).toEqual([
      { workspaceId: first.workspaceId, projectId: first.projectId },
      { workspaceId: second.workspaceId, projectId: second.projectId },
    ]);
  });

  it("F121-U-W-03: fehlendes Projekt ist stiller No-Op, Fehler propagieren", async () => {
    const nullDatabase = {
      recompute: async () => null,
    };
    const quiet = createLeadScoreRecomputeHandler({ database: nullDatabase });
    await expect(quiet([{ id: "job-1", data: dispatch() }])).resolves.toBeUndefined();

    // Ungültiger Payload wirft (kein stiller Skip).
    const strict = createLeadScoreRecomputeHandler({ database: nullDatabase });
    await expect(strict([{ id: "job-2", data: { bogus: true } }])).rejects.toThrow(
      "lead score dispatch payload is invalid",
    );

    // Echte DB-Fehler propagieren (pg-boss ist die einzige Retry-Quelle).
    const boom = new Error("db weg");
    const failing = createLeadScoreRecomputeHandler({
      database: {
        recompute: async () => {
          throw boom;
        },
      },
    });
    await expect(failing([{ id: "job-3", data: dispatch() }])).rejects.toBe(boom);
  });

  it("F121-U-W-04: Sweep ruft Datenbank mit Bounds auf und stoppt sauber", async () => {
    const workspaceCalls: Array<{ afterWorkspaceId: string | null; limit: number }> = [];
    const requeueCalls: Array<{ workspaceId: string; limit: number }> = [];
    const onFatal = vi.fn();
    const controller = startLeadScoreRecoverySweep(
      {
        database: {
          listRecoveryWorkspaces: async (input) => {
            workspaceCalls.push(input);
            return { workspaceIds: [], nextAfterWorkspaceId: null };
          },
          requeueDue: async (input) => {
            requeueCalls.push(input);
            return [];
          },
        },
        onFatal,
      },
      { intervalMs: 60_000, workspaceLimit: 7, jobsPerWorkspaceLimit: 9 },
    );
    // Erster Lauf startet sofort; stop() wartet ihn ab (kein Overlap).
    await controller.stop();
    expect(onFatal).not.toHaveBeenCalled();
    expect(workspaceCalls).toEqual([{ afterWorkspaceId: null, limit: 7 }]);
    expect(requeueCalls).toEqual([]);
  });

  it("F121-U-W-05: Sweep-Fehler meldet genau einmal fatal und stoppt", async () => {
    const onFatal = vi.fn();
    const controller = startLeadScoreRecoverySweep(
      {
        database: {
          listRecoveryWorkspaces: async () => {
            throw new Error("db weg");
          },
          requeueDue: async () => [],
        },
        onFatal,
      },
      { intervalMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.stop();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({
      name: "LeadScoreRecoverySweepError",
      code: "lead_score_recovery_failed",
    });
  });

  it("F121-U-W-06: ungültige Sweep-Optionen werfen sofort", () => {
    const onFatal = vi.fn();
    const database = {
      listRecoveryWorkspaces: async () => ({ workspaceIds: [], nextAfterWorkspaceId: null }),
      requeueDue: async () => [],
    };
    expect(() => startLeadScoreRecoverySweep({ database, onFatal }, { intervalMs: 0 }))
      .toThrow("lead score recovery sweep failed");
    expect(() => startLeadScoreRecoverySweep({ database, onFatal }, { workspaceLimit: 101 }))
      .toThrow("lead score recovery sweep failed");
    expect(onFatal).not.toHaveBeenCalled();
  });
});
