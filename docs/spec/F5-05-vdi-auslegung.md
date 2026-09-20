# F5-05 — WP-Auslegung nach VDI 4645 (F5.4a), Herstellerkatalog-Spike, Bivalenz-Single-Source

Status: **SPECIFIED (RED, Tests geskippt)** · Lane: `codex/muse-fleet-3d-f5` · Stand 2026-09-20 (Spec + RED-Test `tests/unit/f505-auslegung.red.test.ts`, `describe.skip` bis zur Implementierung; Fixtures `tests/fixtures/f5/`)

## Ziel und Abgrenzung

Katalog F5.4 (`docs/blaupause/01-modulkatalog.md`): „Berechnung
raumweise + gebäudebezogen, WP-Dimensionierung nach VDI 4645 mit
Herstellerkatalogen, Bivalenzpunkt (Default −6 °C)". Dieser Slice
spezifiziert die Auslegungsstufe: Heizlast-Eingang → Gerätewahl →
Bivalenzpunkt als Ergebnis → Heizstab-Dimensionierung. Keine neue
Lane-Freigabe nötig (F5-Folgeslice zu F5-01).

**ACHTUNG — nicht vermengen:** VDI 4650 (F5-01-Faustwert:
Bedarf ÷ Volllaststunden, `sizing-estimate-v1.ts`) ist das
**Schätzverfahren** für den Heizlast-Eingang. VDI 4645 ist die
**Auslegung** (Dimensionierung von Wärmepumpe + Zusatzheizung).
F5-01 liefert die Eingangsgröße, F5-05 legt danach aus.

## §1 F5.4a — Auslegung aus Heizlast

- Eingang: Heizlast [kW] aus der F5-01-Schätzung
  (`Heizlast = thermischer Jahresbedarf / Volllaststunden`,
  Bestand 2000 h/a, Neubau 1700 h/a). Der Eingang ist dokumentiert
  **ESTIMATE** — keine DIN-EN-12831-Heizlast; die raumweise
  Heizlastberechnung (F5.2/F5.3-Raummodell) löst ihn ab, sobald sie
  liefert. Bis dahin rechnet F5.4a gebäudebezogen.
- Betriebsweise: **monoenergetisch** (Wärmepumpe + elektrischer
  Heizstab). Monovalent/bivalent sind keine Auslegungspfade dieses
  Slices.
- Der **Bivalenzpunkt ist ERGEBNIS** der Auslegung (Schnittpunkt von
  Gebäudeheizkurve und Geräteleistung), kein Eingabefeld. Der Builder
  nimmt keinen Bivalenz-Eingang an.
- Heizstab-Dimensionierung: Der Builder dimensioniert die elektrische
  Zusatzleistung für die Restlast bei Normaußentemperatur
  (`heatPumpNominalKw + backupHeaterKw ≥ heatingLoadKw`).
- Builder `sizeHeatPumpVdi4645V1` (Version
  `wmee-hp-sizing-vdi4645.v1`), reiner Builder ohne I/O nach
  `sizing-estimate-v1`-Vorbild: fail-closed bei unbelegter Heizlast
  (≤ 0, nicht endlich) und unbekannter Betriebsweise — kein
  0-kW-Ergebnis, kein stiller Default.

## §2 F5.4b — VDI-Detailregeln (nach Normtext-Zugang)

Sperrzeiten des Netzbetreibers, Warmwasser-Zuschläge und die
Normaußentemperatur-Tabelle werden erst nach Normtext-Zugang
spezifiziert (F5.4b). Bis dahin gilt: keine erfundenen Tabellenwerte,
keine behauptete VDI-Konformität — die betroffenen Größen sind
UNKNOWN, der Bau-Slice von F5.4a arbeitet mit den Fixtures aus §5.
(F5-01 bleibt davon unberührt: reine Schätzung, keine Normrechnung.)

## §3 Herstellerkatalog

Vor dem Katalog-Schema läuft ein **hplib-Evaluierungs-Spike**
(Eignung als Leistungskennlinien-Quelle für die Auslegung). Erst
danach wird das Katalog-Schema festgelegt. Es wird **keine
Abdeckung behauptet**: kein Hersteller, keine Baureihe und keine
Kennlinie gilt als belegt, solange der Spike kein Ergebnis liefert
(F4-03 „Bewusst offen": kuratierte Hersteller-DB, eigene
Datenquelle).

## §4 Bivalenz-Single-Source

- **F5 bestimmt** den Bivalenz-Default: Fixture
  `tests/fixtures/f5/bivalenz-default.json`, Default **−6 °C**,
  Status ESTIMATE (Quelle: Modulkatalog F5.4).
- **F4.3 referenziert statt zu duplizieren**: `heat-pump-cop-v2.ts`
  (ESTIMATE-Kennlinie, Stützstellen :51-56; Bivalenz-Schalter
  :183-185; ESTIMATE-Defaults mit Bivalenz −6 °C :40-42;
  Provenienz/SHA :83-102) übernimmt den F5-Wert, sobald der
  F5-Bau-Slice liefert.
- **F4-Fallback bis F5 liefert**: `HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT`
  (−6 °C) bleibt bestehen; kein Byte ändert sich an der F4.3-Rechnung
  (F4-03, :19-21 Bivalenz-Default, :62 Schalter, :104 Hersteller-DB
  offen). Der Pin-Test prüft Fixture-Wert = F4-Fallback.

## §5 Rechenfixtures

Jeder Rechenwert trägt Quelle, Einheit und Toleranz; jedes Fixture
eine Versionsquelle und einen Freigabe-Status (Tabellen-Muster nach
`bdew-h0-table.ts`, Fixture-Muster nach `tests/fixtures/f401/`):

| Fixture | Version | Freigabe | Werte |
|---|---|---|---|
| `tests/fixtures/f5/bivalenz-default.json` | `wmee-f5-bivalence-default.v1` | ESTIMATE | `bivalenceTempC` = −6, °C, Quelle Katalog F5.4, Toleranz 0 |
| `tests/fixtures/f5/vdi-input-pins.json` | `wmee-f5-vdi-input-pins.v1` | ESTIMATE | `heatingLoadKw` = 10, kW, Quelle F5-01 (20000 kWh/a ÷ 2000 h/a), Toleranz 0,01; `operatingMode` = monoenergetisch, SPECIFIED; `coverageShareThesis` = 0,95, THESE (unbelegte Arbeitsthese, kein Normwert), Toleranz 0,005 |

SHA-Pins (kein stiller Wechsel, Test prüft):
`bivalenz-default.json` =
`177dc964…08269a3`, `vdi-input-pins.json` = `43e71c43…67c6e2c`
(vollständig im Test).

## ROT-Beleg (2026-09-20, vor `describe.skip`)

```text
FAIL tests/unit/f505-auslegung.red.test.ts > F5-05 VDI-4645-Auslegung (RED)
  > stellt den Auslegungs-Builder sizeHeatPumpVdi4645V1 bereit
FAIL ... > liefert den Bivalenzpunkt als ERGEBNIS (kein Eingabefeld)
FAIL ... > dimensioniert den Heizstab für die Restlast (monoenergetisch)
Error: Cannot find package '@/lib/integrations/heat-pump/sizing-vdi4645-v1'
Test Files  1 failed (1)
     Tests  3 failed | 2 passed (5)
```

Die 3 RED-Tests scheitern am fehlenden Builder-Modul; die 2
§5-Pin-Tests (Schema + SHA) laufen grün. Der Bau-Slice entfernt das
`.skip`, ersetzt den dynamischen Import durch einen statischen und
implementiert `sizeHeatPumpVdi4645V1` nach §1. Mechanik-Probe mit
Wegwerf-Stub (5/5 grün) bestätigt: Der Test wird grün, sobald das
Modul den Vertrag erfüllt; der Stub wurde danach gelöscht.

## Bewusst offen

- Raumweise Heizlast (F5.2/F5.3) als Ablösung des F5-01-Eingangs.
- F5.4b-Detailregeln (Sperrzeiten, WW-Zuschläge,
  Normaußentemperatur-Tabelle) nach Normtext-Zugang.
- hplib-Spike-Ergebnis und Katalog-Schema (§3).
- Heizlast nach DIN EN 12831 / U-Werte (M5-Produkt, nicht F5-Näherung).
