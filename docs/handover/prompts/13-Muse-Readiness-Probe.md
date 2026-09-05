# MUSE READINESS-PROBE — einmaliger Selbstcheck (Delta, kein Dauer-Prompt)

/goal

Mache einen EINMALIGEN Umgebungs-Selbstcheck und antworte NUR mit dem
Bericht. Keine Fragen an Mikail, keine Code-Änderungen. Ergebnis
zusätzlich nach `docs/parity/muse-welle-03/READINESS.md` schreiben und
committen.

Prüfe und berichte als Tabelle (je Zeile: Status OK / FEHLT /
DEAKTIVIERT, plus ein Wort, ob es dich blockiert):

## 1. Skills (8 portable, Vault 06-Skills-Portable / origin/tooling)
- reonic-parity, pv-fachwissen, software-quality-gates, product-lens,
  contract-first, database-migrations, playwright-verify, browser-qa
- Je Skill: geladen als Skill ODER als fester Arbeitskontext
  (Fallback zählt) — welcher Weg gilt bei dir?

## 2. Plugins / MCPs
- Welche MCPs sind aktiviert (Name + Funktion)? Welche konfiguriert
  aber deaktiviert?
- Context7 (Doku) und GitHub-MCP: verfügbar oder nicht?
- Sind DSH-Plugins vorhanden? (Sie werden NICHT gebraucht — nur
  melden.)

## 3. GitHub-Repo-Zugriff
- `git fetch origin` erfolgreich? `git rev-parse origin/codex/m1-wave-02`
  → muss `5641e3a` sein (Abweichung melden).
- Arbeitskopie/-worktree vorhanden + sauber? `git status --short`
  (nur erwartete Dateien?).
- Push-Test: `git push --dry-run origin codex/muse-welle-03-e2e`
  (Credentials ok?).
- `gh` CLI installiert und angemeldet? Sonst: funktioniert der
  CI-Read per curl-API (Repo ist public)?

## 4. Werkzeuge & Secrets
- `node --version` (≥ 20), `npm --version`, `git --version`,
  `curl --version` — Versionen nennen.
- node_modules vorhanden und lauffähig?
- `.env.local` vorhanden? `grep -c "^OPENROUTER_API_KEY=" .env.local`
  → 0 oder 1 (NUR die Zahl, nie den Wert).

## 5. Sandbox-Grenzen (nur melden, ist bekannt)
- listen()/connect() auf Loopback: weiter EPERM?
- Was kannst du LOKAL grün fahren (lint/typecheck/depcruise/generate/
  playwright --list)? Was nur CI/Mikail (vitest, Rollen, Build, E2E)?

## Abschluss (max. 5 Zeilen)
- Was du ab sofort autonom kannst, was fehlt, und was MIKAIL fixen
  muss (z. B. OpenRouter-Key, Billing — Billing ist bereits erledigt,
  bitte bestätigen, dass CI-Läufe inzwischen starten).
