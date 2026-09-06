# F4.1 — Viertelstunden-Simulation und Muneer-Transposition

Status: **SPECIFIED** · additive v2; bestehende v1-Snapshots bleiben unverändert

## Ziel und Abgrenzung

Ein neuer Rechenvertrag simuliert PV, Last, Speicher und Netz auf exakt
35.040 Viertelstunden eines synthetischen Nicht-Schaltjahres. Jeder Lauf ist
serverseitig reproduzierbar, revisionsgebunden und wird bei relevanten
Änderungen automatisch neu reserviert.

F4.1 gilt erst als `VERIFIED`, wenn beide Teilgates grün sind:

1. **F4.1A:** energieerhaltende Viertelstundenachse und Dispatch
   `PV → Last → Speicher → Netz`.
2. **F4.1B:** unabhängige Clean-Room-Muneer-Transposition gegen öffentliche
   PVGIS-Referenzen.

F4.1B validiert ausschließlich die eigene Einstrahlungstransposition. Die
AC-Leistung bleibt ein gebundener PVGIS-Providerwert. Ohne vollständiges
öffentliches DC-/Temperatur-/Spektrum-/AOI-/Invertermodell wird keine eigene
AC-Parität behauptet. Wirtschaftlichkeit, Tarif-Arbitrage, länderspezifische
Lastquellen und 20-Jahres-Cashflow gehören zu F4.2–F4.5.

## Evidenz

### FACT — öffentliche Primärquellen

- PVGIS v5.3 `seriescalc` liefert stündliche UTC-Daten; Schaltjahre enthalten
  8.784 Zeilen. SARAH-Zeitstempel tragen den Satelliten-Beobachtungszeitpunkt
  und dürfen nicht auf `HH:00` umgeschrieben werden.
- PVGIS nutzt für geneigte Flächen das Muneer-Diffusstrahlungsmodell.
- PVGIS `P` ist der finale PV-Systemoutput einschließlich der gebundenen
  Systemannahmen. Nicht alle internen Einflussgrößen sind über die API
  vollständig reproduzierbar.
- Reonic beschreibt ein synthetisches 15-Minuten-Lastprofil über 8.760
  Stunden sowie den Energiefluss PV zuerst zur Last, danach Speicher, dann
  Netz; bei Defizit Speicher vor Netz.

Quellen:

- <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en>
- <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/pvgis-5-tools/hourly-radiation_en>
- <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/pvgis-5-user-manual_en>
- <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/general-information/data-sources-calculation-methods_en>
- <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/pvgis-5-tools/horizon-profile_en>
- <https://op.europa.eu/en/publication-detail/-/publication/4ef8c4e1-4397-4e27-8487-448786327f27>
- <https://docs.reonic.com/docs/en/offers-simulation-cat-profitability>
- <https://docs.reonic.com/docs/en/offers-simulation-cat-energy-flows>
- <https://docs.reonic.com/docs/en/offers-simulation-cat-production-pv>

### ESTIMATE — nicht veröffentlichte Reonic-Parameter

PVGIS stellt keine native 15-Minuten-Wetterreihe bereit. Reonic veröffentlicht
weder Intra-Hour-Rekonstruktion noch DST-/Schaltjahrregel,
Speicher-Start-SOC, Wirkungsgrade, Leistungsgrenzen oder Toleranzen. Deshalb
sind diese Regeln sichtbar, versioniert und austauschbar:

```text
quarter_hour_reconstruction = energy_conserving_solar_weight.v2
synthetic_year_axis          = utc_to_berlin_standard_time_circular_then_drop_feb29.v2
storage_dispatch             = load_first_cyclic_soc.v1
grid_export_limit            = unbounded.v1
evidence_classification      = ESTIMATE
```

Neue Evidenz darf neue Versionen ergänzen, historische Resultate aber nie
still verändern.

## Additiver Versions- und Persistenzvertrag

- Request: `planning-calculation.v2`
- Result: `planning-calculation-result.v2`
- Preparation: `project-calculation-preparation.v2`
- Katalogauflösung: `catalog-resolution.v2`
- Migration: `0076+`; `0075` bleibt für F3.1 reserviert
- Job und Revision erhalten additive, getrennte
  `result_contract_version`-Felder; bestehende Zeilen bleiben v1.
- DB-Checks akzeptieren nur vollständig bekannte Tupel aus Request-, Result-,
  Preparation-, Modell-, Defaults-, Qualitäts- und Validation-Version.
- Neue Runs verwenden v2 erst nach atomarer Aktivierung der gesamten Kette.
  v1-Leser, v1-Replay und v1-Jobs bleiben funktionsfähig.

Das einzige initial erlaubte v2-Tupel lautet:

```text
contractVersion           = planning-calculation.v2
resultContractVersion     = planning-calculation-result.v2
preparationVersion        = project-calculation-preparation.v2
reservationVersion        = project-calculation-reservation.v2
catalogResolutionVersion  = catalog-resolution.v2
providerRecipeVersion     = pvgis-5.3-sarah3-2020-quarter-hour.v2
modelId                   = wmee-solar
modelVersion              = 2.0.0
sourceRevision            = Git-Blob-SHA-1 der eingefrorenen engine-v2.ts
defaultsVersion           = wmee-planning-defaults.v2
quality                   = server_reproduced_public_reference
validationStatus          = f4_public_reference_validated
```

`sourceRevision` wird beim Freeze aus den tatsächlichen Engine-Bytes erzeugt,
als exakter 40-Hex-Pin in `versions-v2.ts` und Migration übernommen und darf
nicht manuell erfunden werden. Andere Kombinationen sind unbekannt und werden
von Runtime, DB-CHECK und CAS verweigert.

Der v2-Request bindet mindestens Standort/Providerhöhe, je Dach Geometrie,
Peakleistung, Technologie, Montageart, Verluste, Albedo und Horizont; ferner
jeden kanonischen Provider-Query, Abrufbeginn und Empfangszeit, exakte
Rohbytes-SHA-256, erforderliche Parsed-Felder, originale Zeitstempel, `Int`,
Horizont-SHA, Lastprofil, Speicherparameter sowie alle Rezept-, Sidecar-,
Runtime- und Dependency-Digests.

Worker-Payloads enthalten nur Job-/Claim-IDs. Retry nutzt ausschließlich den
immutable Snapshot. Erneuter Netzzugriff ist ein expliziter Refresh mit neuer
Revision. CAS-Finalisierung prüft gemeinsam Request-Version, Result-Version,
Request-SHA, Provider-Bundle-SHA, Modellversion und Claim.

## Providerabrufe

Pro Standort wird ein horizontaler `seriescalc` gebunden:

```text
/api/v5_3/seriescalc
lat={providerEffectiveLatitude}
lon={providerEffectiveLongitude}
raddatabase=PVGIS-SARAH3
startyear=2020
endyear=2020
pvcalculation=0
trackingtype=0
angle=0
aspect=0
optimalinclination=0
optimalangles=0
components=1
usehorizon=0
outputformat=json
browser=0
```

Zusätzlich erfolgen ein `printhorizon` je Standort, je Dach ein `seriescalc`
mit gleicher Datenbank/Jahr, `components=1`, `pvcalculation=1`, `peakpower=1`,
expliziter Technologie, Montageart, Verlustangabe, Dachgeometrie und
gebundenem Horizont sowie je Dach der bestehende `PVcalc`-Abruf für den
langjährigen Jahresreferenzwert.

Der kanonische dachbezogene `PVcalc`-Query ist:

```text
/api/v5_3/PVcalc
lat={providerEffectiveLatitude}
lon={providerEffectiveLongitude}
raddatabase=PVGIS-SARAH3
peakpower=1
pvtechchoice={roof.pvTechnology}
mountingplace={roof.mountingPlace}
loss={roof.systemLossPercent}
angle={roof.providerTiltDeg}
aspect={roof.providerAspectDeg}
usehorizon=1
userhorizon={canonical48PointHorizon}
optimalinclination=0
optimalangles=0
outputformat=json
browser=0
```

`userhorizon` serialisiert die 48 kanonischen Höhen in der Reihenfolge
`A=-180,-172.5,…,172.5` als komma-separierte Dezimalzahlen ohne Exponent;
`-0` wird `0`. Koordinaten, Winkel und Verlustwerte nutzen dieselbe
kanonische Dezimalregel. Der dachbezogene `seriescalc` ergänzt exakt:

```text
startyear=2020
endyear=2020
pvcalculation=1
trackingtype=0
components=1
optimalinclination=0
optimalangles=0
```

`peakpower=1` bedeutet: `P` ist `W/kWp`, `E_y` ist `kWh/kWp`. Derselbe
Geometrie-/Technologie-/Montage-/Verlust-/Horizontvertrag gilt für den
dachbezogenen `seriescalc`; nur Tool-, Jahres-, Komponenten- und
`pvcalculation`-Parameter unterscheiden sich wie oben festgelegt.

Der horizontale Snapshot verlangt:

```text
inputs.location.latitude/longitude/elevation
inputs.meteo_data.radiation_db/meteo_db/year_min/year_max/use_horizon/horizon_db
outputs.hourly[].time
outputs.hourly[].Gb(i)
outputs.hourly[].Gd(i)
outputs.hourly[].Gr(i)
outputs.hourly[].H_sun
outputs.hourly[].T2m
outputs.hourly[].WS10m
outputs.hourly[].Int
```

Dach-Snapshots verlangen zusätzlich `P` und passende Montage-/Modulmetadaten.
Fehlende Felder, nichtendliche Zahlen, doppelte/ungeordnete Stunden, ein
abweichender Eingabespiegel oder unterschiedliche Zeitachsen brechen
fail-closed ab. `G_h=Gb(i)+Gd(i)+Gr(i)`; bei horizontaler Geometrie muss
`Gr(i)` innerhalb der Referenztoleranz null sein.

Nord besitzt eine explizite Providergrenze, weil PVGIS v5.3 angefragte
`aspect=±180` als `-179` spiegelt:

```text
providerAspectDeg(a) = normalizeToMinus180Plus180(a)
providerAspectDeg(±180) = -179
```

Domain-Azimut und providerwirksamer Azimut werden beide gebunden. Query und
strikter Eingabespiegel verwenden den providerwirksamen Wert; Muneer-Gates
gegen PVGIS ebenfalls. Diese 1°-Boundary ist als `ESTIMATE` sichtbar.

```text
providerObservedAtUtc = exakte Parse-Ausgabe von YYYYMMDD:HHmm
providerHourStartUtc  = floor(providerObservedAtUtc,1h)
fetchStartedAtUtc     = serverseitige Abrufmetrik
responseReceivedAtUtc = serverseitige Abrufmetrik
```

Die Provider-Minute wird nie ersetzt. Originalzeit und synthetisches
Slot-Label bleiben getrennt.

`Int` muss ganzzahlig `0` oder `1` sein. Produktion akzeptiert beide, bindet
sie in Input/Hash und warnt bei mindestens einem `Int=1` mit
`pvgis_radiation_reconstructed`. Genauigkeits-Fixtures verwenden nur `Int=0`.
Ein separates `Int=1`-Fixture prüft Parsing, Propagation, Warnung und Replay,
zählt aber nicht als Modellvalidierung.

Der rohe `printhorizon`-Snapshot enthält exakt 49 geordnete Zeilen von
`-180°..+180°`; die letzte ist der duplizierte Ringschluss. Der Parser prüft
gleiche Höhe an beiden Endpunkten, bewahrt/hast die Rohbytes unverändert und
entfernt erst danach `+180°`. Der kanonische Horizont enthält exakt 48
endliche Höhen. PVGIS-`A=-180°` entspricht Nord:

```text
azimuthNorthClockwise = mod(A+180°,360°)
```

Zwischen den 7,5°-Punkten wird zirkulär linear interpoliert `[ESTIMATE]`.

## Achse und Viertelstunden-Rekonstruktion

Providerdaten bleiben auf ihrer echten UTC-Achse. Die Simulation nutzt eine
getrennte ordinale Achse `slot=0..35039`. v2 bildet mit festem UTC+01 auf
Berliner Standardzeit ab, schließt den Jahresrand zirkulär und entfernt erst
danach synthetische 29.-Februar-Slots:

```text
utc_to_berlin_standard_time_circular_then_drop_feb29.v2
```

Diese DST-Regel ist `ESTIMATE`; die kollisionsbehaftete v1-Abbildung wird
nicht wiederverwendet.

Je Quellstunde werden `+07:30/+22:30/+37:30/+52:30` physikalisch ausgewertet.
Direkte Gewichte sind `max(0,sin α_q)`, diffuse Gewichte `1` für `α_q>0`,
sonst `0`. Jede Komponente wird auf das Vierfache ihres Stundenmittels
normiert:

```text
X_q = 4·X_h·w_q/sum(w)
0.25h·sum(X_q) = 1h·X_h
```

Bei positiver Quellenergie und `sum(w)==0` wird abgebrochen. Temperatur und
Wind bleiben innerhalb der Quellstunde konstant. Berechnung erfolgt ohne
Zwischenrundung und mit Neumaier-Summation.

## Solarposition, extraterrestrische Strahlung und Air Mass

JRC veröffentlicht nicht die vollständige numerische PVGIS-Implementierung.
v2 pinnt daher eine unabhängige Abhängigkeit `[ESTIMATE]`:

```text
solar_geometry = pvlib_spa_nrel.v1
pvlib          = 0.15.2
how            = numpy
delta_t        = pvlib.spa.calculate_deltat(year,month)
atmos_refract  = 0.5667°
wheel_sha256   = 42035b063cc692bc3ece9480246297ccf211c835f1151faa752acac9584f6bb5
```

Alle Transitiven und der OCI-Digest werden ebenfalls gepinnt. Quelle:
<https://pypi.org/project/pvlib/0.15.2/>.

```text
geo = spa_python(
  time=t_utc,
  latitude=providerEffectiveLatitude,
  longitude=providerEffectiveLongitude,
  altitude=providerElevationM,
  pressure=101325.0,
  temperature=12.0,
  delta_t=calculate_deltat(year,month),
  atmos_refract=0.5667,
  how="numpy",
  numthreads=1
)
α      = radians(geo.elevation)
γ_s    = radians(geo.azimuth)
z_true = radians(geo.zenith)
```

Relative Air Mass nutzt eine zweite SPA-Auswertung unter
Standard-Meeresspiegelbedingungen:

```text
z_app_deg = seaLevelGeo.apparent_zenith
AM = 1/[cos(radians(z_app_deg))+0.50572·(96.07995-z_app_deg)^(-1.6364)]
```

Es gilt relative, nicht höhenkorrigierte Air Mass. Eq. 31 wird direkt ohne
Clearness-Index-Hilfsclamp berechnet.

```text
G_on = get_extra_radiation(
  t_utc,
  solar_constant=1366.1,
  method="nrel",
  delta_t=calculate_deltat(year,month),
  how="numpy"
)
G_0h = max(0,G_on·cos(z_true))
```

Im öffentlichen Stunden-Gate stammt `α` primär aus PVGIS `H_sun`, damit
Muneer und SPA getrennt prüfbar bleiben. SPA liefert Azimut, `G_0h` und `AM`;
für Viertelstunden die gesamte Geometrie. Nur bei `H_sun>0` werden Air Mass
und Clearness-Indizes ausgewertet. Das Sonnenhöhengate vergleicht
`max(0,SPA_elevation_deg)` gegen PVGIS `H_sun`; Abweichung höchstens `0,25°`.

Dokumentation:

- <https://pvlib-python.readthedocs.io/en/v0.15.2/reference/generated/pvlib.solarposition.spa_python.html>
- <https://pvlib-python.readthedocs.io/en/v0.15.2/reference/generated/pvlib.atmosphere.get_relative_airmass.html>

## Muneer-Clean-Room-Kern

Alle Winkel sind Radiant. PVGIS-Azimut wird nach Nord im Uhrzeigersinn
konvertiert:

```text
γ_T = mod(aspect_pvgis+180°,360°)
cos ξ = sin α·cos β + cos α·sin β·cos(γ_s-γ_T)
K(β)   = sin β - β cos β - π sin²(β/2)
N(k_b) = 0.00263 - 0.712 k_b - 0.6883 k_b²
S(β,N) = (1+cos β)/2 + N·K(β)
k_b  = B_h/G_0h
k_t  = G_h/G_0h
k_t' = k_t/[0.1+1.031·exp(-1.4/(0.9+9.4/AM))]
```

Normative Branch-Reihenfolge:

1. `α<=0`: `B_T=D_T=R_T=G_T=0`; positive Einstrahlung wird nur auf Slots
   mit `α>0` verteilt.
2. `horizonShaded := α<=horizonElevation(γ_s)`,
   `rearSide := cosξ<=0`, `overcast := k_t'<0.3`.
3. Beam und Reflexion. PVGIS v5.3 nutzt bei Horizontschatten/Rückseite für
   die Bodenreflexion nur die diffuse horizontale Komponente; diese
   Live-Referenzregel ist gegenüber der allgemeinen JRC-Kurzform ausdrücklich
   als `pvgis53-shadow-reflection.v1` gebunden:

   ```text
   B_T = horizonShaded || rearSide ? 0 : B_h·cosξ/sinα
   G_ref = horizonShaded || rearSide ? D_h : G_h
   R_T = ρ·G_ref·(1-cosβ)/2
   ```

4. Diffuszweig; erste passende Regel gewinnt:

   ```text
   if tiltDeg == 0:
       D_T = D_h
   else if horizonShaded || rearSide || overcast:
       D_T = D_h·S(β,0.25227)                       # JRC Eq. 28
   else if 0 < α < 0.1:
       D_T = D_h·[S(β,N(k_b))·(1-k_b)
             + k_b·sinβ·cos(γ_T-γ_s)/(0.1-0.008·α)] # JRC Eq. 30
   else:
       D_T = D_h·[S(β,N(k_b))·(1-k_b)
             + k_b·cosξ/sinα]                       # JRC Eq. 29
   ```

5. `G_T=B_T+D_T+R_T`.

Grenzen: `tiltDeg==0` liegt vor dem Niedrigsonnenzweig. Bedeckung ändert nur
Diffus; eine positive Direktkomponente bleibt geometrisch gebunden.
Horizont/Rückseite nullt nur `B_T`, nicht `D_T`/`R_T`; `R_T` bleibt dann auf
der diffusen Quelle positiv. `α==0.1` nutzt Eq. 29,
`k_t'==0.3` ist nicht bedeckt, `cosξ==0` ist Rückseite,
Horizontgleichheit ist verschattet. `k_b`/`k_t` werden nicht auf `[0,1]`
geklemmt. Nichtendliche oder materiell negative Resultate brechen ab; nur
`[-1e-9,0)` darf als Nullrauschen auf null gesetzt werden.

## AC-Leistungsstrategie

F4.1 besitzt kein eigenes AC-Modell:

- `P_h` stammt unverändert aus dem dachbezogenen PVGIS-Snapshot.
- Skalierung auf den langjährigen Jahreswert bleibt sichtbar `[ESTIMATE]`:

  ```text
  s    = PVcalc.E_y/(sum(P_h_after_axis_normalization)/1000)
  P*_h = s·P_h
  ```

- Viertelstundenleistung wird über das eigene Muneer-`G_T,q`
  energieerhaltend verteilt `[ESTIMATE]`:

  ```text
  P_q = 4·P*_h·G_T,q/sum(G_T,q)
  ```

- Bei `P*_h>0 && sum(G_T,q)==0` wird abgebrochen.
- Muneer steuert nur die Substundenform.
- Ein kategorialer `shadingFactor` wird nicht nochmals auf Provider-`P` mit
  gebundenem Horizont angewandt.
- Jahresgleichheit zu `PVcalc.E_y` ist eine Skalierungsinvariante;
  Monatsabweichungen Wetterjahr/langjähriges PVcalc werden nur berichtet.

Die Dachleistung wird danach explizit in Slotenergie überführt und über alle
Dächer summiert:

```text
E_pv,q [kWh] = 0.25/1000 · Σ_roof(roofPeakPowerKwp·P_q,roof [W/kWp])
```

Öffentliche PVGIS-Muneer-Fixtures pinnen `ρ=0.2`, weil die API keinen
Albedo-Parameter anbietet. Produktionsläufe binden die gewählte Albedo; nur
`ρ=0.2` nimmt am öffentlichen PVGIS-Punktgate teil.

Ein eigenes AC-Modell verlangt einen neuen Vertrag mit gepinnten AOI-,
Spektral-, Temperatur-, Modul-, Inverter- und Verlustparametern.

## Speicher- und Netzdispatch

Der v2-Request bindet das bereits auf die synthetische Achse aufgelöste
Lastprofil:

```text
schemaVersion         = quarter-hour-load-profile.v1
axisVersion           = utc_to_berlin_standard_time_circular_then_drop_feb29.v2
slotEnergyKwh         = exakt 35.040 endliche, nichtnegative kWh/Slot
annualConsumptionKwh  = NeumaierSum(slotEnergyKwh)
sourceKind/sourceId/sourceRevision/sourceSha256
```

Basis- und später ergänzte EV-/Wärmepumpenlasten werden vor F4.1 als getrennt
proveniente Slotreihen aufgelöst und zur gebundenen Gesamtlast summiert.
F4.1 nimmt weder kW-Werte noch Monats-/Stunden-IDs entgegen. Summe, Achse und
SHA müssen vor Reservation und Replay identisch sein.

Je Slot mit `Δh=0.25`:

```text
direct  = min(E_pv,E_load)
surplus = E_pv-direct
deficit = E_load-direct
δ_q = surplus>0
  ? η_c·min(surplus,P_c·0.25)
  : -min(deficit,P_d·0.25)/η_d
```

Der unbeschränkte gewünschte SOC-Schritt definiert:

```text
F(s) = fold_q clamp(s+δ_q,SOCmin,SOCmax)
D    = NeumaierSum(δ_q)
s*   = D>0 ? F(SOCmax) : F(SOCmin)
```

`s*` ist der kleinste zyklische Fixpunkt. Ein zweiter Fold bestimmt tatsächliche
Ladung/Entladung. `close(F(s*),s*)` ist Pflicht.

```text
charge_in = min(surplus,P_c·0.25,(SOCmax-SOC)/η_c)
discharge_out = min(deficit,P_d·0.25,(SOC-SOCmin)·η_d)
SOC' = SOC + η_c·charge_in - discharge_out/η_d
storageLoss = charge_in·(1-η_c) + discharge_out·(1/η_d-1)
export = surplus-charge_in
import = deficit-discharge_out
```

Je Slot und aggregiert:

```text
E_pv + import
= E_load + export + curtailment + storageLoss + (SOC'-SOC)
```

Es gilt `0<η_c,η_d<=1`, `0<=SOCmin<=SOCmax<=capacity`; Leistungs- und
SOC-Grenzen gelten vor/nach jedem Slot. Keine Netzladung/Arbitrage.

F4.1 hat keine Einspeisegrenze `[ESTIMATE]`:

```text
grid_export_limit = unbounded.v1
curtailment       = 0
```

Voller Speicher führt zu Export. Inverter-Clipping steckt bereits in `P`.
Eine Einspeisegrenze erfordert einen neuen Requestwert und Rezeptvertrag.

## Resultat und Numerik

Das v2-Resultat enthält `temporalResolution="quarter_hour_35040"`, alle
Rezeptversionen, je Slot PV/Last/Direktverbrauch/Ladung/Entladung/SOC/
Netzbezug/Export/Abregelung/Verluste, Monats-/Jahressummen, Ertrag,
Eigenverbrauch, Autarkie, vollständige Provenienz und Hashes sowie Warnungen.

Persistenz nutzt sechs Nachkommastellen. Slotdaten werden spaltenorientiert
gespeichert. Validatoren trennen zwingend:

- **vor Persistenz:** die unten gepinnten Modell-/Bilanz-Toleranzen;
- **ein persistierter Skalar:** höchstens `0.5·10^-6 kWh` zum ungerundeten
  Wert;
- **Slotbilanz aus bis zu acht unabhängig gerundeten Termen:** höchstens
  `4·10^-6 kWh` Residuum;
- **erneute Summe von N gerundeten Slots:** höchstens
  `N·0.5·10^-6 kWh` zum ungerundeten Aggregat, bei N=35.040 also
  `0.01752 kWh`;
- **separat persistiertes Monats-/Jahresaggregat:** wird direkt aus der
  ungerundeten Neumaier-Summe auf sechs Stellen quantisiert und darf höchstens
  `0.5·10^-6 kWh` abweichen.

Das AC-`E_y`-Gate läuft vor Persistenz mit `0.01 kWh/kWp`; auf dem separat
persistierten Jahresaggregat mit `0.0100005 kWh/kWp`. Eine aus gerundeten
Slots neu gebildete Kontrollsumme nutzt zusätzlich den N-Term-Fehler.

```text
close(a,e,atol,rtol) =
  abs(a-e) <= max(atol,rtol·max(abs(a),abs(e)))
```

| Gate | `atol` | `rtol` |
|---|---:|---:|
| `G_T=B_T+D_T+R_T` | `1e-7 W/m²` | `1e-9` |
| Stunde→4 Slots | `1e-9 Wh/m²` bzw. `Wh/kWp` | `1e-9` |
| Muneer-Punkt gegen PVGIS | `1 W/m²` | `0.005` |
| Muneer-Monat | `0.05 kWh/m²` | `0.005` |
| Muneer-Jahr | `0.10 kWh/m²` | `0.0025` |
| SPA gegen `H_sun` | `0.25°` | `0` |
| skaliertes AC-Jahr gegen `E_y` | `0.01 kWh/kWp` | `1e-9` |
| Slot-Energiebilanz vor Persistenz | `1e-9 kWh` | `1e-9` |
| zyklischer SOC | `1e-8 kWh` | `1e-10` |

Toleranzen sind Projekt-`ESTIMATE`s, keine Reonic-/JRC-Behauptung.

## Ressourcen- und Sicherheitsgrenzen

v2 pinnt `[ESTIMATE]`:

- Dächer `1..4`; Providerjahr 8.784, normalisiert 8.760, Resultat 35.040;
- Horizont roh 49 Zeilen mit geprüftem Ringschluss, kanonisch 48 endliche
  Werte in `[-90°,90°]`;
- Abrufe höchstens `2+2·roofCount`, maximal 10; je Abruf zwei Versuche;
- `seriescalc` 2 MiB dekomprimiert, `PVcalc` 256 KiB, `printhorizon` 64 KiB,
  Provider-Rohmaterial insgesamt 12 MiB;
- kanonischer Request 16 MiB, Resultat 32 MiB;
- Solar-Sidecar: ein Batch, kein Netzwerk, höchstens 35.136 Zeitpunkte und
  `4×35.136` Flächenwerte, 512 MiB RAM, 30 s CPU, 60 s Wallclock;
- Einstrahlung `0..5.000 W/m²`, Temperatur `-100..100°C`, Wind
  `0..100 m/s`, `P` `0..10.000 W/kWp`; alle Werte endlich.

Oversize, zusätzliche Redirects, falscher Content-Type oder unzulässiger Host
führen zu `provider_invalid_response` beziehungsweise
`contract_size_exceeded`; nie truncaten.

## Abnahmegates

- Exakt 35.040 Slots; je Monat `Tage×96`.
- Originale SARAH-Minute bleibt in Snapshot, Hash und Replay.
- Schaltjahr/DST ohne Kollision oder doppelte Slot-ID.
- Stunde→Viertelstunde je Komponente energieerhaltend.
- Pflichtbranches: `β=0` bei niedriger Sonne, overcast mit Direktstrahlung,
  Rückseite/Horizont mit Diffus-/Reflexionsanteil sowie `α=0.1`, `k_t'=0.3`,
  `cosξ=0`.
- Öffentliche Muneer-Fixtures: mindestens drei Klimata/Breitengrade,
  Neigungen 0/30/60/90°, Nord/Ost/Süd/West, hohe/niedrige Sonne; URL,
  Abrufdatum, Query und SHA; CI ohne Netz.
- `Int=1`, Oversize, Redirect, Host/Content-Type, alter Snapshot und
  Offline-Replay regressionsgeprüft.
- Speicher-Fixtures: `D<0`, `D=0`, `D>0`, Fixpunkt, Verluste, volle/leere
  Grenzen und unbeschränkter Export.
- Slot-/Monats-/Jahresbilanzen vor und nach Persistenz.
- Fresh-/Upgrade-DB, Tuple-Checks, Reservation-/Finalize-Races, Worker-Retry,
  RLS/Rollenvertrag, Build und Browser ohne Console-/Hydration-/A11y-Fehler.

Eine native punktweise 15-Minuten-Validierung gegen PVGIS ist unmöglich, da
die Referenz stündlich ist. Nachweisbar sind Stundenenergie, Muneer-Formeln,
öffentliche Stunden-/Monats-/Jahresaggregate und der deterministische eigene
Viertelstundenvertrag.

## Additiver Implementierungsplan

Bestehende v1-Dateien werden nicht umgedeutet. v2 erhält getrennte Module für
Versionen, Vertrag, Preparation, Providerparser, Engine, Resultvalidierung,
Runtime/Worker und Katalogauflösung sowie v2-Artefakte/Fixtures. Migration
`0076+` ergänzt Spalten/Funktionen additiv und ersetzt betroffene
Reservation-/Finalize-Funktionen atomar. Erst nach grünen Vertrags-,
Provider-, Engine-, DB-, Replay-, Rollen- und Browsergates darf der v2-Status
`f4_public_reference_validated` aktiviert werden.
