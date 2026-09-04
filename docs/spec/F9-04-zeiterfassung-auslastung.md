# F9.4 Slice D — Team-Ansicht/Auslastung der Zeiterfassung

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F9.1 (CRUD), F9.2 (Stoppuhr), F9.3 (Filter), F9.4-A (Export),
F9.4-B (Verlauf). Katalog: F9.3-Rest „Team-Ansichten,
Auslastungs-Dashboards" (Modulkatalog M9). F9.4-C (GPS) bewusst später:
braucht Geräte-/Consent-Konzept mit Browser-Permission-Fluss (DECIDED).

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first: Auslastungs-DTO + Query im Zeitvertrag.
- database-migrations: KEINE Migration (reiner Lese-Pfad über
  `time_entry`, gleiche Filter-Semantik wie Liste/Export).

## Scope
1. Service: `getTimeUtilization(tx, ctx, { projectId, userIds? })` mit
   `requireRead` (Viewer sieht Dashboard, Externe nicht — gleiche
   Schranke wie Liste/Export). Filter-Semantik EXAKT wie
   `listTimeEntries` (WYSIWYG): Projekt-Scope, `includeArchived=false`
   (archivierte zählen nicht), laufende Einträge zählen nicht in Summen
   (werden aber als „läuft" markiert), `userIds`-IN-Liste wie F9.3-Fix.
2. Contract: `timeUtilizationRowDtoSchema` (userId, label, entryCount,
   totalWorkingMinutes, running: boolean) +
   `timeUtilizationDtoSchema` (entries: rows, Disziplin wie Liste:
   Sortierung total absteigend, userId aufsteigend). Query =
   `timeEntryListQuerySchema` wiederverwendet (kein neuer Dialekt).
3. UI: neue Section „Auslastung" auf der Zeiterfassungsseite (unter der
   Eintragsliste): Tabelle Mitglied / Einträge / Summe / Status
   („läuft", wenn mind. ein laufender Eintrag). Leere Liste → Hinweis
   „Keine Einträge im Filter." Label-Auflösung via Member-Options
   (wie Verlauf: fehlendes Mitglied → „Unbekannt").
4. Tests: (a) Vitest-DB: Summen je Mitglied (zwei Editoren, Minuten
   exakt), laufender Eintrag zählt nicht in Summe, markiert aber
   „läuft"; Filter treu (userIds); archivierte zählen nicht; Viewer
   lesen ok / Extern denied; Fremdprojekt/`not_found`? — Projekt-Scope
   wie Liste (fremdes Projekt → leere Liste, kein Fehler; gleiche
   Semantik wie `listTimeEntries`). (b) E2E (eigenes f94d-Projekt in
   run.mts — Summen aggregieren, Teilen mit A/B wäre unscharf): zwei
   Einträge per UI (90+30), Auslastungs-Section zeigt „2 Std. 0 Min."
   + Mitglied.

## Nicht-Ziele
- Kein GPS (Slice C, eigener Consent-Slice).
- Keine Subunternehmer-Abrechnung (Rechnungs-Bezug, eigener Slice).
- Keine Wochen-/Monats-Aggregation (Tages-Summen genügen; Gruppierung
  nur je Mitglied).
- Keine Änderung an Create-/Edit-/Export-/Verlauf-Pfaden.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Dashboard-Summe = Listensumme bei gleichem Filter (eine
  Test-Aussage hält das fest).
- Unbefugte sehen weder Einträge noch Dashboard (gleiche Schranke).
