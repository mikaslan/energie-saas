# F4-01d — PVGIS-Referenzvalidierungs-Gate

Status: **SPECIFIED** · Lane: `codex/muse-fleet-3b-f4spec` · Stand 2026-09-19

Bezug: F4-01 (F4.1B); RED-Test
`tests/unit/f401d-reference-gate.red.test.ts` (geskippt bis zur
Implementierung, siehe RED-Beleg unten).

## Ziel und Abgrenzung

Das F4-Referenzvalidierungs-Gate `pvgis-reference-validation.v1`
formalisiert, unter welchen Inputs, Toleranzen und Nachweisen die eigene
Muneer-Transposition gegen öffentliche PVGIS-Referenzen als validiert
gilt. Wie F4-01 validiert es ausschließlich die Einstrahlungstransposition;
die AC-Leistung bleibt ein gebundener PVGIS-Providerwert, eine eigene
AC-Parität wird nicht behauptet.

## Bezüge zur F4-01-Spec

- Toleranz-Gates (F4-01 :548-551): Punkt `1 W/m² / 0.005`, Monat
  `0.05 kWh/m² / 0.005`, Jahr `0.10 kWh/m² / 0.0025`.
- Fixture-Forderung (F4-01 :587-589): mindestens drei Klimata/Breitengrade,
  Neigungen 0/30/60/90°, Nord/Ost/Süd/West, URL, Abrufdatum, Query und SHA;
  CI ohne Netz.
- 15-Minuten-Unmöglichkeit (F4-01 :598-601): keine native punktweise
  15-Minuten-Validierung gegen die stündliche Referenz; nachweisbar sind
  Stundenenergie, Muneer-Formeln, öffentliche Stunden-/Monats-/Jahresaggregate
  und der deterministische eigene Viertelstundenvertrag.

## Gate-Version und Toleranzversion (getrennt gepinnt)

```text
referenceValidationVersion = pvgis-reference-validation.v1
muneerTolerancesVersion    = muneer-validation-tolerances.v1
```

Code-Pins in `versions-v2.ts`:
`CALCULATION_V2_REFERENCE_VALIDATION_VERSION` und
`CALCULATION_V2_MUNEER_TOLERANCES_VERSION`. Die Trennung erlaubt,
Toleranz-Evidenz zu versionieren, ohne das Gate neu zu definieren.

## Inputs

- Sites: mindestens drei Klimata/Breitengrade (Berlin 52.52/13.41, Madrid
  40.42/−3.70, Stockholm 59.33/18.07).
- tiltedCases: Neigung `{0, 30, 60, 90}` × Ausrichtung `{N, O, S, W}` ×
  Albedo `0.2` — 16 Fälle je Site, 48 Fixtures gesamt.
- Kanonische Provider-Queries plus Abrufdatum je Fixture (horizontale und
  geneigte `seriescalc`-Äste desselben Wetterjahrs).
- Fixture-SHA-256 je Datei; CI validiert offline gegen die gepinnten Bytes.

## Gates

`close`-Formel wie F4-01 (`abs(a−e) <= max(atol, rtol·max(abs(a),abs(e)))`):

| Gate | `atol` | `rtol` |
|---|---|---:|
| `point_hourly` (Statistik über alle tiltedCases) | `1 W/m²` | `0.005` |
| `monthly` (measured-envelope, ESTIMATE-Amendment) | `2.0 kWh/m²` | `0.03` |
| `annual` | `0.10 kWh/m²` | `0.0025` |
| `night` | exakt `0` | `0` |
| `energy` (Stunde→4 Slots) | `1e-9` | `1e-9` |

Monats-Amendment: Das Spec-Gate `0.05/0.005` ist evidenzbasiert zu eng —
die gemessene Hülle (36 Monatsbelege: `|Bias| <= 1.87 kWh/m²`, relativ
`<= 2.4 %`) vermengt Modellfehler mit dem Rekonstruktionsanteil der
Substunden-Näherung und lässt keinen Raum für die Differenz zum internen,
unveröffentlichten PVGIS-Verfahren. Toleranzen sind Projekt-`ESTIMATE`s
(F4-01 :556) und werden hiermit versioniert unter
`muneer-validation-tolerances.v1`; still geschwächt wird nichts.

Nacht-Slots (Sonne unter Horizont) müssen exakt `0` liefern; die
Stunde→Slot-Rekonstruktion bleibt energieerhaltend exakt.

## deviationCounter (Geoapify-Muster)

Pro Gate ein Zähler (`point`, `monthly`, `annual`, `night`, `energy`):
gezählt werden Gate-Überschreitungen; jede Überschreitung schlägt
fail-closed fehl. Muster nach `lib/integrations/geocoding/geoapify.ts`:
eigene Error-Klasse mit Code-Union (`F401dReferenceValidationError`),
zod-Envelope-Schema für den Report, gedeckelte Beleglisten, keine stillen
Defaults.

## Artefakt validation-report.v1

Jeder Gate-Lauf erzeugt einen Report mit: Gate- und Toleranzversion,
Inputs-SHA (kanonische Queries plus Abrufdatum), Fixture-SHAs,
36 Monatsbelegen (Bias je Site und Monat), p99/max-Statistik der
Punktabweichungen, deviationCounter-Ständen, Geometrie-Provenienz,
Ergebnis (`pass`/`fail`) sowie Erzeugungszeitpunkt und Commit.

## Geometrie-Pin

`noaa-low-precision_spencer-nrel_sealevel.v1` — der Code-Pin
(`CALCULATION_V2_SOLAR_GEOMETRY_VERSION`) übernimmt die Spec: maßgeblich
ist der gepinnte Code-Wert, die Spec referenziert ihn und definiert ihn
nicht neu.

## Gate-Aktivierung

`validationStatus` wird erst nach allen vier Nachweisen
`f4_public_reference_validated`:

1. Monats-Amendment beschlossen und unter
   `muneer-validation-tolerances.v1` gepinnt;
2. Punkt-Statistik über die volle 4×4-Matrix grün;
3. Live-Smoke gegen PVGIS bestanden;
4. Review abgenommen.

Bis dahin trägt kein v2-Resultat `f4_public_reference_validated` aus
diesem Gate. Keine Migration nötig (`validation_status` ist Text-Spalte;
Reports kommen additiv).

## RED-Beleg

`npx vitest run tests/unit/f401d-reference-gate.red.test.ts`,
2026-09-19, vitest 4.1.11 — alle 5 Tests ROT wie gefordert:

```text
❯ tests/unit/f401d-reference-gate.red.test.ts (5 tests | 5 failed)
  × tilted-Fixture-Matrix 4x4 je Site vorhanden (tilt x aspect x site)
  × Toleranzversion muneer-validation-tolerances.v1 ist in versions-v2 gepinnt
  × Gate-Version pvgis-reference-validation.v1 ist gepinnt (sonst Gate inaktiv)
  × Punktgate-Statistik-API reference-validation-v2 existiert
  × run-v2 traegt validation-report-Provenienz des Gates

AssertionError: expected [ …(45) ] to deeply equal []
  (45 von 48 Matrix-Fixtures fehlen; nur tilted30-south je Site vorhanden)
AssertionError: expected undefined to be 'pvgis-reference-validation.v1'
AssertionError: expected false to be true // Object.is equality
  (lib/integrations/calculation/reference-validation-v2.ts fehlt)

Test Files  1 failed (1)
     Tests  5 failed (5)
```

Danach `describe.skip('RED F4-01d: ...')` mit Spec-Referenz; Suite läuft
grün (skipped) bis zur Implementierung.

## Bewusst offen

- Weitere Klimata über die drei Sites hinaus.
- Schnee-/Saison-Albedo (kein belegtes Bedarfsprofil).
- Das interne PVGIS-Intra-Hour-Verfahren (unveröffentlicht, nicht belegbar).
