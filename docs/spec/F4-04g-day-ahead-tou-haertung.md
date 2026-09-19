# F4-04g Day-ahead-Tarif und TOU-Härtung (Katalog F4.4)

Stand: SPECIFIED (nicht implementiert) · Branch: `codex/muse-fleet-3b-f4spec` ·
Stand 2026-09-19. Folgeslice zu F4-04b (dort Offene Fragen 2–4,
F4-04b-tou-arbitrage.md:62-67) und F4-04d/F4-04e/F4-04f. Schließt den
G3-Befund (TOU-Bill ohne Fixkosten, §2). Dieser Slice ändert keinen
Produktionscode — nur diese Spec plus RED-Test
`tests/unit/f404g-day-ahead.red.test.ts` (6 Tests, alle ROT belegt, §5).

## 1. Day-ahead-Preisvektor (8760 via CSV)

- Eingabe: `consumption.touDayAheadPricesCtPerKwh` (Name spec'd),
  optional, exakt 8760 endliche Zahlen (Ct/kWh, je 0–200),
  Stundenpreise Ortszeit auf der Mitternachtsachse (Achse ab 1. Januar
  00:00 — wie F4-04b §1 und tou-dispatch-v2.ts:231).
- Erfassung: CSV-Import (F4-02c-Vorbild: dort Builder für 8760/35040
  Lastgangwerte; hier nur 8760 Stundenwerte, Granularität
  `hourly_8760`). Ungültig (Anzahl ≠ 8760, nicht numerisch, Bereich
  verletzt) → Formfehler, kein Speichern (fail-closed). Leer →
  unknown, kein Day-ahead, keine Fehler.
- Auflösung: nur belegtes Profilfeld → eigener Request-Schlüssel
  (sonst fehlt der Schlüssel, Althashes stabil — TOU-Vorbild F4-04b
  §1). Gleichzeitig belegtes 24-h-Profil UND 8760-Vektor →
  Formfehler, kein Speichern (fail-closed, keine stille Priorität).
- Abbildung (spec'd): Slot `i` → Jahresstunde `floor(i / 4)` (35040
  Slots → 8760 Stunden) statt Tagesprofil an `(i % 96) / 4`
  (tou-dispatch-v2.ts:185, economics-v2.ts:373). Bill, Dispatch und
  Tagespolitik nutzen die Jahresstunde.
- Kein Live-Spot ohne Provider-Gate: keine Börsenanbindung, kein
  Fetch, kein neuer Provider — nur der statische CSV-Vektor. Das
  F4.1-Provider-Gate bleibt zu, bis ein Day-ahead-Provider spezifiziert
  ist (Offene Frage 6).
- Statisches 24-h-Profil als V1 eingefroren: `resolveTouImportPrices`,
  `computeTouBillEuro` (economics-v2.ts:360-383), `touDayPolicy` und
  `dispatchQuarterHoursTou` behalten ihre 24-Semantik, bis der
  Day-ahead-Slice umgesetzt ist. RED-Pins (§5, Tests 1–2): 8760-Vektor
  löst heute `null` auf, die Bill wirft
  „TOU-Profil hat nicht 24 Stundenpreise".

## 2. G3-Fix: TOU-Bill mit Fixkosten (SPECIFIED, nicht implementieren)

- Befund (G3): `computeTouBillEuro` rechnet nur Arbeitspreis
  (economics-v2.ts:360-383); `run-v2.ts:597` zieht die TOU-Bill von
  `currentEuro` ab, das seit F4-04d/F4-04e Grundpreis plus
  Leistungspreis enthält (economics-v2.ts:580). `savingsVsFlatEuro`
  enthält dadurch einen Phantom-Bonus in Fixkostenhöhe (RED: 120 €
  bei 120 € Grundpreis — §5, Tests 3, 4, 6).
- Spec'd Formel: `touBillEuro = roundMoney(Σ Slot-Netzbezug ×
  Stundenpreis / 100 + touBaseFeeEuro + touPeakKw ×
  touDemandChargeEuroPerKw)` (Cent-genau, gleiche Rundungssemantik
  wie F4.4a-Bills).
- `touPeakKw`: eigene TOU-Dispatch-Spitze = max(TOU-Netzbezugs-Slot)
  × 4 (kW, 2 dp — F4-04e-Vorbild; die TOU-Spitzenlogik ist dort
  bewusst offen: F4-04e „Bewusst offen").
- Eingabe (spec'd, optional, nur bei belegtem Profilfeld — sonst
  fehlt der Schlüssel, Althashes stabil — TOU-Vorbild): TOU-Grundpreis
  (€/Jahr, 0..100.000 wie F4-04d) und TOU-Leistungspreis (€/kW,
  0..10.000 wie F4-04e). Ob eigene Felder oder Wiederverwendung der
  F4-04d/e-Felder, ist REVIEW-offen (Offene Frage 4).
- Fail-closed-Regeln wie F4-04e: belegter Satz ohne Spitze wirft
  (kein stilles Nullen der Umlage); Bereichsverletzung wirft;
  Ersparnis/Cashflow/IRR/Amortisation bleiben per Konstruktion
  unberührt (Grundpreis-Vorbild F4-04d).
- Bis zur Umsetzung: UI-Hinweis im TOU-Block („TOU-Rechnung ohne
  Grund-/Leistungspreis — Vergleich näherungsweise") UND
  `savingsVsFlatEuro` gegen die arbeitspreisbereinigte Rechnung
  (`currentEuro − baseFeeEuro − demandEuro − touBillEuro`), damit
  kein Phantom-Bonus gezeigt wird.

## 3. Zyklenkosten-Parameter (SPECIFIED)

- `degradationCostCtPerKwhThroughput`: optional, Ct/kWh
  Lade-Durchsatz, ≥ 0, Default 0 = Status quo (Althashes stabil).
  Schließt F4-04b-Frage 2 („Zyklenkosten/Degradation im
  Arbitrage-Kalkül (derzeit 0)").
- Margenformel (tou-dispatch-v2.ts:95-99; Konstanten :31 Flach-Tag
  1 Ct, :36 Marge 0,5 Ct): Netzladung erlaubt ⇔ nicht flach UND
  nutzbarer Speicher UND `median × etaCharge × etaDischarge − p25 ≥
  ARBITRAGE_MARGIN_CT + degradationCostCtPerKwhThroughput`.
- Semantik [ESTIMATE, REVIEW-offen]: linearer Durchsatz-Kostenansatz
  pro kWh Netzladung als Hürdenaufschlag (keine Zyklenzählung —
  Offene Frage 2). F4-04b §2 („keine Batteriedegradationskosten
  pro Zyklus") bleibt bis zur Umsetzung gültig.
- RED-Pin (§5, Test 5): Marge 0,6 (Median 40, P25 35,5, η 0,9025)
  ist heute erlaubt; mit Param = 1 wäre 0,6 < 0,5 + 1 verboten.

## 4. TOU-Heuristik als ESTIMATE; HT/NT

- Median/P25-Heuristik (`touDayPolicy`), Flach-Tag-Schwelle 1 Ct,
  Arbitrage-Marge 0,5 Ct, Mitternachtsachse: dokumentierte ESTIMATE
  bis Reonic-Beleg (F4-04b-Frage 1 bleibt offen — keine behauptete
  Reonic-Parität, REVIEW-pflichtig wie F4-04b).
- HT/NT-Umschaltzeiten je Netzbetreiber: frei eingebbar über das
  24-h-Profil (bzw. künftig den 8760-Vektor); keine
  Netzbetreiber-Tabelle (F4-04b-Frage 4 bleibt offen).

## 5. RED-Beleg (Auszug, ungeskippt)

Befehl: `npx tsx scripts/run-tests.mts tests/unit/f404g-day-ahead.red.test.ts`
(6 Tests, NUR existierende Imports, keine neuen Symbole):

```text
FAIL > Day-ahead: 8760-Preisvektor wird aufgeloest (CSV-Import)
AssertionError: expected null not to be null
FAIL > Day-ahead: TOU-Bill honoriert 8760-Preisvektor tagesspezifisch
Error: f4.1 engine rejected input: Wirtschaftlichkeit v2 verletzt: TOU-Profil hat nicht 24 Stundenpreise
FAIL > G3: TOU-Bill enthaelt Grundpreis bei belegtem Grundpreis
AssertionError: expected 34.56 to be 154.56
FAIL > G3: TOU-Bill enthaelt TOU-Dispatch-Spitze × Satz
AssertionError: expected 34.56 to be 884.56
FAIL > Zyklenkosten-Param senkt Netzladung (Marge 0,6 < 0,5 + 1)
AssertionError: expected true to be false
FAIL > savingsVsFlat ohne Fixkosten-Artefakt (gleiche Preise → 0)
AssertionError: expected 120 to be +0
Test Files  1 failed (1) / Tests  6 failed (6)
```

Danach `describe.skip` mit Grund („SPECIFIED, nicht implementiert —
G3-Fix + Day-ahead-Slice offen, 24-h-Profil als V1 eingefroren") und
Ref (diese Spec, F4-04b Fragen 2–4, run-v2.ts:597,
economics-v2.ts:360-383); erneut grün verifiziert (6 skipped).
Entskippen erst mit der Umsetzung (§1–§3).

## Offene Fragen (REVIEW)

1. Reonic-Beleg für Median/P25-Heuristik und Schwellen (aus F4-04b/1).
2. Degradationskosten-Modell: linearer Durchsatz vs. Zyklenzählung
   (aus F4-04b/2).
3. Day-ahead-CSV-Format (Header? Zeitzone? Schaltjahr?) und
   gleichzeitige Belegung 24/8760 (hier: fail-closed).
4. TOU-Grundpreis/Leistungspreis: eigene Felder oder
   F4-04d/e-Felder wiederverwenden?
5. HT/NT-Umschaltzeiten je Netzbetreiber (aus F4-04b/4).
6. Provider-Gate-Kriterien für Live-Spot (bis dahin: nur CSV).

Keine Migration, keine neue Permission, kein Provider.
