# F13-05 Portal-Aktivierung bei BzA-Versand (Katalog F13.2-Folge)

Ziel: Der BzA-Versand aktiviert das Kundenportal als Nebeneffekt —
beim Übergang nach `bza_eingereicht` entsteht automatisch ein aktiver
Portal-Link, wenn keiner (mehr) gültig ist. Der Link erscheint einmalig
in der Transitions-Rückmeldung (Muster F10-01-Einmalanzeige); danach
trägt die Kundenportal-Sektion den aktiven Stand. Bauarbeit, kein
Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)

- Auslöser: jede Transition mit Ziel `bza_eingereicht` (Erstversand aus
  `vorbereitung`, Wiedereinreichung aus `korrektur`). Andere Ziele:
  `not_applicable`, kein Portal-Kontakt.
- Bestandsschutz: aktives, noch nicht abgelaufenes Invite wird
  wiederverwendet (`already_active`, kein Token-Umlauf). Abgelaufenes
  `active`-Invite zählt als fehlend und wird atomar abgelöst
  (F10.1-Supersede im gleichen Aufruf).
- Berechtigung: KEINE neuen Keys. Der Nebeneffekt prüft
  `project.write` + intern (Spiegel von `requireInternalAccess`) und
  erzeugt mit `PORTAL_TTL_DAYS_DEFAULT` (14 Tage, F10-01-Entscheidung).
  Fehlt das Recht, gelingt die Transition trotzdem; die Rückmeldung
  meldet `not_permitted` ehrlich statt still zu überspringen.
  Derzeit unerreichbar (installation.write/project.write teilen
  minRole editor ohne Capability), fail-closed für künftige Trennung.
- Race: zwei gleichzeitige Versände erzeugen je ein Invite; das zweite
  löst das erste atomar ab (F10.1) — Endzustand genau ein aktives
  Invite, kein Fehler.
- Token-Disziplin: Token nur in der einmaligen Rückmeldung, nie in
  Event-Payload, Audit-Details oder DTO-Persistenz (create-Aufruf
  protokolliert nur inviteId/projectId/expiresAt, Muster F10-01).
- Atomar: Nebeneffekt läuft in derselben Transaktion wie die
  Transition. Persistenz-/Integritätsfehler rollen den Versand zurück
  (kein halb aktivierter Stand); nur PermissionDenied wird zu
  `not_permitted` statt Fehler.

## Scopes

1. Service `subsidy-cases`: Aktivierungsblock in
   `transitionSubsidyCase` (nur öffentliche `modules/portal`-API,
   kein Zyklus), DTO-Feld `portalActivation { outcome, token }`,
   Ereignis-Payload trägt nur das Outcome.
2. Server-Action: Rückmeldung je Outcome (`created` mit einmaligem
   `/p/<token>`, `already_active`, `not_permitted`, Standard).
3. Keine Migration, keine Rollen-Pins (keine neuen Rechte/Tabellen).

## Geschlossene Testmatrix

- `F1305-DB-01`: Versand ohne Invite → `created`, Invite aktiv,
  Token löst per `resolvePortalByToken` auf das Projekt auf.
- `F1305-DB-02`: Versand mit aktivem Invite → `already_active`,
  gleiche inviteId, kein Token, keine zweite aktive Zeile.
- `F1305-U-01`: Bestandsprädikat (fehlend/künftig/abgelaufen/
  exakt-jetzt/Fehlform, Grenze strikt künftig, Fehlform fail-closed).
  DB-Seed abgelaufener `active`-Zeilen verbietet der F10-01-Guard
  (`expires_at <= statement_timestamp()`); der Zustand entsteht nur
  durch echten Zeitablauf ohne Besuch.
- `F1305-DB-03`: Storno → `not_applicable`, kein Invite.
- `F1305-E2E-01`: Akte → BzA einreichen → Rückmeldung zeigt
  einmalig `/p/…` → Portal-Übersicht zeigt „BzA eingereicht (BAFA)".

## Bewusst offen

- Kunden-Rückmeldung, BnD-Beleg-Upload, Angebotsbindung,
  AI-Vorschlag (Rest F13.2).
