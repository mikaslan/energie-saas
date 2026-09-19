# F1-23 Routing-Vertiefung (T8) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. Migration **0235**. Quelle: Schwarm-Spec S8 (reviewed).

## DISCOVERED

- F1-10: 1 Regel/Quelle, nur Vorschlag. F12-02: einziger Auto-Pfad
  (Kampagne, manuell, fail-closed). Intake: nie Auto (revision 0).
- UNK-F1-01: Team-/Routing-Semantik UNBELEGT → nichts erfinden;
  F1-23 behauptet KEINE Reonic-Parität, schließt UNK nicht.

## SPECIFIED (eigene WMEE-Semantik, DECIDED/ESTIMATE)

- Regelmodell: Dimension Quelle XOR Kampagne; `mode` suggest(default)/auto;
  `priority` 0..9999; Trigger `auto_on_manual`(default true) /
  `auto_on_intake`(default FALSE); Ziel NUR direkte Membership; nur
  Erfassungszeitpunkt; Kampagnen-Regeln NUR suggest.
- Konflikt: F12-02-Beauftragter > Kampagnen-suggest > Quellen-Auto
  (first-match nach priority). Suggest: Union max 5, Ein-Klick bleibt.
- Guards: Pflege `lead_source.write`; manuell+Race→Erfassung verweigert
  (F12-02); Intake-Drift→unzugewiesen + `lead_routing.failed` (kein 500 an
  Sender); RESTRICT-Offboarding; archivierte Regeln feuern nicht.
- Events: `rule.set/cleared`, Feuerung via `assignment_key_account_changed`
  (+ruleId/trigger), Intake-Degradation via `lead_routing.failed`.

## CONTRACTED

- NEU: 0235 (Spalten+CHECKs+FK+Unique-Umbau, Backfill via Defaults),
  `routing-evaluator.ts`, `f123` DB (~10), E2E-Spec (2).
- EDIT: Schema, routing-service (+Barrel), manual-lead-service (Evaluator),
  intake/service (Hook), Lead-Quellen-UI, Zuweisungs-Panel,
  `db-role-contract.mts` (nur Hash), m111a-Pins.
- Nachbarn `f110/f1201/f1202` grün halten.
