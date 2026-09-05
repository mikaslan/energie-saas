# MUSE-MONITOR — 5-Stunden-Überwachung (2026-09-05, Mission von Mikail)

Kanonische Quelle der Befunde; Kurzfassung geht an Mikail, Details hier.

## Runde 1 (≈ 01:45)

- Stand: Welle-03-Nachholblock + 6 Slices integriert in `codex/m1-wave-02`
  (`e178425`); alle Gates grün (check 215/1988+1, Rollen 88/88, PG18 5/5,
  Build, E2E 96/96).
- Muse aktiv: neuer Commit `668fee3` (F16.3-D Fix-Modell global,
  Snapshot-v2). CI zu dem Zeitpunkt billing-tot (alle Runs sterben nach
  3–4 s, „payments have failed or spending limit").
- **Befund A (kritisch):** Muse hat die bereits angewendete Migration
  `0059_f10_portal_appointments.sql` nachträglich verändert — mein
  Owner-Wrapper (SET-ROLE-Ersatz für CREATE OR REPLACE) wurde
  zurückgedreht auf das reine CREATE OR REPLACE, das im
  test-legacy-single-Modus mit „must be owner of function" scheitert.
  Migrationen sind forward-only — nachträgliche Änderung = Kettenbruch.

## Runde 2 (≈ 02:55)

- **GitHub umgestellt:** Repo wieder PUBLIC (unlimitierte kostenlose
  CI-Minuten) → CI läuft erstmals seit dem Billing-Ausfall wirklich
  (Runs `in_progress` mit >1 min statt 3-s-Tod). Workflows
  kostenoptimiert (paths-ignore für Doku-Pushes, altes `ci.yml` nur noch
  main/manuell).
- Muse: Turn 23 („F16.3-D-Push und CI-Lage festgeschrieben") + F16.3-E-
  Spec Cap-Prozent mit Snapshot-v3; Lane `codex/muse-welle-03-e2e` →
  `dfece96`. Journal 64 Einträge (0061 subsidy_templates,
  0062 portal_signature_status, 0063 snapshot_v2_check).
- Gates auf Lane-Head: lint/typecheck/depcruise grün, db:generate ohne
  Drift. Full-Check läuft — erwarteter Bruch an Befund A (0059).
- Offen: 0059-Wrapper auf Lane-Head wiederherstellen, m111a-Zähler
  prüfen (0061–0063), volle Gates, Integration nach Grün.

## Runde 3 (≈ 03:00) — Verifikation der F10.2-B/F16.3-B–D-Welle

- Muse: Turn 23 + F16.3-E-Spec; Lane `dfece96`. Neue Migrationen 0061
  (subsidy), 0062 (Signatur-Status), 0063 (Snapshot-v2).
- **Befund B:** Muse drehte den 0059-Owner-Wrapper zurück (CREATE OR
  REPLACE bricht test-legacy-single) und 0062 legte einen zweiten
  ungewrappten Resolver-Ersatz nach. Fix: beide owner-sicher gewrappt
  (Muster 0056), Grants ergänzt.
- **Befund C:** Muses Merge verlor meine Pass-2-Fixes (f904/f904b/
  f1603/f10-02-Spec) — wiederhergestellt.
- **Befund D (Produkt-Bug):** F16.3-D vergaß den DB-Trigger
  derive_offer_pdf_draft_input auf den neuen Vertrag zu heben (m202);
  Fix = Migration 0065. Zusätzlich: Euro-Eingaben waren type=number
  (Komma unmöglich) — auf text/inputMode + Komma-Parsing umgestellt.
- **Befund E (echter Infra-Fix):** Migration 0064 — der öffentliche
  Signatur-DEFINER-Pfad war im Testmodus nie lauffähig (RLS-Escape
  app_owner griff nicht); sign/revoke/view app_owner-getanzt + Grants.
- Gates auf Gatefix3: check 221 Dateien/2007 Tests + 1 Skip GRÜN,
  Rollen 88/88, PG18 5/5, Build GRÜN, db:generate ohne Drift.
- **E2E: 7 rot** — 2 davon sind Muses verlorene Fixes (f10-02,
  wiederhergestellt ✓) und der Komma-Bug (f16-03d, behoben ✓).
  4 bleiben: m2-01 (Offer-Create-Gate nicht ready), m2-02
  (Variantennavigation weg), m2-03a (Button detacht mid-click),
  m2-04 ×2 — alle zeigen im Server-Log „destination stream closed
  early" nach saveOfferVariantDraftAction; Verdacht: F16.3-D-Editor/
  Action-Integration (Operations-Serialisierung oder revalidate-
  Stream-Bruch in Dev). NÄCHSTE RUNDE: Root-Cause, dann Integration.
- wave-02 bleibt auf f42a019; Gatefix3 NICHT integriert (E2E nicht grün).
