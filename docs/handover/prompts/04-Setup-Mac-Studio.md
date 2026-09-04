# Prompt 0 — Setup + Verifikation (Mac Studio, Pfade v2)

Dieser Prompt ersetzt `01-Verifikations-Prompt.md` auf dem Mac Studio,
weil dort andere Pfade gelten (Home `/Users/mikailaslan`) und der
Übergabestand erst eingerichtet werden muss.

## Teil A — Einmalige Einrichtung (Mikail, nur EIN manueller Schritt)

1. **Secrets übertragen (einziger manueller Schritt)**: Kopiere
   `.env.local` aus dem Haupt-Repo des Quell-Macs
   (`/Users/mikail/Projects/energie-saas/.env.local`) nach
   `/Users/mikailaslan/Projects/reonic-clone-finale-claude/.env.local`
   (NIE über Chat/Prompt übertragen — nur Dateikopie). Darin stecken
   DB-URLs, Auth-Secrets, Reonic-Keys und der OpenRouter-/Kimi-Key.
2. Falls GitHub-Zugriff fehlt: Credential/SSH auf dem Mac Studio
   einrichten (Remote: `https://github.com/mikaslan/energie-saas.git`).
   (Muses `fetch --dry-run` war bereits erfolgreich — vermutlich entfällt
   das.)

Die gesamte Handover-Doku (05-Handover, 06-Inventar, Skills-Portable,
Prompts) liegt im Git-Repo unter `docs/handover/` (Branch `tooling`) —
Muse holt sie sich selbst per Git (siehe Teil B).

## Teil B — Repo-Basis + Handover-Doku herstellen (Muse, Schreibzugriff erlaubt)

1. `cd /Users/mikailaslan/Projects/reonic-clone-finale-claude`
2. `git fetch origin` und prüfen:
   `git rev-parse origin/codex/m1-wave-02` → muss `194fb3e…` ergeben.
   Fehlt der Branch: origin-URL prüfen
   (`git remote -v` muss `github.com/mikaslan/energie-saas.git` zeigen).
3. Handover-Doku prüfen (Vault ist seit 2026-09-04 synchron):
   ```
   ls "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/05-Handover-Mac-Studio.md"
   ls "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/30-Prompts/03-Go-Prompt.md"
   ```
   Beide müssen existieren. FEHLT etwas (Sync-Lücke): Doku per Git
   nachziehen —
   ```
   git fetch origin tooling
   git show origin/tooling:docs/handover/05-Handover-Mac-Studio.md > /tmp/05-Handover-Mac-Studio.md
   mkdir -p "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/30-Prompts"
   cd /tmp && rm -rf handover-git && mkdir handover-git
   git -C /Users/mikailaslan/Projects/reonic-clone-finale-claude archive origin/tooling docs/handover | tar -x -C handover-git
   cp -R handover-git/docs/handover/05-Handover-Mac-Studio.md handover-git/docs/handover/06-Faehigkeiten-Inventar.md handover-git/docs/handover/skills-portable "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/"
   cp -R handover-git/docs/handover/prompts "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/30-Prompts/"
   cp "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/30-Prompts/02-Wissens-Prompt.md" "/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/30-Prompts/02-Wissens-Prompt.md" 2>/dev/null || true
   ```
   Hinweis: 01-Laufender-Stand.md ist NICHT im Repo — der aktuelle Stand
   steht in docs/parity/STATUS.md (ebenfalls Branch tooling). Das Handover
   referenziert beides.
4. Worktree anlegen:
   `git worktree add /Users/mikailaslan/Projects/energie-saas-m1-wave-02 -b wave-02-checkout origin/codex/m1-wave-02`
   (falls der Pfad existiert: erst `git worktree remove --force`).
4. In den neuen Worktree wechseln und prüfen:
   - `git log --oneline -1` → `194fb3e feat(f9.2): Zeiterfassung-Stoppuhr …`
   - `ls drizzle/*.sql | sort | tail -7` → 0048_v5 … 0054_f9_02_timer
   - `test -f .env.local && echo OK` (sonst Teil A.2 wiederholen)
   - `node_modules`: Symlink anlegen
     `ln -sfn /Users/mikailaslan/Projects/reonic-clone-finale-claude/node_modules node_modules`
     — falls der Klon kein node_modules hat:
     `env -u npm_config_allow_scripts npm install`
     (WICHTIG: ohne `-u` schlägt der Install mit EALLOWSCRIPTS fehl).

## Teil C — Read-only-Verifikation (Gates)

1. `npm run check` → erwartet: **203 passed (203)** Testdateien,
   **1931 passed | 1 skipped (1932)** Tests.
2. `npm run build` → Exit 0.
3. `printf 'y\n' | npm run db:generate` → „No schema changes, nothing to migrate".
4. Fähigkeits-Audit:
   - Lese `06-Faehigkeiten-Inventar.md` (Klassen A/B/C/D).
   - Eigene Fähigkeiten gegen die HART-Checkliste (§3) prüfen.
   - Falls Klasse-A-Skills fehlen: `06-Skills-Portable/` vollständig als
     Arbeitskontext laden und das in der Tabelle vermerken.
   - Kimi-Key-Verifikation (einmalig, read-only):
     `curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models -H "Authorization: Bearer <KEY aus 30-Prompts/03-Go-Prompt.md>"`
     → 200 erwartet; 401/403 → Moonshot-direkt-Fall (Anleitung im
     Go-Prompt, Abschnitt Review-Gate).

## Ausgabeformat

Zwei Tabellen:
1. Repo-Basis: fetch-Ergebnis | rev-parse 194fb3e | Worktree-HEAD |
   Migrationen 0048–0054 | .env.local | node_modules — je Status
   (OK/FEHLT/ABWEICHUNG) + exakte Ausgabe bei Abweichung.
2. Gates + Fähigkeiten: check | build | db:generate | Klasse-A-Skills
   (vorhanden/Portable-Ersatz) | Kimi-Key (HTTP-Code) — je Status + Befund.

Erst wenn ALLE Zeilen OK sind (oder „Portable-Ersatz aktiviert"), mit
dem Go-Prompt (`30-Prompts/03-Go-Prompt.md`) weiterarbeiten.
