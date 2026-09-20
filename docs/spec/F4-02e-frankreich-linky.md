# F4-02e FR-Linky-Pull (Provider-Slice)

Stand: SPECIFIED (kein Code, keine Migration). Baut den
F4-02d-Slice-Stub (§2: Enedis-API + Consent/Privacy-Gate,
F1.1-Praezedenz, kein stiller Import) zur baufaehigen Spezifikation
aus. Default bleibt DE-only: Der Pull lebt nur hinter explizitem
Kunden-Consent, sonst fail-closed.

## 1. Adapter-Shape (Halbstundenlastgang -> 35.040)

- Profilwert `linky_pull.v1` (analog `customer_csv.v1`,
  F4-02c-Nachbar). Belegte Reihe: `consumption.linkyHalfHourKwh`
  mit 17.520 Halbstundenwerten (365 x 48, kWh, endlich, >= 0,
  positive Summe) — Enedis liefert die Verbrauchskurve im
  30-Minuten-Schritt (Provenienz §5).
- Mapping uniform auf 35.040 Viertel-Slots (je Halbstunde / 2 auf
  beide Viertel), analog CSV-Stunden->Viertel (F4-02c:25-26).
  Keine Interpolation, keine erfundene Form.
- Summenprobe analog CSV (F4-02c-Nachbar): Reihensumme ist die
  Jahres-Basis; `householdKwhPerYear` muss unbekannt sein oder im
  Rundungsband (±0,06 kWh) liegen, sonst Widerspruch fail-closed.
- Provenienz der Quelle: `linky_pull.v1` (sichtbar in sources[],
  kein stilles H0-Fallback).

## 2. Consent-Flow (Enedis Data Connect)

- Pull nur mit belegtem Consent (`consumption.linkyConsent`,
  Shape s. Contract `contracts/linky-import.v1.schema.json`):
  `granted == true` + `grantedAt` + `source` + `policyVersion` +
  `authorizationReference` (F1.1-Consent-Praezedenz
  `contactMarketingConsentV1Schema` aus
  `lib/integrations/contacts/contract.ts:93`: granted/grantedAt/
  source/policyVersion; Prinzip geschlossenes Objekt, fehlende
  Werte explizit null).
- Enedis-seitig: OAuth2.0-Autorisierung, der Kunde entscheidet den
  Datenzugang und kann ihn jederzeit widerrufen (Provenienz §5).
  Der Adapter prueft den Consent vor jedem Pull; abgelaufener oder
  widerrufener Consent beendet den Pull (kein Cache-Nachlauf).
- Kein Default-Consent: `granted == true` ohne Nachweis
  (`grantedAt`/Referenz null) ist fail-closed.

## 3. Privacy-Gate (kein stiller Import)

- Ohne Consent kein Pull, keine Speicherung der Rohkurve, keine
  Ableitung: `linky_pull.v1` ohne Consent-Shape bleibt fail-closed
  (DE-only-Guard `fetch-compose-v2.ts:347-356` bleibt Gueltig).
- Linky-Reihe ohne Pull-Option (oder Pull-Option ohne Reihe) ist
  fail-closed wie CSV (F4-02c-Nachbar: keine doppelte/stille Basis).
- Datensparsamkeit (F1.1/DSGVO-Praezedenz): keine PII in Domain-Events/Audit,
  Zaehlpunktreferenz nur im Import-Request, nicht in Logs.

## 4. Fehler / Fallback (fail-closed ohne Consent)

- Fehlender/widerrufener/abgelaufener Consent: kein Pull, Fehler
  an den Aufrufer (kein H0-/DE-Ersatz fuer FR — keine synthetische
  FR-Lastform, F4-02d §2).
- API-Fehler/Teillieferung: kein partieller Import (kein Jahr aus
  Rumpfmonaten); unvollstaendige Reihe ist fail-closed.
- Falsche Aufloesung (nicht 17.520 Werte): fail-closed wie
  CSV-Dialekt (kein Raten, F4-02d §3).

## 5. Provenienz (belegte Enedis-Aussagen, 2026-09-20)

- Data Connect ist Enedis' Linky-API-Plattform fuer
  Wohnkunden mit Linky-Zaehler:
  https://datahub-enedis.fr/services-api/data-connect/
- Der Kunde entscheidet den Datenzugang und kann ihn jederzeit
  widerrufen; APIs basieren auf OAuth2.0 (dieselbe Seite).
- Aktuelle API-Liste: u. a. Verbrauch im 30-Minuten-Schritt
  („courbe de charge") plus Autorisierungs-API, ueber die der
  Kunde sein Einverstaendnis gibt; Neuauflage T2 2026:
  https://datahub-enedis.fr/services-api/data-connect/documentation/
- Nicht belegt (OFFEN, §7): Endpunkt-Pfade/Payloads der
  30-Minuten-API, PRM-Format, Token-/Consent-Lebensdauer.

## 6. RED-Beleg (2026-09-20, vor Implementierung)

`npx tsx scripts/run-tests.mts tests/unit/f402e-linky.red.test.ts`
(ungeskipt): 3 failed | 3 passed (6). Die Guards (Consent-Pflicht,
Default-Consent-Verbot, Consent-Shape-Abweisung) sind gruen; die drei
Slice-Tests sind rot, weil Compose weder `linky_pull.v1` noch das
Consent-Gate kennt:

```text
FAIL ... F4-02e Linky-Pull (Consent-Pflicht) > nimmt den Linky-Pull
  mit explizitem Consent an
Error: f4.1 provider rejected input: Fetch-Komposition v2 verletzt:
  Gewerbe-Lastprofil ist nicht belegt

FAIL ... F4-02e Linky-Pull (Consent-Pflicht) > mappt 17.520
  Halbstundenwerte auf 35.040 Viertel-Slots
Error: f4.1 provider rejected input: Fetch-Komposition v2 verletzt:
  Gewerbe-Lastprofil ist nicht belegt

FAIL ... F4-02e Linky-Pull (Consent-Pflicht) > verweigert die stille
  Linky-Reihe ohne Pull-Option (stiller-Import-Verbot)
AssertionError: expected [Function] to throw an error

Test Files  1 failed (1)
Tests  3 failed | 3 passed (6)
```

Die Suites sind danach per `describe.skip` stillgelegt (Grund + Ref
im Testkopf); Gruenlauf nach Skip s. Testdatei.

## Akzeptanz (fuer den Bau-Slice)

- Unit: Consent-Matrix (granted/fehlend/widerrufen/Default x
  Option/Reihe), 17.520->35.040-Mapping + Summenprobe, Guard
  ohne-Consent-Shape.
- Contract: `linky-import.v1`-Fixtures validieren gegen das Schema
  (geschlossen, keine Zusatzfelder).
- E2E: Pull-Button nur mit Consent-Nachweis klickbar; ohne Consent
  Fehlermeldung statt Import.
- Gates: lint/typecheck/test/build gruen; keine Migration, keine
  synthetische FR-Lastform.

## 7. Offene Fragen (REVIEW)

1. Enedis-Endpunkt-Pfade/Payloads, PRM-Format, Token-Lebensdauer
   (Data-Connect-2026-Umstellung laeuft; Sandbox-Zugang noetig).
2. Consent-Speicherung: eigenes Modell oder F1.1-Kontakt-Consent
   (`contactMarketingConsentV1Schema`)?
3. Scope-Regel: FR-Pull nur bei scope=commercial (F4-02d-Gate) oder
   auch residential?
