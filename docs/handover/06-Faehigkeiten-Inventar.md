# 06 — Fähigkeiten-Inventar (DSH ↔ Mac Studio)

Stand 2026-09-04. Beantwortet: „Braucht der Agent auf dem Mac Studio die
Skills/Plugins aus dem DeepSeek-Harness-Agent-Preset?"

## Kurzantwort

**Nein — die Laufzeit-Infrastruktur (DSH) ist nicht übertragbar und nicht
nötig.** Was übertragbar ist und gebraucht wird, ist (a) das **Wissen**
der projektkritischen Skills — liegt jetzt als Kopie in
`06-Skills-Portable/` — und (b) die **Repro-Toolchain** (Node/npm/git/
Netz), die der Mac Studio selbst mitbringt oder installiert. Die MCPs
des Presets sind für dieses Projekt **nice-to-have, nicht Pflicht**.

## 1. Was das Preset hier enthält (Inventar der Quelle)

- **34 Skills** unter `/Users/mikail/.dsh/.agent-presets/software-factory/skills/`
- **4 aktive MCPs** (aus `agent.cordis.yml`): `mcp-context7`
  (Doku-Lookup), `mcp-chrome-devtools`, `mcp-playwright`,
  `mcp-github`; weitere (Sentry/Supabase) auskommentiert.
- DSH-Plugins (client-plugin u. a.) sind Laufzeit-Interna der DSH-GUI —
  für die Projektarbeit irrelevant.

## 2. Klassifikation der 34 Skills für den Mac Studio

| Klasse | Skills | Braucht der Mac Studio? |
|---|---|---|
| **A — projektkritisch (Wissen)** | `reonic-parity`, `pv-fachwissen`, `software-quality-gates`, `product-lens`, `contract-first`, `database-migrations`, `playwright-verify`, `browser-qa` | **Ja** — Kopie liegt in `06-Skills-Portable/`; der Mac-Studio-Agent liest sie als Kontext-Dokumente, falls sein eigenes Skill-System sie nicht hat |
| **B — generische Best Practices** | api-design, code-review, e2e-testing, postgres-patterns, frontend-*, git-workflow, error-handling, coding-standards, security-audit, deployment-patterns, docker-patterns, hexagonal-architecture, architecture-decision-records, delivery-gate, documentation-lookup, context-budget, plan-canvas, blueprint, effort-router, plugin-router, tokenless | **Nein (Pflicht)** — jeder fähige Agent hat Äquivalente; die Hausregeln stehen zusätzlich in `docs/parity/RUNBOOK.md` + STATUS.md + CONTRIBUTING.md im Repo |
| **C — Orchestrierungs-Skills (DSH-spezifisch)** | orch-add-feature, orch-build-mvp, orch-change-feature, orch-fix-defect, orch-refine-code | **Nein** — sie steuern DSH-Subagenten; der Mac-Studio-Agent orchestriert mit seinen eigenen Mitteln (der /go-Prompt beschreibt die Gate-Kette selbst) |
| **D — Domain-/Projekt-Spezifika** | `vault-orientierung` (im Vault selbst erklärt: `00-Start-hier.md`), `caveman`, `higgsfield` (fremd) | nur `00-Start-hier.md` lesen |

## 3. Was der Mac Studio HART braucht (Checkliste)

| Fähigkeit | Wie prüfen | Ersatz, falls fehlt |
|---|---|---|
| Node ≥ 20 + npm | `node --version && npm --version` | Installieren |
| git + Shell + Datei-Tools | `git --version` | Standard |
| Netz: npm-Registry, OpenRouter (Kimi-Key), Reonic-API (read-only) | `curl -sI https://openrouter.ai/api/v1/models` / `curl -s https://api.reonic.de/rest/v3/openapi` | Mikail melden |
| PostgreSQL für Tests | entfällt — embedded-postgres lädt Binaries selbst beim ersten `npm run check` | — |
| Chromium für E2E | Playwright (Repo-DevDep) lädt selbst | — |
| Kimi-K3-Review | Skript `scripts/kimi-review.mts` + Key (Prompt 3) | OpenRouter-Key prüfen |
| PV-Fachwissen | `06-Skills-Portable/pv-fachwissen/` als Kontext laden | — |

## 4. Was der Mac Studio NICHT braucht

- DeepSeek Harness selbst (GUI, client-plugin, Subagenten-Laufzeit)
- Die 4 Preset-MCPs (Playwright/DevTools/GitHub/Context7) — die E2E laufen
  über `npm run test:e2e` im Repo, Git über die CLI, Docs via Context7 nur
  bei Framework-Fragen (Web-Suche reicht)
- Die 26 generischen Skills als Dateien — sie sind Best Practice und im
  Repo (RUNBOOK/CONTRIBUTING) ohnehin verschriftlicht

## 5. Empfehlung an den Mac-Studio-Agenten (steht auch in Prompt 1)

1. Zu Beginn: `00-Start-hier.md` → `01-Laufender-Stand.md` →
   `05-Handover-Mac-Studio.md` lesen.
2. `06-Skills-Portable/` einmal vollständig als Arbeitskontext laden
   (8 Dateien, ~16 KB) — das ersetzt die Preset-Skills Klasse A.
3. Vor jedem Slice: `reonic-parity` + `software-quality-gates` +
   `contract-first` + `database-migrations` gezielt wieder lesen.
4. Product-Entscheidungen: `product-lens`-Checkliste anwenden.
5. PV-/Fachfragen: `pv-fachwissen`.
