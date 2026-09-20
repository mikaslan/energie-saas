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
// Agent 9: Setup-Specs stehen an Position 1 JEDES Shards (sie sind aus dem
// Round-Robin ausgenommen). Grund: Order-Abhaengigkeit im M2-01-Angebot —
// readM201Offer() wirft, wenn keine Spec zuvor ein Angebot per Browser-Action
// fuer m201ProjectId erzeugt hat (m2-01-fixture.ts). CI 35505358946 Shard 3
// war exakt so rot (m2-01-z-a11y + m2-02 ohne Erzeuger); m2-03a solo lokal
// reproduziert. m2-01-offer.spec.ts erzeugt unbedingt (1 Test, kein Skip).
// Hinweis: Playwright sortiert Dateien alphabetisch (ignoriert Listen-Position);
// m2-01-offer liegt alphabetisch vor den reinen Konsumenten (m2-01-z*,
// m2-02, m2-03a); f16-*/f7-10-Konsumenten erzeugen selbst (gruene Shards).
const SETUP_SPECS = ["m2-01-offer.spec.ts"];
for (const setup of SETUP_SPECS) {
  if (!specs.includes(setup)) {
    throw new Error(`[shards] Setup-Spec fehlt (umbenannt/geloescht?): ${setup}`);
  }
}
const groups: string[][] = Array.from({ length: SHARDS }, () => []);
specs.filter((s) => !SETUP_SPECS.includes(s)).forEach((s, i) => groups[i % SHARDS]!.push(s));
groups.forEach((g) => g.unshift(...SETUP_SPECS));

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
