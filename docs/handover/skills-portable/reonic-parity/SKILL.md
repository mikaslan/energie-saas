---
name: reonic-parity
description: >
  Projekt-Kontext und Qualitätsregime für den Reonic-Nachbau „energie-saas"
  (PV-/Energie-SaaS im WMEE-Design). Laden bei jeder Arbeit am Ziel-Repository,
  vor neuen Slices, Features oder Reviews. Gate-Kette, Nachweis-Pflichten,
  Quellen der Wahrheit, harte Verbote.
---

# Reonic-Parität — Projektkontext & Qualitätsregime

## Quellen der Wahrheit (in dieser Reihenfolge lesen)

1. Vault: `20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/00-Start-hier.md` und
   `01-Laufender-Stand.md` (Status/Quote), `02-Entscheidungsprotokoll.md`,
   `04-Session-Index.md`.
2. Kanonischer Auftrag:
   `20-Bereiche/D-Wmee/Rechner/reonic-clone/REONIC-PARITY-GOAL-PROMPT.md`.
3. Engineering: Git-Repository `/Users/mikail/Projects/energie-saas`
   (Worktrees, `docs/parity/STATUS.md`).

## Mission

Eigenständige, produktionsfähige B2B-Energie-SaaS mit funktionaler und
semantischer 1:1-Parität zu Reonic. **Reonic = funktionale Referenz,
WMEE.de = visuelle Referenz.** Ein Slice zählt erst mit der Kette
DISCOVERED → SPECIFIED → CONTRACTED → RED → IMPLEMENTED → REVIEWED →
VERIFIED. Ein Slice gilt erst als gesichert, wenn er gepusht ist.

## Harte Verbote (Clean Room)

Kein Reonic-Quellcode, keine Texte/Hilfetexte, keine Layouts/Icons/Assets,
keine Datenbank-Exports, keine Umgehung von Zugriffskontrollen, keine
visuelle Nachahmung, keine Optimierung vor dem Parity Freeze (Ideen nur in
`docs/optimization/BACKLOG.md`, je Item: Problem, Nutzergruppe, Beleg,
Wirkung, Risiko, Aufwand, Abhängigkeiten, Flag, Zeitpunkt).

## Qualitätsregime je Slice

- Vertrag zuerst (contract-first), Schema-Hash gepinnt, ADR für
  Architekturentscheidungen.
- TDD: RED vor IMPLEMENTED; Nachweise: `npm run check` (Vitest, alle Dateien
  grün), Rollenproben (88/88), PG18-Proben (5/5), Chromium-E2E,
  Production-Build, TypeScript, ESLint, Dependency-Cruiser,
  `git diff --check`, Secret-Scan.
- Datenbank: Migrationen additiv, RLS/Rollen strikt, Drift-Test
  (`db:generate` sauber), DSGVO-Erasuregraph beachten.
- Unabhängiger Review (Subagenten als Schwarm) vor VERIFIED; P0–P2 schließen.
- Visual-/Menschen-Gates bleiben INCONCLUSIVE, bis Mikail freigibt.

## Nicht tun

Keine CRM-/ERP-Wholesale-Einbauten (doppeln RBAC/RLS/Domain-Events der
verifizierten Architektur); AGPL/GPL/Custom-Lizenzen nur nach bewusster
Prüfung; keine erfundenen Produkt-/Preisdaten (der Katalog startet leer).
