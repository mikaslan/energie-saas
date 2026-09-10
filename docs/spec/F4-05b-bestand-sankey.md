# F4-05b Bestands-Geldvergleich und Energiefluss-Sankey

Stand: SPECIFIED (Codex-Slice F4.5b, Katalog F4.5). Zwei Luecken nach
F4.5/F4.5b: (1) Der Bestand-Branch trug Energie-Deltas, aber kein Geld;
(2) es gab keine Fluss-Visualisierung der Jahresenergie. Keine behauptete
Reonic-Paritaet; Naeherungen als ESTIMATE, REVIEW-pflichtig.

## 1. Bestands-Geldvergleich (`existingInstallation.delta.bills`)

- Nur bei `request.economics` (Importpreis belegt); sonst fehlt der
  Schluessel (kein Geld, kein Fehler).
- `baselineEuro`: Bestand-Netzbezug x Importpreis (Jahr 1, gleiche
  Bezugskosten-Semantik wie F4.4a, keine Einspeiseerloese abgezogen).
- `plannedEuro`: Planungs-Netzbezug x Importpreis (identische Formel wie
  `annualBillsEuro.currentEuro` der Planungs-Seite).
- `savingsEuro = baselineEuro − plannedEuro` (kann negativ sein).
- UI: drei Positionen im Bestandsblock; ohne `bills` unsichtbar.

## 2. Energiefluss-Sankey (rein darstellend, kein Vertragswechsel)

- Client-Komponente aus `annual` (beide Branches; geplant bei Bestand):
  6 Fl_Xe4sse, exakt energieerhaltend (zyklischer SoC):
  PV -> Direktverbrauch, PV -> Speicher (= Entladung + Verlust, folgt aus
  der zyklischen Bilanz), PV -> Einspeisung, Speicher -> Verbrauch,
  Speicher -> Verlust, Netz -> Verbrauch.
- Knotenbilanzen (PV, Speicher, Verbrauch, Einspeisung) gehen exakt auf;
  ein Unit-Test beweist die Erhaltung aus der Annual-Form.
- Recharts-Sankey; ohne `annual` kein Chart (fail-closed darstellend).

## Offene Fragen (REVIEW)

1. Mehrjahres-Bestands-Cashflow (derzeit nur Jahr-1-Rechnungen).
2. Einspeiseerloes-Delta Bestand/Planung (derzeit nur Bezugskosten).
3. Sankey-Farb-/Layout-Abgleich gegen Reonic-Beleg (Beleg fehlt).
