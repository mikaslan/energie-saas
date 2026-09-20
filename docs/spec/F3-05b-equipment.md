# F3-05b String-Equipment: Optimierer + Mikro-WR (Stufe-0)

## Stand
- Modulkatalog F3.5 verlangt „Optimierer pro String/Panel,
  Mikro-WR 1:1". F3-05a (manuelle Strings + WR-Slots) ist
  grün; STRING_NO_AUTO nennt Optimierer als Upgrade danach.
- Stufe-0: Equipment-Einträge je String (Optimierer pro
  String/Panel, Mikro-WR je Panel). Kein Auto-Fill, kein
  Optimierer-String-Algorithmus, keine Ertragsrechnung,
  kein Katalog-Join. 1 Migration (0275, reserviert).

## Umfang
- Migration `0275`: `planning_string_equipment` (id,
  workspace_id, string_id FK→planning_string (ws,id)
  RESTRICT, scope `string|panel`, panel_ref_json NULL
  oder `{group_id, row, col}`, equipment
  `optimizer|micro_inverter`, created_by/at) + CHECKs
  (scope-/equipment-Mengen; scope=string → panel_ref
  NULL; scope=panel → panel_ref-Objekt mit group_id/
  row/col ≥1; Mikro-WR nur scope=panel) + RLS
  tenant_isolation + FORCE + Rollenvertrag (frei
  revidierbar wie Strings).
- Contract `lib/integrations/planning/contracts/
  string-equipment` (client-sicher): Version
  `planning-string-equipment.v1`, Attach-Schema
  (String-Ref, Scope, Panel-Ref, Typ; Kreuzregeln
  scope/panelRef/Mikro) + Advisory-Ableitung
  (Mikro-Teilabdeckung → Warnung, nie Reject).
- Service `modules/planning/string-equipment`:
  attach (Contract + String existiert + gehört zum
  Projekt sonst NotFound; Panel-Ref gegen Gruppen-
  Raster rows/cols sonst ValidationError; Optimierer
  scope=string genau 1 je String; Mikro-Doppel-
  belegung desselben Panels hart), detach, list je
  String. Viewer liest, External fail-closed,
  project.read/write.
- UI (GREEN-Welle): Equipment-Sektion im String-
  Bereich (Optimierer-Toggle + Mikro-Anlage je
  Panel-Ref + Advisory inline, Testids
  planning-string-equipment-*).

## ESTIMATE (reversibel)
- EQUIP_PANEL_VALIDATED: Panel-Ref nur range-validiert,
  kein Vorgriff auf F3-04b-Abwahl; Upgrade: Zell-Semantik.
- EQUIP_MICRO_ADVISORY: Teilabdeckung Advisory statt
  Reject; Upgrade: striktes 1:1-Gate.
- EQUIP_NO_AUTO: kein Belegungs-Algorithmus; Upgrade:
  Auto-Vorschlag nach F3-05b.

## Tests
- Contract: Version, Attach-Ranges + Kreuzregeln,
  Advisory (Teil/volle/leer).
- DB: Anlage + CHECK-Rejects + Fremd-Ref-Reject (FK
  23503) + Service-Fläche (NotFound + RBAC) +
  Fremdtenant-Leere.
- E2E (RED-Welle): WR+String → Optimierer → 2.
  scheitert → Mikro an 2 Panels → Doppelbelegung
  scheitert → Advisory → Viewer/External.
