---
name: software-quality-gates
description: Pflichtkette für jede Software-Änderung: bauen, typisieren, linten, testen, scannen — mit echten Exit-Codes, nie auf Annahme. Lädt bei Implementierungs-, Refactoring- oder Abschlussarbeit an Code.
---

# Software-Quality-Gates — Pflichtkette

Prinzip: **Verifizieren, nie „sollte gehen".** Jedes Gate wird ausgeführt und sein
Exit-Code gelesen. Ein grünes Gate ist ein gemessener Zustand, keine Vermutung.

## Kette (vor jedem „fertig", in dieser Reihenfolge)

| # | Gate | Befehl (je Stack anpassen) | Rot bei |
|---|---|---|---|
| 1 | Build | `pnpm build` | Exit ≠ 0 |
| 2 | Typecheck | `tsc --noEmit` | Exit ≠ 0 |
| 3 | Lint/Format | `eslint .` / `biome check .` | Exit ≠ 0 |
| 4 | Echte Tests | `pnpm test` / `vitest run` | Exit ≠ 0 **oder 0 Tests** |
| 5 | Security-Scan | `semgrep --config=auto .` + `pnpm audit` | Findings/Exit ≠ 0 |
| 6 | Browser-Gate | Skill `playwright-verify` | Console-Fehler, kaputte Viewports |

Reihenfolge bewusst: das Billigste zuerst (Build schlägt schneller fehl als E2E).

## Definition of Done — erst „fertig", wenn

- alle Gates grün und ihre Ausgabe im Kontext gelesen wurde,
- jeder neue Code-Pfad einen Test hat, der ohne den Fix nachweislich fehlschlägt,
- keine TODO-/FIXME-Leichen im Diff sind (entweder erledigt oder Issue angelegt),
- die Änderung gegen Projektregeln (`CLAUDE.md`/`AGENTS.md`) geprüft wurde,
- ein `code-review`-Durchgang ohne P0/P1-Befunde gelaufen ist.

## Red Flags (sofort stoppen und klären)

- „läuft bei mir" ohne reproduzierbaren Befehl
- Tests, die nichts asserten, oder 0 Tests für neuen Code
- Exit-Code ignoriert, weil „die Warnung kenne ich schon"
- Globale Installationen statt Projekt-Dependencies (pnpm/devDependencies)
- Secrets oder Tokens in Logs, Commits oder Notizen

## Repo-Zustand

Vor Arbeit an fremdem/neuem Repo: Tooling-Status feststellen (package.json-Scripts,
Lockfile, CI). Fehlende Gates sind ein Befund, kein Freibrief — erst aufsetzen,
dann arbeiten. Die Gates sind Teil der Software, nicht optionaler Deko.
