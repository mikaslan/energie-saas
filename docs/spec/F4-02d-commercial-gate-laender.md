# F4-02d Commercial-Gate + Laender-Slices

Stand: SPECIFIED (kein Code). Ergaenzt F4-02c um die
„nur Commercial"-Produktregel als Gate (UI + Save, Rechenkern bewusst
ungated) und legt die Laender-Slices als SPECIFIED ab (kein Code, kein
synthetisches Verhalten). Default: DE-only. Keine Migration: Scope kommt
aus dem bestehenden Projekt-/Board-Scope (`residential | commercial`,
z. B. `kanbanBoardScopes`, Portal-`scope`).

## 1. Commercial-Gate (Lastgang-CSV nur bei scope=commercial)

- `consumption.loadProfile == customer_csv.v1` + belegtes
  `consumption.customCsvKwh` ist nur zulaessig, wenn
  `project.scope == commercial`.
- UI (`energy-profile-editor`): CSV-Option im Profil-Select und
  Textarea `loadProfileCsv` werden bei `residential` ausgeblendet
  (kein leeres Gate-Element, keine stille Annahme).
- Save fail-closed: CSV-Option oder CSV-Reihe bei `residential`
  verweigert den Save (`invalid`, kein Service-Call, keine Mutation).
  Fehlender Scope auf dem CSV-Pfad ist ebenfalls fail-closed
  (Scope-Pflicht; REVIEW: Contract-Pflicht vs. Action-Gate).
- Rechenkern bewusst ungated: `buildCsvProfileSourceV2` und die
  Compose-Auswahl in `fetch-compose-v2` bleiben Wohn/Gewerbe-neutral
  (F4-02c:33-35 Kern-ungated-Position bleibt). Das Gate lebt in
  Action/Service, nicht in der Formung.

## 2. Laender-Slices (SPECIFIED, kein Code)

- FR Linky-Pull = Provider-Slice: Enedis-API-Anbindung plus
  Consent/Privacy-Gate. M1-04-BLOCKED-Praezedenz beachten: kein
  stiller Import, kein Default-Consent, Pull nur hinter explizitem
  Gate. Keine synthetische FR-Lastform.
- IT F1/F2/F3 = TOU-Subslice von F4.4b: Die drei Zeitbänder werden
  auf die bestehenden 24 TOU-Stundenpreise (`touImportPricesCtPerKwh`)
  abgebildet (Spezifikation, kein Code). Keine eigene IT-Lastform.
- BR Net Metering = Economics-Regel im F4.5-Slice: Kompensations-/
  Gutschriftregel in der Wirtschaftlichkeit (Spezifikation, kein
  Code). Keine BR-Lastform, kein Tarif-Raten.
- Default DE-only: Unbekannte Laenderprofile (`linky_pull.v1`,
  `it_f1f2f3.v1`, `br_netmetering.v1` u. a.) bleiben fail-closed
  (keine erfundene Lastform). Laenderverhalten nur per Beleg.

## 3. CSV-Dialekt (Hausformat bleibt)

- Striktes Hausformat bis Reonic-Beleg: eine Zahl pro Zeile
  (F4-02c:15-20), Dezimalpunkt oder -komma, keine
  Tausendertrennzeichen, 8.760 Stunden- oder 35.040 Viertelwerte.
- 8.760 -> Viertel uniform (F4-02c:25-26 ESTIMATE) bleibt.
- Kein Delimiter-/Header-/Einheiten-Raten ohne Beleg
  (F4-02c REVIEW-Frage 1 bleibt offen).

## 4. Haushaltstypen (singular = H0)

- Singular-Haushalt ist mit H0 erfuellt bis Beleg: keine
  synthetischen G1/G2/…- oder Sonderformen ohne Reonic-/BDEW-Beleg.
- Gewerbe bleibt `commercial_interval.v1` (v1-exakt, F4-02c-Nachbar).

## 5. RED-Beleg (2026-09-19, vor Implementierung)

`npx vitest run tests/unit/f402d-commercial-scope.red.test.ts`
(ungeskipt): 3 failed | 2 passed (5). Die Guards (commercial-Save,
DE-only-Abweisung) sind gruen; die drei Gate-Tests sind rot, weil
weder Save noch Compose heute einen Scope kennen:

```text
FAIL ... F4-02d Commercial-Gate (Save) > verweigert den CSV-Save bei
  residential Scope fail-closed
AssertionError: expected { Object (status, revision, ...) } to deeply
  equal { status: 'invalid' }
- Expected: { "status": "invalid" }
+ Received: { "changed": true, "confirmed": false, "revision": 1,
  "status": "success" }

FAIL ... F4-02d Commercial-Gate (Compose) > verweigert die CSV-Basis
  bei residential Scope
AssertionError: expected [Function] to throw an error

FAIL ... F4-02d Commercial-Gate (Compose) > verlangt scope im
  Profil-Request auf dem CSV-Pfad
AssertionError: expected [Function] to throw an error

Test Files  1 failed (1)
Tests  3 failed | 2 passed (5)
```

Die Suites sind danach per `describe.skip` stillgelegt (Grund + Ref
im Testkopf); Gruenlauf nach Skip s. Testdatei.

## Akzeptanz (fuer den Bau-Slice)

- Unit: Gate-Matrix (residential/commercial/fehlend × Option/Reihe),
  Scope-Pflicht, DE-only-Abweisung, Guard commercial-Save.
- Actions: Formular-Allowlist ohne CSV-Branch bei residential;
  `invalid` ohne Service-Call.
- E2E: CSV-Textarea nur bei commercial sichtbar; residential-Save mit
  CSV-Reihe bleibt `invalid`.
- Gates: lint/typecheck/test/build gruen; keine Migration, keine
  Contract-Enum-Aenderung ausserhalb des Gates.

## Offene Fragen (REVIEW)

1. Scope-Pflicht als Contract-Feld oder reines Action-/Service-Gate?
2. „Nur Commercial"-Regel per Reonic-Beleg bestaetigen (F4-02c
   REVIEW-Frage 2 wird hiermit beantwortet, Beleg steht aus).
3. Reonic-CSV-Dialekt per Beleg (F4-02c REVIEW-Frage 1, unveraendert).
4. FR/IT/BR-Slices: Belege (Enedis-Docs, F1/F2/F3-Banddefinition,
   BR-Kompensationsregel) vor jedem Bau.
