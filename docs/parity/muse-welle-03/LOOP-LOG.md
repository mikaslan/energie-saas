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

## Turn 10 — 2026-09-04, Slice A implementiert

- `9d1e4a6` feat(f9.4): CSV-Export — Contract-Result, Service
  (IN-Liste, Berlin-Zeiten, BOM, Quoting), Route nach Muster (401/403/
  400/404), UI-Link mit Filter, DB-Tests (f904, inkl. laufend/Viewer/
  Extern), E2E f94 (Download up-/gefiltert). Keine Migration.
- Lokale Gates grün (lint 0 Errors, typecheck, contract, depcruise,
  generate, --list). DB-/E2E-Gates pending (CI-Billing).
- RUNTIME-BLOCKs: keine.
- Nächster Schritt: Slice B Versionshistorie specen (oder CI-Status).

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

## Turn 11 — 2026-09-04, F9.4 Slice B implementiert ( Verlauf bei Edits )

- SPEC `docs/spec/F9-04-zeiterfassung-historie.md` (bereits committet? nein:
  untracked, geht in diesem Push mit). Reviews Exit-3 (kein Key, Q1 aktiv).
- Migration `0057_f9_04_time_entry_revisions` (db:generate, RLS FORCE +
  tenant_isolation im 0050-Muster, immutable: nur created_at).
- Rollenvertrag: `time_entry_revision` in TIME_TRACKING_RELATIONS,
  APPLY-Grants select/insert/update (kein DELETE), Policy-Pin
  `f3bc4959…8633a1` — Herleitung per 6-fach-Orakel bewiesen (alle sechs
  textidentischen tenant_isolation-Pins reproduziert; Rendering:
  `(workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true),
  ''::text))::uuid)`). Sandbox-DB unmöglich (listen EPERM) → CI verifiziert.
- Service: Update-CTE schreibt Vorher-Bild atomar (kein Diff, jede
  Speicherung genau eine Revision); `listTimeEntryRevisions` (requireRead,
  fremder Eintrag => not_found).
- Contract: `timeEntryRevisionDtoSchema` + List-DTO + `{ entryId }`-Query.
- UI: `Verlauf (n)`-Details je Eintrag (n=0 unsichtbar), Berlin-Zeiten
  (explizite TZ), „Geändert von … am …" via Member-Labels.
- Tests: `tests/db/f904b-time-entry-revisions.test.ts` (3 Fälle),
  `tests/e2e/f9-04b-zeiterfassung-verlauf.spec.ts` (F9.4-E2E-02, f94-Projekt
  wiederverwendet, unique Kommentare — DECIDED, kein run.mts-Eingriff).
- Lokal grün: eslint, typecheck, depcruise, db:generate (no drift),
  playwright --list (2 Tests). Vitest-DB/E2E-Ausführung + Rollenprobe nur
  auf Mikails Maschine/CI (RUNTIME-BLOCK Sandbox: kein listen()).
- RUNTIME-BLOCKs: Sandbox-listen EPERM (bestehend), CI-Billing dicht (Q6).
- Nächster Schritt: Slice B committen + pushen (ECC_SKIP_PREPUSH=1, Q5),
  CI-Lage lesen, dann F9.4 C/D.

## Turn 12 — 2026-09-04, F9.4 Slice D implementiert (Team-Auslastung)

- CI-Lage: Slice-B-Runs (33926208078/022) in 2–3s `failure` mit leeren
  Steps = Billing-Block (Q6) bestätigt. Verifikation BLOCKED-ON-MIKAIL.
- Scope-Fund: Slice-A-Spec definiert C=GPS (Consent-Konzept) und
  D=Dashboards. DECIDED: D zuerst (rein lesend, sofort prüffähig).
- SPEC `docs/spec/F9-04-zeiterfassung-auslastung.md`. Reviews Exit-3.
- Service `getTimeUtilization` (Listen-Filter WYSIWYG, requireRead, keine
  Migration; Summe ignoriert laufende, markiert sie; Sort total desc).
  Contract-DTOs, Auslastungs-Section (Tabelle, „Keine Einträge im
  Filter."), eigenes f94d-Projekt in run.mts (Summen aggregieren —
  Teilen mit A/B wäre unscharf; skuSuffix unique).
- Tests: `tests/db/f904d-time-utilization.test.ts` (3 Fälle inkl.
  WYSIWYG-Pin Dashboard=Liste), `tests/e2e/f9-04d-…spec.ts` (E2E-03).
- Lokal grün: eslint, typecheck, depcruise, playwright --list.
  DB-/E2E-Ausführung nur Maschine/CI (RUNTIME-BLOCK Sandbox).
- Nächster Schritt: Slice D committen + pushen, dann F9.4-C-Spec (GPS).

## Turn 13 — 2026-09-04, F9.4 Slice C implementiert (GPS am Start-Event)

- SPEC `docs/spec/F9-04-zeiterfassung-gps.md` (Consent-Konzept DECIDED:
  Opt-in pro Start, Fail-open ohne Koordinaten, nur Start-Event).
  Reviews Exit-3 (kein Key, Q1 aktiv).
- Migration 0058 (start_lat/start_lng double + CHECKs beide-oder-keiner
  auf entry + revision; 0058 war global frei; Journal-Diff minimal;
  Zähler 57→58). Keine Vertragsänderung (Spalten sind pin-neutral —
  verifiziert: kein Column-Inventar im Vertrag).
- Contract: Start-Command mit Beide-oder-keiner-Refine (eigener
  WithGps-Schema, Basis unverändert), DTOs um startLat/startLng.
- Service: Start-Insert mit Koordinaten; Update-CTE kopiert sie ins
  Vollbild; alle SELECTs/RETURNINGs erweitert. Action parseGps
  (crafted Files/halbe Paare => invalid, leer => NULL).
- UI: StartForm (Checkbox ohne Feldname, Klick-Handler statt
  Submit-Intercept — kein Loop; Timeout 10 s; Fehler => Start ohne
  Koordinaten), Standort-Zeile „lat, lng" (4 Dezimalen).
- Tests: `tests/db/f904c-time-entry-gps.test.ts` (3 Fälle),
  `tests/e2e/f9-04c-…spec.ts` (E2E-04, eigenes f94c-Projekt,
  Geolocation-Mock, beide Consent-Pfade, Timer aufgeräumt).
- Lokal grün: eslint, typecheck, depcruise, db:generate (no drift),
  playwright --list. DB-/E2E-Ausführung nur Maschine/CI.
- Nächster Schritt: Slice C pushen, CI-Lage lesen, dann F10.2-Spec.

## Turn 14 — 2026-09-04, F10.2 Slice A implementiert (Termine-Tab)

- SPEC `docs/spec/F10-02-portal-termine.md` (Privacy-DECIDED: nie
  Description; Version bleibt v1 — gleiche Deployment-Einheit).
  Reviews Exit-3 (kein Key, Q1 aktiv).
- Migration 0059 (handgeschrieben, Funktions-Replace aus 0056-Body per
  Skript kopiert + Termine-Projektion; Journal/Snapshot/Zähler 59 von
  Hand nach Konvention; generate bleibt „no changes").
- Funktions-Pin: Methode (sha256 über prosrc-Rohtext) am 0056-Pin mit
  MATCH bewiesen, neuer Hash aus 0059-Text berechnet.
- Contract: appointments-Array in View-Schema + Resolve-Parser
  (strikte Typen); f1001-Contract-Test nachgezogen (Privacy-Aussage).
- UI `/p/[token]`: Tabs Übersicht/Termine per ?tab= (Server, kein JS;
  unbekannt → Übersicht). Berlin-Zeiten.
- Tests: `tests/db/f1002-portal-appointments.test.ts` (Projektion ohne
  Description, leer, Withdraw-not_found),
  `tests/e2e/f10-02-…spec.ts` (E2E-01, eigenes f102-Projekt, interner
  Termin mit interner Notiz → Tab zeigt Titel/Ort, Notiz fehlt).
- Lokal grün: eslint, typecheck, depcruise, generate, --list.
  DB-/E2E-Ausführung nur Maschine/CI (Billing-Block Q6 unverändert).
- Nächster Schritt: Slice A pushen, dann F16.3-Spec.

## Turn 15 — 2026-09-04, F16.3 Slice A implementiert (Rabatt-Vorlagen)

- SPEC `docs/spec/F16-03-rabatt-vorlagen.md` (DECIDED: kein Steuerabzug
  im Template, kein Angebots-Apply in A, Archiv statt Delete).
  Reviews Exit-3 (kein Key, Q1 aktiv).
- Migration 0060 (db:generate + 0053-RLS-Muster, Zähler 60).
  Rollenvertrag: 7 Stellen gespiegelt, Pin per Orakel (Kontrolle
  Checklist-Pin reproduziert exakt).
- Berechtigung: discount_template.read/write additiv (+discounts-Cap);
  Unit-Matrix 43→45 nachgezogen (admin-Verhalten wie economics.write).
- Service modules/discounts (CRUD + Events/Audit, 23505/23514) +
  reine applyDiscountTemplate (Integer, floor, Cap).
- UI rabatt-vorlagen (Euro/Prozent-Eingaben, Cent-Umrechnung in Action;
  kind-Umschalter). E2E nutzt W3-Editor (discounts-Cap im Seed).
- Tests: f1603-DB (3 Fälle inkl. Cap-Gate), discount-apply-Unit
  (Fix/Cap/Rundung/Fehler), F16.3-E2E-01.
- Lokal grün: eslint, typecheck, depcruise, generate, --list.
  DB-/E2E-Ausführung nur Maschine/CI (Billing-Block Q6 unverändert).
- Nächster Schritt: Slice A pushen, dann M2-04-Status klären.

## Turn 16 — 2026-09-04, M2-04-Status geklärt (kein Gap)

- Befund: M2-04-Code ist in der Lane (via Basis 258fb8a); E2E-Spec
  existiert (Guard, Create+Withdraw, Expiry, External-fail-closed).
- Won-Automatik ist per DEC-M204-08 + Spec-Zeilen 6/400/448 explizit
  NICHTZIEL (nur `signature.signed`-Event). Kein Folge-Slice nötig.
- M2-04 = DONE pending CI (wie alle Slices; Billing-Block Q6).
- run.mts-Kontrolle: f94/f94c/f94d/f102-Leads + State-Felder sauber,
  keine Duplikate.
- Nächster Schritt: Review-Pass über die 6 pending-CI-Slices
  (Verstetigung), dann F10.2-B-Spec.

## Turn 17 — 2026-09-04, Review-Pass (Verstetigung), 1 Fix

- StartForm-Fund: Hidden-Inputs kontrolliert (`value=""`) — jeder
  Re-Render (z. B. `locating`) hätte Geokoordinaten zurückgesetzt.
  Fix: `defaultValue` (uncontrolled). Committet als fix(f9.4).
- Gegenlesen ohne Befund: Update-CTE (14=14 Spalten, Revision-CHECK
  immer erfüllt), 0060-RLS (0053-identisch), getTimeUtilization
  (bool_or/count-Casts, WYSIWYG-Set), run.mts-Leads (keine Duplikate).
- Nächster Schritt: Fix pushen, dann F10.2-B-Spec (nächster Portal-Tab).

## Turn 18 — 2026-09-04, F16.3 Slice B implementiert (Förder-Vorlagen)

- SPEC `docs/spec/F16-03-foerder-vorlagen.md` (DECIDED: discounts-Cap
  wiederverwendet, keine neue Capability; Matrix 45→47). Reviews Exit-3
  (kein Key, Q1 aktiv; Spiegel-Diffs gegen Slice A ohne Befund).
- Migration 0061 (db:generate + 0060-RLS-Block gespiegelt, Zähler 61).
  Rollenvertrag: 7 Stellen gespiegelt, Pin per Orakel-Q (PGlite in /tmp:
  Methode am Discount-Pin exakt reproduziert, Subsidy-Pin
  2037cf71…4d0696 abgeleitet — kein Erfinden).
- Berechtigung: subsidy_template.read/write (discounts-Cap); Unit-Matrix
  45→47. Service modules/subsidies + UI foerder-vorlagen (Spiegel).
- Tests: f1603b-DB (3 Fälle), subsidy-apply-Unit, F16.3-E2E-02.
- Lokal grün: eslint (0 Errors), typecheck, depcruise, generate
  (no drift), Unit 30/30 (Temp-Config, globalSetup-Listen-EPERM
  umgangen), E2E --list. DB-/E2E-Ausführung nur Maschine/CI
  (Billing-Block Q6 unverändert).
- Push `3fa1a34` via ECC_SKIP_PREPUSH=1 (Turn-1-DECIDED, Hook-lint/typcheck
  liefen grün durch, nur tsx-Testschritt EPERM). CI-Runs 33928409856/774:
  failure nach 2–3 s ohne Steps/Logs = Billing-Block Q6, kein Codebefund.
- Nächster Schritt: F10.2-B-Spec.

## Turn 19 — 2026-09-04, F10.2 Slice B implementiert (Signatur-Status read-only)

- SPEC `docs/spec/F10-02b-portal-signatur-status.md` (DECIDED: Status
  wörtlich, 'none' ohne Zeile, nie signer_name/Token/Grund; kein
  Tab-Umbau — F10.1-E2E bleibt grün). Reviews Exit-3 (kein Key).
- Migration 0062 (0059-Vollkopie + LEFT JOIN signature_request,
  Zähler 62, Snapshot/Journal von Hand nach 0059-Muster).
  Funktions-Pin per Skript-Methode (Kontrolle 0059-Body = 560bd538…
  MATCH, neuer Pin 6d025bff… — kein Erfinden).
- Contract: signatureStatus-Enum + signedAt (strict, required),
  Parser mit Wortlaut-Prüfung (unbekannt/fehlend/defekt → null).
  UI: Statuszeile je Dokument in Übersicht.
- Tests: f1003-DB (Issuance-Kette aus M2-04 übernommen: none/
  pending/signed + Roh-JSON-Privacy), Parser-Unit 2/2 (Temp-Config),
  F10.2-E2E-02 (Fallback Leerzustand, Positivfall per DB-Test).
- Lokal grün: eslint (0 Errors), typecheck, depcruise, generate
  (no drift), E2E --list. DB-/E2E-Ausführung nur Maschine/CI
  (Billing-Block Q6 unverändert).
- Push `708d9fe` via ECC_SKIP_PREPUSH=1 (Turn-1-DECIDED). CI-Runs
  33928799969/039: failure nach 3–4 s ohne Steps/Logs = Billing-Block
  Q6, kein Codebefund.
- Nächster Schritt: F16.3-C-Spec (Rabatt-/Förder-Apply im Angebot).

## Turn 20 — 2026-09-04, F16.3-C-Spec (Prozent-Apply global)

- SPEC `docs/spec/F16-03c-template-apply.md` (DECIDED: nur cap-freie
  Prozent-Vorlagen → `set_global_discount` via `reviseOfferVariant`;
  Cap-/Fix-Vorlagen → ValidationError statt stiller Verlust; Fix-Modell
  = Slice D. Subsidy symmetrisch).
- Bestand: Variantenmodell kennt global nur Bps; `customDeal` ist
  Zielpreis (kein Rabatt-Ziel); Editor hat Global-Rabatt-Bereich mit
  `discount.apply`-Gate; m2-01-E2E als möglicher C-Träger.
- Nächster Schritt: F16.3-C implementieren (Service + UI + Tests).

## Turn 21 — 2026-09-04, F16.3 Slice C implementiert (Prozent-Apply global)

- SPEC `docs/spec/F16-03c-template-apply.md` (DECIDED: nur cap-freie
  Prozent-Vorlagen → `set_global_discount`; Cap/Fix → ValidationError;
  Fix-Modell = Slice D). Reviews Exit-3 (kein Key).
- Service `applyDiscountTemplateToOfferGlobal` (+ Subsidy-Spiegel,
  Delegation an `reviseOfferVariant`, kein Schema-Eingriff, kein
  Contract-Sprung). UI: Vorlagen-Dropdown im Global-Rabatt-Bereich
  (Draft-lokal, bestehender Save-Pfad; de-DE-Prozentformat wie Model).
- Fixture-Kette aus f202 übernommen (bewährtes Muster, Labels
  getauscht). DB f1603c (Apply→500bps/Rev2, Cap/Fix/NotFound-Abweisung,
  Cap-Gates). E2E-03 (Vorlage→Übernehmen→Save→500bps per Snapshot).
- Schutz-Fix: `readM201Offer` jüngstes zuerst (f16-03c läuft vor m2-01;
  m2-02 braucht m2-01-Angebot — latest-wins passt allen).
- Lokal grün: eslint (0 Errors), typecheck, depcruise, generate
  (no drift), catalog-contract-check, E2E --list. DB-/E2E-Ausführung
  nur Maschine/CI (Billing-Block Q6 unverändert).
- Push `25ab372` via ECC_SKIP_PREPUSH=1 (Turn-1-DECIDED). CI-Run
  33929442145: failure nach 4 s ohne Steps/Logs = Billing-Block Q6,
  kein Codebefund.
- Nächster Schritt: nächste F1–F16-Capability nach Modulkatalog.

## Turn 22 — 2026-09-04, F16.3-D-Spec (Fix-Modell, Snapshot-v2)

- SPEC `docs/spec/F16-03d-fix-modell.md` (DECIDED: `globalFixDiscountCents`
  siegelgebunden → Snapshot-v2 + Dual-Read im einzigen Engpass
  `validateOfferVariantSnapshot`; Schreiber immer v2, Historie bleibt v1;
  Fix nach globalem Prozent, vor Steuer, pro-rata auf Basis-Zeilen;
  kein Cap-Apply (Slice E); kein `customDeal`-Missbrauch).
- Bestand vermessen: money.ts (§279/§280 Apply-Reihenfolge),
  Anzeige-Stellen (pdf-/issuance-template), Editor-Muster (customDeal),
  Contract-Versionen (snapshot v1, jcs v1).
- Risikoflag im SPEC: größter Slice der Welle (Versions­sprung) —
  Review-Schwerpunkt Dual-Read + Rundung.
- Nächster Schritt: F16.3-D implementieren.

## Turn 23 — 2026-09-04, F16.3-D-Implementierung (Fix-Modell, Snapshot-v2)

- Implementiert: `globalFixDiscountCents` siegelgebunden (Snapshot-v2,
  `OFFER_SCHEMA_SHA256 923a3539…`, Migration 0063), Dual-Read v1→v2,
  `set_global_fix_discount` (+Cap `discount.apply`), Fix-Zweige in
  Discount-/Subsidy-Apply, money.ts `applyFixDiscount` (Largest-Remainder,
  Floor 0), PDF-Builder + Fix-Zeile im Template, Editor-Dropdown +
  Detail-Anzeige, f1603d (3 DB-Tests), E2E-04 (Fix→Save→Rev2→-1250).
- Fixture-Migration: 30+ Dateien auf v2-Schlüssel gehoben; PDF-Builder-
  Lücke (`commercialTerms` ohne Fix-Key) geschlossen.
- Goldens belegt: kanonisches Delta exakt `,"globalFixDiscountCents":null`
  (Strip-Beweis per Skript); Pins neu: m202 `cfa07bcc…`, m203a `c33430e3…`,
  m203b1 `41e46fb9…`.
- Lokal grün: typecheck, lint (0 Errors, 11 vorbestehende Warnings),
  depcruise, generate (no drift), catalog-check, E2E-04 --list (1 Test),
  DB-frei 1015 passed / 21 failed = nur DB-/Browser-Umgebung +
  f1001-Portal (per Stash auf HEAD belegt vorbestehend).
- Reviews weiter BLOCKED (kein OPENROUTER_API_KEY) — Exit-3-Pfad per GOAL.
- Nächster Schritt: Slice D committen + pushen, CI lesen.

## Turn 23b — Push + CI (F16.3-D)

- Push `668fee3` auf `codex/muse-welle-03-e2e` (via ECC_SKIP_PREPUSH=1,
  Turn-1-DECIDED). CI-Runs 33930671005/010: failure nach 4 s, beide Jobs
  mit 0 Steps — identische Billing-Block-Signatur Q6, kein Codebefund.
- Slice D damit IMPLEMENTED + lokal belegt, VERIFIED pending CI/Maschine.
- Nächster Schritt: F16.3-E specen (Cap-Prozent).

## Turn 24 — 2026-09-04, F16.3-E-Implementierung (Cap-Prozent, Snapshot-v3)

- Implementiert: `globalDiscountCapCents` siegelgebunden (Snapshot-v3,
  `OFFER_SCHEMA_SHA256 a3c1fee4…`, Migration 0064), Triple-Read v3/v2/v1,
  `set_global_discount` + `capCents` (omit = behalten), Cap-Zweige in
  Discount-/Subsidy-Apply (Cap-Abweisung aus f1603c entfernt),
  money.ts `min(Prozent, Cap)`, PDF-/Release-Carry ohne Anzeigezeile,
  Editor (Cap-Eingabe, Vorlagen-Dropdown mit Cap, Detail-Hinweis),
  f1603e (4 DB-Tests), E2E-05 (Cap→Save→Rev2→-1000).
- RED→GREEN: Cap-Matrix 5 Tests (3 rot belegt, dann grün, 15/15 money).
- Goldens belegt (Strip-Beweis `,"globalDiscountCapCents":null`): m202
  `93a19ddc…`, m203a `23efebd9…`, m203b1 `cb179188…`, seal `b11fae1d…`.
- Lokal grün: typecheck, lint (0 Errors, 11 vorbestehend), depcruise,
  generate (no drift), catalog-check, DB-frei 1020/21 = Umgebung.
- Nächster Schritt: Slice E committen + pushen, CI lesen.
