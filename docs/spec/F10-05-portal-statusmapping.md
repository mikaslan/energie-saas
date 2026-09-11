# F10-05 Portal-Statusmapping (Installation-Umfang)

Erster fehlender durchgängiger Katalogpfad im Portal (F10-03-Code
markiert „Admin-Mapping je Status bleibt offen“): Admins pflegen je
Workspace kundenlesbare Bezeichnungen für den Installationsstand; das
Kundenportal zeigt sie statt der festen Standardtexte. Kein
Reonic-Referenzbeleg; Verhalten ist reversible eigene Näherung
(ESTIMATE).

## Vertrag

- `portal_status_label` (Migration 0113): je Workspace genau eine
  Bezeichnung je `(scope, source_key)`; Scope-Allowlist `installation`,
  Schlüssel-Allowlist `active | completed | handover`; Label 1–80
  Zeichen, getrimmt, keine Steuerzeichen (DB-CHECK + Zod).
- Bedeutung: `active` = laufende Installation („In Ausführung“),
  `completed` = abgeschlossene ohne Abnahme („Abgeschlossen“),
  `handover` = abgeschlossene mit Abnahme („Abgenommen“). Datums-
  suffixe („am …“) baut die Seite wie bisher an, nur das Wort stammt
  aus dem Mapping.
- Ungemappte Schlüssel → Standardtexte (ehrlicher Fallback, kein
  leeres Label). Mapping ist reine Darstellung, kein Statusübergang.
- Resolver (`resolve_portal_public_view`, SECURITY DEFINER) projiziert
  `installation.statusLabels` als Override-Objekt (nur gesetzte
  Schlüssel, nie interne IDs/Namen). Parse fail-closed wie bisher.
- Keine neuen Permissions: Lesen `installation.read`, Schreiben
  `installation.write` (Editor+).

## Regeln

1. Einstellungen-Seite `einstellungen/portal-status`: drei Zeilen mit
   Standard-Hinweis, Textfeld (max 80), Speichern + Zurücksetzen auf
   Standard (Zeile löschen). Viewer read-only.
2. Unbekannte Scope-/Schlüssel-Werte scheitern fail-closed (Zod +
   DB-CHECK); crafted Form-Werte → invalid.
3. Portal liest nur Overrides; ohne Mapping bleibt die Anzeige
   bytegleich zur bisherigen.
4. RLS tenant_isolation + FORCE (M1-CRM-Muster); DEFINER-Grant nur
   SELECT für den Resolver.

## Tests

- DB (`f1005-portal-status-labels`): Upsert-Roundtrip je Schlüssel,
  Validierung (leer/zu lang/Steuerzeichen/unbekannter Schlüssel),
  Mandantentrennung, Portal-Projektion enthält Overrides und fällt
  ohne Mapping auf `{}`.
- E2E (`F10-05-E2E-01`): Editor setzt Bezeichnung in den Einstellungen
  → Portal-Installation-Tab zeigt sie; Zurücksetzen → Standardtext
  wieder sichtbar; keine Browser-Fehler.
