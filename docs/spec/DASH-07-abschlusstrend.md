# DASH-07 Abschlusstrend (12 Monate)

Ziel: won/lost je Berliner Kalendermonat über die letzten 12 Monate als
Balkendiagramm (CSS, keine Chart-Lib), aus eigenen Abschlussdaten.

## ESTIMATE (reversibel, Referenzfrage offen)
- Fenster: 12 Monate inkl. laufendem (Berlin-Key „YYYY-MM"), Lücken = 0.
- `cannot_fulfill` zählt nicht als Abschluss im Trend (reversibel).
- Fenster- und Balkenform sind eigene Darstellung (exakte Reonic-Charts
  UNKNOWN, Q-DASHBOARD-REFERENZ); Sichtbarkeit = Abschlussliste
  (project.read, kein External), keine neue Permission.

## Scopes
1. `getClosureTrendStats` (gleiche Abschlussmenge wie DASH-02, aggregiert).
2. Karte im Dashboard hinter Abschlüssen, nur bei `can("project", "read")`.
