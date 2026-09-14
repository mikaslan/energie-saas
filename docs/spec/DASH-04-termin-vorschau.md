# DASH-04 Termin-Vorschau (eigene Daten, Layout ESTIMATE)

Stand: IMPLEMENTIERT/LOKAL VERIFIZIERT (E2E DASH-01-Test: Termin-Leerzustand + Kalender-Link; E2E DASH-04-Daten 1/1: angelegter Termin erscheint in der Karte, Leertext weg; Stand 2026-09-14, kein Code-Eingriff). Wie DASH-01–03: kein
Reonic-Referenzbeleg (Q-DASHBOARD-REFERENZ offen); Auswahl und Layout
sind reversible eigene Naeherung (ESTIMATE).

## 1. Umfang

- Neue Leseregel `listUpcomingAppointments` (`modules/calendar`):
  workspace-weite naechste Termine (Default 5, max. 20) mit exakt der
  Sichtbarkeit der Projektliste (`appointment.read` + Actor-Praedikat
  `_m115_actor_can_read_appointments` + sichtbare Kalender, nur
  `end_at >= now()`). Keine neue Permission.
- Dashboard-Karte „Naechste Termine": Titel (Projekt-Link), Berlin-Datum/
  Uhrzeit aus Wandzeit ohne TZ-Raten (ganztägig-Sonderfall),
  Kalendername; Leerzustand „Keine anstehenden Termine."; Link zum
  Kalender.

## 2. Tests

- E2E: leerer Workspace zeigt Leerzustand und Kalender-Link.
