# F4-05 — Wirtschaftlichkeit: Tarife, Cashflow, Amortisation, IRR

Status: **SPECIFIED** · Lane: `codex/m1-wave-02` · Stand 2026-09-10

## Ziel und Abgrenzung

Die v2-Kette liefert Energie (kWh), aber kein Geld: keine Tarife, kein
Cashflow, keine Amortisation/IRR — Katalog F4.5 (Outputs: Ertrag,
Autarkie, Eigenverbrauchsquote, Amortisation/IRR/Break-even,
20-Jahres-Cashflow, Einspeisevergütungs-Kaskade) fehlt vollständig
(Greenfield, kein Tarif-/Geld-Modell im Repo). F4.6 liefert nur die
Workspace-Defaults (Preis, Eskalation, Horizont 20) und verweist die
Verkabelung ausdrücklich an den F4.5-Slice. Dieser Slice verkabelt:
Profilpreis + Einspeisekaskade + Investition → Engine-Geld → Ergebnis →
Anzeige. TOU-Tarife/Arbitrage/Ladefahrplan (F4.4) und Sankey bleiben
eigene Folgeslices; Workspace-Default-Fallback (F4.6-Verkabelung) folgt
als F4.5b.

## Datenmodell (additiv, keine Migration)

`consumption.*` (alle optional):

```text
investmentEuro: KnownOrUnknown              # Netto-Investition, 0..10.000.000 €
feedInTariffCtPerKwh: KnownOrUnknown        # Override Einspeisevergütung, 0..100 Ct/kWh
feedInCommissioningYear: KnownOrUnknown     # Inbetriebnahmejahr, int 1990..2100
```

- Strompreis/Eskalation existieren (`electricityPriceCentsPerKwh`,
  `annualPriceIncreasePercent`); unbekannte Eskalation = 0.
- DB-CHECK bindet nur Top-Level-Keys → keine Migration.

## Tarifauflösung (economics-v2.ts, versioniert)

`resolveEconomics(consumption)` → Input oder null (nicht berechenbar):

- Bezugspreis: Profilpreis Ct/kWh bekannt = Pflicht (sonst null — kein
  erfundenes Geld). Eskalation: Profilwert oder 0.
- Einspeisevergütung (Kaskade Override > Post-EEG > Länderdefault):
  Override bekannt → Quelle `override`; sonst EEG-Tabelle nach
  (commissioningYear ?? laufendes Jahr) → Quelle `eeg_default`;
  Anlage älter als 20 Jahre → Marktwert → Quelle `post_eeg`.
- Investition bekannt = Pflicht (sonst null).
- Horizont: vorerst fix 20 (F4.5b übernimmt Workspace-Horizont).

`[ESTIMATE]` EEG-Tabelle (DE Überschusseinspeisung ≤10 kWp, Ct/kWh,
`EEG_FEED_IN_DEFAULT_CT`, REVIEW-Pflicht gegen Clearingstelle):
2020 → 9,0; 2021 → 7,5; 2022 → 8,2; 2023 → 8,2; 2024 → 8,03; 2025 → 7,87;
2026 → 7,5. `[ESTIMATE]` Post-EEG-Marktwert 3,5 Ct/kWh (Größenordnung
Marktwert Solar, kein Tarif). `[ESTIMATE]` Degradation 0,5 %/Jahr
(Anlagenertrag; Eigenverbrauch/Einspeisung skalieren mit Erzeugungsquote,
Last konstant).

## Berechnung (Engine, versioniert)

Request bekommt optionalen Schlüssel `economics` (aufgelöste Zahlen;
`inputSha` deckt Tarife → Ergebnis reproduzierbar). Engine:

```text
preis_y    = preis_1 × (1 + eskalation)^(y-1)      # Bezugspreis eskaliert
quote_y     = (1 − degradation)^(y-1)               # Erzeugungsquote sinkt
savings_y   = self_1 × quote_y × preis_y + feedIn_1 × quote_y × vergütung
              # Vergütung fix 20 Jahre (EEG-Logik); keine Eskalation
cashflow_0  = −investition; cashflow_y = savings_y (y ≥ 1)
kumuliert_y; Amortisation = erstes y mit kumuliert ≥ 0 (null wenn nie)
IRR = Bisektion NPV=0 über Horizont (null ohne Vorzeichenwechsel;
      Investition 0 + Ersparnis > 0 → Amortisation 0, IRR null)
```

Geld rundet auf Cent (`roundMoney`). `economics` fehlt im Resultat,
wenn der Request-Schlüssel fehlt (Altresultate unverändert lesbar;
kein Warning-Enum-Wechsel).

Resultat-`economics`: Eingangs-Echo (Preis, Eskalation, Vergütung,
Vergütungsquelle, Investition, Horizont) + `annualSavingsEuro` (Jahr 1)
+ `cumulativeCashflowEuro[20]` + `amortizationYears|null` +
`irr|null`.

## Validierung (fail-closed)

- Preis oder Investition unbekannt → kein `economics`-Schlüssel (kein
  Fehler, keine erfundenen Euro).
- Override ≤ 0? 0 ist gültig (ungeförderte Volleinspeisung → 0).
  Negative Preise sind im Vertrag nicht darstellbar (F4.6-DECIDED).
- Jahr außerhalb 1990..2100 → Save verweigert (Vertrag).

## Anzeige

Eigener Block in der v2-Ergebnisansicht (Neuanlage + Bestand? Bestand:
Ersparnis aus `additionalSelfConsumption`? — vorerst nur Neuanlage;
Bestand folgt, wenn Baseline-Delta-Geld definiert ist): KPIs
(Jahresersparnis, Amortisation, IRR, Vergütung + Quelle) + 20-Jahres-
Tabelle (Jahr, Ersparnis, kumuliert). E2E-Sichtbarkeit wie F4.2/F4.3.

## Akzeptanz

- Unit: Tarifkaskade (Override/Post-EEG/EEG-Jahre), Cashflow-Reihe,
  Amortisation (nie → null), IRR (Bisektion gegenClosed-Form-Fall),
  Degradations-Skalierung, Rundung.
- Compose/Request-Unit: Auflösung Profil → Request-`economics`,
  absent ohne Preis/Investition.
- Engine-Unit: Geld aus Fixture-Jahreswerten, Bestand-Branch vorerst
  ohne Geld (explizit, Test pinnt Abwesenheit).
- Actions-Unit: Bereiche (Investition, Vergütung, Jahr).
- E2E: Editor speichert Investition/Vergütung → Kette bis currentV2 mit
  `economics` (Amortisationsjahr plausibel), UI-Block sichtbar, Axe.
- Gates: lint/typecheck/test/build + CI grün; v2-Artefakt-Regen
  (Request+Result) + SHA-Pin + Goldens prüfen.

## F4.5b — Workspace-Default-Fallback (geliefert)

- Confirm friert F4.6-Defaults in die Preparation ein (`workspaceEconomics`
  mit Settings-Revision, Preis, Eskalation-bps, Horizont); Profil gewinnt
  immer, Workspace füllt nur Profil-Lücken (Preis, Eskalation, Horizont).
- Ohne Preis überall bleibt Geld unbelegt (kein erfundenes Geld);
  unbrauchbarer Fallback-Preis (0/>200 Ct) zählt als unbelegt, bricht nie
  den Confirm ab.
- Resultat-Echo trägt `priceSource` (profile/workspace_default) und
  `settingsRevision`; UI zeigt die Preis-Herkunft.
- Berechtigung: economics.read (ab Viewer) prüft der Confirm explizit;
  Settings-Read liegt in `lib/integrations/economics/settings-read.ts`
  ohne `server-only`-Marker (E2E/tsx-tauglich).
- E2E: Settings-Zeile (30 Ct, 200 bps, Horizont 15, Rev 1) + preisloses
  Profil → economics mit Quelle workspace_default, 15 Cashflow-Zeilen.

## Bewusst offen
- F4.4: TOU-Tarife, Tarifvergleich alt/neu, Arbitrage/Ladefahrplan
  (Dispatch-Umbau, eigener Slice).
- F4.5b: Sankey-Energiefluss, Bestands-Delta-Geld, Öl-/Gas-Substitution.
- Exakte EEG-Sätze/Clearingstelle, echte EXAA/Marktwert-Fixierung.
