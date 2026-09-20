# F4-01e — Wandzeit-Fixes (EEG-Jahr, Claim-Stichtag, Rohbytes-Hash)

Status: **SPECIFIED** (max SPECIFIED — keine Implementierung, keine Migration)

## Ziel und Abgrenzung

Operationalisiert die drei SPECIFIED-Folgefixes aus ADR-0025,
Entscheidung 9 (9a–9c): EEG-Jahr ohne Laufzeitdatum, Stichtag ohne
Claim-Wandzeit, Rohbytes-Hash in der Hash-Bindung. Bis zur Umsetzung
bleiben EEG-Jahr, Stichtag und Rohbyte-Bindung bekannte Lücken.

## Fix 9a — EEG-Jahr-Regel

Leck: `economics-v2.ts:216-225` liest `new Date().getFullYear()` zur
Laufzeit — für das Default-Jahr und für die Post-EEG-Altersregel.

Regel (SPECIFIED):

```text
eegYear = belegtes Inbetriebnahmejahr ?? Jahr(asOfDate)
alter   = Jahr(asOfDate) - eegYear
postEEG = alter >= 20
```

- Guards W1: `1990 <= eegYear <= 2100` (fail-closed, bestehende Schranke
  bleibt).
- Guards W2: kein `Date`-/`now`-Zugriff im Rechenkern
  (`economics-v2.ts`, `prepare-v2.ts`, `contract-v2.ts`,
  `engine-v2.ts`); Datumsquelle ist ausschließlich `asOfDate`.
- Bei belegtem Inbetriebnahmejahr gilt dessen Jahr (ADR-O3-Empfehlung).
- Override-Kaskade (Override > Post-EEG > Länderdefault) unverändert.

## Fix 9b — asOfDate-Quelle

Leck: `asOfDate` wird aus Claim-`startedAt` abgeleitet
(`prepare-v2.ts:204`), das aus DB-`started_at` stammt
(`calculation-service.ts:420`, `:474`) — reine Claim-Wandzeit.

Regel (SPECIFIED):

- `asOfDate` stammt aus der eingefrorenen Preparation
  (`contracts/simulation-clock.v1.schema.json`, `source` fix
  `frozen_preparation`).
- Feldpfad `preparation.frozenAsOfDate` [ESTIMATE] — ADR O1 empfiehlt
  nur den Preparation-Kontext, der exakte Pfad ist Entscheidung des
  Umsetzungs-Slices.
- Claim-`startedAt` bleibt Transport-/Lease-Metadatum und darf
  `asOfDate`, `commissioningDate` und keinen Hash beeinflussen.
- Guards W3: `startedAt`-Drift bei eingefrorener Preparation ändert
  weder `asOfDate` noch `inputSha256` (RED-Test Claim-Drift).
- Guards W4: ohne eingefrorenen Stichtag fail-closed
  (`PlanningCalculationInputError`); stilles Zurückfallen auf
  `startedAt` ist verboten.
- `commissioningDate` defaultet weiter auf `asOfDate` (ESTIMATE aus
  `prepare-v2.ts:78-80`, unverändert).

## Fix 9c — Rohbytes-Hash

Leck: `rawSha256` wird nur je Abruf gebildet
(`provider-v2.ts:380`, `horizon-v2.ts:99`), `inputSha256` deckt aber
nur den Request ab (`prepare-v2.ts:127-129`, `contract-v2.ts:334`).

Regel (SPECIFIED):

- Der Request trägt je Providerabruf (`seriescalc` je Dach, Horizont,
  `PVcalc`) eine Provenienz mit `rawSha256` — Feldshape
  `providerFetches[]` [ESTIMATE].
- Die Provenienz ist Teil des kanonischen Requests und damit
  automatisch Teil von `inputSha256` (`planning-jcs.v1`).
- Guards W5: je Abruf genau ein `rawSha256` als 64-Hex-Pflichtfeld;
  fehlender/ungeformter Hash ist fail-closed.
- Guards W6: geänderte Rohbytes bei gleichem Query ändern
  `inputSha256` (SHA-Regen-Nachweis, siehe Gate G2).

## SHA-Regen-Freigabe als Gate

Abnahme-Gates (SPECIFIED, beide Pflicht vor Freigabe):

- G1 Zeit-Freeze: derselbe eingefrorene Claim an zwei Wandzeit-Tagen
  (EEG-Kippe 2030 vs 2040, Default 2025 vs 2026) liefert identische
  `asOfDate`, identischen `inputSha256` und identisches EEG-Geld.
- G2 Rohbyte-Bindung: geänderte Provider-Rohbytes erzeugen anderen
  `inputSha256`; unveränderte Rohbytes reproduzieren ihn bitidentisch.
- Freigabe nur bei grünem G1+G2; bis dahin gilt der ADR-Default
  (Laufzeitjahr, `startedAt`-Stichtag, ungebundene Einzel-Hashes) als
  dokumentierte Lücke im Abnahmeprotokoll.

## Contract

- `contracts/simulation-clock.v1.schema.json` — Clock/Epoche/
  `asOfDate`-Shape (`epoch` fix `frozen-asof.v1`, `source` fix
  `frozen_preparation`, `additionalProperties: false`).
- `contracts/examples/simulation-clock.v1.json` — Minimalbeispiel.

## RED-Beleg

ROT-Lauf am 2026-09-20, ungeskippt, via
`npx tsx scripts/run-tests.mts tests/unit/f401e-wandzeit.red.test.ts`
(Vitest direkt verboten) — 5/5 Tests rot, danach `describe.skip`:

```text
FAIL EEG-Jahr-Falle: Post-EEG-Kippe ist wandzeitfrei (...)
AssertionError: expected 'post_eeg' to be 'eeg_default'
FAIL EEG-Jahr-Falle: Default-Jahr folgt asOfDate (...)
AssertionError: expected 7.5 to be 7.87
FAIL Claim-Drift: startedAt-Drift aendert weder asOfDate noch inputSha256
AssertionError: expected '2026-09-02' to be '2026-08-29'
FAIL Hash-Mismatch: Request bindet Rohbytes-Provenienz je Abruf (rawSha256)
AssertionError: expected { …(9) } to have property "providerFetches"
FAIL asOfDate-Pflicht: eingefrorener Stichtag aus Preparation schlaegt Claim-Wandzeit
Error: planning calculation v2 input is invalid
Test Files  1 failed (1) / Tests  5 failed (5)
```

## Provenienz-Block

- `docs/adr/0025-rechenkern-deterministisches-15-minuten-jahr.md:110-122`
  (Fix 9a–9c), `:132-134` (Abnahme-Bedingung), `:140-150` (O1–O3)
- `lib/integrations/calculation/economics-v2.ts:216-225`
  (`new Date().getFullYear()`, Post-EEG-Regel)
- `lib/integrations/calculation/prepare-v2.ts:66` (`startedAt`),
  `:78-80` (`commissioningDate`-Default), `:204` (`asOfDate`-Ableitung),
  `:127-129` (`inputSha256` nur Request)
- `lib/integrations/calculation/contract-v2.ts:168-169`
  (`asOfDate`/`commissioningDate`-Pflicht), `:334` (Hash-Invariante)
- `modules/energy/calculation-service.ts:420` (`startedAt` aus DB),
  `:474` (`asOfDate` aus `startedAt`)
- `lib/integrations/calculation/provider-v2.ts:380`,
  `lib/integrations/calculation/horizon-v2.ts:99` (`rawSha256` je Abruf)
- `docs/spec/F4-01-viertelstunden-simulation.md:106-111` (Request bindet
  exakte Rohbytes-SHA-256)
