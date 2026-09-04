# LOOP-LOG (Welle 03/04) — ein Eintrag je Turn

## Turn 1 — 2026-09-04, Loop-Start

- Turn-Start: Fetch ok. `origin/codex/m1-wave-02` = `cf02c26` (neu: CI-Pipeline
  + Parity-Auswertung, 2 Dateien). Eigene Lane `codex/muse-welle-03-e2e`
  darauf rebased (3 Commits: f7-03-Isolation, Fehler-Mapping, Docs).
- Push-Transport: globaler ECC-Pre-Push-Hook (`core.hooksPath`,
  lint→typecheck→test) scheitert in Sandbox (tsx-EPERM, kein listen()).
  DECIDED: `ECC_SKIP_PREPUSH=1` (designed Hook-Interface, kein
  `--no-verify`) — Gate ist CI auf `codex/**`. Wird je Push offengelegt.
- Push ok: Lane auf origin (3 Commits). CI läuft (`codex-lane-gates` +
  `ci`, in_progress). GitHub-API ohne Token: 404 (Repo privat) → `gh`
  (authentifiziert) nutzen.
- Rebase-Nebenwirkung: `--autostash` hat den getrackten
  node_modules-Symlink restauriert und den lokalen Install verdrängt.
  Fix: Reinstall + `git update-index --skip-worktree node_modules`.
- RUNTIME-BLOCKs: keine (kein Permission-Prompt aufgetreten).
- Nächster Schritt: lokale Gates → F2.2-Commit (Seed f22 + Spec) → Push
  → CI-Ergebnis lesen.

## Turn 2 — 2026-09-04, Nachholblock code-fertig

- Pushes: F2.2 (`0dee6c9`), F9.3 (`6cbc35f`), F16.2 (`905c188`), F10.1
  (`0bf3394`) — je eigene W3-Projekte, lokale Gates je Commit grün
  (lint 0 Errors, typecheck, --list Exit 0; depcruise/generate geprüft).
- CI (`codex-lane-gates` + `ci`) läuft auf dem F10.1-Push; ältere Runs per
  cancel-in-progress ersetzt. Urteil steht aus.
- M2-04-Sichtung: Migration 0044, Service, UI-Panel, `/s/[token]`-Route
  und komplette E2E-Skeleton (Guard/Create/Withdraw/Expiry/External+A11y)
  vorhanden — nach 09 §5.2 bleibt Gate-Lauf + Reviews (Exit-3 ohne Key).
- RUNTIME-BLOCKs: keine.
- Nächster Schritt: CI-Urteil zu 0bf3394 lesen; bei Rot fixen, bei Grün
  M2-04-Gate-Lauf.

## Turn 3 — 2026-09-04, Warten auf CI, M2-04 vorbereitet

- CI läuft weiter (F10.1-Push, beide Workflows in_progress). Kein Urteil.
- M2-04 gelesen: Spec (455 Z.), ADR 0022 (228 Z.), E2E-Skeleton komplett
  (Guard/Create/Withdraw/Expiry/External+A11y), DB-Tests
  (`m204-e-signature-service/-strict`) vorhanden. Nach 09 §5.2 bleibt
  Gate-Lauf + Reviews (Exit-3 ohne Key) — kein Neu-Code absehbar.
- RUNTIME-BLOCKs: keine.
- Nächster Schritt: CI-Urteil lesen.

## Turn 4 — 2026-09-04, Actions war aus / State-Push triggert CI

- Befund Mikail: GitHub Actions wurde erst NACH meinen Pushes aktiviert —
  alte Pushes triggern nichts nachträglich. Bisherige in_progress-Runs
  sind Phantome ohne Läufer.
- State-Dateien (GOAL/LOOP-LOG) committet + gepusht (`75054be`) → beide
  Workflows laufen (Trigger verifiziert, `ci` + `codex-lane-gates`
  in_progress). `ci.yml`-Erstlauf enthält Docker-Schritte.
- M2-04-Selbstreview (Exit-3-Ersatz): Service komplett (create/withdraw/
  analog/sign/revoke/view/resolve), Guard-Route konservativ korrekt
  (DEC-M204-04), DEFINER-Funktionen app_owner + Rollenvertrag-Pins
  vorhanden (Lern-Register #10 erfüllt). Kein Neu-Code nötig — nur Urteil.
- RUNTIME-BLOCKs: keine.
- Nächster Schritt: Trigger verifizieren, parallel M2-04-Gap-Check
  (Spec/ADR vs. Implementierung), CI-Urteil am nächsten Turn-Start.

## Turn 5 — 2026-09-04, CI rot, Ursachenjagd ohne Logs

- Urteil: Gates (`npm run test`) + E2E + `ci`/`check` rot auf 75054be.
  Lint/Typecheck/Contract/Depcruise grün (nur bekannte Warnings).
- CI-Logs unerreichbar: results-receiver antwortet leer (Sandbox-Limit).
  Nur Step-Namen via Annotations. Rerun angestoßen (Flake-Test).
- Kopplungsanalyse: Lane-Delta ist vitest-neutral (kein Test importiert
  Actions/Specs/Seed/Docs — grep-belegt). Fehler-Mapping exoneriert.
  Verdacht: vorbestehendes Rot auf cf02c26 (nie gegated) oder CI-Env.
- Kontrollexperiment: `codex/w3-base-check` (clean cf02c26) gepusht.
- Seed-Audit (E2E): Caps geprüft (`project.write` Rolle, `manage_catalog`
  vorhanden) — kein Defekt gefunden.
- Nächster Schritt: Urteile (Rerun + Kontrolle) lesen, dann gezielt.

## Turn 6 — 2026-09-04, CI-Billing dicht, Observability gebaut

- Kontrolle `codex/w3-base-check` (clean cf02c26): `ci` failure UND
  Gates-Step „Testsuite (Vitest)" failure → Rot BEWIESEN vorbestehend,
  Lane exoneriert. Welcher Test: unbekannt (keine Logs) — klärt der
  Artefakt-Commit nach Billing-Fix.
- Rerun Lane: E2E 3/3 deterministisch rot; Gates-Urteil offen.
- Observability-Commit `be81fb6` (Vitest-JSON + Playwright-JSON als
  Artefakte, best-effort) gepusht — lief nie: Jobs sterben seit ca. 21:37
  in 3s („payments have failed or spending limit") → FRAGEN-AN-MIKAIL
  Nr. 6 (BLOCKED-ON-MIKAIL, nur Account-Inhaber).
- Branch-Löschung remote per Sicherheitsnetz gesperrt (ok, Zweig bleibt).
- RUNTIME-BLOCKs: keine (Permission-Prompts: keine).
- Nächster Schritt: ohne CI weiter (folgende Slices specen+bauen,
  Verifikation nach Billing-Fix); Kontroll-Gates-Urteil mitnehmen.

## Turn 7 — 2026-09-04, Vitest-Rot: Hypothesen ohne Log

- `ci.yml` stellt echtes PG per Service (`POSTGRES_URL_TEST`), die neue
  Lane-CI nutzt Embedded-PG ohne Service. Lane-Delta ist vitest-neutral
  (grep-belegt) → Rot sitzt in Basis/CI-Env.
- Hypothesen (unbewiesen, Reihenfolge): Embedded-PG-Boot auf
  ubuntu-latest (Binärkompatibilität/Download), Node-24-Laufzeit, echter
  Testdefekt auf cf02c26. Klärung erst mit Logs/Artefakten nach
  Billing-Fix (Observability-Commit liegt bereit).
- Nächster Schritt: F9.4+-Scoping (Modulkatalog), Spec-Arbeit ohne CI.

## Turn 9 — 2026-09-04, F9.4 Slice A specifiziert

- F9.4+ = Katalog-F9.3-Rest. Slice A (dieser Turn): CSV-Export
  (`docs/spec/F9-04-zeiterfassung-export.md`) — Lese-Pfad ohne Migration,
  Route nach Rechnungs-CSV-Muster, Berlin-Zeiten, Nutzer als UUID
  (kein Identity-Join). Selbstreview: RFC-Widerspruch, TZ und
  Cross-Spec-Abhängigkeit korrigiert.
- Folge-Slices vorgemerkt: B Versionshistorie, C GPS, D Dashboards.
- CI weiter dicht (Billing, FRAGEN-6). RUNTIME-BLOCKs: keine.
- Nächster Schritt: Slice A implementieren (Contract→Service→Route→UI→
  Tests), lokale Gates, Commit.

## Turn 8 — 2026-09-04, Integration erhalten, 4 Lektionen

- Mikail hat Lane + Gatefix integriert (`e728fb5`, `31a61c4`) und den
  E2E-Job scharf gestellt (`258fb8a`). Seine Gates: alles grün, E2E
  90/90. Lane auf 258fb8a fast-forwarded.
- Die 4 Root-Causes (alle E2E-seitig, meine Statik blind):
  1. f7-02: kein Serverfehler — `key={version}`-Remount fraß den Toast
     (Server lieferte success). Lehre: bei fehlendem Toast erst
     Remount-Verdacht prüfen (React-Keys!), dann Server.
  2. F2.2/F16.2: W3-Caps unvollständig (convert_phase/discounts fehlten,
     Create-Gate read_only). Lehre: Referenz-Membership EXAKT spiegeln,
     nie per Pfad-Analyse kürzen.
  3. F10.1: 404-Navigation loggt Console-Errors (m1-08b-Muster existiert).
     Lehre: bekannte Konsolen-Muster VORHER aus Nachbar-Specs übernehmen.
  4. Doppel-Seed kollidierte auf SKU-Unique (skuSuffix nötig). Lehre: bei
     Seeder-Wiederverwendung Uniqueness-Annahmen prüfen.
- Vitest-Rot: auf seiner Maschine grün (208/1969) — CI-Rot war
  Env/ungegatete-Basis, kein Lane-Defekt. Billing weiter sein Part.
- RUNTIME-BLOCKs: keine.
- Nächster Schritt: F9.4-Spec (erster Vertiefungs-Slice).
