# F3-03b Dach-Sperrzonen, Stufe-0 (Rechteck je Dach)

## Stand
- Modulkatalog F3.3: Sperrzonen (Schornstein Höhe+Schattenwurf,
  Fenster, Sonstige) als Teil des Dach-Editors. F3-03 (Dach-Minimal)
  ist grün (0271, Polygon + Neigung + Rand).
- Stufe-0: generisches Rechteck je Dach (kind + Label +
  x/y/width/height + optionale Höhe). Kein Schattenwurf-Modell,
  keine Gauben/Teilflächen (Folge). 1 Migration (0272).

## Umfang
- Migration `0272`: `planning_roof_restriction` (id, workspace_id,
  roof_id FK→planning_roof_min (ws,id) RESTRICT, kind
  `chimney|window|other`, label, rect_json {x,y,width,height},
  height_m NULL, created_by/at) + CHECKs (kind-Menge; width/height
  > 0; height_m NULL oder 0..50) + RLS tenant_isolation + FORCE
  + Rollenvertrag.
- Contract `lib/integrations/planning/contracts/roof-restriction`
  (client-sicher): Version `planning-roof-restriction.v1`,
  rect-Schema (finite Zahlen, width/height > 0), Rechteck-in-Polygon
  (4 Ecken per Ray-Casting in Dach-Polygon; Kante = drin).
- Service `modules/planning/roof-restrictions`: create (Contract +
  Dach-Bindung + Rechteck-in-Polygon, sonst ValidationError;
  Fremddach → NotFound), list je Dach, remove. Viewer liest,
  External fail-closed, project.read/write.
- UI (GREEN-Welle): Liste + Anlage-Formular in der Dach-Sektion
  (Testids planning-roof-restrictions-*).

## ESTIMATE (reversibel)
- RESTRICTION_RECT_ONLY: nur Rechtecke, keine Freiform; Upgrade:
  Polygon-Sperrzonen + Schornstein-Höhe/Schattenwurf-Modell.
- RESTRICTION_NO_OVERLAP_CHECK: Überlappungen untereinander
  erlaubt; Upgrade: Warnung/Ablehnung.

## Tests
- Contract: Version, rect-Rejects (0/negativ/NaN/Extra), Ecke
  draußen → false, Rechteck drin → true, Kante → true.
- DB: Anlage + kind-Reject + width-0-Reject + Fremddach-NotFound
  (Service) + RBAC + Fremdtenant-Leere.
- E2E (GREEN-Welle): Rechteck anlegen → Liste → Löschen.
