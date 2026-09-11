# F10-09 Portal-FAQ je Installationsstand

Zweiter fehlender durchgängiger Katalogpfad im Portal (Katalog F10.2:
„Installations-Fortschritt (… FAQ je Status)“): Admins pflegen je
Workspace eine Kunden-FAQ pro Installationsstand; das Kundenportal zeigt
sie im Installation-Tab unter dem aktuellen Stand. Baut auf F10-05
(Statusmapping: gleiche Schlüssel, gleiche Seite, gleiche Rechte).
Kein Reonic-Referenzbeleg; Verhalten ist reversible eigene Näherung
(ESTIMATE). FAQ-Texte sind Admin-Autorenschaft (kein Reonic-Text).

## Vertrag

- `portal_status_faq` (Migration 0118, Muster 0113): je Workspace genau
  eine FAQ je `(scope, source_key)`; Scope-Allowlist `installation`,
  Schlüssel-Allowlist `active | completed | handover`; FAQ 1–2000
  Zeichen, getrimmt, keine Steuerzeichen (DB-CHECK + Zod, einzeilig
  wie Labels).
- Bedeutung der Schlüssel wie F10-05 (`active` = laufend,
  `completed` = abgeschlossen ohne Abnahme, `handover` = mit Abnahme).
- Fehlende Zeile = keine FAQ-Anzeige (ehrlicher Fallback, kein
  Standardtext — anders als Labels gibt es keinen sinnvollen Default).
- Resolver (`resolve_portal_public_view`, SECURITY DEFINER) projiziert
  `installation.statusFaq` als Override-Objekt (nur gesetzte Schlüssel,
  nie interne IDs/Namen). Parse fail-closed wie bisher.
- Keine neuen Permissions: Lesen `installation.read`, Schreiben
  `installation.write` (Editor+). Viewer read-only.

## Regeln

1. Einstellungen-Seite `einstellungen/portal-status`: je Stand ein
   Textarea (max 2000) mit Speichern + Zurücksetzen (Zeile löschen).
   Crafted Form-Werte → invalid (Zod + DB-CHECK).
2. Portal-Installation-Tab: FAQ genau des aktuellen Stands, sonst
   nichts. Unverändert ohne Mapping (kein leerer Block).
3. Admin-Texte werden je Sprache unverändert gezeigt (wie Labels:
   keine Übersetzung von Autorenschaft).
4. RLS tenant_isolation + FORCE (M1-CRM-Muster); DEFINER-Grant nur
   SELECT für den Resolver.

## Tests

- DB (`f1009-portal-status-faq`): Upsert-Roundtrip je Schlüssel,
  Validierung (leer/zu lang/Steuerzeichen/unbekannter Schlüssel),
  Mandantentrennung, Portal-Projektion enthält Overrides und fällt
  ohne Mapping auf `{}`.
- E2E (`F10-09-E2E-01`): Editor setzt FAQ in den Einstellungen →
  Portal-Installation-Tab zeigt sie unter dem Stand; Zurücksetzen →
  kein FAQ-Block; keine Browser-Fehler.
