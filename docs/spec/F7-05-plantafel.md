# F7-05 Plantafel (Ressourcen-Grid, Slice 1: Lesepfad)

Status: **Slice 1–3 IMPLEMENTIERT/LOKAL VERIFIZIERT (Lesepfad + Anlage + Lead Installer)** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Slice 3: Lead Installer je Installation (Installations-Ebene)

Katalog F7.5 verlangt zweistufige Zuweisung. Block-Ebene (mehrere Teams
parallel) bleibt offen (keine Team-Entität — wie Kalender-`team_id`,
M1-15b-Präzedenz). Diese Slice schließt die Installations-Ebene:
genau ein Lead Installer (Membership, nullable) je Installation.

## Datenmodell (Migration 0096, additiv)

`installation.lead_installer_membership_id` (uuid, NULL = nicht
zugewiesen), Composite-FK `(workspace_id, lead_installer_membership_id)`
→ `membership(workspace_id, id)` ON DELETE SET NULL (Mitglied weg ≠
Installation weg), Index auf `(workspace_id, lead_installer_membership_id)`.
RLS bleibt Tabellen-RLS (keine neue Policy — Spalte, keine Tabelle).

## Validierung (fail-closed)

- Schreiben: `installation.write` (editor+, internalOnly); Lesen:
  `installation.read` (bestehende Gates, keine neue Permission).
- Membership fremd/leer/fehlend → Validation (kein stiller NULL-Fallback
  bei gesetzter ID; explizites Leeren erlaubt).
- Label (E-Mail) nur über bestehenden Read-Pfad (Join wie F9-Member-
  Options); kein PII-Leak über den Write-Pfad hinaus.

## Anzeige

Installations-Block „Lead Installer": aktuelle Zuordnung (Label oder
„nicht zugewiesen") + Select (Mitglieder) + Speichern (Server-Action,
Revalidate, Feedback); Viewer read-only (canWrite aus DTO).

## Akzeptanz

- DB: setzen/lesen/leeren-Roundtrip, fremde Membership wirft
  Validation, External/Viewer-Schreiben denied.
- E2E: Editor weist zu → Label sichtbar; Viewer sieht Label ohne Formular.
- Gates: migrate+tests grün, typecheck/lint/depcruise grün.

## Slice 2: Anlegen von der Tafel (Create-Pfad)

„＋" je Tageszelle (`?create=DATUM&member=ID`) öffnet ein
Server-formular: Datum (fix, aus der Zelle), Start-/Ende-Uhrzeit
(Berlin-Wanduhr), Titel, Projekt (Auswahl aus `project.read`-Optionen),
Typ, Kalender (Auswahl aus `listVisibleCalendars`), Teilnehmer = die
Zeilen-Membership (fix, kein Orakel über fremde Zeilen). Submit →
Server-Action (`appointment.write`, editor+, internalOnly) →
`executeProjectAppointmentCommand` (echter Pfad, inkl. Konflikt-/
Guard-Fehler) → Revalidate + Erfolgsmeldung; Fehler fail-closed
(ungültig/Konflikt/verweigert/nicht gefunden). Read-only-Akteure sehen
keine „＋"-Links (canWrite aus dem Query). Keine neue Permission, keine
Migration. Unbekannte/wochenfremde `create`-Params → kein Formular
(tolerant wie ?week=).

## Ziel und Abgrenzung

Modulkatalog F7.5 verlangt eine Plantafel: Ressourcen-Grid je
Person/Team, Drag-to-create, Event-Drawer mit Projekt-Link, zweistufige
Zuweisung. Bestand: `project_appointment` (+ Attendees, Kalender-Scopes)
existiert, aber keine Tafel-Ansicht (null Treffer „Plantafel" im Code).
Dieser Slice 1 liefert den durchgängigen **Lesepfad**: Wochengrid aus
bestehenden Terminen + Event-Drawer mit Projekt-Link. Kein Drag-to-create,
keine Zuweisungs-Schreibpfade (Folgeslice); keine Team-Entität (Kalender-
`team_id` bleibt nullable bis zum Team-Slice — Spec-Präzedenz M1-15b §4.1).

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F7.5 (s. Ziel).
- Exakte Reonic-Darstellung UNKNOWN; Grid als ESTIMATE im bestehenden
  Server-Render-Muster (GET, ?week=, ?event=), keine behauptete
  Reonic-Parität der Optik.

## Datenmodell (keine Migration)

Nur Lese-Contract auf bestehenden Tabellen (`project_appointment`,
`project_appointment_attendee`, `membership`, `user_identity`,
`calendar`, `project`): `weekStart` (Kalendertag `YYYY-MM-DD`,
Montag der Berlin-Woche), Rows je Membership (`membershipId`, Label =
E-Mail wie F9-Member-Options), Zellen je Tag mit überlappenden Terminen
(Titel, Berlin-Zeit, Ort, Typ, `projectId` + Projektname, Kalendername).

## Validierung (fail-closed, keine stillen Defaults)

- Neue Lesegrants: keine. Service gatet `appointment.read`
  (viewer+, internalOnly — extern wirft `PermissionDeniedError`).
  Sichtbarkeit je Termin exakt wie `listUpcomingAppointments`:
  `public._m115_actor_can_read_appointments(workspace_id)` +
  `calendarVisibleFragment` (kein Termin-Orakel).
- `weekStart` fehlt/ungültig → Service-Validation wirft; Seite fällt
  tolerant auf die laufende Woche zurück (F9-Listen-Präzedenz).
- `?event=` unbekannt oder unsichtbar → Drawer zeigt „nicht verfügbar"
  (kein Unterschied sichtbar/unsichtbar — kein Orakel).
- Wochenbereich: Montag 00:00 → Folgemontag 00:00 Europe/Berlin;
  Überlappung `start_at < wochenEnde AND end_at > wochenBeginn`;
  mehrtägige Termine erscheinen an jedem überlappten Tag.

## Berechnung/Anzeige

- Route `app/w/[workspaceId]/plantafel/page.tsx`: Wochennavigation
  (Zurück / Diese Woche / Weiter via `?week=`), Tabelle Mitglieder ×
  7 Tage, Event-Chips verlinken `?week=&event=`, Drawer mit Details +
  Projekt-Link, ehrliche Leerzustände („Keine Termine diese Woche",
  „Keine Mitglieder").
- Team-Gruppierung: eine Gruppe „Team" (keine Team-Entität); explizit
  dokumentiert, kein erfundenes Team.

## Akzeptanz

- DB: Wochenschnitt (Mo–So Berlin), Attendee-Zuordnung,
  Mehrtag-Termin an jedem Tag, unsichtbarer Kalender ausgeblendet,
  External denied, ungültiges Datum wirft Validation.
- E2E: Editor sieht Seed-Termin im Grid, Drawer öffnet mit
  Projekt-Link, Wochennavigation filtert heraus; keine Konsolenfehler.
- Gates: lint/typecheck/depcruise + CI grün; keine Migration, keine
  neuen Berechtigungen.
