# DASH-09 Service & Förderung (eigene Daten, Layout ESTIMATE)

Stand: SPECIFIED (Codex-Slice DASH-09; Gesamtauftrag F1–F16 inklusive
Dashboard). Kein Reonic-Referenzbeleg (Q-DASHBOARD-REFERENZ offen);
Layout und Kennzahlauswahl sind reversible eigene Näherung (ESTIMATE).
Alle Zahlen stammen aus verifizierten eigenen Lesemodellen.

## 1. Umfang

Dashboard-Karte „Service & Förderung" (`data-dashboard-service`):

- Service: offen / in Arbeit / überfällig (Fälligkeit < Berliner
  Heute, nur open/in_progress) / erledigt-unbestätigt.
- Förderung: Akten je Stand (7er-Wortschatz, nur Nicht-Null-Stände
  plus Gesamt).
- Belege: Datei-Anfragen offen/hochgeladen/erledigt.
- Je eigene Sichtbarkeit (installation.read für Service/Förderung,
  project.read für Belege); ohne Recht ist die Teilkarte verborgen
  (kein Fehler, blockiert andere Karten nicht — Muster DASH-08).
- Leere Workspace-Zustände als Text („keine offenen Vorgänge" u.ä.).

## 2. Nichtziele

- Projektverlinkung je Zeile (Zählkarte, kein Posteingang).
- Storno-Begründungen, Wartungsintervalle, SLA-Regeln (F13-01-offen).
- Energie-KPIs (weiter offen).
