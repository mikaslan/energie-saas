import { describe, expect, it } from "vitest";

import { IDLE_AFTER_MS, idleState } from "@/lib/time-tracking-idle";

// F9-10 Idle-Hinweis: Entscheidungslogik (deterministisch, ohne Timer).
describe("F9-10 Idle-Hinweis", () => {
  it("F909-U-01: meldet idle erst ab der Schwelle, mit Inaktivitätsbeginn", () => {
    expect(IDLE_AFTER_MS).toBe(5 * 60 * 1_000);
    const now = 1_000_000_000;
    expect(idleState(now - 1_000, now)).toEqual({ idle: false, idleSinceMs: null });
    expect(idleState(now - (IDLE_AFTER_MS - 1), now)).toEqual({
      idle: false,
      idleSinceMs: null,
    });
    expect(idleState(now - IDLE_AFTER_MS, now)).toEqual({
      idle: true,
      idleSinceMs: now - IDLE_AFTER_MS,
    });
    expect(idleState(0, now)).toEqual({ idle: true, idleSinceMs: 0 });
  });

  it("F909-U-02: Zukunfts-Stempel und deformierte Eingaben sind nie idle", () => {
    const now = 1_000_000_000;
    expect(idleState(now + 1, now)).toEqual({ idle: false, idleSinceMs: null });
    expect(idleState(Number.NaN, now)).toEqual({ idle: false, idleSinceMs: null });
    expect(idleState(now - IDLE_AFTER_MS, Number.POSITIVE_INFINITY)).toEqual({
      idle: false,
      idleSinceMs: null,
    });
    expect(idleState("gestern", now)).toEqual({ idle: false, idleSinceMs: null });
    expect(idleState(null, now)).toEqual({ idle: false, idleSinceMs: null });
  });
});
