import { describe, it, expect, afterEach } from "vitest";
import { CI_BUILD_PLATZHALTER, CI_BUILD_PLATZHALTER_PREFIX, requireAuthSecret } from "@/lib/env";

// ═══════════════════════════════════════════════════════════════════════
// Ist-Bericht 2026-08-28, Blocker 3: BETTER_AUTH_SECRET war leer, better-auth
// lief mit Default-Secret, und NICHTS im Repo hat das bemerkt — Build gruen,
// Tests gruen, Deploy moeglich.
//
// Die Suite laeuft unter VITEST=true, wo der Guard bewusst passiv ist. Diese
// Tests schalten ihn deshalb pro Fall scharf, indem sie die Testkennung
// temporaer entfernen. Genau das ist der Zustand einer echten Instanz.
// ═══════════════════════════════════════════════════════════════════════

const ORIGINAL = {
  secret: process.env.BETTER_AUTH_SECRET,
  vitest: process.env.VITEST,
  nodeEnv: process.env.NODE_ENV,
  nextPhase: process.env.NEXT_PHASE,
};

function setzen(name: string, wert: string | undefined): void {
  if (wert === undefined) delete process.env[name];
  else process.env[name] = wert;
}

afterEach(() => {
  setzen("BETTER_AUTH_SECRET", ORIGINAL.secret);
  setzen("VITEST", ORIGINAL.vitest);
  setzen("NODE_ENV", ORIGINAL.nodeEnv);
  setzen("NEXT_PHASE", ORIGINAL.nextPhase);
});

// Versetzt den Prozess in den Zustand "echte, laufende Instanz".
function alsLaufzeit(secret: string | undefined): void {
  setzen("VITEST", undefined);
  setzen("NODE_ENV", "production");
  setzen("NEXT_PHASE", undefined);
  setzen("BETTER_AUTH_SECRET", secret);
}

describe("requireAuthSecret", () => {
  it("wirft zur Laufzeit, wenn das Secret fehlt", () => {
    alsLaufzeit(undefined);
    expect(() => requireAuthSecret()).toThrow(/nicht gesetzt/);
  });

  it("wirft zur Laufzeit, wenn das Secret leer ist", () => {
    alsLaufzeit("");
    expect(() => requireAuthSecret()).toThrow(/nicht gesetzt/);
  });

  it("wirft zur Laufzeit, wenn das Secret zu kurz ist", () => {
    alsLaufzeit("zu-kurz");
    expect(() => requireAuthSecret()).toThrow(/zu kurz/);
  });

  // Der CI-Build setzt diesen Wert bewusst, damit ein Build gruen laufen kann.
  // Genau deshalb darf er eine laufende Instanz NICHT starten lassen.
  it("wirft zur Laufzeit beim CI-Build-Platzhalter", () => {
    alsLaufzeit(CI_BUILD_PLATZHALTER);
    expect(() => requireAuthSecret()).toThrow(/Platzhalter/);
  });

  it("wirft zur Laufzeit bei jedem Secret mit CI-Platzhalter-Kennung", () => {
    alsLaufzeit(`${CI_BUILD_PLATZHALTER_PREFIX}anderer-suffix`);
    expect(() => requireAuthSecret()).toThrow(/Platzhalter/);
  });

  it("laesst ein ausreichend langes Secret durch", () => {
    const gut = "a".repeat(32);
    alsLaufzeit(gut);
    expect(requireAuthSecret()).toBe(gut);
  });

  // Ein Build ist kein Deploy: `next build` importiert und konstruiert, ohne
  // dass eine Instanz laeuft. Wuerde der Guard hier werfen, waere Blocker 1
  // durch die Hintertuer zurueck.
  it("ist waehrend des Produktionsbuilds passiv", () => {
    alsLaufzeit(undefined);
    setzen("NEXT_PHASE", "phase-production-build");
    expect(() => requireAuthSecret()).not.toThrow();
  });

  it("ist in der Testumgebung passiv", () => {
    setzen("VITEST", "true");
    setzen("BETTER_AUTH_SECRET", "");
    expect(() => requireAuthSecret()).not.toThrow();
  });
});
