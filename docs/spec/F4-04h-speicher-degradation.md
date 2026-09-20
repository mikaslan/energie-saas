# F4-04h Speicher-Degradation / SOH (Katalog F4.4)

Stand: SPECIFIED (nicht implementiert) · Branch:
`codex/muse-fleet-3e-f4spec` · Stand 2026-09-20. Folgeslice zu
F4-04g (dort §3 `degradationCostCtPerKwhThroughput` und Offene
Frage 2 „linearer Durchsatz vs. Zyklenzählung") und F4-04b
(Frage 2 „Zyklenkosten/Degradation im Arbitrage-Kalkül").
Dieser Slice ändert keinen Produktionscode — nur diese Spec,
der Contract `contracts/storage-degradation.v1.schema.json`
plus Beispiel, und der RED-Test
`tests/unit/f404h-degradation.red.test.ts` (5 Tests, alle ROT
belegt, §6).

## 1. Zyklenzählung (SPECIFIED)

- Definition: Vollzyklen-Äquivalente (FEC) = Σ
  Entlade-Durchsatz / nutzbare BOL-Kapazität, d. h.
  `storageFullCycles = totals.dischargeOutKwh /
  (socMaxKwh − socMinKwh)` (nutzbar 0 → 0). Das pinnt die
  bestehende Konvention aus run-v2.ts:300-302 und dem
  Contract-Cross-Check (contract.ts:1179) als
  Zyklenzähl-Definition fest — keine neue Zählweise.
- Zähler-Begründung: Entlade-Ausgang (`dischargeOutKwh`,
  nutzbare Arbeit), nicht Lade-Eingang: Der Lade-Eingang
  enthält die Ladeverluste und würde dieselbe Arbeit je nach
  Wirkungsgrad unterschiedlich zählen. Umrechnung in §4.
- Ausweis: `TouDispatchTotals` (tou-dispatch-v2.ts:130-139)
  erhält `storageFullCycles` nach derselben Formel
  (RED-Pin §6, Test 1). Flattarif-Seite unverändert.
- Keine Rainflow-/DoD-gewichtete Zählung in v1: Teilzyklen
  zählen linear über den Durchsatz (ESTIMATE-Vereinfachung,
  REVIEW-offen — Offene Frage 2).

## 2. Kapazitätsdrift / SOH-Modell (SPECIFIED-Formel, ESTIMATE-Parameter)

- Formel (spec'd): `SOH(t) = max(sohFloor, 1 −
  calendarFadePerYear × t − cycleFadePerFullCycle ×
  cumFEC(t))`, mit `t` = Horizontjahr ab 1, `cumFEC(t) = t ×
  fecYear1` (Vollzyklen des BOL-Jahres, linear hochgerechnet
  — ein Durchlauf, keine Iteration, ESTIMATE).
- Parameter (Contract `storage-degradation.v1`, alle
  ESTIMATE-markiert, REVIEW-pflichtig): `calendarFadePerYear`
  (0..0,2, Default 0), `cycleFadePerFullCycle` (0..0,05,
  Default 0), `sohFloor` (0..1, Default 0,7 = übliche
  EOL-Definition 70 % Restkapazität auf
  Herstellergarantie-Niveau). Null-Drift-Default (0/0) =
  Status quo, Althashes stabil (RED-Pin §6, Test 4).
- Analogie PV-Moduldrift (prepare.ts:77, Default 0,5 %/a,
  Anwendung engine.ts:209): bewusst KEINE exponentielle
  Übernahme — der zyklische Term ist additiv und kennt
  keinen Zinseszins auf Fade; lineare Überlagerung
  kalendarisch + zyklisch ist die Standard-Näherung für
  Garantiemodelle. Exponentielle Variante REVIEW-offen
  (Offene Frage 3).
- Engine-Anwendung (spec'd): pro Horizontjahr skalierte
  `StorageParams` — `capacityKwh × SOH(t)`,
  `socMaxKwh × SOH(t)`, `socMinKwh` unverändert (absolute
  Untergrenze), Leistungen und Wirkungsgrade unverändert
  (§3) — mit eigenem `cyclicSocStart` pro Jahr
  (engine-v2.ts:157-167, SoC/clamp-Dynamik unverändert).
  engine-v2.ts wird nur aufgerufen, nie geändert
  (tou-dispatch-v2.ts-Vorbild). Fail-closed: `socMax×SOH <
  socMin` wirft (kein stilles Nullen des Speichers).

## 3. Wirkungsgrad-Drift: Nein (SPECIFIED, begründet)

- `etaCharge`/`etaDischarge` bleiben horizonthomogen
  (kein eta-Drift-Term im Contract). Begründung: (a) kein
  Reonic-Beleg und kein Provider für eta-Alterung; (b) der
  LFP-Roundtrip bleibt über die Lebensdauer näherungsweise
  konstant, der Kapazitätsfade dominiert die
  Wirtschaftlichkeit; (c) ein eta-Drift würde zyklischen
  Fixpunkt, Marge und Dispatch pro Jahr verschieben — ohne
  belastbare Parametrierung reine Scheingenauigkeit.
- REVIEW-offen (Offene Frage 4): Reonic-Beleg könnte einen
  eta-Term nachrüsten; bis dahin Pin „etas konstant".

## 4. Arbitrage-Kalkül mit Degradationskosten (SPECIFIED)

- F4-04g §3 bleibt Fallback — kein Widerspruch:
  `degradationCostCtPerKwhThroughput` (optional, Ct/kWh
  Lade-Durchsatz, ≥ 0, Default 0) ist die manuell gesetzte
  Pauschale für Unkenntnis der Fade-Parameter; Default 0 =
  Status quo (RED-Pin §6, Test 3: ohne Param erlaubt).
- Einordnung: Der 04g-Param ist der Spezialfall des
  H-Modells — sobald H-Parameter belegt sind, tritt der
  abgeleitete Wert an seine Stelle in der Margenformel
  (tou-dispatch-v2.ts:95-99): `median × eta − p25 ≥
  ARBITRAGE_MARGIN_CT + degradationCt` (ESTIMATE-Hürde wie
  bisher, REVIEW-offen).
- Ableitung (spec'd Formel, ESTIMATE-Parameter): Wertverlust
  pro Vollzyklus = `replacementCostEuroPerKwh ×
  capacityKwh × cycleFadePerFullCycle`; pro kWh
  Lade-Durchsatz (04g-Einheit, Umrechnung §1 über
  Roundtrip und DoD-Anteil): `degradationCt =
  replacementCostEuroPerKwh × cycleFadePerFullCycle ×
  roundTrip / usableShare × 100`, mit `roundTrip =
  etaCharge × etaDischarge`, `usableShare = (socMax −
  socMin) / capacity`. Ohne belegte
  `replacementCostEuroPerKwh` keine Ableitung (nur Fallback).
- Doppelbelegung (`degradationCostCtPerKwhThroughput` ≠ 0
  UND H-Parameter belegt) → Formfehler, kein Speichern
  (fail-closed, keine stille Priorität — Analogie zur
  24/8760-Regel, F4-04g §1). RED-Pin §6, Test 5.

## 5. Pins und Versionierung

- Contract: `contracts/storage-degradation.v1.schema.json`
  (`$id .../storage-degradation.v1.schema.json`,
  `contractVersion` const, `additionalProperties: false`,
  ev-profile-Kopf) + Beispiel
  `contracts/examples/storage-degradation.v1.json`
  (illustrative ESTIMATE-Werte: 0,008 kalendarisch,
  0,00005/Vollzyklus, Boden 0,7, 600 €/kWh).
- Pins: `storageFullCycles`-Definition (§1);
  Null-Drift-Default = Status quo (Althashes stabil);
  engine-v2.ts eingefroren (nur aufgerufen);
  35040-Slot-Achse und Mitternachtsachse unverändert;
  etas horizonthomogen (§3).
- Versionierung: v1 additiv — neue Request-Schlüssel nur bei
  belegtem Profilfeld (sonst fehlt der Schlüssel,
  TOU-Vorbild F4-04b §1); 04g-Param-Semantik unangetastet.

## 6. RED-Beleg (Auszug, ungeskippt)

Befehl: `npx tsx scripts/run-tests.mts
tests/unit/f404h-degradation.red.test.ts` (5 Tests, NUR
existierende Imports — neue Symbole per Namespace-Cast,
f405c-Vorbild):

```text
FAIL > Zyklenzaehlung: TOU-Totals weisen Vollzyklen-Aequivalente aus
AssertionError: expected undefined to be close to 0.9499999999999993
FAIL > SOH-Modell: sohForYear existiert, monoton fallend, begrenzt
AssertionError: expected 'undefined' to be 'function'
FAIL > 04g-Kompatibilitaet: Degradationskosten-Param senkt Netzladung
AssertionError: expected true to be false
FAIL > Null-Drift-Default: SOH bleibt 1 ohne belegte Drift
AssertionError: expected 'undefined' to be 'function'
FAIL > Arbitrage-Kalkuel: abgeleitete Durchsatzkosten + Doppelbelegung fail-closed
AssertionError: expected 'undefined' to be 'function'
Test Files  1 failed (1) / Tests  5 failed (5)
```

Danach `describe.skip` mit Grund („SPECIFIED, nicht
implementiert — SOH-Modell + TOU-Zyklenausweis +
04g-Fallback-Vorrang offen") und Ref (diese Spec, F4-04g §3,
F4-04b Frage 2); erneut grün verifiziert (5 skipped).
Entskippen erst mit der Umsetzung (§1, §2, §4).

## Offene Fragen (REVIEW)

1. EOL-Boden: Ist 0,7 als Default belastbar (Herstellergarantien)?
2. Zyklenzählung: linearer Durchsatz vs. DoD-gewichtete /
   Rainflow-Zählung (aus F4-04g/2)?
3. SOH-Form: lineare Überlagerung vs. exponentieller Ansatz
   (PV-Vorbild engine.ts:209)?
4. Wirkungsgrad-Drift: Reonic-Beleg für eta-Alterung?
5. Iterative FEC-Kopplung (Fade senkt Durchsatz senkt Fade)
   statt linearem `cumFEC = t × fecYear1`?
6. SoC-/Temperaturabhängigkeit der kalendarischen Alterung
   (keine Temperaturdaten im Modell — out of scope)?
7. Herstellergarantie-Grenzen (MWh-Throughput-Caps) als
   zusätzliche Schranke?

Keine Migration, keine neue Permission, kein Provider.
