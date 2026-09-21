# F1-24 Kommunikations-Events im Projekt-Feed (Termine + Erwähnungen)

Lane `codex/muse-fleet-6e-f1crm` (Agent 6E). KEINE Migration (erwartet).
Providerfrei: nur Projektion bereits emittierter Domain-Events.

## DISCOVERED (W1-D1, Code-verifiziert)

- Projekt-Timeline (`project-activity-panel.tsx`): nur task_*/outcome_*/note_*
  (`modules/tasks/service.ts:165-181` `activityKinds`).
- `project.appointment_created/updated` werden emittiert (calendar/service),
  `project.note_mentioned` wird emittiert (notes/service:139/210) — beide NICHT
  im Feed projiziert.
- Katalog F1.9 „Kommunikationsbreite": ohne Provider bleibt read-only
  Aggregation — genau dieser Slice.

## SPECIFIED

- `activityKinds` += `project.appointment_created/updated` →
  `appointment_created/updated`, `project.note_mentioned` → `note_mentioned`
  (neue Kind-Sets + Guards im Bestandsmuster, Payload minimal: id + Zeit +
  Titel/Label, Links: Termin → `?event=`, Erwähnung → Notiz-Anker).
- Sichtbarkeit: Termin-Einträge nur mit `appointment.read` auf sichtbarem
  Kalender (kalenderVisibleFragment-Regel); Mention-Einträge nur mit
  `note.read` am Projekt; ohne Recht entfällt der Eintrag lautlos
  (ehrlich flach, kein Platzhalter, kein Orakel). External: Feed denied
  wie bisher (`requireActivityRead` bleibt geschlossen — KEINE
  Berechtigungs-Erweiterung; eine External-Feed-Öffnung wäre eigener
  Security-Slice mit Leitstand-Entscheid).
- Reihenfolge/Paginierung unverändert (occurred_at/id-Cursor).
- Keine neuen Permissions, keine Migration, keine Events (nur Projektion).

## CONTRACTED

- EDIT (max): `modules/tasks/service.ts` (Kinds + Projektion + Guards),
  Aufrufer-Typen falls nötig, `docs/parity/STATUS.md` (F1-Zeile bei CLOSE).
- NEU (max): `tests/db/f124-communication-feed.test.ts`,
  `tests/e2e/f1-24-kommunikations-feed.spec.ts`, diese Spec.
- Tests: DB (Termin-Eintrag im Feed, Mention-Eintrag, External ohne
  Termin-Sicht sieht ihn nicht, ohne note.read keine Mention-Zeile,
  Fremdtenant leer); E2E F1-24-E2E-01 (Termin anlegen + Mention schreiben →
  beide in Timeline sichtbar; Reload; keine Browser-Fehler).
- Nachbarn: f109 (Mentions), m115-Service, f0705, outcome/task-Feed-Tests.
- NICHT: Mail/Push-Benachrichtigung, Versand, Sync (Provider — VERBOTEN).
