# F1-19 Energiedaten-Vertiefung (T4) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. Migration **0232**. Quelle: Schwarm-Spec S4 (reviewed).

## DISCOVERED

- Ist: consumption-only, dreifach verriegelt (DB-CHECK, json-Whitelist,
  Zod-`z.literal("consumption")`). UI nur Consumption-Felder.
- Zielpakete: nur Rechner-`requestedProducts` (Speicher-kWh + 3 Bools),
  lesend; Zahlarten-Stammdaten `payment_option` separat vorhanden.

## SPECIFIED

- Modi: `property` (Objekt-Schätzung: Heizart-Enum, Bewohner 1..20),
  `roomwise` (Raumliste 1..40: Name/Fläche/Nutzung/Heizkörper),
  `manual` (freie Operateur-Eingabe, Provenance `operator_manual`).
  Alle füttern `effectiveConsumption`; unbekannt/halb → Schema-Reject.
- Paket-Matrix (Operateur-Daten, Rechner unverändert): Solar/Speicher/
  Wallbox/Heizung je `{wanted, paymentKind purchase|leasing|financing|null}`;
  `wanted=true→paymentKind!=null`. Kein Rechen-Einfluss (Qualifizierung).
- Migration 0232: CHECK `inputMode IN (4)`, json-Whitelist + Modus-Shapes,
  `project_requirement_json_ck` + `requestedPackages` (geschlossene Keys,
  Kopplung per SQL-Case). Kein Backfill (additiv-optional).

## CONTRACTED

- EDIT: `calculation/contract.ts`, `energy.ts`, `intake.ts` (Typ+CHECK),
  Editor + Actions (Selektor, Raum-/Property-Sektion, Paket-Matrix mit
  Zahlart-Selects), Lese-Stellen (Board + Akte).
- NEU: 0232 + Snapshot, `tests/db/f1019-energy-deepening.test.ts`
  (je Modus OK+Reject, Paket-Matrix OK/Rejects, Altzeilen-Regression),
  `tests/e2e/f119-*.spec.ts` (Modus-Wechsel+Provenance, Pakete in Akte,
  Planungsrechnung `stale→current` erhalten).
