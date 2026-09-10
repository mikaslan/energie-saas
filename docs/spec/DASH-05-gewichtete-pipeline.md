# DASH-05 Gewichtete Pipeline (eigene Daten, Gewichte ESTIMATE)

Stand: SPECIFIED (Codex-Slice DASH-05; Modulkatalog Querschnitt
Dashboard/Reporting „gewichtete Pipeline"). Wie DASH-01–04: kein
Reonic-Referenzbeleg (Q-DASHBOARD-REFERENZ offen). Angebotswerte stammen
aus verifizierten eigenen Daten (Override sonst Forecast des jeweils
juengsten Angebots); die Phasengewichte sind reversible eigene Naeherung
(ESTIMATE).

## 1. Umfang

- Neue Leseregel `getProjectOfferValues` (`modules/offers`): juengster
  Angebotswert je Projekt-ID (Override sonst Forecast, sonst null),
  gedeckelt auf 200 IDs, UUID-geprueft, Sichtbarkeit wie Angebotsliste
  (`project.read`). Keine neue Permission.
- Pipeline-Karte: zusaetzlich „Offen (Angebotswert)" (Summe) und
  „Gewichtet (ESTIMATE)" (Summe x Phasengewicht: lead 10 %, offer 50 %;
  won/lost nicht auf dem offenen Board). Deckelfall mit „+";
  Gewichtsfussnote in der Karte.

## 2. Tests

- E2E: leerer Workspace zeigt 0,00 €-Zeilen und Fussnote.
