# M1-12a — Globale Aufgaben-Inbox v1

- Status: REVIEWED/VERIFIED (lokal) · technisches Gate GO · nicht gepusht
- Datum: 2026-09-01
- F-Bezug: F1.9 (PARTIAL)
- Architektur: ADR 0017
- Basis: M1-10 Projektaufgaben, M1-11a Projektergebnis

## Nutzerergebnis

Interne Workspace-Nutzer erhalten eine zentrale, read-only Aufgaben-Inbox für
bereits vorhandene, nicht archivierte Projektaufgaben. Die Inbox bündelt diese
Aufgaben über Projekte hinweg, bietet eine kanonische Suche sowie feste
Scope-, Status- und Fälligkeitsfilter und verlinkt zur bestehenden Projektakte.

M1-12a erzeugt keinen zweiten Task-Aggregatetyp. Anlegen, Bearbeiten,
Abschließen, Wiederöffnen und Archivieren bleiben ausschließlich im
M1-10-Projektdetail und nutzen dessen bestehende Commands, Revisionen, Events,
Audits, Rollen und Erasure-Grenzen.

## Öffentliche Clean-Room-Evidenz

- [Manage tasks in Reonic](https://docs.reonic.com/docs/en/crm-tasks) beschreibt
  eine globale Tasks-Seite, die Filter `Mine`, `Assigned by me`, `All`,
  `Overdue`, `Due today` und `Completed`, freie Suche sowie Sortierung und
  Gruppierung anbietet. Dieselbe Quelle beschreibt `open|completed`, feste
  Fälligkeitstage und die Sichtbarkeit über den jeweiligen Parent.
- [Task templates and labels](https://docs.reonic.com/docs/en/settings-tasks-task-templates-labels)
  beschreibt Task-Vorlagen und Workspace-Labels; beides bleibt in diesem Slice
  außerhalb der Inbox.

Die Quellen belegen weder private Implementierung noch Limits, Cursorformat,
Datenbankabfragen, exakte DTO-Felder oder WMEE-Sicherheitsregeln. Es wurde kein
Login oder privater Reonic-Zugriff verwendet.

## Autoritativer Vertrag

Die einzige maschinenprüfbare Quelle für Query, Cursorpayload, DTO und
Fehlercodes ist
`lib/integrations/tasks/inbox-contract.ts`. Prosa beschreibt Semantik, darf die
Runtime-Schemas aber nicht neu definieren.

### Query `global-task-inbox-query.v1`

| Feld | Geschlossene Semantik |
|---|---|
| `filter` | `mine` = direkt der aktiven Membership zugewiesen; `assigned_by_me` = durch den Actor erstellt; `all` = alle intern lesbaren Projektaufgaben des Workspace |
| `state` | exakt `open` oder `done` |
| `dueBucket` | `any`, `overdue`, `today`, `upcoming`, `no_due` |
| `query` | NFKC, Trim, 1–100 Zeichen oder `null`; leerer Input wird `null`; keine Steuerzeichen; v1 sucht in Tasktitel oder sicher extrahiertem Plaintext der validierten Rich-Text-Beschreibung |
| `timeZone` | fest `Europe/Berlin` |
| `asOf`/`cursor` | auf Seite 1 beide `null`, auf Folgeseiten beide vorhanden |

Der Scope wird mit `task.read` aus dem aktiven Actor-/Workspace-Kontext
ausgewertet; eine Workspace-ID ist bewusst kein Client-Queryfeld. Archived
Tasks sind nie Teil der Inbox. Alle Kombinationen aus Status und Due-Bucket
sind gültig. Bei `done` beschreibt der Bucket die planmäßige Fälligkeit, nicht
die Behauptung, die abgeschlossene Aufgabe sei weiterhin überfällig.

### Berlin-Tagesgrenzen

Der Server erfasst vor Seite 1 genau ein kanonisches UTC-`asOf`. Der lokale
Kalendertag ist das halboffene Intervall
`[Berlin-Mitternacht, nächste Berlin-Mitternacht)`; damit sind 23- und
25-Stunden-DST-Tage korrekt.

- `overdue`: `dueAt < dayStart`
- `today`: `dayStart <= dueAt < nextDayStart`
- `upcoming`: `dueAt >= nextDayStart`
- `no_due`: `dueAt IS NULL`
- `any`: mit und ohne Datum

Dies ist eine WMEE-v1-Entscheidung. Die öffentliche Reonic-Dokumentation nennt
das Nutzerprofil als Zeitzonenquelle; WMEE pinnt vorerst `Europe/Berlin`, bis
ein versionierter Profil-Zeitzonenvertrag existiert.

### Cursor und Ordnung

Die Ordnung ist fest
`due_at ASC NULLS LAST, created_at DESC, id ASC`; das Cursorpayload bindet
Workspace, Actor, aktive Membership, Scopefilter, Status, Due-Bucket,
kanonische Query, Zeitzone, `asOf`, Ordnungskennung und die letzte Position.
Das externe Token ist kanonisches, URL-sicheres Base64 ohne Padding. Seine
Länge ist **abgeleitet, nicht gesetzt**: `GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH`
ergibt sich aus dem festen Bindungs-/Positionsrahmen plus dem Worst Case der
Query. Deren Grenze zählt UTF-16-Codeunits, Base64 zählt UTF-8-Bytes, ein
BMP-Zeichen kostet also bis zu drei Bytes je Codeunit. Aktuell sind das 1.168
Zeichen. Eine fest gesetzte kleinere Zahl wäre falsch: der Server erzeugte bei
einer vertraglich erlaubten Query ein Token, das sein eigener Seitenvertrag
wieder ablehnt. Es ist
für Clients opak; Decoder müssen Form, JSON-Schema, kanonische Kodierung und
jede Bindung fail-closed prüfen. RLS und Berechtigungen werden auf jeder Seite
erneut angewandt; der Cursor ist keine Autorisierungsgrenze. Der vorhandene
Cursor-Betriebsvertrag wird wiederverwendet, ohne einen neuen HMAC-Schlüssel
einzuführen.

Seite 1 erfasst `asOf`; Folgeseiten übernehmen es unverändert. Implementierung
und spätere DB-Tests müssen zusätzlich `created_at <= asOf` erzwingen. Die
Keyset-Seite ist deterministisch, aber kein Snapshot gegen parallel geänderte
Tasktitel, Status oder Fälligkeiten.

### Minimiertes Readmodel `global-task-inbox-page.v1`

Die Seite enthält höchstens 50 eindeutige Tasks. Pro Task werden ausschließlich
ausgegeben:

- Task-ID, Revision, Titel, `open|done`, `dueAt`
- kompakte Counts für Assignees, Checklist erledigt/gesamt und Labels
- Projekt-ID, Projektname und `open|won|lost|cannot_fulfill`
- ausschließlich die beiden Beziehungsflags `assignedToCurrentActor` und
  `createdByCurrentActor`

Body/Richtext, Checklisttexte/-IDs, Labelnamen/-farben/-IDs, Actor-/Assignee-
IDs, Namen oder E-Mails, Kontakt-/Adressdaten, Loss-Grund und rohe Event-/
Auditdaten sind im Runtime-Schema verboten. Die Suche darf den bereits durch
`task-rich-text.v1` validierten Body ausschließlich serverseitig zu sicherem
Plaintext aus seinen `text`-Nodes reduzieren; Body und Trefferfragmente werden
nie projiziert. Projektname ist kein Suchfeld. Es wird kein Membership-
Verzeichnis in das DTO eingebaut.

## Rollen und Fehler

Die Inbox ist `internalOnly`. Interne Viewer, Editor und Admin dürfen dieselbe
read-only Queue gemäß `task.read` lesen. `external_only`, Worker, System,
widerrufene Memberships und Fremdtenant bleiben auf App-, Service- und
SQL-Ebene fail-closed.

Parser werfen nur kontrollierte Codes:

- `invalid_global_task_inbox_query`
- `invalid_global_task_inbox_cursor`
- `invalid_global_task_inbox_projection`

Fehlertexte enthalten keine Eingabewerte, Queryinhalte oder personenbezogenen
Daten. Autorisierungsfehler bleiben im bestehenden `PermissionDeniedError`-
Vertrag und verraten keine Existenz fremder Tasks.

`invalid_global_task_inbox_projection` entsteht im Server und wird deshalb
bewusst nicht auf `notFound()` abgebildet, sondern an die Error Boundary
weitergereicht. Query- und Cursorfehler stammen aus der Anfrage und bleiben ein
ehrliches `notFound()`.

### Gemessene Statuscode-Grenze

Die Route besitzt ein `loading.tsx` und streamt daher. Next dokumentiert für
diesen Fall ausdrücklich, dass der Statuscode bereits feststeht, wenn
`notFound()` greift: gestreamte Antworten bleiben `200`, ein echtes `404` gilt
nur für ungestreamte Antworten
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/not-found.md`).
Ein ungültiger oder fremd gebundener Cursor erzeugt hier also ein Soft-404:
Next setzt `noindex`, es wird keinerlei Aufgabendatum gerendert, aber der
Statuscode bleibt `200`. Die Abnahme prüft deshalb die gerenderte Ausgabe und
nicht den Statuscode. Wer später ein hartes `404` braucht, müsste die Prüfung
vor den Streamstart ziehen (Proxy-Ebene); das ist kein Ziel dieses Slices.

## Akzeptanzkriterien

| ID | Nachweis | Stand |
|---|---|---|
| `M112A-01` | serverseitige interne `task.read`-Queue über bestehende aktive Project-Tasks, kein neuer Aggregate-/Mutationstyp | GREEN |
| `M112A-02` | exakte Scope-/Status-/Due-/Query-Semantik einschließlich Titel-oder-sicherer-Body-Plaintextsuche, NFKC und Berlin-DST-Grenzen | GREEN |
| `M112A-03` | kanonischer Cursordecode, vollständiger Bindingvergleich, `created_at <= asOf`, stabile Keyset-Seiten und kontrollierte Fehler | GREEN |
| `M112A-04` | strikt validiertes minimiertes DTO ohne Body, Identitäts-IDs, Freitext-/PII-Nebenfelder und ohne archived Tasks | GREEN |
| `M112A-05` | RLS/RBAC: Viewer/Editor/Admin lesen; External/Worker/Fremdtenant/revoked lesen nichts, auch nicht via Counts/Suche/Cursor | GREEN |
| `M112A-06` | responsive/a11y Inbox mit Projektlink; sämtliche Mutationen erfolgen weiter im Projektdetail | GREEN |
| `M112A-07` | DB-, Service-, Race-, Privacy-, Build- und Chromium-Gates grün, unabhängiges P0–P2-Review | GREEN |

## Gemessenes Laufzeitverhalten und Indexentscheidung

`EXPLAIN (ANALYZE, BUFFERS)` wurde über eine temporäre Sonde auf genau das SQL
angewendet, das `getGlobalTaskInboxPage` absetzt — nicht auf eine Nachbildung.
Datenlage: ein Workspace, ein Projekt, 4.000 offene, nicht archivierte
Aufgaben, alle dem Actor zugewiesen, danach `ANALYZE`.

| Abfrageform | gelesene Zeilen | Planform | Laufzeit |
|---|---:|---|---:|
| `all` / `any` | 4.000 | Bitmap Heap Scan + top-N heapsort | 26,9 ms |
| `mine` / `any` | 4.000 (+4.000 Index-Only-Loops) | zusätzlich Nested Loop je Kandidatenzeile | 47,7 ms |
| `assigned_by_me` / `any` | 4.000 | Bitmap Heap Scan + heapsort | 24,7 ms |
| `all` / `overdue` | 0 | Bitmap Heap Scan | 0,09 ms |
| `all` / `today` | 587 | Bitmap Heap Scan + heapsort | 4,4 ms |
| `all` / Suche | 4.000 (3.999 verworfen) | Index Scan + `jsonb_path_query` je Zeile | 30,2 ms |

Befund: jede unbegrenzte Form liest und sortiert den vollständigen aktiven
Aufgabenbestand des Workspace, bevor die 51er-Grenze greift. Die Kosten wachsen
linear mit der Zahl der Aufgaben je Workspace.

Ursache ist die Ordnung selbst. Sortiert wird über
`date_trunc('milliseconds', due_at)` und `date_trunc('milliseconds', created_at)`.
Diese Kürzung ist **nicht** entfernbar: der Cursor serialisiert seine Position
als kanonischen Instant mit exakt drei Nachkommastellen. Verglichen man
ungekürzte Mikrosekundenwerte gegen eine Millisekundenposition, fielen
Aufgaben, deren `created_at` innerhalb derselben Millisekunde hinter dem Anker
liegt, stillschweigend aus der Folgeseite heraus. Die Kürzung trägt also die
Lückenfreiheit der Paginierung.

Ein passender Ausdrucksindex ist zugleich nicht anlegbar: PostgreSQL führt
`date_trunc(text, timestamptz)` als `STABLE`, nicht als `IMMUTABLE`, weil das
Ergebnis für größere Einheiten von der Sitzungszeitzone abhängt. Ein Index
darüber wird abgewiesen. Möglich wäre nur eine eigene, als `IMMUTABLE`
deklarierte Hülle mit fest verdrahteter UTC-Kürzung plus additivem Index.

Entscheidung für M1-12a: **kein Index.** Die Messung belegt bei realistischem
Nahbereichsvolumen Laufzeiten von 0,1–48 ms; ein P0–P2-Defekt liegt nicht vor.
Eine neue `IMMUTABLE`-Funktion samt Migration ist eine Änderung am
Datenbankvertrag und gehört in einen eigenen, review-pflichtigen Slice statt an
das Ende dieses Slices. Offen und benannt bleibt:

- `M112A-PERF-01` — additive `IMMUTABLE`-Kürzungsfunktion und darauf gestützter
  Index `(workspace_id, status, kürzung(due_at) asc nulls last,
  kürzung(created_at) desc, id) where archived_at is null`, sobald ein
  Workspace die Größenordnung fünfstelliger Aufgabenzahlen erreicht oder eine
  Messung an echten Daten den Bedarf belegt. Die Suche über
  `jsonb_path_query` braucht dafür eine getrennte Betrachtung.

## Nichtziele und Unknowns

- keine Inbox-Mutation, Bulk-Aktion oder Inline-Complete
- keine persönlichen, Kontakt-, Commercial- oder Team-Tasks
- keine Teams, zentrale Labels/Templates, Kommentare oder Benachrichtigungen
- keine Saved Views, Gruppierung, Kanban, Custom-Daterange oder Sortierauswahl
- keine External-, Mobile-, Offline-, Kalender- oder KI-/WhatsApp-Sicht
- unbekannt bleiben private Reonic-Defaultordnung, Cursor-/Paginggrenzen,
  Query-Ranking/Tokenisierung, exakte Countdarstellung und Leerzustände

Diese Unknowns werden nicht als 1:1-Parität behauptet; sie benötigen spätere
öffentliche Evidenz, Nutzerinterviews oder eine ausdrücklich eigene WMEE-Spec.
