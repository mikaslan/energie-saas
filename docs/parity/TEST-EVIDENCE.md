# Test Evidence

Stand: 2026-08-30

Dieses Dokument trennt ausgeführte Evidenz strikt von geplanten Tests.

## Letzte verifizierte Basis

| Slice | Beleg | Status |
|---|---|---|
| M1-08 Katalog/Projektauflösung | 69 Vitest-Dateien, 661/661 Tests, Build, 75 Rollenproben, 5 PG18-Proben, 7/7 Chromium-E2E; Commit `71dded3` | REVIEWED/VERIFIED lokal |
| M2-01 Angebotsvarianten/Snapshot-BOM | `npm run check`: 87/87 Testdateien, 856 bestanden, 1 ausdrücklich opt-in übersprungen; 88/88 Rollenproben, 5/5 PG18-Proben; Chromium 16/16 (15 funktionale/A11y-Fälle plus 1 Visual-Capture-Fall mit 26/26 Kandidaten); Production-Build, ESLint, TypeScript, Dependency-Cruiser, Diff- und `db:generate`-Prüfung grün | REVIEWED/VERIFIED lokal; technisches Gate 2 **GO**; Visual-Candidate-Capture grün, menschliches Visual-Gate `INCONCLUSIVE` |

Die Detailabnahme liegt in der Vault-Datei `Reonic Clone Final/08-Abnahme-M1-08.md`.

## M2-01

Status: **REVIEWED/VERIFIED lokal; technisches Gate 2 GO**. Der finale
Gesamtnachweis umfasst 87/87 Testdateien mit 856 bestandenen Tests und einem
ausdrücklich opt-in übersprungenen Test, 88/88 Rollen- plus 5/5
PostgreSQL-18-Proben sowie 16/16 Chromium-E2E: 15 funktionale/A11y-Fälle und
ein Visual-Capture-Fall mit 26/26 maskierten Reviewkandidaten. Production-Build,
ESLint, TypeScript, Dependency-Cruiser, Diff-Prüfung und `db:generate` sind grün. Der
abschließende unabhängige Review enthält keine offenen Produkt-P0–P2.

| Test-ID | Ebene | Beleg | Aktuell |
|---|---|---|---|
| `M201-CONTRACT-01` | Contract | geschlossene Commands/Snapshots, Contact-/Site-Allowlist, Canonicalizer, Golden Hash, Redaktion, Seed 250/251/500 und Reject 501 | GREEN im finalen Gesamtlauf; Schema-SHA `b98e8eaf92596e46fca04ad775a82e0147dd5a68a63b800b5fa73c640e785183` |
| `M201-MONEY-01` | Unit/Golden | Rundungspunkte, Rabattreihenfolge, Largest Remainder inkl. Custom Target, Optional/Hidden, Cap 0 | GREEN im finalen Gesamtlauf |
| `M201-MONEY-02` | Property | Overflow, Safe Integer, Halbcent, gemischte Steuer, negative/adversariale Inputs | GREEN im finalen Gesamtlauf |
| `M201-DB-01` | Migration/DB | generate-clean, fresh+upgrade, History pinning, RLS, FKs, DB-append-only, kanonischer Body plus relationale Mirrors/Pointer, ACL, Board-Backfill mit Custom-/Commercial-/Archiv-Negativfixtures | GREEN; `db:generate` clean; Rollenvertrag 88/88 plus 5/5 PG18 |
| `M201-DB-02` | DB concurrency | Convert/Nummer/Duplicate/Save/Erasure-Lockorder inkl. LegalHold und Replay; persistente Quota bei Denied/Validation/Replay/Conflict/Domain-Rollback; Workspace→Actor-Locks, `clock_timestamp()` nach Lock, physischer UTC-`date_bin`-Grenzwarte-Race und Variantenlimit 12/13 | GREEN einschließlich realer Save/Duplicate/neue-Basis↔Erasure-Races und physischer Viertelstundengrenze |
| `M201-SVC-01` | Integration | readiness, Phase/Board/Offer/Revision/Event/Audit atomar | GREEN im finalen Gesamtlauf |
| `M201-ACTION-01` | Next/Action | `$ACTION_`, unbekannte/doppelte/File-Felder, Caps, Auth/Error-Mapping, exakte Revalidation vor Redirect | GREEN; finale UI-/Action-/Contract-Matrix 123/123 |
| `M201-RBAC-01` | Integration/Security | Viewer, Editor, Admin/Feature-Flag, Preis-/Rabatt-/Steuerrechte einschließlich neuer Basis, External, Cross-Tenant, Hashredaktion | GREEN; 88/88 Rollenvertrag plus 5/5 PG18 |
| `M201-PRIVACY-01` | DB/Integration | exakte Snapshot-PII, Draft-Erasure, frische Offer-Revision blockiert Inaktivitätserasure, gesperrter Runtime-Delete, alte Tombstone-Replays | GREEN; Erasure-Races und abschließende Targeted-Regressionsmatrix 37/37 |
| `M201-E2E-01` | Browser | Request→Offer→Duplicate→Edit→Reload | GREEN im finalen funktionalen 15/15-Chromium-Lauf |
| `M201-E2E-02` | Browser | Drift→Outdated→neue Basisvariante, alter Snapshot unverändert | GREEN im finalen funktionalen 15/15-Chromium-Lauf |
| `M201-A11Y-01` | Browser/A11y | Keyboard-Reorder, Dialogfokus, Axe, 320/375/390/768/1024/1440/1920, 200 %/400 %, Reduced Motion | GREEN im finalen funktionalen 15/15-Chromium-Lauf |
| `M201-VISUAL-01` | Browser/Visual | geschlossene Route×Rolle×Zustand-Matrix, exakte 375×812/390×844/768×1024/1024×900/1440×1000/1920×1080-Captures, DSF 1, Light, Reduced Motion, dynamische Maskierung, 26/26 SHA-verifizierte Kandidaten und lokaler Review-Index | Candidate-Capture GREEN; menschliche Baseline-Freigabe INCONCLUSIVE |

Die RED→GREEN-Historie, der finale Gesamt-/Build-/Browserlauf und das
unabhängige Abschlussreview sind abgeschlossen. M2-01 ist technisch
`REVIEWED/VERIFIED (lokal)` und Gate 2 ist **GO**. `M201-VISUAL-01` bleibt davon
ausdrücklich getrennt bis zu Mikails Screenshot-Baseline-Freigabe
`INCONCLUSIVE`.

## M1-11b + M1-13 (2026-09-02)

| Slice | Vitest | Rollen | Chromium | Build | Reviews |
|---|---|---|---|---|---|
| M1-11b | 173 Dateien / 1.718 grün / 1 opt-in skip | 88/88 + PG18 5/5 | 4/4 (Slice) · 48/48 (Suite) | grün | Kimi Spec (10) + Kimi Code (6) geschlossen; 4 Browser-Laufzeit-P0 behoben |
| M1-13 | 175 Dateien / 1.726 grün / 1 skip | 88/88 + PG18 5/5 | zentral geplant | grün | Kimi Spec (6) geschlossen |

## M1-Welle-01 Gesamt-E2E (2026-09-03, 00:30)

Integrations-Branch `codex/m1-wave-01` (`e5a9c5d`, remote): komplette
Chromium-Suite **48/48 passed, Exit 0** (3,1 Min) — inkl. M1-11b 4/4, M1-12a
8/8 (Mitternachts-Flake behoben: Fälligkeit relativ zum Berlin-Tagesende),
M1-05…M2-03b1. Vollgate `npm run check` Exit 0 (177 Dateien, 1.743 Tests,
Rollen 88/88 + PG18 5/5), Build grün.

## Import-Gate Katalog (2026-09-03, Kimi-Auflage 3)

`scripts/catalog-import-dry-run.mts` validiert die 337 Komponenten mit dem
echten `parseCatalogCsvPreview`: 38 gültig / 299 ungültig / 0 Formatfehler
(deterministisch, SHA-256 gepinnt; Bericht `artifacts/catalog-import-20260902/DRY-RUN.md`).
Top-Lücken: purchasePriceNet (264), Batterie-Technik (71), WR-Leistung (52),
Marke (25). 13-Reonic-Typen→7-Katalogtypen-Mapping verifiziert.

## M1-14 Kontakt-Datensatz (0042) — REVIEWED/VERIFIED (2026-09-03, 02:30)

Branch `codex/m1-14-contact-dataset` (`f6a990b`, remote): Kimi-Code-Review
geschlossen (2 P1 + 5 P2 + 2 Race-Tests nachgeliefert); Legacy-sichere
Migration (nullable → Backfill → SET NOT NULL); echte Browser-Funde behoben
(server-only-Barrel → `lib/integrations/contacts`; Editor-Schließen über
Server-Wahrheit; `<dl>`-A11y). Nachweise: Vollgate exit 0 (180/180 Dateien,
1771/1), Rollen 88/88 + PG18 5/5, Build, keine Drift, **Chromium-E2E 4/4**.

## M1-15 Termine/Kalender (0043) — REVIEWED/VERIFIED (2026-09-03, 02:30)

Branch `codex/m1-15-calendar-appointments` (`6d80f62`, remote):
Kimi-Code-Review geschlossen (2 P1 + 5 P2); DST-CHECK auf Berliner
Datumsebene; echter `erase_inactive_lead`-Lauf; Dialog-Fix (M1-13-Muster) +
DB-Guard-P0 (42501 auf jedem DELETE) nur vom Browser gefunden. Nachweise:
Vollgate exit 0 (181/181 Dateien, 1776/1), Rollen 88/88 + PG18 5/5, Build,
keine Drift, **Chromium-E2E 6/6**.

## M1-Welle-02 Integration (2026-09-03, 03:00)

`codex/m1-wave-02` (`db9e13d`, remote): 0042→0043 gemergt; Journal-`when`
monoton, 0043-Snapshot prevId→0042, Erasure-Pin post-0042 `cec63897…`
(Rollenprobe-gedeckt). Nachweise: `npm run check` exit 0 (**184/184 Dateien,
1804 passed/1 skipped**), Rollen 88/88 + PG18 5/5, Build exit 0, `db:generate`
keine Drift, depcruise 0 (352 Module), **Chromium-E2E komplett 58/58, exit 0**.

## M2-04 E-Signatur (0044) — REVIEWED/VERIFIED, integriert (2026-09-03)

Lane `codex/m2-04-e-signature` (`5098e8f`, remote): Vollcheck exit 0
(180/180 Dateien, 1755/1), Rollenprobe 88/88 + PG18 5/5, E2E fokussiert 4/4.
Kimi-Code-Review: 0 P0 / 3 P1 / 9 P2 / 3 P3; P1 a1/a2 + P2 a3/b2/c2
geschlossen, Spot-Recheck **FREIGABE**. d1/с1 als M2-04b-Gates eingestuft.
Integration `codex/m1-wave-02` (`163d2a8`): Erasure-Kette post-0043
re-verankert (tombstone 66dbe75a, graph 350a4c4f, erase cec63897),
Rollenvertrags-Pins auf Integrations-Ist (m204 350a4c4f, Worm cc6f8018,
Erase 0c4442f5), 0044-Snapshot drei-Wege (db:generate „No schema changes"),
**E2E 62/62**. Kimi-Integrations-Review FREIGABE.

## M3-00 Workspace-Stammdaten (0045) — REVIEWED/VERIFIED, integriert (2026-09-03)

Lane `codex/m3-00-workspace-stammdaten` (`3e6b681`, remote): RLS-Capability-
Gate (Admin ODER Editor+invoicing), M300-DB-RBAC-01-Schreibmatrix, Vollcheck
exit 0 (186/186), E2E fokussiert 4/4. Integration `codex/m1-wave-02`
(`1b1f944`): Permissions-Matrix 33, m111a-Zähler 46, tenant-fixtures additiv,
0045-Snapshot auf 0044-Kette (prevId 97b3db4b, exakt 2 neue Tabellen);
Vollcheck exit 0 im ersten Lauf, `db:generate` keine Drift, Build exit 0,
**Chromium-E2E komplett 66/66**. Kimi-Integrations-Review FREIGABE.
