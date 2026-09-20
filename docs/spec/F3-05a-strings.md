# F3-05a Stringplanung: manuelle Strings + WR-Slots (Stufe-0)

## Stand
- Modulkatalog F3.5 (Stringplanung): WR mit MPP-Tracker-Slots,
  manuelle Strings, Optimierer, Mikro-WR, Advisory-Warnungen.
  Davon existiert: nichts (F3-04a Panel-Gruppen sind grün und
  liefern die Bezugsobjekte).
- Stufe-0: Wechselrichter-Registry je Projekt (Label, Tracker-Zahl,
  optionale Advisory-Max-Länge) + manuelle Strings (WR-Ref, Slot,
  Member-Liste ganzer Panel-Gruppen). Kein Auto-Fill, kein
  Optimierer, keine Stromstärken-Berechnung, kein Katalog-Join,
  kein Schatten-/Ertragsbezug (F3.6), kein PDF-Output.
  1 Migration (0274, reserviert).

## Umfang
- Migration `0274`: `planning_inverter` (id, workspace_id,
  project_id FK→project (ws,id) RESTRICT, label, mpp_trackers
  int 1..12, max_string_modules int NULL ≥1 Advisory-Grenze,
  created_by/at) + `planning_string` (id, workspace_id,
  inverter_id FK→planning_inverter (ws,id) RESTRICT,
  tracker_slot int ≥1, label, member_json jsonb Array
  1..200 Einträge je `{group_id}`, created_by/at) +
  CHECKs (Tracker-Range; Slot ≥1; Member-Array nicht leer,
  Einträge mit group_id via immutable Kapsel nach 0271-Muster;
  Label nicht leer) + RLS
  tenant_isolation + FORCE + Rollenvertrag (select/insert/
  update/delete analog planning_panel_group — Strings sind
  frei revidierbar).
- Contract `lib/integrations/planning/contracts/string-plan`
  (client-sicher): Version `planning-string.v1`,
  WR-Schema (Label, Tracker-Zahl, optionale Max-Länge) +
  String-Schema (WR-Ref, Slot, Member-Liste) + Advisory-
  Ableitung (H/V-Mix, Überlänge vs. max_string_modules →
  Warnliste, nie Reject).
- Service `modules/planning/strings`: createInverter,
  listInverters, createString (Contract + alle Gruppen
  existieren + gehören zu Dächern desselben Projekts,
  sonst NotFound; Slot > mpp_trackers → ValidationError
  (App-Level); Doppelbelegung derselben Gruppe in zwei
  Strings desselben WR → ValidationError hart;
  Advisories im Response, kein Block), listStrings je
  Projekt, removeString. Viewer liest, External
  fail-closed, project.read/write.
- UI (GREEN-Welle): WR-Sektion (Anlage: Label +
  Tracker-Zahl) + String-Anlage (WR-Select + Slot +
  Gruppen-Multi-Select) + Advisory-Hinweise inline
  (Testids planning-strings-*).

## ESTIMATE (reversibel)
- STRING_GROUP_WHOLE: Strings referenzieren ganze Panel-
  Gruppen, keine Einzelzellen; Upgrade: Zell-Ranges nach
  F3-04b-Abwahl.
- STRING_SLOT_APP: Slot ≤ Tracker nur App-Level, DB nur
  Slot ≥1; Upgrade: DB-Trigger.
- STRING_NO_AUTO: keine Auto-Generierung/Optimierer/
  Mikro-WR; Upgrade: Optimierer nach F3-05a.
- STRING_ADVISORY_ONLY: nur Längen-/Mix-Advisories, keine
  Stromstärken; Upgrade: E-Modell mit F3.6.

## Tests
- Contract: Version, WR-Ranges, String-Ranges (Slot/Member/
  UUID/Extra), Advisory (H/V-Mix, Überlänge, sauber → leer).
- DB: Anlage (WR + String) + CHECK-Rejects + Fremd-Ref-
  Reject (FK 23503) + Service-Fläche (NotFound + RBAC) +
  Fremdtenant-Leere.
- E2E (RED-Welle): WR anlegen → String aus 2 Gruppen →
  Advisory sichtbar → Doppelbelegung scheitert → Viewer
  read-only → External fail-closed.
