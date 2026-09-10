# F1-10 Lead-Routing (Quelle → Standard-Betreuer)

Ziel: Jede Lead-Quelle kann genau einen Standard-Betreuer (Mitgliedschaft)
tragen. Das Zuweisungs-Panel zeigt bei Projekten mit dieser Quelle einen
Vorschlag („Routing-Vorschlag (Quelle X): Person als Key Account festlegen“),
der per Klick den bestehenden `set_key_account`-Pfad nutzt (gleiche
Permission `project.assign`, gleiche CAS-Revision, keine neuen Permissions,
keine Automatik im Intake).

## Entscheidungen (reversibel)

- Eine Regel je Quelle (`lead_source_id` workspace-weit eindeutig).
- Regelziel ist eine Workspace-Mitgliedschaft; Label ist die Identity-E-Mail
  (gleiches Label wie die Zuweisungssuche).
- FK-Verhalten: Mitgliedschaft → RESTRICT (kein stilles Verlieren der Regel
  beim Offboarding — Regel erst explizit löschen); Lead-Quelle → CASCADE
  (Quelle weg → Regel gegenstandslos; Archivierung löst nichts aus).
- Vorschlag erscheint nur, wenn: Regel vorhanden, Mitglied noch im Workspace,
  noch kein Key Account am Projekt. Bereits als `user` zugewiesenes Mitglied
  wird zur Beförderung vorgeschlagen (gleicher Klick).
- Kein Vorschlag ohne Regel (kein Default), kein Schreiben ohne Klick.

## Scopes

1. Migration `0087`: Tabelle `project_lead_routing_rule` + RLS-Vertrag im
   F7.1-Muster, Rollen-ACL wie `service_case` (SELECT/INSERT/UPDATE/DELETE
   für den Service-Pfad — Regeln werden ersetzt/gelöscht, daher DELETE).
2. Service in `modules/lead-sources` (bestehende `lead_source.read/write`):
   `setRoutingRule`, `clearRoutingRule`, `listRoutingRules`,
   `suggestAssigneeForProject`.
3. UI: Regelpflege in der Lead-Quellen-Verwaltung; Vorschlagsbox im
   Zuweisungs-Panel (nutzt vorhandene `set_key_account`-Form).
