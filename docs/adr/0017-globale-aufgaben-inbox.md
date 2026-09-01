# ADR 0017: Globale Aufgaben-Inbox als read-only Projektion

- Status: angenommen; lokal implementiert und verifiziert (nicht gepusht)
- Datum: 2026-09-01
- Bezug: `docs/spec/M1-12a-globale-aufgaben-inbox.md`

## Kontext

M1-10 besitzt bereits tenantgebundene Projektaufgaben mit CAS-Mutationen,
RLS/RBAC, Events, Audits und kontrollierter Erasure. Die öffentliche Reonic-
Dokumentation beschreibt zusätzlich eine globale Aufgabenliste mit Scope-,
Fälligkeits-, Status- und Suchfiltern. Eine zweite globale Taskwahrheit würde
Aggregate, Rollen und Datenschutzgrenzen unnötig verdoppeln.

## Entscheidung

M1-12a ist eine ausschließlich interne, read-only Workspace-Projektion über
bereits vorhandene, aktive `project_task`-Aggregate. Sie führt weder Tabellen
noch Mutationscommands ein. Jede Mutation bleibt im bestehenden Projektdetail
und läuft unverändert durch den M1-10-Vertrag.

Die Projektion besitzt einen autoritativen Runtime-Vertrag mit strikt
geschlossenen Queryfiltern, minimiertem DTO, kontrollierten Fehlercodes und
einem opaken, vollständig gebundenen Keysetcursor. Der Actor-/Workspace-Kontext
kommt ausschließlich aus der autorisierten Session. Der Cursor bindet diesen
Workspace-, Actor- und Membership-Kontext sowie alle sichtbaren Filter,
ersetzt jedoch nie RLS oder `task.read`.

Fälligkeitsgrenzen verwenden vorerst fest `Europe/Berlin` und ein auf Seite 1
erfasstes `asOf`; Folgeseiten verwenden dasselbe `asOf`. Das ist deterministisch
über DST-Wechseltage und kann später additiv durch einen versionierten
Profil-Zeitzonenvertrag ersetzt werden.

Das DTO enthält nur die für Triage und Projektverlinkung erforderlichen Felder:
Taskkern, Counts, Projectkern sowie zwei actorrelative Beziehungsflags.
Actor-/Membership-IDs, Richtext, Checklisttexte, Labels, Namen, E-Mails,
Kontakt-/Adressdaten und Protokolldaten bleiben in der globalen Projektion
ausgeschlossen. Die Suche umfasst Tasktitel und serverseitig sicher
extrahierten Plaintext aus den `text`-Nodes des bereits validierten
`task-rich-text.v1`; Projektname, Body und Trefferfragmente werden nicht
projiziert.

## Konsequenzen

- Eine Queue kann hinzukommen, ohne Taskzustand oder Mutationsevidenz zu
  duplizieren.
- Interne Viewer erhalten Triage-Leserechte, aber keine versteckten
  Mutationscontrols; External bleibt vollständig ausgeschlossen.
- Query, Cursor und Projektion können vor Service/UI unabhängig getestet
  werden.
- `created_at <= asOf` und eine feste Keysetordnung begrenzen Pagingdrift; der
  Vertrag verspricht bewusst keinen transaktionalen Snapshot bei parallelen
  Taskänderungen.
- Zusätzliche Parenttypen, Inline-/Bulkmutationen, Saved Views und alternative
  Zeitzonen benötigen neue Verträge statt stiller v1-Erweiterungen.

## Verworfen

### Neue globale Tasktabelle

Verworfen: doppelte Wahrheit, eigene Erasure-/RLS-/Revisionierungsprobleme und
Drift zum Projektaggregate.

### Inline-Mutation in der Inbox v1

Verworfen: vergrößert den Slice um Actions, Konfliktentwürfe und Racepfade.
Der Projektlink führt zur bereits verifizierten Mutationsoberfläche.

### Vollständiges Taskdetail im Queue-DTO

Verworfen: Richtext, Checklist- und Labeltexte sowie Namen/E-Mails vergrößern
die PII- und Leakfläche ohne notwendigen Triage-Nutzen.

### Neues Cursor-HMAC-Secret

Verworfen: Das bestehende strikt validierte Base64url-/Bindingmuster genügt,
weil der Cursor keine Autorisierung erteilt und jede Abfrage RLS/RBAC erneut
erzwingt. Ein eigener Secret-Lebenszyklus wäre für diesen Slice unbegründet.
