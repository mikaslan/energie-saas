# F3-03 Dach-Minimal (1 Polygon + Neigung/Kante + Rand)

## Stand
- Modulkatalog F3.3: Smart Roof (Neigung pro Kante 0–90°) +
  Flachdach, Gauben, Sperrzonen, Randabstände pro Kante,
  Validierung keine Selbstschnitte.
- Batch-1 (F3-BATCH-1-vertrag): nur 1 Polygon, Neigung pro
  Kante ODER Flachdach-Einzelneigung, Randabstände mit
  Uniform-Fallback, Selbstschnitt-Validierung.
- Infra: MapLibre (@vis.gl/react-maplibre + maplibre-gl)
  vorhanden; nur Pin-Nutzung bisher (address-pin-map).

## Umfang
- Migration `0271`: `planning_roof_min` (id, workspace_id,
  source_id FK→planning_source RESTRICT, polygon_json
  3..64 Punkte, tilt_per_edge_json NULL ODER
  flat_single_tilt NULL (genau eines), edge_margins_json
  NULL, created_by/at) + CHECKs (Punktanzahl;
  tilt 0–90; flat XOR per-edge) + RLS tenant_isolation +
  FORCE + Rollenvertrag (eigene Relations-Menge, Policy-Pin).
- Selbstschnitt-Prüfung auf App-Ebene (Contract), DB-CHECK
  nur Punktanzahl.
- Service `modules/planning/roofs`: `createRoof` (source_id
  gehört zum Projekt sonst NotFound), `updateRoof` (Voll-
  ersatz Polygon/Neigung/Rand), `getRoof`, `listRoofs` je
  Projekt. Events/Audit nur IDs.
- UI: MapLibre-Polygon zeichnen/editieren auf Quell-Basis,
  Neigung/Kante-Inputs ODER Flachdach-Toggle, Rand-Default-
  Hinweis; Schreibrecht; Viewer liest; Quick blendet aus.

## ESTIMATE (reversibel)
- ROOF_SINGLE_POLYGON_NO_DORMER, MARGIN_UNIFORM_FALLBACK
  (siehe Batch-Vertrag).
- Keine Gauben/Teilflächen/Sperrzonen (Folge-Batch).
- Snapshot: Dach-Referenz additiv an Variante (v4-Hash-Regel
  F3-01: ohne Feld unverändert).

## Tests
- DB: Anlage + tilt-Range + flat-XOR + Selbstschnitt-reject
  + Fremdquelle-NotFound + RBAC + Fremdtenant-Leere.
- Contract: Polygon 3..64, Selbstschnitt-Algorithmus,
  tilt 0–90.
- E2E: Polygon zeichnen → speichern → laden → Quick-Ausblendung.
