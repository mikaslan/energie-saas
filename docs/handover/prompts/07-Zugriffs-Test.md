# Prompt 7 — Zugriffs-Test (vorab, read-only, schnell)

Du bist auf einem Mac Studio. Teste NUR den Zugriff auf alle nötigen
Dateien — strikt read-only, KEINE Änderungen, KEINE Installationen,
KEINE langen Testläufe. Dauer maximal wenige Minuten.

## Prüfliste (alle Befehle einzeln ausführen)

### A. Vault
V="/Users/mikailaslan/Documents/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final"
1. test -f "$V/00-Start-hier.md" && echo OK || echo FEHLT
2. test -f "$V/01-Laufender-Stand.md" && grep -q "F9.2 Stoppuhr VERIFIED" "$V/01-Laufender-Stand.md" && echo OK || echo FEHLT
3. test -f "$V/05-Handover-Mac-Studio.md" && echo OK || echo FEHLT
4. test -f "$V/06-Faehigkeiten-Inventar.md" && echo OK || echo FEHLT
5. ls "$V/06-Skills-Portable/" | wc -l   (erwartet: 8)
6. ls "$V/30-Prompts/" | wc -l           (erwartet: mindestens 7)
7. test -f "$V/30-Prompts/06-Ultra-Prompt.md" && echo OK || echo FEHLT
8. test -f "$V/reonic-clone/REONIC-PARITY-GOAL-PROMPT.md" -o -f "$V/../reonic-clone/REONIC-PARITY-GOAL-PROMPT.md" && echo OK || echo FEHLT
   (Hinweis: liegt ggf. unter .../Rechner/reonic-clone/ — find-Suche erlaubt)

### B. Repo
R=~/Projects/reonic-clone-finale-claude
9.  test -d "$R/.git" && echo OK || echo FEHLT
10. git -C "$R" remote -v | grep -q "github.com/mikaslan/energie-saas" && echo OK || echo FEHLT
11. git -C "$R" fetch origin --dry-run && echo OK || echo FEHLT
12. git -C "$R" rev-parse origin/codex/m1-wave-02
    (erwartet: 194fb3e…; liefert ls-remote den Branch, rev-parse aber
    nicht → einmal git -C "$R" fetch origin (echt) ausführen, dann erneut)
13. test -f "$R/.env.local" && echo OK || echo FEHLT
    (NUR Existenz prüfen — Inhalt NIE ausgeben)
14. ls "$R/node_modules/.bin/next" >/dev/null 2>&1 && echo OK || echo FEHLT
15. git -C "$R" archive origin/tooling docs/parity/STATUS.md 2>/dev/null | tar -xO 2>/dev/null | grep -q "F9.2 Stoppuhr" && echo OK || echo FEHLT
16. git -C "$R" archive origin/tooling docs/handover 2>/dev/null | tar -t 2>/dev/null | grep -q "prompts/06-Ultra-Prompt.md" && echo OK || echo FEHLT
17. git -C "$R" ls-tree origin/codex/m1-wave-02 --name-only drizzle/ | grep -E "005[0-4]_" | wc -l
    (erwartet: 5 — 0050 bis 0054)

### C. Toolchain + Netz
18. node --version && npm --version && git --version   (node ≥ 20)
19. curl -s -o /dev/null -w "%{http_code}" https://github.com             (erwartet: 200/301/302)
20. curl -s -o /dev/null -w "%{http_code}" https://api.reonic.de/rest/v3/openapi   (erwartet: 200)
21. curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models     (erwartet: 200/401 — Erreichbarkeit zählt)
22. Falls .env.local existiert (Punkt 13 OK):
    KEY=$(grep -m1 '^OPENROUTER_API_KEY=' "$R/.env.local" | cut -d= -f2-)
    curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models -H "Authorization: Bearer $KEY"
    (erwartet: 200; NIE den Key selbst ausgeben)

## Ausgabeformat (nur das, nichts weiter)

Tabelle mit drei Spalten: Nr | Prüfpunkt | Ergebnis (OK/FEHLT + exakte
Ausgabe bei Abweichung). Danach EINE Zeile Verdikt:

- Alles OK → "ZUGRIFF VOLLSTÄNDIG — bereit für den Ultra-Prompt."
- Sonst → "ES FEHLT: <Nr-Liste>" — KEINE Reparaturen, KEINE Fragen,
  nur die Fehlliste melden.
