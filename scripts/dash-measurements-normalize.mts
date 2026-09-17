// Normalisiert DASH-VG-Mess-Artefakte aus test-results/e2e/dash-measurements/
// in versionierte Baselines unter docs/parity/dash-measurements/.
// Gebrauch: npx tsx scripts/dash-measurements-normalize.mts --head <sha>
// (Deterministisch: Lauf-UUIDs/Datum werden normalisiert, Boxen bleiben
// exakt; --head bindet die Baseline an den vermessenen Commit.)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RawBox = {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type RawArtifact = {
  route: string;
  viewport: { width: number; height: number };
  capturedAt: string;
  boxes: RawBox[];
};

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ROUTE_WORKSPACE_PATTERN = /\/w\/[0-9a-f-]{36}/giu;
const ROUTE_PROJECT_PATTERN = /\/anfragen\/[0-9a-f-]{36}/giu;
const ROUTE_OFFER_PATTERN = /\/angebote\/[0-9a-f-]{36}/giu;
const ROUTE_PORTAL_PATTERN = /\/p\/[A-Za-z0-9_-]+/gu;

function normalizeRoute(route: string): string {
  return route
    .replace(ROUTE_WORKSPACE_PATTERN, "/w/:workspaceId")
    .replace(ROUTE_PROJECT_PATTERN, "/anfragen/:projectId")
    .replace(ROUTE_OFFER_PATTERN, "/angebote/:offerId")
    .replace(ROUTE_PORTAL_PATTERN, "/p/:token");
}

function main(): void {
  const headIndex = process.argv.indexOf("--head");
  const head = headIndex >= 0 ? process.argv[headIndex + 1] : undefined;
  if (!head || head.startsWith("-")) {
    throw new Error("Fehlender Parameter: --head <commit-sha> ist Pflicht.");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceDir = join(repoRoot, "test-results", "e2e", "dash-measurements");
  const targetDir = join(repoRoot, "docs", "parity", "dash-measurements");
  mkdirSync(targetDir, { recursive: true });
  const files = readdirSync(sourceDir).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(`Keine Mess-Artefakte in ${sourceDir}; erst DASH-VG-E2E fahren.`);
  }
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(sourceDir, file), "utf8")) as RawArtifact;
    if (typeof raw.route !== "string" || !Array.isArray(raw.boxes) || raw.boxes.length === 0) {
      throw new Error(`Ungültiges Artefakt ${file}: route/boxes fehlen.`);
    }
    const gaps = raw.boxes.filter((box) => box.width < 0 || box.height < 0);
    if (gaps.length > 0) {
      throw new Error(
        `Artefakt ${file} enthält ${gaps.length} Lücken-Boxen: ${gaps.map((box) => box.selector).join(", ")}`,
      );
    }
    const normalized = {
      artifact: "dash-measurements/v1",
      route: normalizeRoute(raw.route),
      viewport: raw.viewport,
      head,
      sourceRunCapturedAt: raw.capturedAt,
      boxes: raw.boxes,
    };
    if (UUID_PATTERN.test(normalized.route)) {
      throw new Error(`Route in ${file} nicht vollständig normalisiert: ${normalized.route}`);
    }
    const name = file.replace(/\.json$/u, "");
    const target = join(targetDir, `v1-${name}.json`);
    writeFileSync(target, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    console.log(`geschrieben: docs/parity/dash-measurements/v1-${name}.json`);
  }
}

main();
