# F10-03 Installation-Tab ( consuming F7.1/F7-05-Projektion, read-only)

Ziel: Der Portal-Tab „Installation" zeigt den Ausführungsstand des
Projekts — aus eigenen Daten, ohne neue Belegtypen, ohne
Kunden-Schreibpfad. Folgt auf F10.2 (Übersicht/Termine,
Signatur-Status).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `resolve_portal_public_view` projiziert zusätzlich
  `installation` (Migration 0091, Funktionsersatz im
  0059/0062-Muster, Funktions-Hash im Rollenvertrag nachgezogen).
- Inhalt: genau eine Zeile je Projekt (`installation_ws_project_uq`):
  `status` (`active`/`completed`), `completedAt`, `handoverAt`
  (Abnahme-Datum). Keine Namen, keine Notizen, keine
  Offer-/Varianten-Referenzen (Privacy wie Termin-Description).
- Kein Projekt-Installation → `installation: null`, ehrlicher
  Leerzustand („Noch keine Installation hinterlegt.").
- Anzeige-Mapping fest versioniert: `active` → „In Ausführung",
  `completed` ohne Abnahme → „Abgeschlossen", `completed` mit
  Abnahme → „Abgenommen am …". Admin-Mapping je Status (Katalog)
  bleibt offen.
- Exakte Reonic-Darstellung UNKNOWN; Layout ESTIMATE, nur
  gespeicherte Werte.

## Scopes
1. Migration + Projektion (`installation` oder null), fail-closed
   (unbekannt/entzogen → weiter `not_found`, kein Orakel).
2. `PortalPublicViewV1.installation` (nullable) + Parser.
3. Portal-UI: Tab „Installation" per `?tab=installation`
   (Server-Links ohne JS; unbekannter Wert fällt wie bisher auf
   Übersicht zurück). Tabs unverändert sonst.
4. Sichtbarkeit: nur per gültigem Portal-Token (öffentlich,
   kein Konto); keine neue Permission.

## Geschlossene Testmatrix
- `F1004-DB-01`: Projektion mit Installation (active/completed +
  Abnahme) und ohne (null); keine Namen/Notizen im JSON.
- `F1004-RBAC-01`: entzogener Link → weiter `not_found`.
- `F10-03-E2E-01`: Tab öffnen → Status sichtbar; Projekt ohne
  Installation → Leerzustand (lokal beobachtet).

## Bewusst offen
- Admin-Mapping interner Status auf Kundennamen + Sichtbarkeit,
  FAQ je Status, KfW-/Netzanmeldung-Tabs, My Files, File Requests.
