/**
 * Reonic API v3 — READ-ONLY Pass 2: Detail-Endpunkte mit echten IDs.
 * Strukturelle Evidenz (Keys + JSON-Typen), KEINE Feldwerte ins Repo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = readFileSync(".env.local", "utf8");
const key = env.match(/^REONIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error("REONIC_API_KEY fehlt"); process.exit(2); }
const BASE = "https://api.reonic.de/rest/v3/";
const OUT = "docs/parity/reonic-api-live";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Shape = Record<string, string>;
const shape = (v: unknown, depth = 0): Shape | string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `[${typeof v[0]}×${v.length}]` : "[]";
  if (typeof v !== "object") return typeof v;
  if (depth > 2) return "…";
  const o: Shape = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    o[k] = typeof (shape(val, depth + 1)) === "string" ? (shape(val, depth + 1) as string) : JSON.stringify(shape(val, depth + 1)).slice(0, 60);
  }
  return o;
};

const get = async (path: string): Promise<{ status: number; body: unknown; err?: string }> => {
  try {
    const res = await fetch(BASE + path.replace(/^\//, ""), { headers: { "X-Authorization": key } });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 80); }
    return { status: res.status, body, err: res.ok ? undefined : String(((body as { message?: string })?.message ?? text.slice(0, 80))) };
  } catch (e) { return { status: 0, body: null, err: String(e) }; }
};

const firstId = async (path: string, keyOf: (item: unknown) => unknown = (i) => (i as { id?: unknown })?.id) => {
  const r = await get(path);
  if (r.status !== 200) return { id: null, err: r.err ?? `status ${r.status}` };
  const data = (r.body as { data?: unknown[] })?.data ?? (Array.isArray(r.body) ? r.body : []);
  if (!data.length) return { id: null, err: "leer" };
  return { id: keyOf(data[0]), err: undefined };
};

// Plan: Detailpfad → (Liste für ID, Key-Extraktor)
const plans: [string, string, (i: unknown) => unknown][] = [
  ["/residentialProjects/{id}", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/residentialProjects/{id}/variants", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/residentialProjects/{id}/paymentOptions", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/residentialProjects/{id}/subsidies", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/residentialProjects/{id}/signatureRequests", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/residentialProjects/{id}/heatingLoad/roomWise", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/checklists/{id}", "/residentialProjects", (i) => (i as { id?: unknown }).id],
  ["/users/{id}", "/users", (i) => (i as { id?: unknown }).id],
  ["/tasks/{id}", "/tasks", (i) => (i as { id?: unknown }).id],
  ["/tags/{id}", "/tags", (i) => (i as { id?: unknown }).id],
  ["/leadSources/{id}", "/leadSources", (i) => (i as { id?: unknown }).id],
  ["/notes/{id}", "/notes", (i) => (i as { id?: unknown }).id],
  ["/files/{id}", "/files", (i) => (i as { id?: unknown }).id],
  ["/components/{id}", "/components", (i) => (i as { id?: unknown }).id],
  ["/components/{id}/versions", "/components", (i) => (i as { id?: unknown }).id],
  ["/kanbanColumns/{id}", "/kanbanColumns", (i) => (i as { id?: unknown }).id],
  ["/kanbanBoards/{id}", "/kanbanBoards", (i) => (i as { id?: unknown }).id],
  ["/contacts/{id}", "/contacts", (i) => (i as { id?: unknown }).id],
  ["/planningTemplates/{id}", "/planningTemplates", (i) => (i as { id?: unknown }).id],
  ["/planningPackages/{id}", "/planningPackages", (i) => (i as { id?: unknown }).id],
  ["/offerTemplates/{id}", "/offerTemplates", (i) => (i as { id?: unknown }).id],
  ["/checklistTemplates/{id}", "/checklistTemplates", (i) => (i as { id?: unknown }).id],
  ["/wiki/pages/{id}", "/wiki", (i) => (i as { id?: unknown }).id],
  ["/photogrammetry/jobs/{id}", "/photogrammetry/jobs", (i) => (i as { id?: unknown }).id],
];

const rows: string[] = [];
let okCount = 0;
for (const [tpl, list, extractor] of plans) {
  const { id, err } = await firstId(list, extractor);
  await sleep(1500);
  if (id == null) { rows.push(`| ${tpl} | — | keine ID (${err}) |`); continue; }
  const r = await get(tpl.replace("{id}", String(id)));
  await sleep(1500);
  const s = r.status === 200 ? shape(r.body) : undefined;
  const keys = s && typeof s === "object" ? Object.keys(s) : [];
  rows.push(`| ${tpl} | ${r.status} | ${keys.join(", ")} |`);
  if (r.status === 200) okCount++;
  console.log(`${tpl} → ${r.status}${r.err ? ` (${r.err})` : ` keys=${keys.length}`}`);
}

// Varianten-Detail (2. Stufe) + Komponenten-Version (2. Stufe)
const v = await firstId("/residentialProjects/{id}/variants".replace("{id}", String((await firstId("/residentialProjects")).id)));
await sleep(1500);
if (v.id != null) {
  const r = await get(`/residentialProjects/${String(v.id)}/variants/${String(v.id)}`);
  console.log(`variant-detail → ${r.status}`);
}
const cid = (await firstId("/components")).id;
if (cid != null) {
  const vers = await get(`/components/${String(cid)}/versions`);
  const versArr = ((vers.body as { data?: unknown[] })?.data ?? []) as unknown[];
  if (versArr.length) {
    const vId = (versArr[0] as { id?: unknown })?.id;
    const r = await get(`/components/${String(cid)}/versions/${String(vId)}`);
    console.log(`component-version-detail → ${r.status}`);
  }
}

const md = [
  `# Reonic API v3 — Pass 2: Detail-Endpunkte (READ-ONLY, echte IDs)`,
  ``,
  `Stand: ${new Date().toISOString()} · ${okCount}/${plans.length} Details live beobachtet`,
  ``,
  `| Pfad | Status | Struktur-Keys (Typ-Map gekürzt) |`,
  `|---|---|---|`,
  ...rows,
  ``,
  `*(Struktur-Evidenz nur; keine Feldwerte, keine Reonic-Daten übernommen.)*`,
].join("\n");
writeFileSync(join(OUT, "LIVE-SWEEP-PASS2.md"), md);
console.log(`\nOK: ${okCount}/${plans.length} — ${join(OUT, "LIVE-SWEEP-PASS2.md")}`);
