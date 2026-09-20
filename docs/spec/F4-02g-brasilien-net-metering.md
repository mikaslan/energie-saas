# F4-02g Brasilien Net Metering (SCEE-Gutschriftregel)

Stand: SPECIFIED (kein Code, keine Migration). Loest den
F4-02d-§2-Stub („BR Net Metering = Economics-Regel im F4.5-Slice",
F4-02d-commercial-gate-laender.md:36-38) als reine Spezifikation ein:
Kompensations-/Gutschriftregel in der Wirtschaftlichkeit, nach dem
Muster der DE-EEG-Kaskade (F4-05-wirtschaftlichkeit.md:39-52,
economics-v2.ts:205-226). Keine BR-Lastform, keine Tarif-Raten
(F4-02d:36-38 bleiben).

## 1. Kompensationsregel (belegt, Lei-14.300-Modell)

- Einspeisung → Gutschrift → Verrechnung: Eingespeiste Energie wird
  als Energiegutschrift (kWh) gutgeschrieben und auf der Rechnung mit
  dem Netzbezug verrechnet (SCEE-Prinzip, s. Provenienz).
- Faktor: `gutschrift_kwh = einspeisung_kwh × compensationFactor`
  (0..1). Der Faktor ist Regelsatz-Input aus dem Contract
  (`contracts/brasil-net-metering.v1.schema.json`), kein
  hartcodierter Satz: Das Übergangsregime (Fio-B-Komponenten auf
  kompensierte Energie) existiert laut Quelle, seine Staffel ist
  hier unbelegt und wird NICHT erfunden (s. Offene Punkte 1).
- Übertrag: Ungenutzte Gutschriften werden in Folgemonate
  übertragen (direkte Folge der Verfallsregel).
- Verfall: Gutschriften verfallen 60 Monate nach der
  Entstehungs-Fakturierung und fallen entschädigungslos an die
  Tarifmilderung (Lei 14.300/2022, s. Provenienz).

## 2. Abgrenzung zur DE-EEG-Kaskade (kein Doppelpfad)

- Exklusivität: Ein Profil läuft ENTWEDER über die DE-Kaskade
  (Override > Post-EEG > EEG-Default, economics-v2.ts:205-226) ODER
  über die BR-Gutschriftregel — nie über beide. `feedInTariffSource`
  (`override | eeg_default | post_eeg`) bleibt DE-only; ein
  BR-Resultat trägt stattdessen den Gutschrift-Block und kein
  `feedInTariffSource`.
- DE-EEG-Override + BR-Regelsatz gleichzeitig ist fail-closed
  (Bau-Slice wirft statt zu mischen).
- BR betrifft nur die Geldrechnung (F4.5-Slice). Energiefluss,
  Lastform und TOU bleiben unberührt; `br_netmetering.v1` als
  Lastprofil bleibt fail-closed abgewiesen (F4-02d DE-only-Guard).

## 3. Fail-closed ohne BR-Regelsatz

- BR-Kennzeichen (`brasilNetMetering` bekannt) ohne vollständigen
  Regelsatz (Contract-Pflichtfelder) liefert kein Geld
  (`resolveEconomics` → null), keinen stillen Faktor, keine
  stillen 60 Monate.
- Contract-Verletzung (Faktor ausserhalb 0..1, Verfall ≠ 60) ist
  ebenfalls fail-closed (kein stilles Kappen).

## 4. RED-Beleg (2026-09-20, vor Implementierung)

`npx tsx scripts/run-tests.mts tests/unit/f402g-net-metering.red.test.ts`
(ungeskipt): 5 failed (5). Keine BR-API existiert: `resolveEconomics`
ignoriert das BR-Kennzeichen und liefert DE-Geld.

```text
FAIL ... f402g brasil net metering > BR-Regelsatz erzeugt Gutschrift-Block
  statt Einspeiseverguetung
AssertionError: expected { importPriceCtPerKwh: 36, …(8) } to have property
  "brasilNetMetering"

FAIL ... f402g brasil net metering > Gutschrift-Verfall 60 Monate ist
  exportiert (Lei 14.300)
AssertionError: expected { …(15), …(1) } to have property
  "BRASIL_CREDIT_EXPIRY_MONTHS" with value 60

FAIL ... f402g brasil net metering > Gutschrift-Uebertrag in den Folgemonat
  ist exportiert
AssertionError: expected false to be true // Object.is equality

FAIL ... f402g brasil net metering > DE-EEG-Kaskade und BR-Gutschrift
  schliessen sich aus (fail-closed)
AssertionError: expected [Function] to throw an error

FAIL ... f402g brasil net metering > BR-Kennzeichen ohne Regelsatz liefert
  kein Geld (fail-closed)
AssertionError: expected { importPriceCtPerKwh: 36, …(8) } to be null

Test Files  1 failed (1)
Tests  5 failed (5)
```

Die Suite ist danach per `describe.skip` stillgelegt (Grund + Ref im
Testkopf); Entskippen, sobald der Bau-Slice die BR-Regel implementiert.

## Provenienz (belegte Quellen)

- Lei 14.300/2022 (Volltext, MME): SCEE-Kompensation; Gutschriften
  verfallen 60 Monate nach Entstehungs-Fakturierung
  („Os créditos de energia elétrica expiram em 60 (sessenta) meses
  após a data do faturamento em que foram gerados").
  https://www.gov.br/mme/pt-br/acesso-a-informacao/legislacao/leis/lei-n-14-300-2022.pdf
- Schirato/Campos (2023), „The distributed generation regime in
  Brazil": SCEE ermöglicht den Rechnungsabzug verbrauchter Energie
  gegen eingespeiste Energie; Reform mit Übergangsregimen für neue
  Tarifkomponenten auf kompensierte Energie.
  https://www.redalyc.org/journal/6002/600271948008/html/
- U.S. EIA (2020), „Brazil's net metering policy": Gutschriften für
  Überschusseinspeisung, Verfall nach 60 Monaten (seit 2015).
  https://www.eia.gov/todayinenergy/detail.php?id=42035

## Offene Punkte (unbelegt, NICHT erfunden)

1. Fio-B-Übergangsstaffel (Prozentsatz je Anschlussjahr) — vor Bau
   per ANEEL-/Gesetzesbeleg fixieren, sonst bleibt der Faktor
   reiner Regelsatz-Input.
2. Simultaneitätsfaktor / Verfügbarkeitskosten (custo de
   disponibilidade) und Mindestfakturierung — unbelegt.
3. Gutschrift-Übertrag auf andere Verbrauchseinheiten
   (autoconsumo remoto, gleiche CPF/CNPJ-Gruppe) — unbelegt;
   Spec deckt nur Übertrag in Folgemonate derselben Einheit.
4. Währung der BR-Geldrechnung (BRL vs. Euro-Darstellung) und
   Tarifquellen — unbelegt; keine BR-Tarif-Raten in dieser Spec.
5. Mehrjahres-Serie (Eskalation/Degradation auf Gutschrift-Basis)
   — Bau-Slice-Entscheidung nach Beleg.
