# F16-05 Termin-Vorlagen

Nächster fehlender Vorlagentyp der F16.3-Liste (nach Rabatt, Förderung,
Checkliste, Task/F16-04): Termin-Vorlagen — Titel-Preset + Standarddauer,
Anwenden am Projekt mit Startzeitpunkt und Kalender. Angebots-, Planungs-,
E-Mail- und File-Request-Vorlagen bleiben getrennte Slices.

## Vertrag

- `appointment_template`: `id`, `workspace_id`, `name` (1–200, normalisiert
  unique je Workspace unter aktiven), `title` (1–200), `duration_minutes`
  (1–2880), `position`, `active`, `created_by`, Timestamps. Archiv statt
  Delete (F7.3/F16.3-Muster).
- Anwenden: `templateId`, `projectId`, `calendarId`, `start` (Berliner
  Wanduhrzeit `YYYY-MM-DDTHH:mm`, floating wie Appointment-Vertrag);
  Ende = Start + Dauer. Teilnehmer: keine (v1-Scope; explizit).
- Keine neuen Permissions: `appointment.read` (Liste),
  `appointment.write` (CRUD + Anwenden). Sichtbarkeitsregeln für Kalender
  gelten beim Anwenden wie beim manuellen Anlegen (`validateCalendar`).

## Regeln

1. CRUD/Archiv/Restore spiegeln F16-04 (Konflikt bei normalisiertem
   Duplikat, Validation fail-closed, NotFound bei Archiv-Anwendung).
2. Anwenden: nur aktive Vorlage; Start muss gültige Berliner Wanduhrzeit
   sein (DST-Lücke fail-closed wie Appointment-Vertrag); Dauer aus Vorlage;
   Fehler des Appointment-Pfads (Kalender unsichtbar etc.) laufen als
   `invalid`/`not_found` durch.
3. Löschen gibt es nicht. Events/Audit je Mutation
   (`appointment_template.created/updated/archived/restored/applied`).
4. Mandantenisolation: RLS `tenant_isolation` + FORCE.

## UI

- Einstellungen `termin-vorlagen`: Verwaltung wie Aufgaben-Vorlagen
  (Name, Termin-Titel, Dauer in Minuten, Reihenfolge).
- Projekt-Kalenderbereich: „Aus Vorlage anlegen" (Vorlage + Beginn +
  Kalender, nur `appointment.write`).

## Tests

- DB (`f1605-appointment-templates`): CRUD, Duplikat, Archiv-Sperre,
  Anwenden (Titel/Dauer/Ende = Start + Dauer), DST-Lücke fail-closed,
  Viewer fail-closed, Isolation.
- E2E (`F16-05-E2E-01/02`): Editor legt Vorlage an und wendet sie an
  (Termin mit Titel/Dauer sichtbar); Viewer lesend.
