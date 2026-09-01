# ADR 0015: Projektaufgaben und interne Aktivitätsprojektion

- Status: angenommen
- Datum: 2026-08-31
- Bezug: `docs/spec/M1-10-projektaufgaben-aktivitaet.md`

## Kontext

F1.9 verlangt Aufgaben mit Titel, Rich-Text, absolutem Fälligkeitsdatum,
mehreren Nutzern und Teams, Labels, Checklisten und Vorlagen. Die öffentliche
Reonic-Dokumentation beschreibt zusätzlich mehrere Elternarten, globale
Aufgabenlisten, Benachrichtigungen, Kommentare und eine eingeschränkte
External-Sicht. Teams, ein globaler Queue-Scope und ein freigegebener externer
Task-Datenvertrag existieren im aktuellen WMEE-Modell noch nicht.

Die vorhandene Projektakte besitzt dagegen bereits echte Tenant-, Rollen-,
Assignment-, Event-, Audit- und Erasure-Grenzen. Der kleinste belastbare Slice
ist deshalb eine ausschließlich projektgebundene, interne Aufgabe samt
Aktivitätsprojektion. Er erweitert den realen Rechner→Lead→Projekt-Pfad, ohne
ein zweites Autorisierungsmodell vorzutäuschen.

## Entscheidung

M1-10 führt vier Tenant-Tabellen ein: `project_task`,
`project_task_assignee`, `project_task_checklist_item` und
`project_task_label`. Jede besitzt `workspace_id`, ein zusammengesetztes
Tenant-FK-Ziel und FORCE RLS. Aufgaben haben genau ein unveränderliches Project
als Elternobjekt. Freistehende, Kontakt- oder Commercial-Eltern folgen später.

`project_task.revision` ist die optimistische Aggregate-Revision. Create
sperrt das Project und startet ohne `expectedRevision` bei Revision 1. Jeder
wirksame Command an einer bestehenden Task sperrt zuerst das Project, danach
die Task und erforderliche Membership-/Kindzeilen, verlangt
`expectedRevision` und erhöht die Revision genau einmal. Kindänderungen
spiegeln `updated_at` auf dem Task; semantische No-ops erzeugen weder Revision
noch Event.

Die Beschreibung wird als `task-rich-text.v1` gespeichert. App-Vertrag und
Datenbank akzeptieren ausschließlich eine kleine Tiptap/ProseMirror-Allowlist,
begrenzen Bytes, Tiefe, Knoten und Text und erlauben keine HTML-, Style-,
Script-, Bild-, Iframe- oder frei benannten Attribute. Die UI rendert Nodes als
React-Elemente und verwendet kein `dangerouslySetInnerHTML`.

Normale Tasks speichern ein absolutes `timestamptz`; der erste Portalvertrag
interpretiert ein gewähltes Kalenderdatum als Ende dieses Tages in
`Europe/Berlin` und persistiert den daraus abgeleiteten Instant. Relative
Fristen existieren nur in späteren Templates.

Quick Create setzt ausschließlich Titel, festen Project-Parent und den
handelnden internen Nutzer als Default-Assignee. Full Create und Edit erlauben
Beschreibung, Datum, mehrere interne Memberships, task-eigene farbige Labels
und geordnete Checklisten. Eine geteilte Workspace-Taxonomie bleibt ein eigener
Folgeslice: freie Labeltexte könnten sonst nach Lead-Erasure als verwaiste
personenbezogene Daten in einer weiterverwendeten Dictionary-Zeile verbleiben.

Taskzustand besitzt zwei unabhängige Achsen: `open|done` und
`archived_at IS NULL|NOT NULL`. Complete und Reopen sind reversibel. Archive
ist einwegig und sperrt alle weiteren Fachmutationen. Unerledigte
Checklistenpunkte blockieren Complete bewusst nicht.

Die Actions `task.read`, `task.write` und `project.activity.read` sind
`internalOnly`. Interne Viewer dürfen Tasks und Aktivität lesen; interne
Editor und Admin dürfen Tasks mutieren. `external_only` erhält in diesem Slice
weder Task-/Label-/Aktivitäts-SQL noch DTO, RSC, HTML oder Controls. Das ist
eine bewusst engere WMEE-Grenze als die öffentlich beschriebene spätere
External-Task-Capability.

Aktivität ist keine zweite mutable Fachwahrheit. Jede Taskmutation emittiert
atomar ein `domain_events`-Event am Project-Aggregat. Payloads enthalten nur
Project-/Task-ID, Revision, Commandtyp, sortierte Change-Keys und Counts, nie
Membership-/Kind-IDs, Titel, Beschreibung, Datum, Namen, E-Mail oder
Labeltexte. Das Readmodel projiziert ausschließlich eine feste
Task-Event-Allowlist.

Der DSGVO-Erasuregraph enthält die Task-Aggregat-IDs. Erasure sperrt Project
vor Tasks; Assignee-, Checklisten- und Labelrelationen werden dabei über ihre
FKs deterministisch mitgelöscht und benötigen keine separaten WORM-Kind-IDs.
Replay und Verifikation verwenden die Aggregat-IDs. Taskaktivität zählt für
die Inaktivitätsgrenze. Die bestehende dynamisch gehärtete Erasure-Funktion
darf nur über gepinnten Quellhash, exakte Anker und
Fresh-/Upgrade-/Replaytests erweitert werden.

## Konsequenzen

- Der operative Rechner-Lead kann ohne externe Provider bis zu einer echten,
  zugewiesenen und prüfbaren Arbeitsaufgabe geführt werden.
- Teams, zentrale Labeltaxonomie, Templates, Kommentare, Benachrichtigungen,
  globale Queue, Mobile, Offline, Kalender und External-Sicht bleiben explizite
  Folgeslices.
- Membership-Offboarding bleibt bei aktiven Assignee-FKs fail-closed, bis ein
  auditiertes Cleanup die Zuweisungen löst.
- Ein späterer Global-Task-Slice kann neue Parenttypen additiv ergänzen, ohne
  Project-Parent oder historische Events umzuschreiben.

## Verworfen

### Tasks als JSON-Array auf Project

Verworfen: keine eigene Revision, keine tenantgebundenen Assignees/Labels,
keine selektiven Constraints und keine saubere Activity-/Erasure-Semantik.

### Freies HTML als Rich Text

Verworfen: XSS-, CSS- und Datenexfiltrationsfläche sowie keine stabile
versionierte Semantik.

### External-Sicht nur im React-Tree verstecken

Verworfen: ein vergessener Query- oder RSC-Pfad würde Inhalte ausliefern. App,
Action, DTO und RLS müssen gemeinsam fail-closed bleiben.

### Eventpayload mit Tasktitel

Verworfen: append-only Protokolle würden personenbezogene Freitexte dauerhaft
duplizieren und Erasure erschweren.

### Hard Delete als normales Benutzerkommando

Verworfen: Archive ist die sichtbare, irreversible Fachkante; physisches
Löschen gehört ausschließlich in den kontrollierten DSGVO-Erasurepfad.
