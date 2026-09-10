# F4-04a — Tarifvergleich: Rechnung ohne/mit PV, Alt- vs. Neutarif

Status: **SPECIFIED** · Lane: `codex/m1-wave-02` · Stand 2026-09-10

## Ziel und Abgrenzung

Katalog F4.4 verlangt „Tarifvergleich alt/neu" — bislang zeigt die Kette
nur Ersparnis gegen implizit null (self×Preis + feed×Vergütung), aber
keine Stromrechnung. Dieser Slice legt die Jahr-1-Rechnung offen: ohne
PV, mit PV (aktueller Tarif), mit PV (Neutarif, optional). Kein
Dispatch-Umbau (weiter `load_first_cyclic_soc.v1`); TOU-Tarife,
Arbitrage und Ladefahrplan sind der eigene Folgeslice F4.4b.

## Datenmodell (additiv, keine Migration)

`consumption.alternativeImportPriceCtPerKwh`: KnownOrUnknown 1..200 Ct,
optional. Unbelegt = kein Neutarif-Vergleich (kein Fehler).

## Berechnung (Engine, versioniert)

Bei belegtem economics-Input (F4.5) zusätzlich, aus Engine-Jahreswerten
(Jahr 1, physikalische Flüsse identisch für alle Tarife):

```text
noPvBill      = consumption_1 × preis_1            # ohne PV
currentBill   = gridImport_1 × preis_1              # mit PV, aktueller Tarif
newTariffBill = gridImport_1 × neupreis  (nur bei belegtem Neutarif)
```

- Geld auf Cent (`roundMoney`); keine Eskalation (Jahr-1-Vergleich,
  dokumentiert — Mehrjahresvergleich folgt mit TOU in F4.4b).
- Konsistenz (exakt, Test pinnt): noPvBill − currentBill =
  selfConsumption_1 × preis_1 (Kette: consumption = self + gridImport);
  annualSavingsEuro liegt darüber um feedIn_1 × Vergütung.
- Resultat-`economics` bekommt `annualBillsEuro: { noPv, current,
  newTariff: number | null }`.

## Validierung (fail-closed)

- Neutarif außerhalb 1..200 → Save verweigert (Vertrag).
- Ohne economics-Input keine Bills (gleiche Regel wie Geld).

## Anzeige

Eigener Block „Stromrechnung (Jahr 1)" in der v2-Ergebnisansicht: drei
Zeilen (ohne PV / mit PV aktuell / mit PV Neutarif oder „—"), plus
Ersparnis-Zeile (= annualSavingsEuro, Konsistenz sichtbar).

## Akzeptanz

- Unit: Bills aus Fixture-Jahreswerten, Neutarif-null-Pfad, Rundung,
  Konsistenz-Ungleichung.
- Engine-Unit: Bills im Resultat bei economics-Input, absent ohne.
- Actions-Unit: Bereich 1..200, leer erlaubt.
- E2E: Editor speichert Neutarif → Kette bis currentV2 mit Bills,
  UI-Block sichtbar (drei Zeilen), Axe.
- Gates: lint/typecheck/test/build + CI grün; v2-Artefakt-Regen + SHA-Pin.

## Bewusst offen

- F4.4b: TOU-Tarife (Zeitplan), Arbitrage/Netzladung, Ladefahrplan
  (Dispatch-Strategie `tou_arbitrage.v1`, eigene Spec).
- Mehrjahres-Tarifvergleich mit Eskalation je Tarif.
- Grundpreis/Leistungspreis-Komponenten (nur Arbeitspreis modelliert).
