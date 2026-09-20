# F4-02f Italien Fasce F1/F2/F3 (TOU-Subslice)

Stand: SPECIFIED (kein Code). TOU-Subslice aus F4-02d §2:
Die italienischen Zeitbänder F1/F2/F3 werden je Tagart auf den
bestehenden 24h-TOU-Vektor (`touImportPricesCtPerKwh`, F4-04b §1,
`contract.ts:302`, `resolveTouImportPrices` in `economics-v2.ts:339`)
abgebildet. Keine eigene IT-Lastform, keine Migration, Default
DE-only (F4-02d §2) bleibt.

## 1. Provenienz (belegte Quelle)

- ARERA (vorm. AEEG), Delibera 181/06, „Tabella 1: fasce orarie
  con decorrenza 1 gennaio 2007":
  `https://www.arera.it/fileadmin/allegati/docs/06/181-06tab.pdf`
  (Abruf 2026-09-20, PDF-Text extrahiert).
- Wortlaut der Tabelle: F1 „Nei giorni dal lunedì al venerdì:
  dalle ore 8.00 alle ore 19.00"; F2 „Nei giorni dal lunedì al
  venerdì: dalle ore 7.00 alle ore 8.00 e dalle ore 19.00 alle
  ore 23.00", „Nei giorni di sabato: dalle ore 7.00 alle ore
  23.00"; F3 „Nei giorni dal lunedì al venerdì: dalle ore 23.00
  alle ore 7.00", „Nei giorni di domenica e festivi: Tutte le
  ore della giornata".
- Ableitung (zwingend, in der Spec markiert): Samstag 0–7 und
  23–24 Uhr sind F3 per Elimination — F1 gilt nur Mo–Fr, F2 am
  Samstag nur 7–23 Uhr, jede Stunde gehört zu genau einem Band.

## 2. Banddefinition

- F1 (ore di punta / peak): Mo–Fr 8:00–19:00 (ausser Feiertag).
- F2 (ore intermedie / mid-level): Mo–Fr 7:00–8:00 und
  19:00–23:00; Sa 7:00–23:00 (ausser Feiertag).
- F3 (ore fuori punta / off-peak): Mo–Fr 23:00–7:00; Sa 0:00–7:00
  und 23:00–24:00 (Ableitung per Elimination, s. §1); So und
  Feiertage alle 24 Stunden.
- Stunden-Semantik: „dalle ore H alle ore K" = Stunden-Slots mit
  Start h in [H, K), Ortszeit (F4-04b §1: Slot-Tage ab lokaler
  Mitternacht, täglich wiederholt).

## 3. Abbildung auf den 24h-TOU-Vektor

Eingabe: `italy-tou-bands.v1` (Contract: `bandPricesCtPerKwh`
{F1, F2, F3} je 0–200 Ct/kWh, `dayKind` in
`weekday | saturday | sunday_holiday`). Der Bau-Slice erweitert
`resolveTouImportPrices` um diesen Pfad und liefert exakt 24
endliche Preise:

- `weekday`: h0–6 F3, h7 F2, h8–18 F1, h19–22 F2, h23 F3.
- `saturday`: h0–6 F3, h7–22 F2, h23 F3.
- `sunday_holiday`: h0–23 F3.
- Vorrang (REVIEW): Ist der direkte 24h-Vektor
  `touImportPricesCtPerKwh` belegt, gewinnt er (direkter Beleg
  vor Ableitung); die Bänder greifen nur ohne belegten Vektor.

## 4. Feiertags-Regel

Feiertage (`festivi`) nach Fussnote der ARERA-Tabelle: 1. Januar,
6. Januar, Ostermontag, 25. April, 1. Mai, 2. Juni, 15. August,
1. November, 8. Dezember, 25. Dezember, 26. Dezember. An diesen
Tagen gilt `sunday_holiday` (alle Stunden F3), auch wenn sie auf
einen Werktag oder Samstag fallen. Der Schutzpatron-Tag (Santo
Patrono) steht NICHT in der ARERA-Tabelle → Offener Punkt 1.

## 5. Fail-closed-Regeln

- Unbekanntes Band (Schlüssel ausser F1/F2/F3), unbekannte
  `dayKind`, nicht-endliche oder ausserhalb 0–200 liegende
  Bandpreise → kein TOU-Block (`resolveTouImportPrices`
  liefert null), kein Raten, kein Default-Band.
- Fehlende `dayKind` ist ebenfalls fail-closed (Pflichtfeld).
- Die F4-04b-Regeln (exakt 24 Werte, Bereich 0–200, Althashes
  stabil ohne `tou`-Schlüssel) gelten unverändert.

## 6. Contract

`contracts/italy-tou-bands.v1.schema.json` (Kopf nach
`ev-profile.v1`-Muster) + Beispiel
`contracts/examples/italy-tou-bands.v1.json`.

## 7. RED-Beleg (2026-09-20, vor Implementierung)

`npx tsx scripts/run-tests.mts tests/unit/f402f-fasce.red.test.ts`
(ungeskipt): 4 failed | 1 passed (5). `resolveTouImportPrices`
kennt keinen `italyTouBands`-Pfad und liefert null:

```text
FAIL ... F4-02f Italien Fasce (Band-Zeiten) > bildet F1 auf
  Werktag 8-19 Uhr ab
AssertionError: Target cannot be null or undefined.

FAIL ... F4-02f Italien Fasce (Band-Zeiten) > bildet Samstag
  7-23 Uhr auf F2 ab
AssertionError: Target cannot be null or undefined.

FAIL ... F4-02f Italien Fasce (Band-Zeiten) > bildet Sonntag und
  Feiertag vollstaendig auf F3 ab
AssertionError: expected null to deeply equal [ 20, 20, 20, ... ]

FAIL ... F4-02f Italien Fasce (Band-Zeiten) > liefert exakt 24
  endliche Preise 0..200 (Vektor-Abbildung)
AssertionError: Target cannot be null or undefined.

Test Files  1 failed (1)
Tests  4 failed | 1 passed (5)
```

Der Guard (unbekanntes Band / unbekannte Tagart → null) ist
grün. Die Suites sind danach per `describe.skip` stillgelegt
(Grund + Ref im Testkopf).

## Akzeptanz (fuer den Bau-Slice)

- Unit: Band-Zeiten-Matrix (3 Tagarten × 24 Stunden),
  Feiertags-Vorrang, Vektorform (24, endlich, 0–200),
  Fail-closed-Matrix (Band/Tagart/Preis fehlerhaft).
- Contract: Schema validiert Beispiel, weist F4-Schlüssel und
  unbekannte `dayKind` ab.
- Gates: lint/typecheck/test/build gruen; keine Migration, keine
  Contract-Enum-Aenderung ausserhalb des Slices.

## OFFENE PUNKTE

1. Santo Patrono (städtischer Feiertag): nicht in der
   ARERA-Tabelle — stadtspezifisch ergänzen oder bewusst
   auslassen? (Bau-Entscheidung mit Beleg.)
2. Welche Tagart nutzt der Economics-Lauf? Der F4-04b-Vektor wird
   täglich wiederholt — ein Vektor kann nicht Werktag, Samstag
   und Sonntag zugleich sein (Vorschlag: `dayKind`-Pflichtfeld
   am Profil, V1 Werktag; REVIEW).
3. Vorrang direkter Vektor vs. Bänder (§3) per REVIEW bestätigen.
4. Sommer-/Winterzeit und Schaltjahr: F4-04b sagt Ortszeit ohne
   DST-Regel — gilt die Bandtabelle an Umstellungstagen roh?
5. Aktuelle Gültigkeit: Delibera 181/06 gilt seit 2007; keine
   neuere ARERA-Tabelle geprüft — vor dem Bau Bestätigung, dass
   keine Nachfolgeregelung die Zeiten geändert hat.
