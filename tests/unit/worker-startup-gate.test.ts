import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkerStartupGate,
  WorkerStartupCancelledError,
} from "@/worker/startup-gate";

describe("worker startup shutdown gate", () => {
  it("prevents every later startup stage after shutdown wins an awaited race", async () => {
    const gate = createWorkerStartupGate();
    const lateRegistration = vi.fn();
    let releaseProbe!: () => void;
    const probe = new Promise<void>((resolveProbe) => {
      releaseProbe = resolveProbe;
    });

    const startup = (async () => {
      gate.assertOpen();
      await probe;
      gate.assertOpen();
      lateRegistration();
    })();
    gate.requestShutdown();
    releaseProbe();

    await expect(startup).rejects.toBeInstanceOf(WorkerStartupCancelledError);
    expect(lateRegistration).not.toHaveBeenCalled();
    expect(gate.shutdownRequested).toBe(true);
  });

  it("wires the gate around queues, heartbeat, server listen, and shutdown", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../worker/index.ts"),
      "utf8",
    );
    expect(source).toContain("startupGate.requestShutdown()");
    expect(source).toMatch(/boss\.start\(\);\s*startupGate\.assertOpen\(\)/u);
    expect(source).toMatch(/boss\.work\(CALCULATION_QUEUE[\s\S]*startupGate\.assertOpen\(\)/u);
    expect(source).toMatch(/startupGate\.assertOpen\(\);\s*server\.listen/u);
  });
});
