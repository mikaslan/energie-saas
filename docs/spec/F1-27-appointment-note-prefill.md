# F1-27 Termin-Notiz-Übernahme („Als Notiz übernehmen")

Lane `codex/muse-fleet-6e-f1crm` (Agent 6E). KEINE Migration (erwartet).
Kalender×Notizen-Nahtstelle. Providerfrei.

## DISCOVERED (W1-D2, Code-verifiziert)

- Termine und Notizen sind unverbunden (kein FK, kein Link, keine Übernahme);
  Besprechungs-Ergebnisse müssen manuell abgetippt werden.
- Beide Schreibpfade existieren (`create_appointment`, `create_note`); es fehlt
  nur die UI-Brücke mit Prefill.

## SPECIFIED

- Termindialog (Projektakte): Button „Als Notiz übernehmen" (nur mit
  `note.write`, sonst unsichtbar) → öffnet Notiz-Dialog mit Prefill:
  Markdown-Zitat aus Termin (Titel, Datum/Zeit Berlin-Wanduhr, Ort falls
  gesetzt, Link `#project-appointments`); Text editierbar, Speichern =
  normaler `create_note` (Revision 1, Mentions-Auflösung wie üblich).
- Plantafel-Drawer: derselbe Button (führt in die Projektakte zum Notiz-Dialog
  mit Prefill via URL-Param `?note=prefill-<appointmentId>`; Prefill-Text wird
  serverseitig aus lesbarem Termin gebaut — ohne appointment.read kein
  Prefill, ehrlich leerer Dialog).
- Kein Automatismus (kein Auto-Anlegen, kein Sync), kein neuer Command:
  ausschließlich Prefill + Bestands-`create_note`. Keine neue Permission.
- Nahtstellen-Fix (GREEN gefunden): Formulare übertragen LF als CRLF —
  `note-actions` normalisiert `textMarkdown` vor der kanonischen Validierung
  auf LF zurück, sonst scheitert jeder mehrzeilige Notiztext am Roundtrip.

## CONTRACTED

- EDIT (max): Termindialog-Komponente (Button), Notiz-Dialog (Prefill-Param),
  Plantafel-Drawer (Button + Param-Link), Projektakte (Prefill-Auflösung),
  STATUS (bei CLOSE).
- NEU (max): `tests/db/f127-appointment-note-prefill.test.ts` (Prefill-Builder
  + Guards — falls serverseitige Helper-Datei nötig, sonst UI-only + E2E),
  `tests/e2e/f1-27-termin-notiz.spec.ts`, diese Spec.
- Tests: E2E F1-27-E2E-01 (Termin → Übernehmen → Prefill sichtbar → speichern →
  Notiz mit Zitat da; ohne note.write kein Button; ohne appointment.read ehrlich leer);
  DB nur falls Helper gebaut wird.
- Nachbarn: f109, m115-Service, f0705.
- NICHT: Auto-Protokolle, Sync, Versand (Provider — VERBOTEN).
