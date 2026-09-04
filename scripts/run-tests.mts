// Vitest 4.1.11 liefert in der hier installierten Node-24-Laufzeit selbst bei
// fehlgeschlagenen Assertions Prozessstatus 0. Das machte eine `&&`-CI-Kette
// falsch-grün. Der JSON-Reporter enthält dagegen zuverlässig success=false.
// Dieser kleine Runner behält die normale Konsolenausgabe, liest zusätzlich
// den maschinenlesbaren Abschluss und setzt den Prozessstatus selbst.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

interface VitestJsonResult {
  success?: boolean;
  numFailedTests?: number;
  numFailedTestSuites?: number;
}

const forwarded = process.argv.slice(2);
if (forwarded.some((arg) => arg.startsWith("--reporter") || arg.startsWith("--outputFile"))) {
  throw new Error("scripts/run-tests.mts reserviert --reporter/--outputFile für das CI-Exit-Gate.");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const tempDir = mkdtempSync(join(tmpdir(), "energie-saas-vitest-"));
const resultFile = join(tempDir, "result.json");

let failed = true;
try {
  const child = spawnSync(
    process.execPath,
    [
      vitestCli,
      "run",
      ...forwarded,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${resultFile}`,
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );

  if (child.error) throw child.error;
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as VitestJsonResult;
  failed =
    child.status !== 0 ||
    result.success !== true ||
    (result.numFailedTests ?? 0) > 0 ||
    (result.numFailedTestSuites ?? 0) > 0;
} finally {
  try {
    // CI-Observability (autonomer Loop): stabiler Pfad für das
    // Artefakt-Upload; test-results/ ist git-ignoriert. Best effort —
    // darf den Gate-Lauf nie kippen.
    mkdirSync(join(repoRoot, "test-results"), { recursive: true });
    copyFileSync(resultFile, join(repoRoot, "test-results", "vitest-result.json"));
  } catch {
    // Absichtlich still: der Exit-Status oben bleibt maßgeblich.
  }
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
