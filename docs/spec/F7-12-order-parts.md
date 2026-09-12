# F7-12 Order Parts (Nachbestellungen mit Thread je Zeile)

## Stand
- Modulkatalog F7.8: „Order Parts (Nachbestellungen mit Message-Thread
  je Zeile)". Kein Modell, kein Pfad (0 Treffer).
- Fotodoku-Batch/Markup (zweite Hälfte von F7.8) ist NICHT enthalten
  (eigener Folgeslice).

## Umfang
- Migration `0124`: `order_part` (id, workspace, installation FK,
  line_domain_id Text-Referenz auf Snapshot-Zeile [kein FK ins JSON],
  quantity_milli, note, status `open|ordered|delivered|cancelled`,
  created_by/at, updated_at) + `order_part_message` (id, workspace,
  order_part FK CASCADE, author, body ≤ 2000, created_at) + RLS
  tenant_isolation + FORCE + Rollenvertrag (app_runtime SIU, Pins).
- Service `modules/order-parts`: `requestOrderPart` (Installation +
  gebundene Variante prüfen; Zeile muss im Current-Snapshot existieren,
  sonst NotFound; Menge ≥ 1 Stück ganzzahlig), `listOrderParts`
  (mit Messages, chronologisch), `postOrderPartMessage`,
  `setOrderPartStatus` (open→ordered→delivered; cancel aus
  open/ordered; sonst Validation). Events/Audit IDs + Status.
- UI: Workbook-Panel-Sektion (Liste mit Threads + Anlegeformular
  Zeile/Menge/Notiz + Nachrichtenformular + Statusbuttons).
- Statusmenge ist ESTIMATE (Katalog nennt keine); Fotodoku offen.

## Tests
- DB: Anlage an echter Zeile, Fantasie-Zeile → NotFound, Kanten,
  Thread-Reihenfolge, RBAC, Fremdtenant-Leere.
- E2E: Nachbestellung anlegen → Nachricht → Status sichtbar.
