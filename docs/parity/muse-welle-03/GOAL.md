# GOAL — energie-saas Parity Freeze (Welle 03)

Ziel: funktionale 1:1-Parität zu Reonic im WMEE-Design, alle F1–F16 VERIFIED.
Basis: Ultra-Prompt 06 (origin/tooling) + Delta 09 (dieses Dokument geht bei
Widersprüchen vor). Vault bleibt gesperrt — diese Datei + FRAGEN-AN-MIKAIL.md
leben unter `docs/parity/muse-welle-03/`, Mikail spiegelt in den Vault.

Stand: E2E-Nachholblock code-fertig auf Lane `codex/muse-welle-03-e2e`:
f7-03-Isolation, Fehler-Mapping, F2.2-/F9.3-/F16.2-/F10.1-Specs (je
eigenes W3-Projekt) + State-Push (Actions war aus, Erstlauf beider
Workflows). Basis `origin/codex/m1-wave-02` = `cf02c26`. M2-04-
Implementierung vorhanden (0044, Service, UI, Skeleton) — wartet auf
CI-Urteil. CI-Billing seit ca. 21:37 dicht (keine Job-Ausführung,
FRAGEN-AN-MIKAIL.md Nr. 6, BLOCKED-ON-MIKAIL). Lane-Rot ist vorbestehend
(Kontrolle clean-cf02c26 ebenfalls rot). Weiter ohne CI: specen+bauen,
verifizieren nach Billing-Fix.

Als Nächstes: 4 E2E-Specs (F2.2, F9.3, F16.2, F10.1, je eigener
Commit, eigenes Projekt je Spec) → f7-02-Root-Cause nach Mikails E2E-Output
→ M2-04. Pipeline: Lane `codex/muse-welle-03-e2e`, Commits lokal
(f433631 f7-03-Isolation, 16365b5 Fehler-Mapping), Push blockiert durch
globalen ECC-Pre-Push-Hook (FRAGEN-AN-MIKAIL.md Nr. 5) — kein Bypass.

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
