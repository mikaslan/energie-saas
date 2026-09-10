# F4-04b Zeitvariabler Tarif (TOU), Arbitrage und Ladefahrplan

Stand: SPECIFIED (Codex-Slice F4.4b, Katalog F4.4). Ergänzt F4-04a
(Flattarif-Vergleich) um einen 24-Stunden-Bezugspreis, preisgeführte
Speicherfahrweise und einen mittleren 24-h-Ladefahrplan. Keine behauptete
Reonic-Parität; Näherungen sind als ESTIMATE markiert und REVIEW-pflichtig.

## 1. Eingabe: TOU-Profil

- `consumption.touImportPricesCtPerKwh`: optional, exakt 24 endliche Zahlen
  (Ct/kWh, je 0–200), Stundenpreise Ortszeit, täglich wiederholt
  [ESTIMATE: Slot-Tage beginnen um lokale Mitternacht; die Achse startet
  am 1. Januar 00:00].
- Erfassung: ein Textfeld „TOU-Stundenpreise (24 Werte, Komma-getrennt,
  leer = kein TOU)“. Ungültig (Anzahl ≠ 24, nicht numerisch, Bereich
  verletzt) → Formfehler, kein Speichern (fail-closed). Leer → unknown,
  kein TOU-Block, keine Fehler.
- Auflösung (`resolveTouImportPrices`): nur bekanntes, vollständig
  belegtes Profilfeld → Request-Schlüssel `tou`; sonst fehlt der Schlüssel
  (Althashes stabil).

## 2. Preisgeführter Dispatch (`tou-dispatch-v2.ts`, engine-v2 bleibt eingefroren)

Politik „preisgeführt mit Tag-Voraussicht“ [ESTIMATE: statischer TOU ist
im Voraus bekannt; dynamische Day-ahead-Märkte sind NICHT abgebildet]:

- Direktverbrauch PV → Last unverändert (erste Priorität).
- PV-Überschuss lädt den Speicher (wie Flattarif).
- Defizit: Entladen nur, wenn der Stundenpreis ≥ Tagesmedian der 24
  TOU-Preise; sonst Netzbezug (SoC für teure Stunden schonen).
- Netzladung (Arbitrage): nur in Stunden ≤ Tages-P25 UND nur, wenn die
  Handelsspanne den Rundungsverlust trägt:
  `median × etaCharge × etaDischarge − p25 ≥ 0,5 Ct/kWh` [ESTIMATE].
  Leistung: nach PV-Ladung verbleibende Ladeleistung.
- Flacher Tag (Spanne < 1 Ct/kWh) oder kein nutzbarer Speicher →
  exakt Flattarif-Verhalten (keine Netzladung, immer Entladen bei Defizit).
- SoC-Dynamik bleibt `clamp(soc + delta)` mit SoC-unabhängigen Deltas →
  zyklischer Fixpunkt via `cyclicSocStart`, Gate atol 1e-8 kWh wie F4.1.
  Slot-Bilanz wird fail-closed geprüft (gleiche Toleranz wie engine-v2).
- Kein Einspeise-Arbitrage (Exportpreis bleibt flach); keine
  Batteriedegradationskosten pro Zyklus [ESTIMATE, REVIEW-offen].

## 3. Geld: TOU-Rechnung Jahr 1

- `touBillEuro = Σ Slot-Netzbezug × TOU-Stundenpreis` (Cent-genau, nur
  Bezugskosten — gleiche Semantik wie F4.4a-Bills, keine
  Einspeiseerlöse abgezogen).
- `savingsVsFlatEuro = currentEuro − touBillEuro` (kann negativ sein;
  ehrlicher Vergleich: gleiche PV/Last, andere Fahrweise + Preise).
- `gridChargeKwh`: Jahres-Netzladung (Arbitrage-Volumen).
- TOU-Block nur bei `request.tou` UND `request.economics` (Neuanlage und
  geplante Bestands-Seite); sonst fehlt der Schlüssel.

## 4. Ladefahrplan (UI)

- `schedule24h`: je Ortsstunde Mittelwerte über 365 Tage: Laden kW
  (PV + Netz), Entladen kW, Netzladung kW, SoC kWh.
- UI-Block „Zeitvariabler Tarif & Ladefahrplan“: TOU-Rechnung, Ersparnis
  vs. Flattarif, Arbitrage-Volumen, Recharts-24-h-Balken (Laden/Entladen)
  plus SoC-Hinweis. Ohne TOU-Block ist der Block unsichtbar.

## Offene Fragen (REVIEW)

1. COP-/Rechenreferenz für TOU-Schedule-Form (Reonic-Beleg fehlt).
2. Zyklenkosten/Degradation im Arbitrage-Kalkül (derzeit 0).
3. Dynamische Stromtarife (Day-ahead) statt statischem 24-h-Profil.
4. HT/NT-Umschaltzeiten je Netzbetreiber (derzeit frei eingebbar).
