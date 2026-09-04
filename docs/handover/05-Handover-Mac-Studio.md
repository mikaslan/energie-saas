# 05 — Handover Mac Studio (Stand 2026-09-04, alle Lanes abgeschlossen)

Dieses Dokument ist der komplette Übergabestand für einen frischen Agenten
(Mac Studio). Reihenfolge: 01-Laufender-Stand.md lesen, dann dieses
Dokument, dann die Prompts in `30-Prompts/`.

## 1. Wo alles liegt

| Artefakt | Pfad |
|---|---|
| Repository (Haupt-Lane `tooling`) | `/Users/mikail/Projects/energie-saas` |
| Integrations-Worktree (KANONISCH, Branch `codex/m1-wave-02`) | `/Users/mikail/Projects/energie-saas-m1-wave-02` |
| Vault (Obsidian) | `/Users/mikail/Downloads/OBSIDIAN/ASLAN FINAL/20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/` |
| Status-Doku | `docs/parity/STATUS.md` (Repo, Tooling-Branch) |
| Kanonischer Auftrag | Vault: `reonic-clone/REONIC-PARITY-GOAL-PROMPT.md` |

**Kanonischer Code-Stand: Branch `codex/m1-wave-02`** (HEAD `194fb3e`).
Alle Slice-Lanes der Session sind dort per Fast-Forward integriert und
gepusht — es geht nichts verloren. Alle Slice-Lanes sind abgeschlossen,
keine WIP-Lane offen.

## 2. Was VERIFIED ist (chronologisch, alle gepusht)

- M1-Welle 01+02: Autorisierungsgrenze, Tenant-Schlüssel, Actor/Membership,
  DB-Rollentrennung (88/88 + PG18 5/5), Rechner-V3-Intake (HMAC), Lead-Triage,
  Adresskorrektur (Geoapify-Vertrag), Energieprofil (PVGIS-Vertrag),
  Produktkatalog, Zuweisung, DB-Core, Projekt-Aufgaben, Outcomes, Cannot
  fulfill, Task-Inbox, Notizen, Kontakte (M1-14), Termine/Kalender (M1-15).
- M2-01 Angebotsvarianten + Snapshot-BOM; M2-04 E-Signatur: Spec+ADR fertig.
- M3-00 Stammdaten, M3-01 Rechnungs-Kern.
- F4.6 Workspace-Simulationsdefaults.
- **Session 2026-09-04 (dieser Stand):**
  - 0048 v5-Leadquelle (Rechner-v5-Leads ohne Berechnung, Producer-Enum)
  - 0049 F1.8 Lead-Sources (OBSERVED-Schema, Intake-Attribution)
  - 0050 F9.1 Zeiterfassung (Ereignistypen + manuelle Einträge)
  - 0051 F7.2 Projekt-Checkliste (Blocks/Segmente/Items, CAS)
  - 0052 M1-15b Kalender-Scopes (4 Scopes, Scope-RBAC, Maskierung)
  - 0053 F7.3 Checklisten-Vorlagen (Katalog-Positionen, ESTIMATE-Apply)
  - 0054 F9.2 Stoppuhr (start/stop/discard, partieller Unique)

**Nachweis-Stand:** 203 Testdateien, 1931 Tests + 1 Skipped, Build grün,
`db:generate` ohne Drift, E2E-Suites je Slice grün (M1-15 6/6, M1-15b 2/2,
F1.8 2/2, F9.1 2/2, F9.2 2/2, F7.2 2/2, F7.3 2/2).
**Quote (ESTIMATE):** ~35 % Gesamtmission F1–F16; Fundament ~97–98 %.

## 3. Arbeitsweise (Kurzform — Details im Goal-Prompt)

- Gate-Kette: DISCOVERED→SPECIFIED→CONTRACTED→RED→IMPLEMENTED→REVIEWED→
  VERIFIED. Vertrag zuerst, Schema-Hash/SHA-Pins, TDD mit echten Nachweisen.
- Kimi-K3-Review (OpenRouter, kimi-k3, effort high) für Spec UND Code:
  `cd /Users/mikail/Projects/energie-saas && npx tsx scripts/kimi-review.mts <prompt> <bundle> <out>`
- Slice-Lane: `git worktree add …-lane origin/codex/m1-wave-02`, dann
  `ln -sfn /Users/mikail/Projects/energie-saas-m1-wave-02/node_modules node_modules`
  und `.env.local`-Symlink aufs Hauptrepo. Integration per Fast-Forward in
  `codex/m1-wave-02`, dort check+build+db:generate, dann push.
- Migrationen: Drizzle `printf 'y\n' | npm run db:generate`; bei Auswahl-
  Prompts (Spalten-Rename) via PTY mit `\r` beantworten. **NIE** Control-
  Zeichen in CHECKs schreiben — POSIX-Klasse `[[:cntrl:]]` verwenden.
- Rollenvertrag: neue Tabellen in `scripts/db-role-contract.mts` verdrahten
  (Relation + RLS/FORCE-Pin + Policy-Hash-Pin + ACL-Pins). Policy-Hash
  per Check-Lauf aus der Fehlermeldung bootstrappen.
- Zähler nach jeder Migration: m111a-Tests (idx/TOTAL) + permissions-Test.
- RLS: Neue CRM-Tabellen = M1-CRM-Muster (tenant_isolation + FORCE, keine
  Actor-Policies); Geld-/Settings-Tabellen = 0047-Muster mit Actor-Policies.
- Verbote: keine Pushes auf main, kein Deploy, keine Reonic-Mutation,
  keine erfundenen Preise/Daten; Clean-Room (Reonic funktional, WMEE visuell).

## 3b. Review-Gate auf dem Mac Studio

Metamuse Spark 1.3 (Agent) arbeitet; **Kimi K3** prüft jede Spec- und
Code-Änderung als unabhängige Zweitstimme (Key + Anleitung: siehe
`30-Prompts/03-Go-Prompt.md`, Abschnitt „Review-Gate"). Key = SECRET,
nur in `.env.local`, nie committen.

## 4. Offene Punkte (Blocker bei Mikail)

- F4-Fragen UNK-F4-01..05 (KPI-Liste, Rechenkern-ADR 0026, Preis-Defaults,
  TOU-Umfang, Cashflow-Defaults) — größter Hebel.
- Browser-Login-Sweep (Portal-UI, read-only) — Freigabe ausstehend.
- S3-Object-Lock (M2-03b2), Live-PVGIS, Resend, Neon, Hetzner-Worker,
  Codex-Usage-Limit (Reset 7. Sep.), v5-Deploy-GO.
- Visuelle Gates INCONCLUSIVE bis Mikail-Freigabe.

## 5. Nächste Kandidaten (nach Mikail-Entscheid)

F2.2 Varianten-Vertiefung (isPrimary/totalPriceOverride/optionalBundles,
Live-evidenziert) · F9.3 Fremdnutzer-Filter · M2-04 E-Signatur (Spec fertig)
· F16.2 Vorlagen/Pakete · F10 Kundenportal · F4-Rechenkern (nach UNK-F4).

## 6. Befehle

```bash
cd /Users/mikail/Projects/energie-saas-m1-wave-02
npm run check          # lint+typecheck+contracts+depcruise+tests+db:roles
npm run build
printf 'y\n' | npm run db:generate   # Drift-Check
M1_05_E2E_GREP='F9.2' npm run test:e2e   # fokussierte E2E
```
