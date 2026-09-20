# F4-05d Zubau-Delta (Delta-Cashflow/Amortisation/IRR)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-3e-f4spec` · Stand 2026-09-20

## Ziel und Abgrenzung

Folgeslice zu F4-05c §3 (Stub — hier erweitert, nicht gedoppelt): löst
F4-05b Q1 (Mehrjahres-Bestands-Cashflow) und Q2 (Einspeiserlös-Delta
Bestand/Planung) ein. Drei Geld-Sichten werden getrennt:

1. **Bestand** (Jahr-1-Rechnungsvergleich, F4-05b §1),
2. **Gesamtanlage** (Economics-Block im Bestand-Fall, `assembleResultV2`
   über `planned.annual`),
3. **Zubau-Delta** (NEU: inkrementeller Cashflow nur aus Delta-Flüssen).

Keine behauptete Reonic-Parität; Näherungen als ESTIMATE,
REVIEW-pflichtig. Keine Migration (nur Spec + Contract + RED-Test).

## 1. Delta-Rechnung (Zubau-Cashflow/Amortisation/IRR)

- Inkrementelle `savingsDelta(year)` aus Delta-Eigenverbrauch
  (`additionalSelfConsumptionKwh`, Bestand minus Planung mit Vorzeichen
  geplant−Bestand) plus Einspeise-Delta (`plannedFeedInKwh −
  baselineFeedInKwh`, bei Zubau-Speicher meist negativ):
  `savingsDelta(y) = selfDelta·quote(y)·price(y) + feedInDelta·quote(y)·feedInEuro`
  — gleiche Degradations-/Eskalations-/Rundungs-Semantik wie
  `computeEconomics` (Horizont, Amortisation = erstes Jahr mit
  kumuliertem Cashflow ≥ 0, IRR-Bisektion).
- Startwert: `−investmentDeltaEuro` (nur Zubau-Investition, nicht
  Gesamtanlage). `amortizationYearsDelta: null` wenn nie im Horizont;
  `irrDelta: null` ohne Vorzeichenwechsel (Investition 0 analog).
- Break-even-Satz aus F4-05c §4 gilt je Scope: „Break-even" nur als
  Synonym für das Amortisationsjahr desselben Scopes.

## 2. scopeNote-Pflicht (aus F4-05c §3)

- Jede Delta-Zahl trägt sichtbar `Zubau-Delta (nicht Gesamtanlage)`;
  jede Gesamtanlagen-Zahl im Bestand-Fall weiter `Gesamtanlage (nicht
  Zubau-Delta)` (F4-05c Sofort-Kennzeichnung, bleibt Pflicht).
- Maschinenlesbar: `basis: "zubau_delta"` (Enum-Wert existiert in
  `economics-guard.v1`); UI/PDF zeigen die Wortlaute aus §5.
- Fail-closed darstellend: Delta-Zahl ohne scopeNote wird nicht
  gerendert (kein Geld ohne Scope).

## 3. Einspeiserlös-Delta (löst F4-05b Q2 ein)

- `feedInRevenueDeltaEuro = feedInDeltaKwh × feedInTariffCtPerKwh`
  (Jahr 1, Cent-Rundung); fließt in `annualSavingsDeltaEuro` ein
  (Bezugskosten-Delta + Einspeiserlös-Delta).
- Vergütungssatz aus derselben Kaskade wie `resolveEconomics`
  (Override > Post-EEG > Länderdefault); F4-05c-Gates (EEG-Rand,
  DE-only, Hinweiszeile) gelten unverändert auch für das Delta.

## 4. Doppelzählungs-Guards

- **G1 Bestandserzeugung nicht neu vergüten:** Nur Delta-Flüsse
  (`additionalSelfConsumptionKwh`, `feedInDeltaKwh`) fließen in die
  Delta-Ersparnis ein — nie `planned.annual`-Absolutwerte.
- **G2 Kein doppelter Bezugskosten-Abzug:** `bills.savingsEuro`
  (Jahr-1-Rechnungsvergleich) und Delta-Cashflow teilen die Formel,
  werden aber nie addiert; UI zeigt beide als getrennte Zeilen.
- **G3 Kein Delta ohne Bestand:** Neuanlage-Branch (kein
  Bestands-Kontext) trägt keinen Delta-Block; die Delta-Auflösung
  liefert null (gleiche null-Semantik wie unbelegter Preis).
- Contract-Pin: `doubleCountingGuard: true` (const) im Ergebnis.

## 5. UI/PDF-Kennzeichnung

- Economics-Block im Bestand-Fall: getrennte Abschnitte „Gesamtanlage"
  und „Zubau-Delta", je mit scopeNote-Zeile; F4-05c-Hinweiszeile
  (Haftung) bleibt am Block.
- Angebots-PDF: Sobald Delta-Werte ins Angebot fließen, wandern
  scopeNote + Haftungshinweis wortgleich mit (Anforderung an den
  PDF-Slice, kein Umbau hier).

## 6. Contract

`contracts/extension-delta.v1.schema.json` (Kopf wie `ev-profile.v1`):
`request` (Bestand-/Planungs-Jahreswerte, Tarife, Zubau-Investition,
Horizont) + `result` (scopeNote/`basis`-Pflicht, `bills`,
Einspeiserlös-Delta, Delta-Cashflow/Amortisation/IRR,
`doubleCountingGuard`). Beispiel:
`contracts/examples/extension-delta.v1.json` (Zubau-Speicher:
Jahr-1-Delta 411,52 €, Amortisation Jahr 11, IRR ≈ 7,2 %).

## ROT-Beleg (RED-Test, NUR existierende Imports)

`tests/unit/f405d-zubau-delta.red.test.ts`, 5 Tests, Stand 2026-09-20
alle ROT (`npx tsx scripts/run-tests.mts
tests/unit/f405d-zubau-delta.red.test.ts`, Exit 1):

```text
× Zubau-Delta-Rechnung trägt Zubau-scopeNote (nicht Gesamtanlage)
  AssertionError: expected { annualSavingsEuro: 540, …(4) } to have property
  "scopeNote" with value 'Zubau-Delta (nicht Gesamtanlage)'
× Bestands-Geldvergleich trägt scopeNote-Pflicht (Gesamtanlage, F4-05c §3)
  AssertionError: expected { baselineEuro: 1440, …(2) } to have property
  "scopeNote" with value 'Gesamtanlage (nicht Zubau-Delta)'
× Einspeiserlös-Delta wird ausgewiesen (F4-05b Q2)
  AssertionError: expected { baselineEuro: 1440, …(2) } to have property
  "feedInRevenueDeltaEuro"
× Doppelzählungs-Guard: computeExtensionDelta ist exportiert
  AssertionError: expected false to be true // Object.is equality
× Fallback ohne Bestand: resolveExtensionDelta ist exportiert
  AssertionError: expected false to be true // Object.is equality
Test Files  1 failed (1) · Tests  5 failed (5)
```

Danach `describe.skip` mit Grund + Ref (nicht implementiert, F4-05d),
Suite erneut grün.

## Akzeptanz (Umsetzungs-Slice)

- Unit: Delta-Rechnung (Formel/Serie/Amort/IRR), scopeNote-Pflicht
  beider Scopes, Einspeiserlös-Delta, G1–G3 (u. a. Fallback null ohne
  Bestand), Contract-Pin.
- UI: getrennte Abschnitte + scopeNotes sichtbar (E2E-Pins wie
  F4.2/F4.3), Axe.
- PDF-Slice: scopeNote + Haftungshinweis wortgleich im Angebot.
- Gates: lint/typecheck/test/build + CI grün.

## Provenienz (Datei:Zeile-Belege)

- F4-05c §3-Stub (Sofort-Kennzeichnung + Folgeslice-Auftrag):
  `docs/spec/F4-05c-haftung-eeg-rand-delta.md:63-72`.
- F4-05b Q1/Q2 (offen, hier eingelöst): `docs/spec/F4-05b-bestand-sankey.md:32-33`.
- Bestands-Assembly teilt Geld mit Gesamtanlage:
  `lib/integrations/calculation/run-v2.ts:479-520`,
  Geld aus `planned.annual`: `run-v2.ts:540-556`.
- `bills`-Assembly nur bei belegtem `request.economics`:
  `run-v2.ts:505-513`.
- Delta-Eigenverbrauch: `run-v2.ts:473-475`.
- Amort/IRR-Semantik (Horizont, quote/price/savings, Bisektion):
  `lib/integrations/calculation/economics-v2.ts:506-546`.
- `computeExistingBillDelta` (Jahr-1-Vergleich ohne ScopeNote/Einspeis-Delta):
  `economics-v2.ts:399-423`.
- `basis`-Enum mit `zubau_delta`: `contracts/economics-guard.v1.schema.json:27-33`.
- Contract-Kopf-Vorbild: `contracts/ev-profile.v1.schema.json:1-10`.

## OFFENE-PUNKTE

- Exakte EEG-Sätze/Clearingstelle, echte Marktwert-Fixierung (aus
  F4-05c übernommen, gilt auch für das Einspeise-Delta).
- F4-05b Q3 (Sankey-Farb-/Layout-Abgleich, Reonic-Beleg fehlt) —
  unberührt von diesem Slice.
- Ob `investmentDeltaEuro` je aus Profil/Workspace auflösbar ist
  (kein Beleg im Profil-Schema gefunden) oder reine Eingabe bleibt.
- Neuanlage-Bestand-Mischfälle (PV-Zubau auf Bestand-PV: geteilte
  Vergütungssätze je Teilanlage) — außerhalb Zubau-Speicher-Scope.
