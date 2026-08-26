import { describe, it, expect } from "vitest";
import { createStateMachine, IllegalTransitionError } from "@/lib/state-machine";

const phase = createStateMachine({
  request: ["offer"],
  offer: ["installation", "request"],
  installation: [],
} as const);

describe("state machine", () => {
  it("erlaubt definierte Übergänge", () => {
    expect(phase.canTransition("request", "offer")).toBe(true);
  });
  it("verbietet undefinierte Übergänge", () => {
    expect(phase.canTransition("request", "installation")).toBe(false);
    expect(() => phase.assertTransition("installation", "request")).toThrow(IllegalTransitionError);
  });
  it("Fehler nennt beide Zustände", () => {
    try { phase.assertTransition("request", "installation"); } catch (e) {
      expect((e as Error).message).toContain("request");
      expect((e as Error).message).toContain("installation");
    }
  });
});
