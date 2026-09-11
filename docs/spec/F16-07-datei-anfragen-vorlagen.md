# F16-07 Datei-Anfragen-Vorlagen

Nächster fehlender Vorlagentyp der F16.3-Liste (nach Rabatt, Förderung,
Checkliste, Task/F16-04, Termin/F16-05, Angebot/F16-06):
Datei-Anfragen-Vorlagen — Titel-Preset + optionale Beschreibung, Anwenden
am Projekt legt eine offene Datei-Anfrage an. Planungs- und
E-Mail-Vorlagen bleiben getrennte Slices.

## Vertrag

- `file_request_template`: `id`, `workspace_id`, `name` (1–200,
  normalisiert unique je Workspace unter aktiven), `title` (1–160),
  `description` (optional, 1–2000), `position`, `active`, `created_by`,
  `updated_by`, Timestamps. Archiv statt Delete (F7.3/F16.3-Muster).
- Anwenden: `templateId`, `projectId` → Datei-Anfrage mit Titel-Preset
  (Status offen, keine Akten-Verknüpfung — v1-Scope, explizit; BnD-Belege
  bleiben manuell).
- Keine neuen Permissions: `project.read` (Liste),
  `project.write` (CRUD + Anwenden).

## Regeln

1. CRUD/Archiv/Restore spiegeln F16-05 (Konflikt bei normalisiertem
   Duplikat, Validation fail-closed, NotFound bei Archiv-Anwendung).
2. Anwenden: nur aktive Vorlage; Fehler des File-Request-Pfads
   (Projekt fehlt etc.) laufen als `invalid`/`not_found` durch.
3. Löschen gibt es nicht. Events/Audit je Mutation
   (`file_request_template.created/updated/archived/restored/applied`).
4. Mandantenisolation: RLS `tenant_isolation` + FORCE.

## UI

- Einstellungen `datei-anfragen-vorlagen`: Verwaltung wie
  Termin-Vorlagen (Name, Anfrage-Titel, Beschreibung, Reihenfolge).
- Projekt-Datei-Bereich: „Aus Vorlage anlegen“ (Vorlagen-Auswahl, nur
  `project.write`).

## Tests

- DB (`f1607-file-request-templates`): CRUD, Duplikat, Archiv-Sperre,
  Restore + Anwenden (Titel/Status offen/keine Akten-Bindung), Viewer
  fail-closed, Isolation.
- E2E (`F16-07-E2E-01`): Editor legt Vorlage an und wendet sie an
  (Anfrage mit Titel-Preset, Status Offen, sichtbar).
