/**
 * Reonic API v3 — READ-ONLY Live-Sweep (Discovery-Lane)
 *
 * Compliance: COMPLIANCE-REONIC-API.md (Gate offen, 02.09.2026).
 * NUR GET-Endpunkte, NIE Mutationen. Rate-Limit-safe: ~1 Request/2 s,
 * Standard-Cache-Verhalten (kein Reonic-Cache-Control: no-cache).
 * Key kommt aus .env.local, wird nie geloggt.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const env = readFileSync(".env.local", "utf8");
const key = env.match(/^REONIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error("REONIC_API_KEY fehlt in .env.local"); process.exit(2); }

const BASE = "https://api.reonic.de/rest/v3/";
const OUT = "docs/parity/reonic-api-live";
mkdirSync(OUT, { recursive: true });

type Result = {
  path: string;
  method: string;
  status: number;
  ok: boolean;
  bytes: number;
  error?: string;
  paginationTotal?: number | null;
  dataCount?: number;
  sampleKeys?: string[];
  beta?: boolean;
  deprecated?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1) Öffentliche OpenAPI-Spec → GET-Pfade
const specRes = await fetch("https://api.reonic.de/rest/v3/openapi");
const spec = (await specRes.json()) as {
  paths: Record<string, Record<string, {
    operationId?: string;
    deprecated?: boolean;
    tags?: string[];
  }>>;
};
const gets: { path: string; op: { operationId?: string; deprecated?: boolean; tags?: string[] } }[] = [];
for (const [p, methods] of Object.entries(spec.paths)) {
  if (methods.get) gets.push({ path: p, op: methods.get });
}

console.log(`OpenAPI: ${Object.keys(spec.paths).length} Pfade, ${gets.length} GETs`);

const results: Result[] = [];
const probe = async (path: string, op: { deprecated?: boolean; tags?: string[] }) => {
  const url = BASE + path.replace(/^\//, "");
  try {
    const res = await fetch(url, { headers: { "X-Authorization": key } });
    const text = await res.text();
    let sampleKeys: string[] = [];
    let paginationTotal: number | null = null;
    let dataCount: number | undefined;
    if (res.ok && text) {
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const data = (json.data ?? (Array.isArray(json) ? json : null)) as unknown[];
        if (Array.isArray(data)) {
          dataCount = data.length;
          const obj = data[0];
          if (obj && typeof obj === "object") sampleKeys = Object.keys(obj as object).slice(0, 25);
        } else if (typeof json === "object" && json !== null) {
          sampleKeys = Object.keys(json).slice(0, 25);
        }
        const pag = json.pagination as { total?: number } | undefined;
        paginationTotal = pag?.total ?? null;
      } catch { /* kein JSON */ }
    }
    return {
      path, method: "GET", status: res.status, ok: res.ok, bytes: text.length,
      error: res.ok ? undefined : (JSON.parse(text).message ?? text.slice(0, 120)),
      paginationTotal, dataCount, sampleKeys,
      beta: (op as { beta?: boolean }).beta, deprecated: op.deprecated,
    } satisfies Result;
  } catch (e) {
    return { path, method: "GET", status: 0, ok: false, bytes: 0, error: String(e), sampleKeys: [] };
  }
};

// 2) Key-Verifikation zuerst
const me = await probe("me", {});
results.push(me);
console.log(`GET /me → ${me.status}${me.ok ? "" : ` (${me.error})`}`);

// 3) Alle GETs, Rate-Limit-safe
for (const g of gets) {
  if (g.path === "/me") continue;
  const r = await probe(g.path, g.op as { deprecated?: boolean; tags?: string[] });
  results.push(r);
  const flag = r.status === 200 ? "" : ` ⚠${r.status}`;
  console.log(`GET ${r.path}${flag}${r.paginationTotal != null ? ` total=${r.paginationTotal}` : ""}${r.dataCount != null ? ` n=${r.dataCount}` : ""}`);
  await sleep(2000);
}

// 4) Report
const byTag = new Map<string, { total: number; ok: number; withData: number; empty: number; err: number }>();
for (const r of results) {
  const tags = gets.find((g) => g.path === r.path)?.op.tags ?? [];
  const tag = tags[0] ?? "(me)";
  const e = byTag.get(tag) ?? { total: 0, ok: 0, withData: 0, empty: 0, err: 0 };
  e.total++; if (r.ok) e.ok++;
  if (r.ok && (r.dataCount ?? 0) > 0) e.withData++;
  if (r.ok && (r.dataCount ?? 0) === 0) e.empty++;
  if (!r.ok) e.err++;
  byTag.set(tag, e);
}

const md = [
  `# Reonic API v3 — Live-Sweep (READ-ONLY)`,
  ``,
  `Stand: ${new Date().toISOString()} · OBSERVED (Live-Key, nur GET) · ${results.length} Aufrufe`,
  ``,
  `## Zusammenfassung je Tag`,
  ``,
  `| Tag | GETs | 200 | 200+Data | 200 leer | Fehler |`,
  `|---|---|---|---|---|---|`,
  ...([...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(
    ([t, e]) => `| ${t} | ${e.total} | ${e.ok} | ${e.withData} | ${e.empty} | ${e.err} |`,
  )),
  ``,
  `## Einzelaufrufe`,
  ``,
  `| Pfad | Status | total | n | Sample-Keys |`,
  `|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.path} | ${r.status} | ${r.paginationTotal ?? "—"} | ${r.dataCount ?? "—"} | ${(r.sampleKeys ?? []).join(", ")} |`),
  ``, `*(Nur GETs; keine Mutationen; Fehlertexte ggf. bereinigt.)*`,
].join("\n");
writeFileSync(join(OUT, "LIVE-SWEEP.md"), md);
writeFileSync(join(OUT, "live-sweep.raw.json"), JSON.stringify(results, null, 2));
console.log(`\nOK: ${results.filter(r => r.ok).length}/${results.length} — Report: ${join(OUT, "LIVE-SWEEP.md")}`);
