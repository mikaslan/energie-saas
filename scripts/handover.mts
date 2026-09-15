// Handover-Check: Beweist auf jedem Gerät, ob der lokale Stand der
// aktuellste ist. Quelle der Wahrheit ist das Origin-Repository, nicht das
// lokale Gefühl. Ablauf auf Gerät B: `git pull`, dann `npm run handover` —
// das Skript vergleicht den frischen Origin-HEAD mit dem letzten in der
// (geräteübergreifend synchronisierten) Vault notierten Stand und meldet
// AKTUELL oder was fehlt. Voraussetzung: Die Vault synchronisiert zwischen
// den Geräten (z. B. iCloud/Obsidian Sync); sonst gilt nur der Git-Vergleich.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const VAULT_DIR = process.env.REONIC_VAULT_DIR
  ?? "/Users/mikailaslan/Obsidian/Aslan/20-Bereiche/D-Wmee/Reonic Clone Final";
const NOTE_PATH = join(VAULT_DIR, "Handover-Stand.md");
const HISTORY_KEEP = 20;

function git(args: Array<string>): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function originHead(branch: string): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", "origin", branch], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    const sha = out.split(/\s+/)[0];
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function latestCiRun(branch: string): string {
  try {
    const out = execFileSync(
      "gh",
      ["run", "list", "--branch", branch, "--limit", "1", "--json",
        "databaseId,conclusion,status,displayTitle,createdAt"],
      { cwd: REPO, encoding: "utf8", timeout: 30_000 },
    ).trim();
    const runs = JSON.parse(out) as Array<{
      databaseId: number;
      conclusion: string | null;
      status: string;
      displayTitle: string;
      createdAt: string;
    }>;
    const run = runs[0];
    if (!run) return "kein Lauf gefunden";
    return `${run.databaseId} (${run.conclusion ?? run.status}) — ${run.displayTitle}`;
  } catch {
    return "unbekannt (gh nicht verfügbar)";
  }
}

function readLastRecorded(): { originHead: string | null; at: string | null } {
  if (!existsSync(NOTE_PATH)) return { originHead: null, at: null };
  const text = readFileSync(NOTE_PATH, "utf8");
  const heads = [...text.matchAll(/^origin_head:\s*([0-9a-f]{40})\s*$/gm)].map((m) => m[1]);
  const ats = [...text.matchAll(/^at:\s*(.+?)\s*$/gm)].map((m) => m[1]);
  return {
    originHead: heads.length > 0 ? heads[heads.length - 1]! : null,
    at: ats.length > 0 ? ats[ats.length - 1]! : null,
  };
}

function main(): void {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unbekannt";
  const localHead = git(["rev-parse", "HEAD"]);
  const localShort = git(["rev-parse", "--short", "HEAD"]) ?? "?";
  const subject = git(["log", "-1", "--pretty=%s"]) ?? "?";
  const dirty = (git(["status", "--porcelain"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const origin = branch === "unbekannt" ? null : originHead(branch);
  const aheadBehind = origin && localHead
    ? git(["rev-list", "--left-right", "--count", `${origin}...${localHead}`])
    : null;
  const ci = branch === "unbekannt" ? "unbekannt" : latestCiRun(branch);
  const recorded = readLastRecorded();
  const now = new Date().toISOString();

  const lines: Array<string> = [];
  lines.push("== Handover-Check ==");
  lines.push(`Zeitpunkt: ${now}`);
  lines.push(`Branch: ${branch}`);
  lines.push(`Lokal: ${localShort} (${subject})`);
  lines.push(`Origin: ${origin ? origin.slice(0, 7) : "offline/unbekannt"}`);
  lines.push(`Arbeitsbaum: ${dirty.length === 0 ? "sauber" : `${dirty.length} offene Datei(en)`}`);
  for (const file of dirty.slice(0, 15)) lines.push(`  - ${file}`);
  if (dirty.length > 15) lines.push(`  … +${dirty.length - 15} weitere`);
  if (aheadBehind) {
    const [behind, ahead] = aheadBehind.split(/\s+/).map(Number);
    lines.push(`Abstand zu Origin: ${ahead} voraus / ${behind} hinterher`);
  }
  lines.push(`Letztes CI-Orakel (${branch}): ${ci}`);
  if (recorded.originHead) {
    lines.push(`Vault-Stand vom ${recorded.at ?? "?"}: ${recorded.originHead.slice(0, 7)}`);
  } else {
    lines.push("Vault-Stand: noch keiner notiert");
  }

  let verdict: string;
  if (!localHead || !origin) {
    verdict = "UNKLAR — Offline? Git- oder Netzprüfung fehlgeschlagen. "
      + "Ohne Origin-Vergleich ist „aktuell“ nicht beweisbar.";
  } else if (localHead !== origin) {
    verdict = dirty.length > 0
      ? "NICHT AKTUELL — erst `git stash`/`git commit`, dann `git pull`, "
        + "danach `npm run handover` wiederholen."
      : "NICHT AKTUELL — `git pull` ausführen, danach `npm run handover` wiederholen.";
  } else if (dirty.length > 0) {
    verdict = "HEAD AKTUELL, ABER ARBEITSBAUM SCHMUTZIG — offene Dateien committen "
      + "oder stashen, bevor du woanders weiterarbeitest.";
  } else if (recorded.originHead && recorded.originHead !== origin) {
    verdict = "HEAD AKTUELL — aber die Vault-Notiz war älter und wird jetzt "
      + "nachgezogen. Ab hier gilt dieser Stand.";
  } else {
    verdict = "OK, DAS IST WIRKLICH DER AKTUELLSTE STAND — HEAD = Origin, Baum sauber.";
  }
  lines.push(`Ergebnis: ${verdict}`);
  console.log(lines.join("\n"));

  try {
    if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });
    const entry = [
      "### Handover",
      `at: ${now}`,
      `branch: ${branch}`,
      `local_head: ${localHead ?? "?"}`,
      `origin_head: ${origin ?? "?"}`,
      `dirty: ${dirty.length}`,
      `ci: ${ci}`,
      `verdict: ${verdict}`,
      "",
    ].join("\n");
    let previous = "";
    if (existsSync(NOTE_PATH)) {
      previous = readFileSync(NOTE_PATH, "utf8");
      const parts = previous.split(/^### Handover\s*$/m);
      const header = parts[0] ?? "";
      const kept = parts.slice(1).slice(-(HISTORY_KEEP - 1));
      writeFileSync(
        NOTE_PATH,
        `${header}${kept.map((p) => `### Handover${p}`).join("")}${entry}`,
        "utf8",
      );
    } else {
      const header = [
        "---",
        "title: Handover-Stand",
        "type: handover",
        "status: active",
        `created: ${now.slice(0, 10)}`,
        `updated: ${now.slice(0, 10)}`,
        "tags:",
        "  - reonic-clone",
        "  - handover",
        "---",
        "",
        "# Handover-Stand",
        "",
        "Maschinell gepflegt durch `npm run handover` (Skript",
        "`scripts/handover.mts`). Jeder Eintrag beweist: Welcher Origin-HEAD",
        "galt wann auf welchem Stand? Auf dem anderen Gerät gilt: `git pull`,",
        "dann `npm run handover` — Ergebnis `OK, DAS IST WIRKLICH DER",
        "AKTUELLSTE STAND` abwarten, erst dann weiterarbeiten. Es werden nur",
        "SHAs, Branch, Dateinamen und CI-Titel notiert — keine Secrets, keine",
        "Kundendaten, keine OTPs.",
        "",
      ].join("\n");
      writeFileSync(NOTE_PATH, `${header}${entry}`, "utf8");
    }
    console.log(`Vault-Notiz aktualisiert: ${NOTE_PATH}`);
  } catch (error) {
    console.log(`Vault-Notiz NICHT geschrieben (${(error as Error).message}) — `
      + "Git-Vergleich oben gilt trotzdem.");
  }

  if (verdict.startsWith("UNKLAR") || verdict.startsWith("NICHT") || verdict.startsWith("HEAD AKTUELL, ABER")) {
    process.exitCode = 1;
  }
}

main();
