# ADR 0025: Rechenkern als deterministisches 15-Minuten-Jahr

- Status: angenommen
- Datum: 2026-09-19
- Bezug: F4-Simulationskern v2 auf m1-wave-02-Basis; MISSION-Plan-Abnahme
  (deterministisches 15-Minuten-Jahr Last → Batterie → Einspeisung)

## Kontext

Der F4-Simulationskern v2 berechnet das Planungsjahr als Kette
Last → Batterie → Einspeisung in Viertelstundenauflösung. Die
MISSION-Plan-Abnahme verlangt ein deterministisches Simulationsjahr:
gleiche Eingaben erzeugen bitidentische Ergebnisse, jede Abweichung wird
fail-closed abgebrochen statt stillschweigend geglättet.

Die kritische Matrix für die Abnahme umfasst: Energieerhaltung je
Zeitschritt, Zeitzone/DST, Missing Data, Schaltjahr, Decimal/Rundung,
Null-/Extremwerte, Referenzfixtures und Haftungskennzeichnung. Alle
Belegstellen unten wurden im Code dieser Branch verifiziert.

## Entscheidung

1. Deterministisches 35.040-Slot-Jahr. Die Achse ist ordinal und fix:
   `QUARTER_HOUR_SLOTS = 35_040`
   (`lib/integrations/calculation/engine-v2.ts:11`). Request und Resultat
   sind über `planning-jcs.v1` kanonisch gehasht
   (`lib/integrations/calculation/contract.ts:14`,
   `contract-v2.ts:166`, `contract-v2.ts:270`). Die Finalize-Grenze
   prüft per Re-Run modellexakt: `exactDifferencePaths` vergleicht tief
   mit `Object.is`-Identität
   (`lib/integrations/calculation/validate-result-v2.ts:40-84`,
   Vergleich an `:46`, Re-Run an `:106-124`). Genau ein erlaubtes
   Versions-Tupel ist in
   `lib/integrations/calculation/versions-v2.ts` gepinnt (Contract,
   Achse, Rekonstruktion, Dispatch, Provider-Rezept
   `pvgis-5.3-sarah3-2020-quarter-hour.v2`, Modell, Source-Revision,
   Schema-SHA).

2. Energieerhaltung fail-closed auf drei Ebenen. Slot: absolute Toleranz
   1e-9 kWh (`engine-v2.ts:16`, Prüfung `:236-239`). Jahr: 0,01 kWh nach
   Rundung (`lib/integrations/calculation/run-v2.ts:69`, Prüfung
   `:278-285`). Zyklischer SoC: 1e-8 kWh
   (`run-v2.ts:67`, Prüfung `:242-244`). Zusätzlich darf die Entladung
   die wirkungsgradbereinigte Ladung nicht übersteigen
   (`run-v2.ts:248-253`). Jede Verletzung wirft, statt zu korrigieren.

3. Zeitzone Europe/Berlin als Standardzeit ohne DST-Sprung. Fester
   UTC+01-Versatz (`lib/integrations/calculation/axis-v2.ts:7`,
   `:29`, Anwendung `:123`); Slot-Labels tragen konstant `+01:00`
   (`axis-v2.ts:159`). Version
   `utc_to_berlin_standard_time_circular_then_drop_feb29.v2`
   (`versions-v2.ts:29-30`, `axis-v2.ts:24`). Die DST-Regel ist bewusst
   Spec-ESTIMATE (`axis-v2.ts:11`); die kollisionsbehaftete v1-Abbildung
   wird nicht wiederverwendet (`axis-v2.ts:12`).

4. Schaltjahr: PVGIS-2020 liefert 8.784 Stunden, exakt 24
   29.-Februar-Stunden werden entfernt, Rest 8.760 Stunden =
   35.040 Slots. Der Parser verlangt exakt 8.784 Zeilen
   (`lib/integrations/calculation/provider-v2.ts:366-367`), die
   Komposition verlangt exakt 8.784 je Dach und je Horizontalreihe
   (`lib/integrations/calculation/fetch-compose-v2.ts:565-566`,
   `:728-729`). Die Achse entfernt genau die 24 Berliner
   29.-Februar-Stunden und bricht bei jeder anderen Zahl fail-closed ab
   (`axis-v2.ts:120-139`); die normalisierte Dachreihe muss danach exakt
   8.760 Stunden haben (`fetch-compose-v2.ts:596-598`).

5. Rundung nur an der Run/Result-Grenze. Der Kern rechnet ohne Rundung
   (Neumaier-Summen, `engine-v2.ts:5-6`). Energie wird erst am
   Ausgang auf 6 Dezimalstellen gerundet
   (`run-v2.ts:92-96`, `-0`-Normalisierung), Geld auf Cent
   (`lib/integrations/calculation/economics-v2.ts:61-66`), Jahresspitzen
   auf 2 Dezimalstellen (`run-v2.ts:102-106`). Die Rundungsversion
   `wmee-energy-rounding.v1` ist im Resultat gepinnt
   (`run-v2.ts:629`, `contract-v2.ts:280`).

6. Haftung: maschinenlesbare Kennzeichnung statt Freitext. Bei
   Provider-Schätzung trägt das Resultat die Warnung
   `provider_estimate` mit Severity `info`
   (`run-v2.ts:529-532`, Contract `:259` in `contract-v2.ts`). Die UI
   rendert daraus eine Box „Planungshinweise" mit festem Text
   (`app/w/[workspaceId]/anfragen/[projectId]/energy-calculation-section.tsx:295-328`).
   ESTIMATE-Marker kennzeichnen zusätzlich EEG-Default/Post-EEG
   (`energy-calculation-section.tsx:538-539`) und die
   Wirtschaftlichkeit als belegte Näherung (`:837`). Ein
   Freitext-Disclaimer existiert bewusst nicht (Lücke → F4-05c).

7. Missing-Data-Regel: strikt fail-closed, keine Interpolation. Transport:
   Timeouts/5xx/Netzfehler sind retryable, 429 trägt Retry-After, 4xx
   ist deterministisch ohne Retry
   (`lib/integrations/calculation/fetch-v2.ts:69-84`). Inhalt: exakt
   8.784 Stunden in strikt aufsteigender Achse
   (`provider-v2.ts:366-374`); fehlende Stundenleistung, fehlende
   Stundenindizes oder fehlende horizontale Stunden brechen die
   Komposition ab (`fetch-compose-v2.ts:580`, `:590-592`, `:630-634`).
   Der Horizont verlangt exakt 49 Zeilen mit gleichem Ringschluss
   (`lib/integrations/calculation/horizon-v2.ts:78-97`). Fehlende
   PVGIS-Stunden werden niemals mit Nullen, Defaults oder Interpolation
   aufgefüllt.

8. Null-/Extremwert-Guards an der Serienschranke. `assertSlotSeriesV2`
   verlangt exakt 35.040 endliche, nichtnegative kWh/Slot und wird von
   Persist- und Finalize-Schicht geteilt
   (`run-v2.ts:119-141`). Die Engine prüft zusätzlich jede Slot-Eingabe
   auf Endlichkeit und Nichtnegativität
   (`engine-v2.ts:30-32`, `:214-216`) sowie den Start-SoC auf den
   Bereich `[socMinKwh, socMaxKwh]` (`engine-v2.ts:204-207`).
   Spitzen- und Horizontwerte sind analog beschränkt
   (`run-v2.ts:109-117`, `horizon-v2.ts:90`).

9. DECIDED Folgefixes (SPECIFIED, hier NICHT implementiert):
   a. Wandzeit-Leck EEG-Jahr: `economics-v2.ts:216-225` liest
      `new Date().getFullYear()` zur Laufzeit. Fix: Jahr aus
      `asOfDate`/`commissioningDate` ableiten.
   b. `asOfDate` ist Claim-Wandzeit: abgeleitet aus `startedAt` der
      Claim-Zeile (`modules/energy/calculation-service.ts:420`,
      `:474`; übernommen in `prepare-v2.ts:204`). Fix: eingefrorener
      Stichtag aus der eingefrorenen Preparation.
   c. PVGIS-Rohbytes in die Hash-Bindung aufnehmen: `rawSha256` wird
      heute nur je Abruf gebildet (`provider-v2.ts:380`,
      `horizon-v2.ts:99`), `inputSha256` deckt aber nur den Request ab
      (`prepare-v2.ts:127-129`, `contract-v2.ts:334`). Fix: Roh-Hashes
      in die Request-Provenienz und damit in die Bindung aufnehmen.

## Konsequenzen

- Gleiche Eingaben erzeugen bitidentische Resultate; Replay und
  Finalize prüfen das modellexakt statt nur schematisch.
- Unvollständige oder korrupte Providerdaten können kein still
  verfälschtes Jahr erzeugen: der Lauf bricht mit benanntem Fehler ab.
- Rundungs- und Zeitzonenregeln sind versioniert; jede Änderung verlangt
  einen neuen Review und neue Pins statt stiller Drift.
- Die drei SPECIFIED-Folgefixes (9a–9c) sind vor der Abnahme
  nachzuziehen; bis dahin sind EEG-Jahr, Stichtag und Rohbyte-Bindung
  als bekannte Lücken dokumentiert.
- Freitext-Haftungsausschlüsse bleiben bis F4-05c offen; bis dahin trägt
  nur die `provider_estimate`-Kette die Kennzeichnung.

## Offene Fragen

- O1: Quelle des eingefrorenen Stichtags (Fix 9b). Empfehlung: Stichtag
  aus der eingefrorenen Preparation (Profil-/Claim-Kontext) ableiten,
  nicht aus DB-`started_at`. Default bis zum Fix: heutiges
  `startedAt`-Verhalten beibehalten und als Wandzeit dokumentieren.
- O2: Granularität der Rohbyte-Bindung (Fix 9c). Empfehlung: je Abruf
  (`seriescalc` je Dach, Horizont, PVcalc) einen `rawSha256` in die
  Request-Provenienz aufnehmen und damit in `inputSha256` binden.
  Default bis zum Fix: vorhandene Einzel-Hashes unverändert lassen.
- O3: EEG-Jahr-Quelle (Fix 9a). Empfehlung: `asOfDate`-Jahr, bei
  belegtem Inbetriebnahmejahr dessen Jahr. Default bis zum Fix:
  Laufzeitjahr, mit der Lücke im Abnahmeprotokoll vermerkt.
- O4: Freitext-Disclaimer (F4-05c). Empfehlung: einen versionierten,
  zentral definierten Hinweistext einführen statt freier UI-Texte.
  Default bis dahin: nur `provider_estimate`-Box plus ESTIMATE-Marker.

## Verworfen

### Echte DST-Abbildung mit 23/25-Stunden-Tagen

Verworfen, weil sie die ordinale 35.040-Slot-Achse brechen und Slots
mehrdeutig machen würde. Feste Berliner Standardzeit hält jeden Slot
eindeutig und lückenlos.

### Best-effort-Auffüllung fehlender Stunden

Verworfen. Nullen, Defaults oder Interpolation würden ein scheinbar
vollständiges, tatsächlich erfundenes Jahr erzeugen. Fail-closed
erzwingt stattdessen einen sichtbaren, wiederholbaren Fehler.

### Rundung innerhalb des Kerns

Verworfen, weil frühe Rundung Energiebilanz-Drift über 35.040 Slots
akkumuliert. Der Kern bleibt rundungsfrei; gerundet wird nur einmal an
der Run/Result-Grenze.
