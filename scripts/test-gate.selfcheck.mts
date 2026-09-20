// Agent-9-Befund-1-Regressionsschutz: beweist, dass rohe Vitest-Laeufe
// ehrliche Exit-Codes liefern (rot -> 1, gruen -> 0). Historie: der
// transitive `beforeExit`-Hook von `async-exit-hook` (via embedded-postgres
// im globalSetup) beendete jedes natuerliche Prozessende mit process.exit(0)
// und machte roh `npx vitest run` falsch-gruen. Der Fix (Hook-Entfernung im
// globalSetup-Teardown) wird hier gegen Re-Introduction gepinnt.
// Aufruf: `npm run test:gate`. Fail-closed: jede Abweichung -> EXIT 1.
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const redFixture = join(repoRoot, "tests", "unit", "__gate-selfcheck-red.test.ts");
const greenFixture = join(repoRoot, "tests", "unit", "__gate-selfcheck-green.test.ts");

function runRawVitest(fixture: string): number | null {
  const child = spawnSync("npx", ["vitest", "run", fixture], {
    cwd: repoRoot,
    env: process.env,
    stdio: "pipe",
  });
  if (child.error) throw child.error;
  return child.status;
}

let failures = 0;
try {
  writeFileSync(
    redFixture,
    'import { expect, test } from "vitest";\ntest("__gate-selfcheck rot", () => { expect(1).toBe(2); });\n',
  );
  writeFileSync(
    greenFixture,
    'import { expect, test } from "vitest";\ntest("__gate-selfcheck gruen", () => { expect(1).toBe(1); });\n',
  );

  const redStatus = runRawVitest(redFixture);
  const greenStatus = runRawVitest(greenFixture);
  console.error(`[test:gate] roh-rot EXIT=${String(redStatus)} (erwartet 1)`);
  console.error(`[test:gate] roh-gruen EXIT=${String(greenStatus)} (erwartet 0)`);
  if (redStatus !== 1) {
    console.error("[test:gate] FAIL: roter Lauf liefert nicht EXIT 1 — Exit-Gate-Regression!");
    failures += 1;
  }
  if (greenStatus !== 0) {
    console.error("[test:gate] FAIL: gruener Lauf liefert nicht EXIT 0!");
    failures += 1;
  }
} finally {
  rmSync(redFixture, { force: true });
  rmSync(greenFixture, { force: true });
}

process.exit(failures > 0 ? 1 : 0);
