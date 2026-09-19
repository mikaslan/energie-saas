# T9 F1-12-Folgenachweis — Spec

Lane `codex/muse-fleet-1c-f1`. KEINE Migration (erwartet). Quelle: Schwarm-Spec S9 (reviewed).

## DISCOVERED

- Plantafel-Blockzuweisung (F7-06): IMPLEMENTIERT (CAS via
  `update_appointment`, setzen+entziehen, Guards). Randfall UNVERIFIZIERT:
  Range-Filter könnte mehrtägige Termine verfehlen → `not_found`.
- Kalender-Scopes: Schema 4/4, Sichtbarkeit korrekt, Create-Pfade je Scope
  belegt, F1-13 Team-Umfang belegt. **Echte Lücke: `validateCalendar`
  prüft NICHT `team.active`** → Termine auf Kalendern archivierter Teams
  buchbar (inkonsistent zu F1-12-`validateTeam`).
- client-Scope: bewusst geschlossen (kein Gap im T9-Sinn).

## SPECIFIED

- S1: Nachweis-Test Assign-bei-mehrtägigem-Termin; falls positiv: Fix
  (Range-Puffer oder Direkt-Read). Kein Contract-Change.
- S2: `validateCalendar` += Team-aktiv-Check (type=team ⇒ team.active,
  sonst `invalid`; Lesen bleibt = Historie) + 3 Nachweis-Tests
  (buchen-invalid / lesen-bleibt / reaktiviert-buchbar).
- NICHT: client-Nutzung, team-FK, user-Create/Archiv.

## CONTRACTED

- EDIT (max): `plantafel/actions.ts` (S1 falls positiv),
  `modules/calendar/service.ts` (S2) + 2 Nachweis-Testdateien.
- Beweisgrün: db `f0706/f0705/f1012/f1013/m115b/m115-service` + e2e
  `f7-06/f7-05/f1-12/f1-13`.
