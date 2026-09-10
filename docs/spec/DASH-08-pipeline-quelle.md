# DASH-08 Pipeline nach Quelle

Ziel: Offene Board-Projekte je Lead-Quelle (gleiche Menge wie Pipeline),
aus eigenen Daten, rein lesend.

## ESTIMATE (reversibel, Referenzfrage offen)
- Menge = Board-Karten der Pipeline (Cap 200 wie Angebotswerte).
- „Ohne Quelle"-Bucket für Projekte ohne Quelle; archivierte Quellen
  erscheinen mit Namen (Historie lesbar). Exakte Reonic-Darstellung
  UNKNOWN (Q-DASHBOARD-REFERENZ).
- Sichtbarkeit: lead_source.read (Modulkonvention); Karte blendet sich bei
  Denied aus, ohne die Pipeline-Karte zu blockieren. Keine neue Permission.

## Scopes
1. `getLeadSourcePipelineStats` (fail-closed bei >200/ungültigen IDs).
2. Karte im Dashboard hinter Pipeline, nur mit Inhalt.

## Verhalten (DASH08-DB-01 belegt)
- Aktive Quellen ohne Pipeline-Karten erscheinen ehrlich mit 0
  (kein leeres Verschwinden trotz vorhandener Quelle).
- „Ohne Quelle"-Bucket nur bei quellenlosen Projekten in der Menge.
- Kante: Eine Quelle mit dem literalen Namen „Ohne Quelle" ist von dem
  Bucket optisch nicht unterscheidbar (Namen sind je Workspace eindeutig,
  normalisiert) — dokumentiert, kein Gate.
