# Prompt 1 — Verifikation (Mac Studio)

Du bist ein Software-Ingenieur auf einem Mac Studio. Prüfe ZUERST, ob die
Übergabe aus dem Obsidian-Vault vollständig ist und ob du auf alle Ressourcen
Zugriff hast. Arbeite strikt read-only (keine Änderungen an Code, Git oder
Datenbank), bis alle Prüfpunkte grün sind.

## Prüfschritte

1. **Vault lesen** (in dieser Reihenfolge):
   `/Users/mikail/Downloads/OBSIDIAN/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/`
   - `00-Start-hier.md`
   - `01-Laufender-Stand.md` (letzter Eintrag muss `2026-09-04 (nacht) — F9.2 Stoppuhr VERIFIED` enthalten)
   - `05-Handover-Mac-Studio.md` (muss existieren und §2 mit den 7 Session-Slices 0048–0054 aufführen)
   - `reonic-clone/REONIC-PARITY-GOAL-PROMPT.md` (kanonischer Auftrag)

2. **Repo-Zugriff prüfen**:
   - `cd /Users/mikail/Projects/energie-saas-m1-wave-02`
   - `git status` — Branch muss `codex/m1-wave-02` sein, sauberer Baum
   - `git log --oneline -1` — HEAD muss `194fb3e` sein („feat(f9.2): Zeiterfassung-Stoppuhr …")
   - `git remote -v` + `git fetch --dry-run` — Push/Pull zum Remote möglich
   - `ls drizzle/*.sql | sort | tail -7` — letzte Migrationen müssen
     0048_v5 … 0054_f9_02_timer sein (Lückenlosigkeit 0048→0054 prüfen)

3. **Toolchain prüfen**:
   - `node --version` (≥ 20), `npm --version`
   - `ls node_modules/.bin/next` — falls fehlt: `env -u npm_config_allow_scripts npm install`
     (WICHTIG: ohne `-u` schlägt der Install mit EALLOWSCRIPTS fehl)
   - `test -f .env.local && echo OK` (Symlink aufs Hauptrepo ist normal)

4. **Gates grün (read-only-Läufe)**:
   - `npm run check` → Erwartung: „203 passed (203)" Testdateien,
     „1931 passed | 1 skipped (1932)" Tests
   - `npm run build` → Exit 0
   - `printf 'y\n' | npm run db:generate` → „No schema changes, nothing to migrate"

5. **Fähigkeits-Audit (Skills/Plugins)** — der Agent muss für dieses
   Projekt KEINE DSH-Infrastruktur haben, aber prüfe und berichte:
   - Lese `06-Faehigkeiten-Inventar.md` im Vault (Klasse A/B/C/D).
   - Prüfe deine eigenen Fähigkeiten gegen die HART-Checkliste (§3):
     Shell/Datei-Tools, Git, Node/npm, Netz (OpenRouter + Reonic-API
     per curl), PV-Fachwissen.
   - Falls dein Skill-System die Klasse-A-Skills nicht hat: lade
     `06-Skills-Portable/` vollständig als Arbeitskontext (das ist der
     Ersatz) und vermerke das in der Tabelle.
   - MCPs (Context7/Playwright-DevTools/GitHub) sind NICE-TO-HAVE —
     fehlend = kein Blocker, nur Zeile „entfällt" eintragen.
   - Kimi-Key verifizieren (einmalig, read-only):
     curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models
     -H "Authorization: Bearer <KEY aus Prompt 3>"   → 200 erwartet.

## Ausgabeformat

Berichte eine Tabelle:

| Prüfpunkt | Status (OK/FEHLT/ABWEICHUNG) | Befund |
|---|---|---|
| Vault-Dokumente | … | … |
| Git-HEAD 194fb3e | … | … |
| Migrationen 0048–0054 | … | … |
| node_modules | … | … |
| check | … | … |
| build | … | … |
| db:generate | … | … |

Bei ABWEICHUNG: exakte Ausgabe/Fehlermeldung zitieren, NICHT selbst
reparieren — erst im Antworttext melden, was fehlt oder abweicht.
