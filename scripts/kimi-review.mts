#!/usr/bin/env tsx
// kimi-review.mts — Review-Aufruf über Kimi K3 mit OpenRouter-Primär und
// lokalem CLI-Fallback (Vorgabe Mikail 2026-09-03):
//   1. OpenRouter-API (moonshotai/kimi-k3, reasoning effort high = max).
//   2. Wenn OpenRouter "leer" ist (402/429/5xx/Netzfehler) oder kein Key
//      gefunden wird: lokales Kimi-Code-Binding (~/.kimi-code/bin/kimi),
//      Effort max (CLI-Default auf kimi-k3).
// Aufruf: npx tsx scripts/kimi-review.mts <promptFile> <bundleFile> [outFile]
// Ausgabe: Review-Text nach stdout bzw. in outFile; Exit 0 = Antwort erhalten,
// Exit 3 = beide Wege erfolglos (Review muss warten, Mikail informieren).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [promptFile, bundleFile, outFile] = process.argv.slice(2);
if (!promptFile || !bundleFile) {
  console.error("Usage: kimi-review.mts <promptFile> <bundleFile> [outFile]");
  process.exit(2);
}

const prompt = readFileSync(promptFile, "utf8");
const bundle = readFileSync(bundleFile, "utf8");
const OUT = outFile && outFile !== "-" ? outFile : null;

function openRouterKey(): string | null {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const envLocal = join(process.cwd(), ".env.local");
  if (existsSync(envLocal)) {
    const match = readFileSync(envLocal, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match) return match[1].trim().replace(/^"|"$/g, "");
  }
  const configToml = join(homedir(), ".kimi-code", "config.toml");
  if (existsSync(configToml)) {
    const match = readFileSync(configToml, "utf8").match(/api_key\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

async function viaOpenRouter(): Promise<string | null> {
  const key = openRouterKey();
  if (!key) {
    console.error("[kimi-review] Kein OpenRouter-Key gefunden — lokales Binding.");
    return null;
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k3",
        reasoning: { effort: "high" }, // max effort
        messages: [
          {
            role: "user",
            content: `${prompt}\n\n=== REVIEW-BUNDLE (NUR dieses Material verwenden) ===\n${bundle}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      console.error(
        `[kimi-review] OpenRouter HTTP ${response.status} (${await response.text().then((t) => t.slice(0, 120))}) — Fallback auf lokales Binding.`,
      );
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim().length > 0) return content;
    console.error("[kimi-review] OpenRouter-Antwort leer — Fallback auf lokales Binding.");
    return null;
  } catch (error) {
    console.error(`[kimi-review] OpenRouter-Fehler (${String(error)}) — Fallback auf lokales Binding.`);
    return null;
  }
}

function viaLocalCli(): string {
  const cli = join(homedir(), ".kimi-code", "bin", "kimi");
  // Prompt als Argument (klein), Bundle via stdin; CLI-Default = Kimi K3, max.
  const output = execFileSync(cli, ["-p", prompt], {
    input: bundle,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return output.trim();
}

async function main(): Promise<void> {
  const fromOpenRouter = await viaOpenRouter();
  if (fromOpenRouter !== null) {
    console.error("[kimi-review] Quelle: OpenRouter API (kimi-k3, effort high).");
    if (OUT) writeFileSync(OUT, fromOpenRouter);
    else console.log(fromOpenRouter);
    return;
  }
  try {
    const fromCli = viaLocalCli();
    console.error("[kimi-review] Quelle: lokales Kimi-Binding (kimi-k3, effort max).");
    if (OUT) writeFileSync(OUT, fromCli);
    else console.log(fromCli);
  } catch (error) {
    console.error(`[kimi-review] Auch das lokale Binding ist erfolglos: ${String(error)}`);
    console.error("[kimi-review] Review aussetzen und Mikail informieren (OpenRouter-Credits prüfen).");
    process.exit(3);
  }
}

void main();
