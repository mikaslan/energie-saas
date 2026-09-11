# F13-10 Kundenchat zur Förderakte

Dritter fehlender durchgängiger Katalogpfad (Katalog F10.2: „KfW (mit
Chat …)“; M13-Grundmuster: „Chat mit typisierten Datei-Slots“ —
Datei-Slots existieren bereits als aktenverknüpfte Datei-Anfragen,
F13-07): Nachrichten zur Förderakte je Projekt, beide Richtungen
(intern ↔ Kunde). E-Mail je Übergang bleibt wie überall am fehlenden
Provider hängen (RESEND_API_KEY externer Blocker) — der Chat ist
rein in-App, kein Versand. Kein Reonic-Referenzbeleg; Verhalten ist
reversible eigene Näherung (ESTIMATE).

## Vertrag

- `subsidy_case_message` (Migration 0119, Muster file_request):
  `workspace_id`, `project_id`, `subsidy_case_id` (Akte des Projekts),
  `author_side` (`internal | customer`), `body` 1–2000 Zeichen,
  getrimmt, keine Steuerzeichen (DB-CHECK + Zod), `created_by`
  nullable (Kunde hat keine Identität), `created_at`.
- Genau eine Akte je Projekt (v1-Grenze wie F13-03); Nachricht ohne
  passende Akte/Projektbindung scheitert fail-closed (NotFound statt
  Orakel, Muster F13-07).
- Intern: Lesen `installation.read`, Schreiben `installation.write`
  (keine neue Permission). Kunde: Token-Kapsel
  `post_subsidy_message(bytea, uuid, text)` (Muster
  `confirm_service_case`, F13-06) — nur bei gültigem Invite, Text
  validiert in der Kapsel.
- Resolver (`resolve_portal_public_view`) projiziert
  `subsidy.messages` als Liste `{side, body, at}` (nie IDs/Akteure;
  BzA-Nummer bleibt wie bisher ausgeschlossen). Parse fail-closed.
- RLS tenant_isolation + FORCE (M1-CRM-Muster).

## Regeln

1. Portal-Förder-Tab: Verlauf (älteste zuerst) + Antwortfeld
   (max 2000, POST per Token-Route, Redirect mit Hinweis).
2. Interne Aktenansicht: Verlauf mit Seiten-Kennzeichnung + Antwortfeld.
3. Leere/fremde/entzogene Token → identischer 404-Endzustand (kein
   Orakel, Muster F10.1).
4. Viewer read-only (intern), kein Schreiben ohne `installation.write`.

## Tests

- DB (`f1310-subsidy-chat`): Post beider Seiten, Validierung
  (leer/zu lang/Steuerzeichen/fremde Akte), Mandantentrennung,
  Portal-Projektion enthält Nachrichten ohne IDs.
- E2E (`F13-10-E2E-01`): Editor schreibt intern → Portal zeigt die
  Nachricht; Kunde antwortet im Portal → intern sichtbar; keine
  Browser-Fehler.
