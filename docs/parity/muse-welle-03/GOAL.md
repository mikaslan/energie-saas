# GOAL — energie-saas Parity Freeze (Welle 03)

Ziel: funktionale 1:1-Parität zu Reonic im WMEE-Design, alle F1–F16 VERIFIED.
Basis: Ultra-Prompt 06 (origin/tooling) + Delta 09 (dieses Dokument geht bei
Widersprüchen vor). Vault bleibt gesperrt — diese Datei + FRAGEN-AN-MIKAIL.md
leben unter `docs/parity/muse-welle-03/`, Mikail spiegelt in den Vault.

Stand: E2E-Nachholblock in Arbeit. Worktree `~/Projects/energie-saas-wave-02`,
Branch `codex/m1-wave-02`, HEAD `9fc49eb` (verifiziert). Migrationen 0000–0056
lückenlos. Ultra-Prompt 06 + Delta 09 vollständig gelesen.
Diagnosen f7-02/f7-03 von Mikail bestätigt (Details: FRAGEN-AN-MIKAIL.md §B).

Als Nächstes: npm-install → Gates-Baseline auf 9fc49eb → 4 E2E-Specs
(F2.2, F9.3, F16.2, F10.1, je eigener Commit, eigenes Projekt je Spec nach
M1-12a-Muster) → f7-02-Toast-Root-Cause + f7-03-Isolation fixen → M2-04.

Offene Mikail-Fragen: siehe FRAGEN-AN-MIKAIL.md (3 aktiv).
Mission: ~36 % (ESTIMATE) — steigt nur mit VERIFIED-Slices.
Lern-Register 09 §2: bindend, wird je Slice abgearbeitet.
Reviews: Kimi + DeepSeek je Spec/Code — BLOCKIERT (kein `.env.local`, kein
OPENROUTER_API_KEY) → Exit-3-Pfad: Gates entscheiden, in FRAGEN-AN-MIKAIL.md
notiert.

## Laufzeit-Umgebung (DECIDED, Sandbox-Limit, kein Repo-Defekt)

- `tsx`-CLI scheitert (`listen EPERM` IPC-Pipe) → alle Skripte via
  `node --import tsx <skript>` laufen lassen (Verhalten identisch).
- `listen()`/`connect()` auf Loopback generell EPERM → Embedded-Postgres,
  Next-Server, Vitest-DB-Suite, `db:roles:verify`, `test:e2e` hier NICHT
  lauffähig. DB-/E2E-Nachweise liefert Mikails Maschine (dort grün gemessen).
- `npm run build` scheitert hier am Google-Fonts-Fetch (Netzrestriktion).
- Grün HIER verifizierbar: lint, typecheck, contract-check, depcruise,
  `db:generate` („No schema changes" auf 9fc49eb bestätigt).
- Kein Push ohne vollständige Gates: Commits lokal, Push erst nach Mikails
  Gate-Lauf. F2.2 hat keine Primary-/Override-/Bundle-UI (Service-only);
  E2E deckt den klickbaren Variantenpfad + DB-Read-back ab (Details je Commit).
