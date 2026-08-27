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

// Codex-Review (Minor): assertTransition hing am Methoden-Receiver — als
// Callback oder destrukturiert scheiterte es mit TypeError statt mit
// IllegalTransitionError.
describe("state machine ist receiver-fest und unveränderlich", () => {
  it("destrukturierte Methoden funktionieren", () => {
    const { canTransition, assertTransition } = phase;
    expect(canTransition("request", "offer")).toBe(true);
    expect(() => assertTransition("request", "installation")).toThrow(IllegalTransitionError);
  });

  it("als Callback übergeben funktioniert ebenfalls", () => {
    const paare: [string, string][] = [["request", "offer"]];
    expect(() => paare.forEach(([from, to]) => phase.assertTransition(from as never, to as never))).not.toThrow();
    const kaputt: [string, string][] = [["installation", "request"]];
    expect(() => kaputt.forEach(([from, to]) => phase.assertTransition(from as never, to as never))).toThrow(
      IllegalTransitionError,
    );
  });

  it("die übergebene Matrix ist nach dem Erzeugen nicht mehr manipulierbar", () => {
    const matrix: Record<string, string[]> = { a: [], b: [] };
    const sm = createStateMachine(matrix as Record<"a" | "b", readonly ("a" | "b")[]>);
    expect(sm.canTransition("a", "b")).toBe(false);
    // Nachträgliche Mutation der ursprünglichen Matrix darf die Maschine
    // NICHT erreichen (defensive Kopie).
    matrix.a.push("b");
    expect(sm.canTransition("a", "b")).toBe(false);
  });
});
