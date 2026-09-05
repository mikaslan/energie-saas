# GOAL — energie-saas Parity Freeze (Welle 03)

Ziel: funktionale 1:1-Parität zu Reonic im WMEE-Design, alle F1–F16 VERIFIED.
Basis: Ultra-Prompt 06 (origin/tooling) + Delta 09 (dieses Dokument geht bei
Widersprüchen vor). Vault bleibt gesperrt — diese Datei + FRAGEN-AN-MIKAIL.md
leben unter `docs/parity/muse-welle-03/`, Mikail spiegelt in den Vault.

Stand: Nachholblock INTEGRIERT (`origin/codex/m1-wave-02` = `258fb8a`):
Lane + Mikails Gatefix (`31a61c4`, 4 Root-Causes) + scharfer E2E-Job.
Seine Gates: check 208/1969+1, Rollen 88/88, PG18 5/5, Build, E2E 90/90.
Lane auf 258fb8a fast-forwarded. M2-04 damit gates-belegt (Reviews
Exit-3). CI-Billing weiter dicht (FRAGEN-AN-MIKAIL.md Nr. 6).
Stand: F9.4 A–D + F10.2-A + F10.2-B + F16.3-A + F16.3-B + F16.3-C +
F16.3-D implementiert (Snapshot-v2, Fix-Modell, f1603d, E2E-04; lokal
grün, Goldens belegt; DB-/E2E-Ausführung pending CI/Maschine —
Billing-Block Q6). M2-04 als DONE pending CI verifiziert (Won per
DEC-M204-08 NICHTZIEL).
Stand: + F16.3-E implementiert (Snapshot-v3, Cap-Modell, f1603e, E2E-05; lokal grün, Goldens belegt; DB-/E2E-Ausführung pending CI/Maschine).
Stand Turn 26: CI-Triage 55/55 kartiert (bbd9a80: 55 failed/1958 passed),
Fixes committet (c3c22c7, lokal): Fixtures/Grants/Pins/Gates-Chromium +
Gatefix2-Locators. Push BLOCKIERT (ECC-Hook/test, EPERM-Sandbox, Nr. 5) —
Push + CI ab Mikails Maschine, Quote 25 % ESTIMATE.
Stand Turn 27: + 0065 Signatur-Definer-Tanz + 0066 Derive-v3-Felder
(Gatefix3-Ports, dort 0064/0065) + f1003-Echtpfad, committet (676b357,
lokal). Journal 67, m111a-Pins nachgezogen. Push-Block unverändert.
Stand Turn 28: + Euro-Kommaparsing (E2E-04 tippt 12,50),
committet (965407b, lokal). Push-Block unverändert.
Nächstes: Slice E pushen + CI lesen, dann F1–F16-Sweep.

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

## Stand Turn 46 (2026-09-05)
- Lane enthält Merge df1f444 von origin/codex/m1-wave-02 (6 Commits:
  fc936ba, 68380d7, 1306548, d50f7c5, e178425, f42a019); 7 Konflikte
  aufgelöst (0059 + end_at-Guard HEAD aus Ketten-/Schema-Gründen,
  Fixture + Testkommentare von Basis übernommen).
- Lokal grün: typecheck, lint (0 errors), depcruise, db:generate.
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 47 (2026-09-05)
- F2.2-UI-Slice implementiert (FRAGEN-4 erledigt): Panel, Actions,
  Unit-Tests, E2E-02; lokal grün (typecheck/lint/depcruise/generate,
  --list 2/2). VERIFIED pending CI/Maschine (Billing-Block).
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 48 (2026-09-05)
- Turn-47-Slice gehärtet (Bundle-Read-Toleranz, sonst CI-rot auf
  bestehenden Mocks); lokal typecheck/lint grün.
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 49 (2026-09-05)
- E2E-02 gehärtet (Offer-Scope im Read-back); lokal grün.
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 50 (2026-09-05)
- F2.5 Slice A spezifiziert (Zahlarten-Anzeige, providerfrei).
- ALS NÄCHSTES: F2.5 RED → IMPLEMENTED (0068 + Service + Tests + UI).

## Stand Turn 51 (2026-09-05)
- F2.5 Slice A implementiert (0068 + Service + UI + Tests); lokal
  grün. VERIFIED pending CI/Maschine (Billing-Block + Orakel-Pin).
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 52 (2026-09-05)
- F2.5-Eigen-Review ohne Befund (SQL/Snapshot, Helper, E2E-Muster).
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 53 (2026-09-05)
- F7.1 Slice A implementiert (0069 + Service + UI + Tests); lokal
  grün. VERIFIED pending CI/Maschine.
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.

## Stand Turn 54 (2026-09-05)
- F7.1A-Eigen-Review ohne Befund (Snapshot, Audit/Events, E2E-Texte).
- ALS NÄCHSTES: Push ab Mikails Maschine, Gates-/E2E-Logs lesen.
