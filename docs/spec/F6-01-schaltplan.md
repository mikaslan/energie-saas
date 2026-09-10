# F6-01 Schaltplan (einlinig, lesend)

Ziel: Einphasiges Übersichtsschaltbild je Angebotsvariante aus den
Angebotssektionen — rein lesend, keine Editierung, keine neue Permission.

## ESTIMATE (reversibel, Referenzfrage offen)
- Topologie-Festlegung: PV → Wechselrichter → Zähler → Netz (Backbone),
  Speicher ↔ Wechselrichter, Wallbox/Wärmepumpe → Zähler (Hausabgang),
  Montage → PV (mechanisch). Exaktes Reonic-Layout UNKNOWN (Q-DASHBOARD-
  REFERENZ-Nachbarschaft); Positionen sind fest und deterministisch.
- Nur sichtbare Angebotszeilen (isHidden=false) zählen zum Umfang.
- Kategorien ohne Leitungsführung (mounting ausgenommen, other) erscheinen
  als Hinweisliste, nicht als Knoten — keine erfundene Verdrahtung.

## Scopes
1. Reiner Builder `single-line-v1` (Kategorien → Knoten/Kanten).
2. SVG-Renderer + Hinweisliste in der Angebotsdetailansicht.
