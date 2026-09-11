# DASH-10 Conversion-Funnel (eigene Daten, Layout ESTIMATE)

Stand: IMPLEMENTIERT (Muse-Slice DASH-10; Querschnitt
Dashboard/Reporting). Wie DASH-01–09: kein Reonic-Referenzbeleg
(Q-DASHBOARD-REFERENZ offen); Auswahl und Layout sind reversible eigene
Naeherung (ESTIMATE).

## 1. Umfang

- Neue Leseregel `getConversionFunnelStats` (`modules/projects`,
  outcome-service): Bestands-Snapshot über die Projektphasen — Anfragen
  (alle Projekte), Angebote (Phase offer/installation), Installationen
  (Phase installation), Gewonnen (outcome won, phasenunabhängig) plus
  Raten relativ zu Anfragen (eine Nachkommastelle, 0 bei leerem
  Bestand). Gleiche Sichtbarkeit wie die Abschlussliste
  (`project.read`, kein External). Keine neue Permission, keine
  Migration (reine Aggregation).
- Dashboard-Karte „Conversion-Funnel (Bestand, ESTIMATE)“: vier Stufen
  mit Raten; Leerzustand „Noch keine Projekte im Bestand.“
- Ehrlich Bestand, keine Kohorten-/Zeitattribution (Abgrenzung zu
  DASH-07 Abschlusstrend).

## 2. Tests

- DB (`tests/db/dash10-conversion-funnel.test.ts`): Stufen zählen
  (4/2/1/1, Raten 50/25/25; Abschluss über legalen mark_won-Pfad),
  leerer Bestand mit Null-Raten, Mandantenisolation.
- E2E (`dashboard-overview.spec.ts`, DASH-10): leerer Workspace zeigt
  Leerzustand; nach manuellem Lead 1 Anfrage, 0er-Stufen.
