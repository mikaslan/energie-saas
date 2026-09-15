# F16-12 Mengenverknüpfung („Linked amounts", Katalog F16.2)

## Status dieser Spec

Ex post festgeschrieben (implementiert Vorderbau 40/41, lokal verifiziert:
DB F1612 6/6, E2E F16-12 1/1, Nachbarn grün). Beschreibt den gebauten Stand,
kein Vorab-Entwurf — Abweichungen zwischen Spec und Code gehen zugunsten
des Codes, bis Codex sie im Endaudit auflöst.

## ESTIMATE (reversibel)

- Freie Angebotszeile folgt einer Quellzeile × Faktor (Milli).
- Ziel nur `custom`-Zeilen (Katalog-Seed nie direkt verlinkt), Quelle beliebig.
- `quantityLink` strikt optional ohne Default: linklose Snapshots bleiben
  byte-identisch; gepinnte SHAs und f1603-Ketten unangetastet
  (Golden-Schema per Generator + Pin regeneriert).

## Vertrag

Revise-Ops `set_line_quantity_link` / `clear_line_quantity_link` mit
Revisions-CAS; transitive Kaskade bei Quellmengen-Änderung
(`recascadeQuantityLinks`); Fail-closed: Self-Link, Zyklus, Katalogziel,
verwaistes Löschen (`assertNoQuantityDependents` in `remove_custom_line` /
`remove_custom_section` — erst lösen, dann löschen, kein stilles Verwaisten).
Paket-Einsetzen (F16-11) läuft über dieselben Revise-Ops und erbt den Schutz.

## UI

Editor: Quell-Select + Faktor + Ableitungsvorschau, Menge der Zielzeile
deaktiviert. Read-only-Sicht: Karte „Verknüpft mit × Faktor".

## Tests

- DB `tests/db/f1612-quantity-links.test.ts` (6/6).
- E2E `tests/e2e/f16-12-mengenverknuepfung.spec.ts` (Editor + Viewer).

## Bewusst offen

- Nichts mehr offen: alle F16.2-Punkte dieses Pfads gebaut. Öffentlich-Flag
  fürs Energiehaus bleibt separat blockiert (Q-F12-FUNNEL-REFERENZ).
