#!/usr/bin/env tsx
// Generiert deterministische E2E-Shard-Listen (Round-Robin ueber sortierte Specs).
// Usage: tsx scripts/e2e-shards.mts [--check]
// --check verifiziert nur, dass die committeten Listen aktuell sind (fuer CI).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E2E = join(REPO, "tests", "e2e");
const OUT = join(E2E, "shards");
const SHARDS = 3;

function collect(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "shards") continue;
      collect(p, acc);
    } else if (e.name.endsWith(".spec.ts") && statSync(p).isFile()) {
      acc.push(relative(E2E, p));
    }
  }
}

const specs: string[] = [];
collect(E2E, specs);
const groups: string[][] = Array.from({ length: SHARDS }, () => []);
specs.forEach((s, i) => groups[i % SHARDS]!.push(s));

const check = process.argv.includes("--check");
let dirty = false;
mkdirSync(OUT, { recursive: true });
groups.forEach((g, i) => {
  const content = g.join("\n") + "\n";
  const path = join(OUT, `shard-${i + 1}.txt`);
  let prev = "";
  try {
    prev = readFileSync(path, "utf8");
  } catch {
    prev = "";
  }
  if (prev !== content) {
    if (check) {
      console.error(`[shards] ${path} veraltet (${prev.split("\n").filter(Boolean).length} vs ${g.length} Specs). Neu generieren: tsx scripts/e2e-shards.mts`);
      dirty = true;
    } else {
      writeFileSync(path, content);
    }
  }
});
console.log(`[shards] ${specs.length} Specs auf ${SHARDS} Shards: ${groups.map((g) => g.length).join("/")}`);
if (check && dirty) process.exit(1);
