# F4-05c Haftung, EEG-Randsätze, Bestands-Delta-Geld

Status: **IMPLEMENTED** · Spec-Lane: `codex/muse-fleet-3b-f4spec` (2026-09-19) · Implementiert 2026-09-20 auf `codex/muse-fleet-8-f4kern` (EEG-Rand fail-closed, economics_estimate-Warning mit Contract-Pin, Haftungs-Hinweiszeile + Gesamtanlagen-Note, BREAK_EVEN_DEFINITION, f405c 5/5; entskippt; PDF-Hinweiszeile + Delta-Rechnung + Freigabe-Gate weiter offen/Folgeslices)

## Ziel und Abgrenzung

Drei Lücken nach F4.5/F4.5b (F4-05) und F4.5b-Geldvergleich (F4-05b):

1. Der Economics-Block trägt Geld, aber keine Haftungs-Hinweiszeile.
2. Die EEG-Tabelle deckt 2020–2026 (`EEG_FEED_IN_DEFAULT_CT`,
   economics-v2.ts:41-49); `eegDefaultForYear` (:142-149) liefert
   außerhalb still fortgeschriebene Randsätze (vor 2020 → erster Satz,
   nach 2026 → letzter Satz), die `resolveEconomics` als `eeg_default`
   mit Geld auflöst — still, ohne Warnhinweis.
3. Der Bestand-Branch teilt sich die Geld-Assembly mit der Neuanlage
   (run-v2.ts:479-520 → `assembleResultV2`, Geld aus `planned.annual`,
   :533-555): Bei belegtem `request.economics` trägt auch der
   Bestand-Result Amortisation/IRR/Cashflow — bezogen auf die
   **Gesamtanlage**, lesbar aber wie ein Zubau-Delta
   (Fehlverkaufs-Risiko). F4-05b:32-33 lässt Mehrjahres-Bestands-Cashflow
   und Einspeiserlös-Delta bewusst offen.

Keine behauptete Reonic-Parität; Näherungen als ESTIMATE,
REVIEW-pflichtig. Keine Migration (nur Spec + RED-Test in diesem Slice).

## 1. Haftungsgate: Hinweiszeile (Anzeige + PDF, kein Freigabe-Gate)

- Hinweiszeile am Economics-Block (`V2Economics`,
  energy-calculation-section.tsx:542ff), Vorbild der
  `provider_estimate`-UI-Text (:295-300):
  > „Unverbindliche Schätzung: Diese Wirtschaftlichkeit nutzt
  > ESTIMATE-Vergütungssätze (EEG-Tabelle/Post-EEG-Marktwert, kein
  > Clearingstellen-Beleg) und Planungsannahmen — keine Rechts- oder
  > Steuerberatung."
- Fail-closed darstellend: Die Hinweiszeile ist immer sichtbar, wenn der
  `economics`-Schlüssel vorhanden ist — kein Geld ohne Hinweis.
- Angebots-PDF: Sobald Economics-Werte ins Angebot fließen, wandert die
  Hinweiszeile wortgleich mit (`lib/integrations/offers/pdf-template.ts`
  trägt heute kein Geld; Anforderung an den PDF-Slice, kein Umbau hier).
- Echtes Freigabe-Gate (explizite Bestätigung vor bindenden Zahlen) erst
  mit F2-Angebotsbindung (Folgeslice, noch nicht spezifiziert) — hier nur
  Kennzeichnung, keine Klick-Schranke.

## 2. EEG-Randsätze: fail-closed + Scope-Gate DE-only

- Jahr außerhalb 2020–2026 ohne Override → fail-closed: kein Geld
  (`resolveEconomics` → null, gleiche Semantik wie unbelegter
  Preis/unbelegte Investition, F4-05 § Validierung) + sichtbarer
  UI-Hinweis statt stiller Sätze.
- Bis zur Umsetzung: sichtbarer Warnhinweis statt stiller Sätze — neuer
  Warning-Code (z. B. `economics_estimate`) im v2-Result, Vorbild
  `provider_estimate` (run-v2.ts:529-532, UI-Text
  energy-calculation-section.tsx:295-328). Ausdrücklich kein
  Warning-Enum-Wechsel ohne Contract-Pin (F4-05 § Berechnung).
- Post-EEG bleibt unberührt: Anlagenalter ≥ 20 Jahre → Marktwert
  (`post_eeg`, 3,5 Ct/kWh ESTIMATE).
- Scope-Gate DE-only explizit: Spec + UI gelten nur für DE
  (EEG-Tabelle = DE Überschusseinspeisung ≤10 kWp; v2-Kette bereits
  DE-gepinnt via `countryCode: z.literal("DE")`, contract-v2.ts:185).
  Andere Länder → Override-Pflicht: Ohne Override kein Geld +
  UI-Hinweis (greift, sobald das Länderliteral je aufgeweitet wird).

## 3. Bestands-Amortisation/IRR/Cashflow: Sofort-Kennzeichnung + Folgeslice

- SOFORT (Fehlverkaufs-Schutz): Kennzeichnung am Economics-Block im
  Bestand-Fall — jede Amortisations-/IRR-/Cashflow-Zahl trägt sichtbar:
  „bezogen auf Gesamtanlage, nicht auf Zubau-Delta".
- Folgeslice Delta-Rechnung (löst F4-05b:32-33 ein): inkrementelle
  `savings` aus Delta-Eigenverbrauch (`additionalSelfConsumptionKwh`,
  run-v2.ts:473-475) + Einspeis-Delta (Einspeiserlös-Delta
  Bestand/Planung) → eigener Delta-Cashflow mit eigener (zubau-bezogener)
  Amortisation/IRR. Erst dann darf eine Zubau-Amortisation stehen.

## 4. Break-even ≡ Amortisationsjahr (Spec-Satz, kein Code)

Spec-Satz: „Break-even ist das Amortisationsjahr (`amortizationYears`):
erstes Jahr mit kumuliertem Cashflow ≥ 0, null wenn nie im Horizont."
Kein eigenes Feld, kein eigener Export, keine eigene Berechnung —
UI-Texte dürfen „Break-even" nur als Synonym für das Amortisationsjahr
verwenden.

## ROT-Beleg (RED-Test, NUR existierende Imports)

`tests/unit/f405c-economics-guard.red.test.ts`, 5 Tests, Stand 2026-09-19
alle ROT (`npx vitest run tests/unit/f405c-economics-guard.red.test.ts`):

```text
× EEG-Randjahr 2030 ohne Override ist fail-closed (wirft statt stiller Randsätze)
  AssertionError: expected [Function] to throw an error
× resolveEconomics Jahr 2030 ohne Override liefert kein Geld
  AssertionError: expected { importPriceCtPerKwh: 36, …(8) } to be null
× ESTIMATE-Vergütung (eeg_default) trägt Economics-Warning
  AssertionError: expected { importPriceCtPerKwh: 36, …(8) } to have property
  "warnings" with value ArrayContaining ["economics_estimate"]
× Bestands-Geldvergleich trägt Gesamtanlagen-Kennzeichnung
  AssertionError: expected { baselineEuro: 1440, …(2) } to have property
  "scopeNote" with value 'Gesamtanlage (nicht Zubau-Delta)'
× Break-even-Definition ist exportiert (Break-even ≡ Amortisationsjahr)
  AssertionError: expected false to be true // Object.is equality
Test Files  1 failed (1) · Tests  5 failed (5)
```

Danach `describe.skip` mit Grund + Ref (nicht implementiert, F4-05c),
Suite erneut grün.

## Akzeptanz (Folge-Slices)

- Unit: Randjahre (2019/2030 ohne Override → null; mit Override →
  Geld), Warning-Code bei `eeg_default`/`post_eeg`, Gesamtanlagen-Note
  im Bestand-Result, Override-Pflicht Nicht-DE (sobald Länderliteral
  aufgeweitet).
- UI: Hinweiszeile + Gesamtanlagen-Kennzeichnung sichtbar (E2E-Pins wie
  F4.2/F4.3), Axe.
- PDF-Slice: Hinweiszeile wortgleich im Angebot, sobald Geld fließt.
- Gates: lint/typecheck/test/build + CI grün; kein Warning-Enum-Wechsel
  ohne Contract-Pin.

## Bewusst offen

- Exakte EEG-Sätze/Clearingstelle, echte EXAA/Marktwert-Fixierung
  (aus F4-05 übernommen).
- F2-Angebotsbindung: Freigabe-Gate (Folgeslice).
- Delta-Rechnung (Zubau-Cashflow/Amortisation/IRR, Folgeslice).
