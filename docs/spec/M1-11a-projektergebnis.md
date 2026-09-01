# M1-11a — Projektergebnis Won/Lost/Reopen

- Status: REVIEWED/VERIFIED lokal · TECHNISCHES GATE 2 GO
- Datum: 2026-09-01
- F-Bezug: F1.6 (PARTIAL)
- Architektur: ADR 0016
- Basis: `bc491d4`; geplante Migration `0039`

## Nutzerergebnis

Ein interner Editor oder Admin kann eine offene Anfrage ausdrücklich als
gewonnen oder verloren abschließen. Verloren verlangt einen aktiven,
strukturierten Workspace-Grund und erlaubt einen kurzen internen Kommentar.
Gewonnene und verlorene Anfragen verschwinden aus der offenen Kanban-Pipeline,
bleiben aber in einer eigenen Ansicht für abgeschlossene Anfragen auffindbar.

Won und Lost können revisionssicher wieder geöffnet werden. Die bisherige
Kanban-Spalte bleibt bei allen Outcome-Übergängen unverändert. Viewer sehen
Outcome, Abschlusszeit und den aktiven Verlustgrund ohne Mutationscontrols.
External-, Worker-, widerrufene und fremde Actors erhalten weder
Outcome-Mutationen noch die interne Abschlussliste oder Verlustkommentare.

## Öffentliche Clean-Room-Evidenz

- [Lead lifecycle](https://docs.reonic.com/docs/en/leads-overview-lead-characteristics)
  belegt Open/Won/Lost, strukturierten Verlustgrund, ergänzenden Freitext,
  Reopen und das Entfernen geschlossener Leads aus der aktiven Pipeline.
- [Offer lifecycle](https://docs.reonic.com/docs/en/offers-overview-overview-offer-characteristics)
  belegt dieselbe Outcome-Achse für Angebote und die Trennung von
  Geschäftsergebnis und unveränderlichen Vertragsartefakten.
- [Kanban board management](https://docs.reonic.com/docs/en/settings-kanban-boards-board-management)
  belegt die Trennung von Kanban-Spalte und Outcome sowie getrennte Filter für
  Closed und Archived.
- [Contacts](https://docs.reonic.com/docs/en/crm-contacts) belegt, dass Reopen
  Kontakt-, Planungs- und Aktivitätshistorie erhält.

Die öffentlichen Seiten widersprechen sich dazu, ob Reopen den früheren
Verlustgrund am aktiven Datensatz entfernt. WMEE entscheidet: aktive
Verlustfelder werden geleert; das append-only Outcome-Event behält die
historische Reason-ID. Exakte Reonic-Limits, Texte, Taxonomie, private UI und
Implementierung sind nicht bekannt und werden nicht kopiert.

## Capability- und Abnahmematrix

| ID | Fähigkeit | Objektive Abnahme |
|---|---|---|
| `M111A-01` | Verlustgrund verwalten | Admin erstellt, archiviert und reaktiviert einen kanonisch eindeutigen Workspace-Grund per CAS; kein Hard Delete |
| `M111A-02` | Won | offene Request Revision N wird atomar zu Won Revision N+1 mit DB-Zeit als `closed_at`; Kanban-Spalte bleibt gleich |
| `M111A-03` | Lost | offene Request Revision N verlangt aktiven Tenant-Grund und optionalen Kommentar; alles wird atomar gespeichert |
| `M111A-04` | Reopen | Won/Lost Revision N wird zu Open N+1; `closed_at`, Reason-ID und Kommentar werden atomar geleert |
| `M111A-05` | Geschlossene Ansicht | interne Nutzer filtern Won/Lost und öffnen den stabil paginierten Datensatz; offene Pipeline enthält nur Open |
| `M111A-06` | Readmodel | Detail zeigt Outcome, Revision, Abschlusszeit und aktiven Grund; Viewer bekommt keine Fakebuttons |
| `M111A-07` | Rollen/Privacy | Editor/Admin mutieren; Viewer liest; External/Worker/revoked/cross-tenant bleiben in SQL, Actions, RSC und HTML fail-closed |
| `M111A-08` | CAS/Races | paralleles Won/Lost/Reopen mit gleicher Revision erzeugt genau einen seriellen Gewinner und keinen Teilstand |
| `M111A-09` | Activity | jede wirksame Transition schreibt genau ein redigiertes Project-Event und Audit in derselben Transaktion |
| `M111A-10` | Erasure | Outcome-Freitext wird mit Project gelöscht; geteilte Reason-Taxonomie bleibt kontaktunabhängig erhalten; Outcome-Update aktualisiert Project-Recency |
| `M111A-11` | UI/A11y | Tastatur, Fokus, Live-Feedback, 320/375-px-Reflow, Reduced Motion und Axe bestehen |
| `M111A-12` | Migration/Gesamtpfad | Fresh/Upgrade/Retry, FORCE RLS, ACL, Generator, Rollen-/PG18-Proben, Build und Chromium sind grün |

## Geschlossener Datenvertrag

### `project_loss_reason`

- `id`, `workspace_id`, `label`, `position`, `revision`
- `archived_at`, `created_at`, `updated_at`
- `UNIQUE(workspace_id,id)` und kanonisch eindeutiges Label im gesamten
  Workspace, auch nach Archive
- Label: NFKC, getrimmt, keine Kontrollzeichen, 1–80 Zeichen
- Position und Revision sind positive 32-Bit-Integer
- Archive ist logisch; Reaktivierung ist per aktueller Revision möglich;
  physisches DELETE und TRUNCATE sind verboten
- aktive und archivierte Gründe können intern gelesen werden; nur Admin darf
  erstellen, archivieren oder reaktivieren

Die Migration legt keine vermeintlichen Reonic-Standardgründe an. Ein
Workspace ohne aktiven Grund kann Won ausführen, aber Lost erst nach bewusster
Admin-Konfiguration.

### Ergänzungen an `project`

- `outcome_revision integer NOT NULL DEFAULT 0`
- `closed_at timestamptz NULL`
- `loss_reason_id uuid NULL` mit zusammengesetztem Tenant-FK
- `loss_reason_text text NULL`, getrimmt/NFKC/kontrollzeichenfrei, 1–500 Zeichen

Kohärenz:

```text
open             => closed_at NULL, reason NULL, text NULL
won              => closed_at NOT NULL, reason NULL, text NULL
lost             => closed_at NOT NULL, reason NOT NULL, text optional
cannot_fulfill   => closed_at NOT NULL, reason NULL, text NULL
```

`closed_at` ist endlich. `outcome_revision` liegt zwischen 0 und
2.147.483.647. Upgrade-Bestand mit Won/Cannot-fulfill erhält `updated_at` als
transparenten historischen Näherungswert. Ein unerwarteter Lost-Bestand ohne
strukturierten Grund lässt die Migration laut fehlschlagen statt Daten zu
erfinden.

## Zustandsmaschine

M1-11a autorisiert ausschließlich Request-Projects:

```text
request/open@N --mark_won-->  request/won@N+1
request/open@N --mark_lost--> request/lost@N+1
request/won@N  --reopen-----> request/open@N+1
request/lost@N --reopen-----> request/open@N+1
```

- `expectedOutcomeRevision` ist für jede Mutation Pflicht.
- Ein identischer zweiter Command ist kein No-op, sondern ein Konflikt: Der
  Actor muss den aktuellen Zustand bewusst neu laden.
- Phase und Kanban-Board/-Spalte bleiben bytegleich.
- `cannot_fulfill` besitzt in M1-11a keine neue Kante.
- Offer-/Installation-Phasen werden nicht verändert; spätere Signaturautomation
  erhält einen eigenen, artefaktbewussten Vertrag.

## Commands und Actions

Version `project-outcome-command.v1`:

- `mark_won(projectId, expectedOutcomeRevision, confirmation=true)`
- `mark_lost(projectId, expectedOutcomeRevision, lossReasonId,
  lossReasonText|null, confirmation=true)`
- `reopen(projectId, expectedOutcomeRevision, confirmation=true)`

Version `project-loss-reason-command.v1`:

- `create(label)`
- `archive(reasonId, expectedRevision, confirmation=true)`
- `reactivate(reasonId, expectedRevision)`

Actions akzeptieren ausschließlich allowlistete Felder, reautorisieren jede
Anfrage und lesen Project/Reason/Membership serverseitig neu. Erwartete Fehler
werden als `invalid`, `not_found`, `conflict`, `illegal_transition`,
`unauthenticated` oder `denied` zurückgegeben. Unbekannte Fehler bleiben laut.

## Rollen- und Datenvertrag

Neue Action `project.outcome.write`:

| Actor | offene/geschlossene Liste + Detail | Outcome ändern | Reasons verwalten |
|---|---:|---:|---:|
| interner Viewer | ja | nein | nein |
| interner Editor | ja | ja | nein |
| interner Admin | ja | ja | ja |
| `external_only` | nur bisherige zugewiesene offene Sicht | nein | nein |
| revoked/fremder Actor | nein | nein | nein |
| Worker/Auth/System | nein | nein | nein |

`project.outcome.write` ist `internalOnly` und verlangt mindestens Editor.
Reason-Verwaltung bleibt `settings.manage`. Das Schließen entzieht einer
zugewiesenen External-Membership durch die bestehende Project-RLS ab derselben
committeten Transaktion die Sicht, weil deren Scope `request/open` verlangt.

## Event-, Audit- und Activity-Vertrag

Eventtypen:

- `project.outcome_won`
- `project.outcome_lost`
- `project.outcome_reopened`

Payloads enthalten ausschließlich Project-ID, vorherigen/nächsten Outcome,
Outcome-Revision und bei Lost/Reopen die strukturierte Reason-ID sowie ein
`hasComment`-Boolean. Namen, E-Mail, Label, Kommentar, Datum aus Nutzereingabe
und andere Freitexte sind verboten. `closed_at` stammt aus der Eventzeit und
muss nicht dupliziert werden.

Die Projektaktivität zeigt feste deutsche Ereignislabels. Sie rendert weder
rohe Payload noch Verlustkommentar. Der aktuelle interne Detailstand darf das
Reason-Label und den Kommentar aus dem löschbaren Project-Readmodel zeigen.

## Lock- und Race-Vertrag

- Reason-Create sperrt die Workspace-Zeile, danach bestehende Reasons in
  stabiler Reihenfolge, um Label und nächste Position zu serialisieren.
- Outcome-Mutation sperrt zuerst das Project, danach bei Lost genau den
  referenzierten Reason.
- Erasure sperrt bereits Project vor abhängigen Aggregaten. Outcome nutzt
  denselben ersten Lock und kann daher nicht nach einer gewonnenen Erasure
  wiederauferstehen.
- Update enthält zusätzlich den erwarteten Outcome, die Revision und den
  unveränderten Request-Scope im WHERE; null Zeilen bedeuten Konflikt.
- Event und Audit stehen in derselben Transaktion wie das Project-Update.

## UI-Vertrag

- Offenes Board erhält eine deutlich benannte Navigation
  `Offen` / `Abgeschlossen`.
- `/w/{workspaceId}/anfragen/abgeschlossen` zeigt nur interne, geschlossene
  Requests, Filter `Alle`, `Gewonnen`, `Verloren`, stabile Keyset-Pagination
  und Deep-Links; kein Drag-and-drop.
- Projektkopf zeigt Outcome und Abschlusszeit. Ein eigener Outcome-Abschnitt
  bietet Won/Lost für Open sowie Reopen für Won/Lost.
- Lost verwendet eine beschriftete Auswahl und optionales Textfeld. Fehlende
  aktive Reasons erzeugen einen erklärten Admin-Link statt einen leeren
  Submitpfad.
- Bestätigungen nennen die konkrete Zustandsänderung. Pending sperrt alle
  parallelen Outcome-Controls. Konflikt bewahrt die Lost-Eingabe und führt den
  Fokus zur Statusmeldung.
- Viewer sieht Status und Grund als Text, aber keine deaktivierten Buttons.
- Kein Farbsignal ohne Text/Icon; Touchziele mindestens 44 px; keine
  horizontale Pflichtbewegung bei 320/375 px.

## Nichtziele

- `Cannot fulfill`, Kundenmail-Outbox und Signatursperre
- Lost-and-Archive, allgemeines Project-Archive und Restore
- automatische Outcome-Änderung durch Kanban-Spaltentyp
- Angebots-/Signatur-/Installationsautomation
- Funnel-, Win/Loss- und Conversion-Auswertungen
- Reorder oder Import einer Reason-Taxonomie
- externe Outcome-Sicht, REST/API-Automation, Mobile/Offline
- private Reonic-Texte, UI, Daten, Taxonomie oder Implementierungsdetails

## Gate 2

`REVIEWED/VERIFIED lokal` ist erst zulässig, wenn Contract-, DB-, Service-,
Race-, RBAC/Privacy-, Action-, UI-, A11y- und Browserfälle grün sind. Zusätzlich
müssen Fresh-/Upgrade-/Retry-Migration, Generator ohne Drift, Rollenvertrag,
PostgreSQL-18-Proben, Dependency-Cruiser, Production-Build und der vollständige
Chromium-Pfad bestehen. Human Visual bleibt ein separates, ausdrücklich
benanntes Gate. Kein Push oder Deployment gehört zu M1-11a.

Finaler lokaler Nachweis: `npm run check` mit 166/166 Testdateien, 1.608
bestandenen und einem ausdrücklich opt-in übersprungenen Test; Rollenvertrag
88/88 plus PostgreSQL-18-Proben 5/5; Dependency-Cruiser 305 Module/1.077
Abhängigkeiten; fokussierte M1-11a-Matrix 86/86, Strict-`app_runtime` 3/3 und
Chromium 4/4. Production-Build und `db:generate` mit 56 Tabellen ohne Drift
sind grün. Unabhängige Abschlussreviews melden keine offenen P0–P2. Human
Visual bleibt separat; Push und Deployment wurden nicht ausgeführt.
