# Muse Welle-03 — Umgebungs-Selbstcheck (READINESS)

Stand: 2026-09-05 ~11:05 UTC · Branch: `codex/muse-welle-03-e2e` · Commit-Basis: `18e73cb`
Repo: `mikaslan/energie-saas` (Worktree `Projects/energie-saas-wave-02`)
Hinweis: Vault wurde NICHT gelesen (Turn ohne `/vault-lesen`, Sperre respektiert).

## 1. Skills (8 portable)

| Skill | Status | Weg bei mir | Blockiert? |
|---|---|---|---|
| browser-qa | OK | Skill (Katalog, `.agents/skills/browser-qa`) | nein |
| reonic-parity | OK | Fallback (`git show origin/tooling:docs/handover/skills-portable/reonic-parity/SKILL.md`, verifiziert) | nein |
| pv-fachwissen | OK | Fallback (dto., SKILL.md lesbar) | nein |
| software-quality-gates | OK | Fallback (dto., SKILL.md lesbar) | nein |
| playwright-verify | OK | Fallback (dto., SKILL.md lesbar) | nein |
| product-lens | FEHLT | weder Skill noch Arbeitskontext; tooling-Eintrag ist Symlink auf `/Users/mikail/.codex/plugins/cache/ecc/…` (Ziel fehlt, andere Maschine) | nein |
| contract-first | FEHLT | dto. (Symlink defekt) | nein |
| database-migrations | FEHLT | dto. (Symlink defekt) | nein |

## 2. Plugins / MCPs

| MCP / Plugin | Status | Funktion / Bemerkung | Blockiert? |
|---|---|---|---|
| mcp__context7 | OK | Doku (`resolve_library_id`, `query_docs`), per tool_search gefunden | nein |
| mcp__firecrawl | OK | Web-/Developer-Suche, GitHub-Index (Issues/PRs/READMEs) | nein |
| mcp__projectatlas | OK | Repo-Intelligenz (Datei-/Symbol-Suche) | nein |
| mcp__chrome_devtools | OK | Browser-Network-Inspektion | nein |
| mcp__shopify_dev | OK | Shopify-Doku/Validierung (hier irrelevant) | nein |
| GitHub-MCP | FEHLT | 3 tool_search-Proben, kein Treffer; Ersatz `gh`+curl funktioniert (s. 3) | nein |
| Exa-MCP | FEHLT | nur in `~/.mcporter/mcporter.json` (Fremd-Harness) konfiguriert, in meiner Session nicht auffindbar | nein |
| konfiguriert-aber-deaktiviert | DEAKTIVIERT | für mich nicht einsehbar (`~/.config/muse` lesegesperrt) | nein |
| DSH-Plugins | FEHLT | keine gefunden (Skills, Repo, `~/.codex/plugins/cache` ohne DSH-Treffer); werden nicht gebraucht | nein |

## 3. GitHub-Repo-Zugriff

| Prüfung | Status | Beleg | Blockiert? |
|---|---|---|---|
| `git fetch origin` | OK | Exit 0 (`tooling 9cee8f3..6fbefe3`) | nein |
| `git rev-parse origin/codex/m1-wave-02` | FEHLT | **`f42a019`, erwartet `5641e3a` → ABWEICHUNG** | nein |
| Worktree sauber | OK | `git status --short` leer, Branch `codex/muse-welle-03-e2e` | nein |
| `git push --dry-run origin codex/muse-welle-03-e2e` | OK | `Everything up-to-date` | nein |
| `gh` CLI | OK | installiert, angemeldet als `mikaslan` (keyring) | nein |
| CI-Read per curl | OK | `api.github.com/…/actions/runs` → HTTP 200 | nein |

## 4. Werkzeuge & Secrets

| Prüfung | Status | Beleg | Blockiert? |
|---|---|---|---|
| `node --version` | OK | `v26.4.0` (≥ 20) | nein |
| `npm --version` | OK | `11.17.0` | nein |
| `git --version` | OK | `2.52.0` | nein |
| `curl --version` | OK | `8.7.1` | nein |
| node_modules | OK | vorhanden, `node -e` ok, eslint `v9.39.5` läuft | nein |
| `.env.local` / `grep -c "^OPENROUTER_API_KEY="` | FEHLT | Datei fehlt → Zahl n/a (weder 0 noch 1 messbar) | nein |

## 5. Sandbox-Grenzen

| Prüfung | Status | Beleg | Blockiert? |
|---|---|---|---|
| listen() Loopback | DEAKTIVIERT | `LISTEN_ERR:EPERM listen EPERM 127.0.0.1` (weiter EPERM) | ja |
| connect()/fetch Loopback | DEAKTIVIERT | ohne Listener untestbar; `fetch 127.0.0.1:9` → `fetch failed` | ja |
| `npm run lint` lokal | OK | Exit 0 (0 errors, 11 warnings) | nein |
| `npm run typecheck` lokal | OK | Exit 0 (`next typegen` + `tsc --noEmit`) | nein |
| `npm run depcruise` lokal | OK | Exit 0 (470 Module, 0 violations) | nein |
| `npm run db:generate` lokal | OK | Exit 0 (`No schema changes`), Tree bleibt sauber | nein |
| `playwright test --list` lokal | FEHLT | Config verlangt kanonischen Loopback-Origin nur via `test:e2e` + Server (`playwright.config.ts:7/22`) → EPERM | ja |
| vitest / Rollen / Build / E2E | DEAKTIVIERT | nur CI/Mikail (DB/Server/Loopback nötig) | ja |

## Abschluss

- Autonom ab sofort: lesen/ändern/committen/pushen, lint/typecheck/depcruise/generate lokal grün, CI-Read via `gh`+curl; **Billing bestätigt — CI-Läufe starten** (zuletzt Run `33954429993`, heute 08:08 UTC, completed).
- Fehlt: 3 Skill-Inhalte (defekte Symlinks), `.env.local`, GitHub-MCP (Ersatz vorhanden), playwright-list/E2E lokal (EPERM).
- MIKAIL muss fixen: (1) Ref-Abweichung klären (`5641e3a` erwartet, `f42a019` gefunden); (2) OpenRouter-Key als CI-Secret prüfen/falls E2E ihn braucht; (3) vitest/Rollen/Build/E2E bleiben CI-Sache.
