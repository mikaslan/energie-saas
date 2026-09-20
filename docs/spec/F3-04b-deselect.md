# F3-04b Einzelmodul-Abwahl: Zellen-Deselect je Panel-Gruppe (Stufe-0)

## Stand
- Modulkatalog F3.4 verlangt „Einzelmodule abwählbar" —
  letzter providerfreier F3.4-Rest neben Auto-Fill/KI
  (F3-04a Gruppen sind grün). Zwei ESTIMATEs nennen
  F3-04b als Upgrade-Voraussetzung (STRING_GROUP_WHOLE,
  EQUIP_PANEL_VALIDATED).
- Stufe-0: Deselect-Zeilen je Gruppe (row/col, optionale
  Begründung). Doppel-Abwahl idempotent. Kein Eingriff
  in String-/Equipment-Logik (effectiveCount-Nutzung
  folgt im Zell-Ranges-Slice). 1 Migration (0276,
  reserviert).

## Umfang
- Migration `0276`: `planning_panel_deselect` (id,
  workspace_id, group_id FK→planning_panel_group
  (ws,id) RESTRICT, row/col int ≥1, reason NULL
  ≤280 Zeichen, created_by/at) + UNIQUE(group_id,
  row, col) + CHECKs (row/col ≥1; reason-Länge) + RLS
  tenant_isolation + FORCE + Rollenvertrag (frei
  revidierbar wie Gruppen). Bekannte Stufe-0-Grenze:
  Gruppe mit Abwahlen ist nicht löschbar (RESTRICT;
  erst Reselect) — F3-Muster hat Vorrang vor CASCADE.
- Contract `lib/integrations/planning/contracts/
  panel-deselect` (client-sicher): Version
  `planning-panel-deselect.v1`, Deselect-Schema
  (Gruppen-Ref, row/col, reason optional) +
  Ableitung effectiveCount (rows·cols − Abwahlen)
  zur Nachnutzung.
- Service `modules/planning/panel-deselect`:
  deselect (Gruppe+Dach-Bindung sonst NotFound;
  row/col gegen Raster sonst ValidationError;
  Doppel-Abwahl idempotent), reselect/remove,
  list je Gruppe, effectiveCount. Viewer liest,
  External fail-closed, project.read/write.
- UI (GREEN-Welle): Abwahl-Formular + Liste in der
  Panelgruppen-Sektion (Testids
  planning-panel-deselect-*); Quick-Modus blendet
  aus (F3-01).

## ESTIMATE (reversibel)
- DESELECT_IDEMPOTENT: Doppel-Abwahl No-op statt
  Reject; Upgrade: strikte Zählung.
- DESELECT_NO_PROPAGATION: keine String-/Equipment-
  Wirkung hier; Upgrade: Folge-Slice Zell-Ranges.
- DESELECT_GROUP_RESTRICT: Gruppen-Remove mit
  Abwahlen scheitert; Upgrade: Cleanup-Flow.

## Tests
- Contract: Version, Deselect-Ranges, effectiveCount-
  Ableitung.
- DB: Anlage + UNIQUE-Reject (23505) + CHECK-Rejects
  + Fremd-Ref-Reject (FK 23503) + Service-Fläche
  (NotFound + RBAC + Idempotenz) + Fremdtenant-Leere.
- E2E (RED-Welle): Gruppe → 2 Zellen abwählen →
  Count sinkt → Doppel-Abwahl idempotent →
  Out-of-Range scheitert → Re-Select → Viewer/
  External.
