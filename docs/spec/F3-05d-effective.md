# F3-05d Effektive String-Advisories + Equipment×Deselect-Konsistenz (Stufe-0)

## Stand
- String-Advisories (`over-length`, `partial-coverage`)
  zählen brutto (`rows·cols`), obwohl F3-04b Zellen
  abwählt und F3-05c Ranges kennt: Phantom-Module.
  Equipment-Panel-Refs können auf abgewählte Zellen
  zeigen (MEMBER_EQUIP_LEGACY offen). `member_json`
  bleibt lesbar (Bestandsschutz, kein Backfill).
- Stufe-0: Advisories rechnen effektiv (Ranges minus
  Deselect-Schnitt), neuer Code für Equipment auf
  abgewählter Zelle. KEINE Migration (0278/0279
  bleiben frei).

## Umfang
- Contract `string-plan` (additiv, v1 unangetastet):
  `stringEffectiveAdvisoriesV1({members, maxStringModules,
  equipment})` mit members `[{groupId, kind, cells,
  deselectedCells}]` und equipment `[{cell, deselected}]`
  → Codes `orientation-mix` (Kinds differs),
  `over-length` (Effektiv-Summe > max),
  `equipment-on-deselected` (Equipment-Zelle
  abgewählt). Reine Funktion, client-sicher.
- Service (`strings.ts`, `string-equipment.ts`):
  laden Ranges (`planning_string_member`, Legacy-
  `member_json` = volle Range) + Deselects
  (`planning_panel_deselect`) und füttern die
  v1-Advisory via Contract-Helper effektiv; DTOs
  tragen Effektiv-Zahlen (cells/effective).
- UI: Advisory-Texte zeigen Effektiv-Zahl („14 von
  18"), Deselect-Warnung inline (Testids
  planning-string-members-effective + bestehende
  Advisory-Slots).

## ESTIMATE (reversibel)
- EFFECTIVE_ADVISORY_V1: v1-Helper bleibt für
  Legacy-Pfade; Upgrade: v1 entfernen nach UI-Umzug.
- MEMBER_JSON_LEGACY_READ (bleibt): alte Strings
  zählen als volle Range; Upgrade: Backfill (abgelehnt,
  s. G4).
- EQUIP_DESELECT_ADVISORY: Warnung statt Reject bei
  Equipment auf Deselect; Upgrade: striktes Gate.

## Tests
- Contract: v1-Helper (Mix/Überlänge/effektiv/
  Equipment-Code, Legacy-Range).
- DB: Service effektiv (Deselect in Range →
  `over-length` verschwindet; Mikro auf Deselect →
  neuer Code; Legacy-String = volle Range).
- E2E: Deselect in Range → Count sinkt + Warnung →
  `over-length` weg; Mikro auf Deselect → Advisory;
  Viewer/External wie bisher.
