# F16-10 E-Mail-Vorlagen

Letzter fehlender Vorlagentyp der F16.3-Liste (nach Angebot, Planung,
Rabatt, Förderung, Checkliste, Task/F16-04, Termin/F16-05,
Angebot/F16-06, Datei-Anfrage/F16-07, Planung/F16-08,
Förder-Preset-Kopplung/F16-09): E-Mail-Vorlagen — die 8 fixen
Kunden-Mail-Automatiken aus dem Katalog (New lead, Need information,
New/Edited proposal, File request, Signature completed, Portal link,
Cannot fulfil), editierbar, mit Variablen, nur 1 Sprachset (DE,
ESTIMATE).

v1-Scope ist bewusst nur die **Verwaltung** (Betreff/Text je Schlüssel,
Aktiv-Flag, Vorschau mit Beispielwerten). Der **Versand** bleibt ein
getrennter Slice — er braucht einen Provider (vgl. F10-08
Noop-Transport, Blocker RESEND_API_KEY) und ist hier fail-closed
dokumentiert, nicht implementiert.

## Vertrag

- `email_template`: `id`, `workspace_id`, `key` (einer von 8 fixen
  Schlüsseln, genau eine Zeile je Schlüssel je Workspace),
  `subject` (1–200), `body` (1–10000), `active`, `created_by`,
  `updated_by`, Timestamps. Archiv statt Delete (F7.3/F16.3-Muster):
  inaktiv = eingebaute Standardfassung gilt (ESTIMATE, greift erst mit
  künftigem Versand-Slice).
- Liste sät fehlende Schlüssel idempotent mit der eingebauten
  DE-Standardfassung (`ON CONFLICT DO NOTHING`, ein Statement,
  race-sicher); Seed ist kein Nutzer-Mutation und schreibt weder
  Event noch Audit.
- Aktualisieren: nur `subject`/`body` je Schlüssel.
  Unbekannter Schlüssel → NotFound (fail-closed).
- Variablen (ESTIMATE-Allowlist, dokumentiert):
  `customer_name`, `project_name`, `portal_link`, `company_name`.
  `renderEmailTemplate` ersetzt `{{name}}` strikt aus der Map;
  unbekannte Platzhalter bleiben literal stehen (Vorschau, kein
  Versandpfad).
- Keine neuen Permissions: `project.read` (Liste),
  `project.write` (Aktualisieren + Archiv/Reaktivieren).

## Regeln

1. CRUD/Archiv/Restore spiegeln F16-07 (Validation fail-closed,
   NotFound bei unbekanntem Schlüssel). Kein Duplikat-Konflikt by
   design (fixe Schlüssel, eine Zeile je Schlüssel).
2. Events/Audit je Nutzer-Mutation
   (`email_template.updated/archived/restored`), nie für Seed.
3. Mandantenisolation: RLS `tenant_isolation` + FORCE.
4. Versand, Provider, Sprachsets jenseits DE und Freigabe-Workflow
   sind explizit NICHT Teil dieses Slices.

## UI

- Einstellungen `e-mail-vorlagen`: alle 8 Schlüssel mit
  Betreff-/Text-Formular, Vorschau mit Beispielwerten (Mustermann),
  Archivieren/Reaktivieren — wie Termin-Vorlagen aufgebaut.

## Tests

- DB (`f1610-email-templates`): Seed-8-beim-Listen, Update,
  unbekannter Schlüssel NotFound, Archiv-Sperre/Restore, Viewer
  fail-closed, Isolation. Unit: Render (bekannte/ unbekannte
  Platzhalter, Mehrfachsetzung).
- E2E (`F16-10-E2E-01`): Editor ändert Betreff von `portal_link`,
  Erfolg sichtbar, nach Reload persistent, Vorschau zeigt
  Beispiel-Ersetzung.
