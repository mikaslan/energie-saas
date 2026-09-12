# F12-02 — Kampagnen-Auto-Routing (intern, ohne öffentliches Frontend)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02`
Nachweis: DB 6/6, E2E 1/1 (lokal beobachtet); Nachbarn 86/86 inkl.
Invarianten + m111a-Pins; Rollenvertrag grün (keine neue Tabelle).
Katalog: F12.2 („Varianten pro Kampagne: zugewiesener User =
Auto-Routing"). Baut auf F12-01 auf. Keine behauptete Reonic-Parität;
Näherungen als ESTIMATE, REVIEW-pflichtig.

## Ziel und Abgrenzung

F12-01 attributiert (Quelle + Kampagne), weist aber nichts zu; die
bestehenden Routing-Regeln (F1-10) sind nur Vorschläge. Dieser Slice
macht die Kampagnen-Zuweisung wirksam: Wer eine Anfrage mit Kampagne
erfasst, deren Kampagne einen Beauftragten trägt, bekommt das Projekt
automatisch als Key Account zugewiesen — sichtbare, auditierte
Systemwirkung, kein stiller Default.

Berechtigungsmodell (fail-closed, KEINE neuen Keys): Der Beauftragte
wird unter `lead_source.write` in der Kampagnen-Konfiguration
festgelegt (Verwaltung). Die Erfassung braucht weiter nur
`project.write`; die Zuweisung ist Regelvollzug (wie ein Trigger),
kein Zuweisungsrecht des Erfassers — aber vollständig belegt:
`project.assignment_key_account_changed`-Event (mit
`autoRouted: true`) + `project.assign`-Audit, Akteur = Erfasser.
Ohne Zuweisungs-Konfiguration (NULL) passiert nichts (F12-01-
Verhalten, abwärtskompatibel).

Bewusst NICHT in diesem Slice: öffentliche Funnel-Screens/Embed
(Q-F12-FUNNEL-REFERENZ), Provider-Webhooks (Q-F12-PROVIDER-PRIVACY),
 nachträgliches Ändern des Beauftragten (unveränderlich wie die
Quelle — Archiv + Neuanlage), Erinnerungsmails, Partnerlogo.

## Datenmodell (Migration 0126, additiv)

- `funnel_campaign.assignee_membership_id` NULLABLE + composite-FK
  `(workspace_id, assignee_membership_id)` auf
  `membership(workspace_id, id)`, RESTRICT (wie
  `project_lead_routing_rule_membership_fk`: kein stilles Lösen —
  Offboarding einer referenzierten Mitgliedschaft wird blockiert,
  konsistent zu Routing-Regeln).
- Keine Änderung an `project`/`project_assignment` (Wiederverwendung).

## Validierung (fail-closed)

- Anlegen: Beauftragter optional; wenn gesetzt, muss die Mitgliedschaft
  im Workspace existieren (sonst `FunnelCampaignAssigneeNotFoundError`,
  Action → `invalid`). Unveränderlich danach (kein Update-Pfad —
  wie Quelle in F12-01).
- Erfassung: Kampagne mit Beauftragtem → nach Projekt-Insert:
  `project_assignment`-Insert (key_account) + `assignment_revision = 1`
  (Projekt ist neu, keine Konkurrenz möglich) + Event + Audit wie oben.
  Mitgliedschaft im selben Zug erneut geprüft (Race) — fehlt sie,
  wird die gesamte Erfassung verweigert (`FunnelCampaignValidationError`,
  kein Projekt ohne zugesagte Zuweisung). Kampagne ohne Beauftragten →
  exakt F12-01 (Revision bleibt 0, kein Event).
- Listen: DTO trägt `assignee: { membershipId, label } | null`
  (Label = Mitglieder-E-Mail wie Routing-Regeln).

## Anzeige

- Kampagnen-Verwaltung: Beauftragten-Dropdown (alle Mitglieder,
  `listRoutableMembers`, „Keine automatische Zuweisung"); Liste zeigt
  Beauftragten.
- Manuell-Formular: Kampagnen-Option um Zuweisung ergänzt
  („Name · Quelle · Zuweisung: E-Mail" bzw. ohne).
- Projektakte: Zuweisung steht im bestehenden Zuweisungs-Abschnitt
  (kein neues UI — wiederverwendet).

## Akzeptanz

- DB: Beauftragter fremd/fehlend verweigert; Erfassung mit Beauftragtem
  → key_account + Revision 1 + Event (`autoRouted: true`) + Audit;
  ohne Beauftragten → Revision 0, kein Assignment-Event;
  Offboarding des Beauftragten per RESTRICT blockiert (23001);
  Archiv-Regeln unverändert.
- E2E (isoliert): Kampagne mit Beauftragtem → manuelle Anfrage →
  Projektakte zeigt Key Account; Axe sauber.
- Gates: lint/typecheck/test + CI grün; keine neuen Permissions
  (`lead_source.read/write`, `project.write` wie F12-01).
