# F13-06 Service-Sicht + Kundenbestätigung im Portal (Katalog F13.2-Folge)

Ziel: Aktive Portal-Links zeigen die Servicevorgänge des Projekts; der
Kunde bestätigt erledigte Vorgänge („zur Kenntnis genommen"). Zweiter
anonymer Schreibpfad des Portals nach F10-04-Upload (Muster
`fulfill_file_request`). Bauarbeit, kein Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)

- Projektion `service`: Vorgänge mit Status open/in_progress/done
  (id, title, status, dueDate, completedAt, confirmedAt), sortiert nach
  Anlage. `cancelled` bleibt intern (kein Kundenhandlungsbedarf);
  `description` wird nie projiziert (F10.2-Privacy-Präzedenz: Freitext
  kann interne Notizen tragen).
- Bestätigung nur an `done` + unbestätigt: `confirm_service_case`
  setzt `confirmed_at` atomar (Invite-Bindung: Mandant + Projekt aus
  dem Invite, nie aus dem Request). `done` + bestätigt → `already`
  (idempotent, kein Fehler). Alles andere (unbekannt/deformiert/
  entzogen/abgelaufen/fremd/nicht-done) → uniform `not_found`
  (kein Orakel über Existenz oder Stand).
- Spalte `service_case.confirmed_at` (NULL-Default) + CHECK
  (`confirmed_at IS NULL OR status = 'done'`; done ist terminal,
  kein Rückpfad nötig). Ereignis `service_case.confirmed`
  (Aggregat project, Actor system, nur caseId/inviteId — Muster
  `file_request.uploaded`).
- Berechtigung: KEINE neuen Keys. Lesen via DEFINER-Resolver
  (SELECT-Grant service_case an app_owner, Muster 0106); Schreiben via
  DEFINER-Funktion + Owner-Tanz (Muster 0104), EXECUTE nur für die
  Migrationsrolle.
- Token-Disziplin: Route statt Server-Action (Muster F10-04-Upload,
  ohne-JS-fähig); Ergebnis per `?confirm=` (ok/bereits/fehler),
  kein Token in Event/Audit.

## Scopes

1. Migration 0107 (Spalte + CHECK, resolve-Rewrite Muster 0106 mit
   `service_case_list`-Marker, `confirm_service_case` + Owner-Tanz
   Muster 0104, Grants, Rollen-Pins + Journal-Pins nachgezogen).
2. Vertrag: `portalServiceCaseSchema` + Parse-Allowlist (Muster
   `portalSubsidySchema`).
3. Service `confirmServiceCaseByToken` (Pool, Token-Kapsel-Muster;
   Rückgabe-Union ok/already, NotFound/Validation als Fehler).
4. Portal-Übersicht: Serviceblock (Stand je Vorgang, Confirm-Formular
   nur an done-unbestätigt, Test-IDs) + Route
   `app/p/[token]/service-cases/route.ts`.
5. Interne Service-Sektion: Bestätigungs-Badge an done-Vorgängen
   (reine Wertdarstellung, DTO-Feld `confirmedAt`).

## Geschlossene Testmatrix

- Contract: vollständig ok; fremde Schlüssel/Status/cancelled →
  null (Allowlist fail-closed).
- `F1306-DB-01`: Resolve projiziert open/done mit Titel/Stand/Zeiten,
  ohne description; stornierte Vorgänge fehlen.
- `F1306-DB-02`: Confirm an done → ok + confirmedAt; wiederholt →
  already; an open/fremd/unbekannt → NotFound (uniform).
- `F1306-E2E-01`: Vorgang anlegen → erledigen → Portal zeigt „Erledigt"
  → „Zur Kenntnis nehmen" → intern Badge „Kunde bestätigt".

## Bewusst offen

- BnD-Beleg-Upload (file-requests-Anbindung), Angebotsbindung
  BzA-Phase, AI-Vorschlag (Rest F13.2).
- Storno-Begründung für den Kunden, Wartungsverträge/Intervalle,
  SLA-/Reaktionszeit-Regeln (F13-01-Offenpunkte).
