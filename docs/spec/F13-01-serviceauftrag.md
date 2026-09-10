# F13-01 Serviceauftrag (Meldung → Erledigt)

Ziel: Nach Abnahme anfallende Service-/Wartungsarbeiten je Projekt als
eigenes Filing-Objekt mit kleiner Statusmaschine — aus eigenen Daten,
ohne neue Permission (Bauarbeit, kein Referenzbeleg).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `service_case` (Projekt-FK, Titel 1–160, Beschreibung
  optional ≤2000, Status, Fälligkeit optional, Erledigt-Zeitstempel).
  Statusmaschine: `open → in_progress → done`, dazu `cancelled` aus
  `open`/`in_progress`; `done`/`cancelled` terminal. Reopen nur via
  neuen Vorgang (kein Zurücksetzen — Historie bleibt ehrlich).
- Berechtigung: Wiederverwendung `installation.read`/`installation.write`
  (Service ist Lebenszyklus-Fortsetzung der installierten Anlage;
  KEINE neuen Permission-Keys — Mandat).
- Anzeigestandort: Projektakte (eigene Sektion), kein Portal-Anteil.
- Exakte Reonic-Darstellung UNKNOWN; ESTIMATE-Layout, nur
  gespeicherte Werte.

## Scopes
1. Migration + `createServiceCase/setServiceCaseStatus` (+ Liste je
   Projekt), fail-closed (Statuskanten, leere Titel, NotFound ohne
   Orakel, Fremdtenant sieht nichts).
2. Projekt-Sektion: Liste + Anlegeformular + Statuswechsel nur mit
   Schreibrecht; Viewer liest.
3. Events/Audit ohne PII über IDs/Status hinaus (Titel ist
   Kundenkontext — Audit nur IDs + Status, wie Angebotskette).

## Geschlossene Testmatrix
- `F1301-DB-01`: Anlage → Kanten (open/in_progress/done/cancelled);
  illegale Kanten, leere Titel, Fremdprojekt fail-closed.
- `F1301-RBAC-01`: Viewer liest read-only; External fail-closed;
  Fremdtenant sieht nichts.
- `F1301-E2E-01`: Vorgang anlegen → disponieren → erledigen →
  Status sichtbar.

## Bewusst offen
- Wartungsverträge/Intervalle, Ersatzteil-/Materialbuchung,
  Techniker-Disposition mit Kalenderbindung, Kunden-Rückmeldung,
  SLA-/Reaktionszeit-Regeln, Portal-Sicht.
