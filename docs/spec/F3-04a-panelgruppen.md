# F3-04a Modulbelegung: manuelle Panel-Gruppe (Stufe-0)

## Stand
- Modulkatalog F3.4 (Modulbelegung): Auto-Fill je Dachseite,
  „Optimieren"-KI, manuelle Panel-Gruppen (H/V/zweiseitig, Gaps,
  Tilt), Einzelmodule abwählbar, Performance-Mode ab 400 Modulen.
  Davon existiert: nichts (F3-03 Dach-Polygon + F3-03b Sperrzonen
  sind grün und liefern die Geometrie-Basis).
- Stufe-0: manuelle Panel-Gruppe als Rechteck-Raster je Dach
  (Art H/V, Ursprung, Zeilen/Spalten, Modulmaß explizit, uniforme
  Lücke, Gruppen-Neigung). Kein Auto-Fill, keine KI, keine
  Zweiseitig-Gruppen, kein Abwählen einzelner Module, kein
  Katalog-Join (Folge-Capabilities). 1 Migration (0273).

## Umfang
- Migration `0273`: `planning_panel_group` (id, workspace_id,
  roof_id FK→planning_roof_min (ws,id) RESTRICT, kind `h|v`,
  label, origin_json {x,y}, rows int 1..200, cols int 1..200,
  module_w_m double 0.1..5, module_h_m double 0.1..5, gap_m
  double 0..2, tilt_deg double 0..90 NULL, created_by/at) +
  CHECKs (kind-Menge; rows/cols 1..200; Maße/Gap/Tilt-Ranges;
  Gruppen-Rechteck positiv) + RLS tenant_isolation + FORCE
  + Rollenvertrag (select/insert/update/delete analog
  planning_roof_restriction — Gruppen sind frei revidierbar).
- Contract `lib/integrations/planning/contracts/panel-group`
  (client-sicher): Version `planning-panel-group.v1`,
  Gruppen-Schema (finite Zahlen, Ranges wie DB), Gruppen-Rechteck-
  Ableitung (origin + cols*module_w + gaps …) + Rechteck-in-Polygon
  (wiederverwendet aus roof-restriction-Contract).
- Service `modules/planning/panel-groups`: create (Contract +
  Dach-Bindung + Rechteck-in-Polygon, sonst ValidationError;
  Fremddach → NotFound), list je Dach, get, remove. Viewer liest,
  External fail-closed, project.read/write.
- UI (GREEN-Welle): Liste + Anlage-Formular in der Dach-Sektion
  (Testids planning-panel-groups-*).

## ESTIMATE (reversibel)
- PANEL_GROUP_RECT_ONLY: nur Rechteck-Raster, keine Freiform-
  Gruppen; Upgrade: Polygon-Gruppen + Lücken-Editor.
- PANEL_GROUP_NO_CATALOG: Modulmaß explizit je Gruppe, kein
  Katalog-Join; Upgrade: Katalog-Modul-Referenz + Watt-Peak.
- PANEL_GROUP_NO_AUTOFILL: keine Auto-Fill/KI-Belegung;
  Upgrade: Auto-Fill je Dachseite + „Optimieren".

## Tests
- Contract: Version, Range-Rejects (rows/cols/Module/Gap/Tilt/
  NaN/Extra), Rechteck-Ableitung, Ecke draußen → false.
- DB: Anlage + kind-/Range-Reject + Fremddach-NotFound
  (Service) + RBAC + Fremdtenant-Leere.
- E2E (GREEN-Welle): Gruppe anlegen → Liste → löschen.
