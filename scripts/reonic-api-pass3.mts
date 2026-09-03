/**
 * Reonic API v3 — READ-ONLY Pass 3: INNERE Struktur-Keys der Detail-Endpunkte.
 * Nur Key-Namen + Typen (keine Feldwerte) — saubere Contract-Evidenz.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = readFileSync(".env.local", "utf8");
const key = env.match(/^REONIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error("REONIC_API_KEY fehlt"); process.exit(2); }
const BASE = "https://api.reonic.de/rest/v3/";
const OUT = "docs/parity/reonic-api-live";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Rate-Limit: Uncached-Bucket = 30/min → 4s Pacing zwischen Detail-Calls

const typeOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `arr<${typeof v[0]}>×${v.length}` : "arr<>";
  if (typeof v === "object") return "obj";
  return typeof v;
};
const innerKeys = (v: unknown, depth = 0): string[] => {
  if (depth > 1 || v == null || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  return Object.entries(o).map(([k, val]) => {
    const t = typeOf(val);
    const nested = t === "obj" ? `{${innerKeys(val, depth + 1).join(",")}}` : t;
    return `${k}:${nested.slice(0, 80)}`;
  });
};

const get = async (path: string) => {
  const res = await fetch(BASE + path.replace(/^\//, ""), { headers: { "X-Authorization": key } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 80); }
  return { status: res.status, body };
};
const unwrap = (body: unknown) => {
  const b = body as { data?: unknown } | null;
  return b?.data ?? body;
};
const firstId = async (path: string) => {
  const r = await get(path);
  await sleep(4000);
  if (r.status !== 200) return null;
  const d = unwrap(r.body);
  const arr = Array.isArray(d) ? d : (d as { data?: unknown[] })?.data;
  if (!Array.isArray(arr) || !arr.length) return null;
  return (arr[0] as { id?: unknown })?.id ?? null;
};

const rows: string[] = [];
const pid = await firstId("/residentialProjects");
const cid = await firstId("/contacts");
const compId = await firstId("/components");
const taskId = await firstId("/tasks");
const noteId = await firstId("/notes");
const offerTplId = await firstId("/offerTemplates");
const pkgId = await firstId("/planningPackages");
const checklistTplId = await firstId("/checklistTemplates");

// Varianten: richtige Variant-ID aus Projekt-Variantenliste
let variantKeys = ["(kein Projekt)"];
if (pid) {
  const vr = await get(`/residentialProjects/${String(pid)}/variants`);
  const vArr = unwrap(vr.body) as unknown[];
  const vId = Array.isArray(vArr) ? (vArr[0] as { id?: unknown })?.id : null;
  if (vId) {
    const d = await get(`/residentialProjects/${String(pid)}/variants/${String(vId)}`);
    await sleep(4000);
    variantKeys = innerKeys(unwrap(d.body));
  }
}

const targets: [string, string | null][] = [
  [`/residentialProjects/${String(pid)} (Detail)`, String(pid)],
  [`/residentialProjects/${String(pid)}/subsidies`, String(pid)],
  [`/residentialProjects/${String(pid)}/signatureRequests`, String(pid)],
  [`/residentialProjects/${String(pid)}/paymentOptions`, String(pid)],
  [`/contacts/${String(cid)}`, String(cid)],
  [`/components/${String(compId)}`, String(compId)],
  [`/tasks/${String(taskId)}`, String(taskId)],
  [`/notes/${String(noteId)}`, String(noteId)],
  [`/offerTemplates/${String(offerTplId)}`, String(offerTplId)],
  [`/planningPackages/${String(pkgId)}`, String(pkgId)],
  [`/checklistTemplates/${String(checklistTplId)}`, String(checklistTplId)],
  [`/checklists/${String(pid)}`, String(pid)],
];
for (const [label, path] of targets) {
  if (!path) { rows.push(`| ${label} | — |`); continue; }
  const fullPath = label.replace(/ \(Detail\)$/, "");
  const r = await get(fullPath);
  await sleep(4000);
  const keys = r.status === 200 ? innerKeys(unwrap(r.body)) : [`HTTP ${r.status}`];
  rows.push(`| ${label} | ${keys.join(" · ") || "∅"} |`);
  console.log(`${label} → ${r.status} (${keys.length} Keys)`);
}

const md = [
  `# Reonic API v3 — Pass 3: Innere Detail-Strukturen (READ-ONLY)`,
  ``,
  `Stand: ${new Date().toISOString()} · Nur Key:Typ — keine Feldwerte, keine Datenübernahme`,
  ``,
  `| Endpunkt | Struktur |`,
  `|---|---|`,
  ...rows.map((r) => r),
  `| Varianten-Detail (echte Variant-ID) | ${variantKeys.join(" · ") || "∅"} |`,
  ``,
].join("\n");
writeFileSync(join(OUT, "LIVE-SWEEP-PASS3.md"), md);
console.log(`\n→ ${join(OUT, "LIVE-SWEEP-PASS3.md")}`);
