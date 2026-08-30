# Test Evidence

Stand: 2026-08-30

Dieses Dokument trennt ausgeführte Evidenz strikt von geplanten Tests.

## Letzte verifizierte Basis

| Slice | Beleg | Status |
|---|---|---|
| M1-08 Katalog/Projektauflösung | 69 Vitest-Dateien, 661/661 Tests, Build, 75 Rollenproben, 5 PG18-Proben, 7/7 Chromium-E2E; Commit `71dded3` | REVIEWED/VERIFIED lokal |
| M2-01 Angebotsvarianten/Snapshot-BOM | `npm run check`: 87/87 Testdateien, 856 bestanden, 1 ausdrücklich opt-in übersprungen; 88/88 Rollenproben, 5/5 PG18-Proben; Chromium 16/16 (15 funktionale/A11y-Fälle plus 1 Visual-Capture-Fall mit 26/26 Kandidaten); Production-Build, ESLint, TypeScript, Dependency-Cruiser, Diff- und `db:generate`-Prüfung grün | REVIEWED/VERIFIED lokal; technisches Gate 2 **GO**; Visual-Candidate-Capture grün, menschliches Visual-Gate `INCONCLUSIVE` |
| M2-02 interner Angebots-PDF-Entwurf | 96/96 Vitest-Dateien, 949 bestanden, 1 ausdrücklich opt-in übersprungen; 88/88 Rollen- und 5/5 PG18-Proben; Chromium 16/16 aktiv plus 1 opt-in Visual-Fall übersprungen; Production-Build, ESLint, TypeScript, Dependency-Cruiser, Diff, `db:generate`, Compose, Worker-Bundle und gepinnter `linux/amd64`-Container-Smoke grün | REVIEWED/VERIFIED lokal; technisches Gate **GO**; unabhängiges Review ohne offene P0–P2; `M202-VISUAL-01` `INCONCLUSIVE`; Deploy `NOT RUN` |
| M2-03a Angebotsprofil/Freigabekandidat | 111/111 Vitest-Dateien, 1.078 bestanden, 1 übersprungen; 88/88 Rollen- und 5/5 PG18-Proben; Chromium 17 bestanden, 1 opt-in übersprungen; Production-Build, ESLint, TypeScript und Dependency-Cruiser (237 Module/764 Abhängigkeiten) grün; gepinnter `linux/amd64`-Container-Smoke mit Pflichtstatus auf 11/11 PDF-Seiten | REVIEWED/VERIFIED lokal; technisches Gate **GO**; Security-, Regression-, Navigation- und lokaler Claude-Code-Opus-Max-Review ohne offene P0–P2; Human Visual `INCONCLUSIVE`; Deploy/Issuance/WORM/Versand/Signatur `NOT RUN` |

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

## M2-02

Status: **REVIEWED/VERIFIED lokal; technisches Gate GO**. Der finale
Gesamtnachweis umfasst 96/96 Vitest-Dateien mit 949 bestandenen Tests und einem
ausdrücklich opt-in übersprungenen Test, 88/88 Rollen- plus 5/5
PostgreSQL-18-Proben sowie 16/16 aktive Chromium-E2E. Der siebzehnte
Browserfall ist ausschließlich die opt-in Visual-Candidate-Erzeugung und blieb
im normalen Lauf übersprungen. Production-Build, ESLint, TypeScript,
Dependency-Cruiser, Diff-Prüfung, `db:generate`, expandierter Compose-Vertrag
und das 380,3-kB-Worker-Bundle sind grün. Der unabhängige Abschlussreview lief
mit 145/145 gezielten Tests und meldet keine offenen P0–P2.

| Test-ID | Ebene | Finaler Beleg | Aktuell |
|---|---|---|---|
| `M202-CONTRACT-01` | Contract/Golden | geschlossenes Inputschema, JCS-Kanonisierung, Golden-SHA, Unknown-Field-Reject, 1/500 Zeilen und Reject 501; Renderer-Rezept exakt gepinnt | GREEN im finalen Gesamtlauf |
| `M202-PRIVACY-01` | Contract/Integration | Input/HTML/DTO/Event/Audit ohne E-Mail, Telefon, EK, Marge, interne IDs, Rohpayload oder Vollhash; DB leitet PII, Preise, Totals, Reservation und Zeit aus der gebundenen Revision ab | GREEN einschließlich adversarialer Runtime-Injection-Gegenproben |
| `M202-TEMPLATE-01` | Unit/Golden | escapendes A4-HTML, sichtbare Draft-Kennzeichnung, Positionsarten, Steuer/Summen, Hidden-Markierung und keine Remote-Assets | GREEN |
| `M202-RENDER-01` | Chromium/Container | zwei bytegleiche Render derselben 500-Zeilen-Eingabe im gepinnten `linux/amd64`-/Playwright-1.62.1-Container; 1.629.886 Bytes, SHA-256 `414e25a0b3f8a9742580d2f3c47e0aa9e884b25e6b20ee497d5affe493eb7e84` | GREEN; `pinnedRuntimeVerified=true` |
| `M202-SSRF-01` | Adversarial/Container | normales und ausschließlich bei `page.pdf()` ausgelöstes Print-Netzwerk fail-closed; Container `network_mode:none`, Chromium-Sandbox, Seccomp, read-only, Null-Capabilities, `NoNewPrivs=1` | GREEN |
| `M202-DB-01` | Migration/RLS/ACL | Fresh-, idempotenter und Legacy-Upgrade-Pfad, FORCE RLS, FKs, DB-abgeleiteter Input, minimale Runtime-/Worker-Spaltenrechte, immutable Input/Artefakt und echter Erasure-Tombstone-Replay | GREEN; `db:generate` ohne Drift; Rollenvertrag 88/88 plus PG18 5/5 |
| `M202-DB-02` | Concurrency/Recovery | Doppelrequest, Reservation-Poisoning, N+1-Dispatch, Claim/Lease/CAS, Retry/Maxversuche, abgelaufenes `running`, `retry_wait`, stale Finalize, Nondeterminismus-Fatalpfad und aktive-Lease-Erasureblockade | GREEN; 60-s-Sweep begrenzt und shutdown-fähig |
| `M202-SVC-01` | Integration | aktuelle immutable Revision→DB-versiegelter Job→Event/Audit; User-Replay aller nichtterminalen Zustände repariert Dispatch und aktualisiert Offer-Aktivität; Worker-Recovery verlängert Retention nicht | GREEN |
| `M202-RBAC-01` | Integration/Security | Viewer read/download, Editor/Admin mit `project.write` request/replay, External und Cross-Tenant fail-closed; vorhandene Flags eskalieren keine Rechte | GREEN |
| `M202-WORKER-01` | Unit/Integration | strikter ID-only-Payload, tenantgebundener Reload, Fehlerklassifikation, keine Rohfehler-/PII-Logs, minimaler `app_worker`; Renderer-Nondeterminismus führt sanitisiert fatal und mutiert kein Erfolgsartefakt | GREEN |
| `M202-ROUTE-01` | Next/Route | Promise-Params, Reauth, Tenant-/Offer-/Job-Bindung, MIME-/Längen-/Hashprüfung, sicherer Dateiname, `private, no-store`, `nosniff` | GREEN |
| `M202-E2E-01` | Browser | echte Anmeldung→Offer→PDF-Anforderung→`queued`→synthetischer DB/Worker-Abschluss→Reload→privater Download exakt der gehashten Bytes | GREEN im finalen 16/16-Aktivlauf |
| `M202-A11Y-01` | Browser/A11y | Keyboard-/Statuspfad, Axe A/AA, Theme-Scope/Kontrast, bestehender 200/400-%-Reflow und Reduced Motion ohne Regression | GREEN im finalen 16/16-Aktivlauf |
| `M202-VISUAL-01` | Human Visual | eigene Portal-/A4-Richtung technisch renderbar; keine menschlich freigegebene maskierte Portal- und gerasterte PDF-Baseline | `INCONCLUSIVE` |

Der final neu gebaute Container verwendet das Playwright-Child
`sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac`
und meldete zusätzlich `containerHardeningVerified=true`,
`sameUidProcessIsolationVerified=true` sowie blockierte Leseversuche auf
Eltern-Environment und offenen Eltern-FD. Die lokale macOS/arm64-Diagnose war
ebenfalls deterministisch (1.849.499 Bytes, SHA-256
`88c18aa341b4798c70fa9a2c295ae96b5e8df2a721b20e101a82ab9804227275`),
meldete aber erwartungsgemäß alle Produktions-/Containerpins als `false` und
ist **keine** Produktionsrezept-Evidenz.

`npm audit --omit=dev --audit-level=high` endete grün ohne High/Critical. Die
sechs weiterhin gemeldeten Moderate-Funde stammen aus bestehendem
Drizzle-/esbuild-Tooling beziehungsweise `node-zugferd`/`fast-xml-parser`; ein
erzwungener Breaking-Change-Fix wurde nicht als Teil von M2-02 ausgeführt.

Nicht als geliefert behauptet werden produktiver Deploy, Zielhost-Rollback,
Object Lock/WORM, `issued`, Versand, Annahme, Signatur, öffentlicher Link,
Rechnung oder Kundenportal. Die autonome Recovery-Discovery ist an die
vorhandene pg-boss-Historie gebunden; nach vollständigem Historienverlust über
die dokumentierte Aufbewahrungsgrenze hinaus bleibt der autorisierte
Benutzer-Replay die Reparatur. Ein darüber hinausgehendes autonomes SLO braucht
eine dauerhafte Registry.

## M2-03a

Status: **REVIEWED/VERIFIED lokal; technisches Gate GO**. Der finale
Gesamtnachweis umfasst 111/111 Vitest-Dateien mit 1.078 bestandenen und einem
übersprungenen Test, 88/88 Rollen- plus 5/5 PostgreSQL-18-Proben sowie den
vollen Chromium-Lauf mit 17 bestandenen, einem opt-in übersprungenen und keinem
fehlgeschlagenen Fall. Typecheck, ESLint, Production-Build und
Dependency-Cruiser (237 Module/764 Abhängigkeiten) sind grün.

| Test-ID | Ebene | Finaler Beleg | Aktuell |
|---|---|---|---|
| `M203A-CONTRACT-01` | Contract/Golden | strikte Profil-, Empfänger-, Candidate-Input- und Dispatchschemas; Normalisierung, Canonical SHA, Unknown-/Duplicate-Field-Reject | GREEN im finalen Gesamtlauf |
| `M203A-HIDDEN-01` | Contract/Service | jede Hidden-Zeile blockiert Candidate-Prepare, ohne Summen oder Historie umzuschreiben | GREEN im finalen Gesamtlauf |
| `M203A-DB-01` | Migration/RLS/ACL | Fresh-/Upgrade-Pfad, Tenant-FKs, FORCE RLS, je eine Policy, Append-only-Guards, genaue Runtime-/Worker-Rechte und Erasuregraph | GREEN; Rollenvertrag 88/88 plus PG18 5/5 |
| `M203A-DB-02` | Concurrency/Recovery | Profilrevision/-aktivierung, Empfängerrevision, Reservation/Replay, Claim/Lease/CAS, Retry/Finalize, Approval- und Erasure-Races | GREEN im finalen Gesamtlauf |
| `M203A-SVC-01` | Integration | exakte Variant-/Draft-/Profil-/Recipient-Bindung, Readiness, Event/Audit und stale-/missing-/denied-Pfade | GREEN im finalen Gesamtlauf |
| `M203A-APPROVAL-01` | Integration | erneuter Hash der tatsächlichen PDF-Bytes, vier feste Attestations plus bedingte 0-%-Bestätigung, Race/Replay/stale/cross-tenant | GREEN; append-only Approval und nur abgeleitetes `approved_not_issued` |
| `M203A-PRIVACY-01` | Adversarial | keine Adressen, Rechtstexte, Preise, Bytes oder Vollhashes in Status-DTO, Event, Audit oder Log; Candidate-Input nur Allowlist | GREEN im finalen Gesamtlauf |
| `M203A-WORKER-01` | Unit/Integration | ID-only Payload, tenantgebundener DB-Reload, Fehlerklassifikation, Retry/Recovery, deterministischer Hash, kein Secret-/PII-Logging | GREEN im finalen Gesamtlauf |
| `M203A-TEMPLATE-01` | Unit/Container | escaping, Empfänger/Billing getrennt von Site, Positionen/Summen/Rechtstexte sowie Pflichtstatus auf jeder Seite | GREEN; echter gepinnter Container meldet Status 11/11 Seiten und A4 11/11 |
| `M203A-RBAC-01` | Integration/Security | interne Profilreads, Admin-Profilmutation, Prepare-/Approve-Capabilities, private Bytes, External/Cross-Tenant ohne Oracle | GREEN; Security-Abschlussreview GO ohne offene P0–P2 |
| `M203A-ROUTE-01` | Next/Route | Promise-Params, Reauth, Tenant-/Offer-/Candidate-Bindung, MIME-/Längen-/Hashprüfung, sicherer Dateiname und private Header | GREEN im finalen Gesamtlauf |
| `M203A-E2E-01` | Browser | Admin-Profilrevision/-aktivierung → Empfänger → Prepare → Status → Approval → Reload → Download exakt der erwarteten Bytes; Rev. 1 → externe Rev. 2 → Refresh bindet sichtbare Felder, Hidden-CAS, Candidate, Snapshot und Hash atomar an Rev. 2; Reader-HTML/RSC enthält weder Rev.-1- noch Rev.-2-PII | GREEN im vollen Chromium-Lauf; Claim/Finalize werden testseitig synthetisch in der DB ausgeführt |
| `M203A-A11Y-01` | Browser/A11y | Landmark/Skip-Link, Fokus nach Actions, Fehlerzuordnung, korrigierbares `aria-invalid`, Formularerhalt, Keyboard und Reflow | GREEN; unabhängiger Navigation-Review und finaler lokaler Claude-Code-Opus-Max-Lesereview GO ohne P0–P2 |
| `M203A-RENDER-01` | Chromium/Container | zwei deterministische Render im gepinnten `linux/amd64`-Rezept; PDF-Struktur, A4 und Pflichtstatus auf jeder Seite | GREEN; 103.871 Bytes, SHA-256 `c3ea9de557e66eb2975cc19fc858f6e5b0c3127f058046ec750158b2bc76ac1b`, Status 11/11 Seiten |
| `M203A-VISUAL-01` | Human Visual | freigegebene Portal- und gerasterte PDF-Baseline durch einen Menschen | `INCONCLUSIVE` |

Der Browserlauf beweist den kompletten geschützten UI-/Action-/Downloadpfad
gegen exakt geprüfte Bytes, verwendet für Claim und Finalize aber bewusst eine
synthetische DB-/Worker-Finalisierung. Er ist deshalb kein Beleg für den echten
Chromium-Worker. Diese Lücke schließt separat `M203A-RENDER-01` im gepinnten
`linux/amd64`-Container; die beiden Evidenzen werden nicht miteinander
vermischt.

Security-, Regression- und unabhängiger Navigation-Review sind **GO**. Der
abschließende lokale Claude-Code-Lesereview lief mit Modellalias `opus` und
Effort `max` und fand nach der A11y-Nacharbeit keine offenen P0–P2. Das ist
Design-/A11y-Gegenevidenz, keine Reonic-Produktwahrheit.

Nicht ausgeführt oder freigegeben sind menschliche Visual-Abnahme, echte
WMEE-Firmen-/Rechtstexte, produktiver Deploy, Object Lock/WORM, Issuance,
Versand/Delivery, Annahme und Signatur. Der Container-Smoke prüft den
technischen Tagged-PDF-Pfad, ersetzt aber keine formale Prüfung der
PDF/UA-Konformität oder der Rechtsinhalte.
