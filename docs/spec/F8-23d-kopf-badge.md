# F8-23d — Detail-Kopf Status-Badge

Vierter F8-23-Folgeslice (klein, UI-only): Detail-Kopf zeigt Status nur
als Text-Label — kein Badge, kein Sent-Zustand im Kopf (Nachweis erst
weiter unten im Versand-Panel). Badge im Kopf für Sofort-Sichtbarkeit.

## Umfang

- Status-Badge neben `h1` in `[documentId]/page.tsx`
  (`data-testid="document-status-badge"`), Mapping (DECIDED):
  `draft` → „Entwurf“, `issued` ohne `sentAt` → „Ausgestellt“,
  `issued` mit `sentAt` → „Versendet“, `voided` → „Storniert“.
- Datenquelle: `document.status` + `document.sentAt` (bereits geladen,
  kein Backend-Touch, keine neue Query).
- Text-Label-Zeile („Status“-`dt`/`dd`) bleibt unverändert (DECIDED —
  kein Bruch bestehender Tests/Leser).
- Styling-Spiegel `invoice-kind-badge` (existierendes Badge-Muster).

## Nicht-Umfang

- Kein Backend, keine Migration, keine Capability-Änderung.
- Keine Panel-Änderungen, keine neuen Aktionen.
- Kein Provider-/F8.7-Scope.

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F823D-UI-01 | Badge-Mapping alle 4 Fälle (draft/issued/sent/voided) | UI-Contract-Tests |
| F823D-E2E-01 | Badge im Kopf sichtbar (issued + versendet) | E2E-Test |
