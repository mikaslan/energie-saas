# F1-17 Bulk-xlsx + Auto-Geocoding (T2) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. KEINE Migration. Quelle: Schwarm-Spec S2 (reviewed).

## DISCOVERED

- Ist: `importManualLeadBulk({csvText,…})` nur CSV (500 Zeilen, Report v1,
  Dry-Run via SAVEPOINT+ROLLBACK). Sites landen `legacy`, ungeocodiert.
- Geocoding in-repo (`searchAddressCandidates` + `resolveAddressCandidate`,
  house-präzise DE-gefiltert), Site-Geo-Spalten + Schreibmuster
  (`service.ts` address-correct-Flow) + E2E-Geoapify-Stub existieren.
- Risiken: KEIN xlsx-Parser (neue Dep nötig); Stub-Gate
  `geoapifyContractWasExercised` erwartet exakt 1+1 Requests.

## SPECIFIED

- xlsx zusätzlich (kein Ersatz): `{fileKind, csvText|bytes}`, nur erstes
  Sheet, gleiche Aliase/Spalten. Limits fail-closed: 5 MB, 500 Zeilen,
  10 Spalten, Header ≤100, Zelle ≤2000, `line` = Excel-Zeile.
  Neue Dep `xlsx` (read-only, `sheetRows` cap).
- Auto-Geocoding je qualifizierter Zeile (Residential + 4 Adresszellen)
  NACH `createManualLead`: search→erster Kandidat→resolve→site-UPDATE
  (`selected`, lat/lng, `follow_up=false`, Revision+1, Event/Audit wie
  Bestand). Fail-closed: jeder Fehler → Zeile bleibt `created`+`legacy`,
  Report `geocoded:false` + Code. Sequentiell, kein Retry. Commercial nie.
- Dry-Run: KEINE Geocode-Calls, Report `geocoded:null` (= würde versuchen).
- Report v2 additiv (`geocoded`, `geocodeError`, Counts); v1-Felder stabil.
  KEINE neue Permission (`project.write`).

## CONTRACTED

- EDIT: `lead-bulk-import.ts`, `modules/projects/index.ts`, Bulk-Actions/Form,
  `run.mts` (Stub-Zähler parametrisieren!), `package.json` (+lock).
- NEU: `modules/projects/lead-bulk-geocode.ts`, `tests/db/f117-*.test.ts`,
  `tests/e2e/f1-17-*.spec.ts`.
- DB-Tests (4): xlsx-OK+selected / Limits / Fail-closed+Dry-Run-0-Calls /
  CSV-Regression. E2E (2): xlsx→Dry-Run→Import mit Pin-Adresse /
  Stub-ohne-Kandidaten. F1-02-Suites müssen grün bleiben.
