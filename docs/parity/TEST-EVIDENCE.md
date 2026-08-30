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
