# F3-05c String-Zell-Ranges: effective-Member je String (Stufe-0)

## Stand
- Strings referenzieren ganze Gruppen (`member_json`), F3-04b
  wählt Zellen ab — die Abwahl propagiert nirgends hin
  (Phantom-Module in Längen/Advisories). Drei ESTIMATEs
  nennen diesen Slice als Upgrade-Nachfolger
  (STRING_GROUP_WHOLE, DESELECT_NO_PROPAGATION,
  EQUIP_PANEL_VALIDATED).
- Stufe-0: Rechteck-Ranges je String-Member (Gruppen-Ref +
  Zeilen-/Spalten-Fenster), Deselect-Schnittmenge als
  Effektiv-Count, Überlapp-Reject, Zell-Doppelbelegung
  hart pro WR. `member_json` bleibt lesbar (Bestands-
  schutz), neue Writes gehen in die Tabelle.
  1 Migration (0277, reserviert).

## Umfang
- Migration `0277`: `planning_string_member` (id,
  workspace_id, string_id FK→planning_string (ws,id)
  RESTRICT, group_id FK→planning_panel_group (ws,id)
  RESTRICT, row_from/to + col_from/to int ≥1 mit
  from≤to, created_by/at) + CHECKs + RLS
  tenant_isolation + FORCE + Rollenvertrag (frei
  revidierbar wie Strings).
- Contract `lib/integrations/planning/contracts/
  string-member` (client-sicher): Version
  `planning-string-member.v1`, Range-Schema
  (finite ints, from≤to) + rangesOverlap (gleiche
  Gruppe + Rechteck-Schnitt) + effectiveMemberCount
  (Zellen minus Deselect-Schnittmenge).
- Service `modules/planning/string-members`: add
  (String+Gruppe same-Project sonst NotFound; Range
  gegen Raster sonst ValidationError; Range aus nur-
  abgewählten Zellen → ValidationError hart; Überlapp
  im selben String → ValidationError; Zell-Doppel-
  belegung in anderem String desselben WR hart),
  remove, list je String. Viewer liest, External
  fail-closed, project.read/write.
- UI (GREEN-Welle): Range-Anlage (Gruppen-Select +
  von/bis) + Member-Liste mit Effektiv-Count +
  Deselect-Warnung inline im String-Bereich (Testids
  planning-string-members-*).

## ESTIMATE (reversibel)
- MEMBER_RANGE_RECT_ONLY: nur Rechteck-Ranges, keine
  Freiform-Zellmengen; Upgrade: Zell-Listen.
- MEMBER_JSON_LEGACY_READ: alte member_json-Strings
  lesen als volle Gruppen-Range; Upgrade: Backfill.
- MEMBER_DESELECT_HARD: Voll-Deselect-Range rejectet;
  Upgrade: Advisory statt Reject.
- MEMBER_EQUIP_LEGACY: Equipment-Refs auf nachträglich
  abgewählte Zellen Bestandsschutz + Advisory (Folge).

## Tests
- Contract: Version, Range-Ranges + from≤to, Overlap-
  Erkennung, Count-Ableitung.
- DB: Anlage + CHECK-Rejects + Fremd-Ref-Reject (FK
  23503) + Service-Fläche (NotFound + RBAC + Regeln)
  + Fremdtenant-Leere.
- E2E (RED-Welle): WR+String → Range → Deselect in
  Range → Count sinkt → Voll-Deselect scheitert →
  Doppelbelegung scheitert → Overlap scheitert →
  Viewer/External.
