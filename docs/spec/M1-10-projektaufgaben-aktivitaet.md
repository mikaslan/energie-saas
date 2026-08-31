# M1-10 — Projektaufgaben und interne Projektaktivität

- Status: SPECIFIED / CONTRACTED · RED ausstehend
- Datum: 2026-08-31
- F-Bezug: F1.9 (PARTIAL)
- Architektur: ADR 0015
- Basis: Integrationscommit `091e7a1`; nächste Migration `0038`

## Nutzerergebnis

Ein interner Editor oder Admin kann direkt in einer bestehenden Projektakte
eine schnelle Einzeiler-Aufgabe oder eine vollständige Aufgabe anlegen. Die
vollständige Aufgabe unterstützt sichere Rich-Text-Beschreibung, absolutes
Fälligkeitsdatum, mehrere interne Personen, farbige task-eigene Labels und
eine geordnete Checkliste. Interne Viewer sehen den Stand ohne
Mutationscontrols.

Aufgaben lassen sich explizit abschließen, wieder öffnen und einwegig
archivieren. Checklistenpunkte können unabhängig gesetzt werden. Jede wirksame
Änderung erscheint als redigierter Eintrag in der Projektaktivität und ist mit
Event und Audit atomar.

External-Nutzer sehen in M1-10 keinerlei Task-, Label- oder Aktivitätsdaten.

## Öffentliche Clean-Room-Evidenz

- [Manage tasks in Reonic](https://docs.reonic.com/docs/en/crm-tasks) belegt
  Quick/Full Create, festen Parent, Titel, Beschreibung, absolutes Datum,
  mehrere Assignees, Teams, zentrale Labels, geordnete Checkliste,
  Complete/Reopen, einwegiges Archive und Parent-Activity.
- [Task templates and labels](https://docs.reonic.com/docs/en/settings-tasks-task-templates-labels)
  belegt zentrale farbige Task-Labels sowie persönliche/unternehmensweite
  Templates mit relativer Frist.

Die Quellen belegen keine private Implementierung, Limits, Datenbankstruktur,
Fehlertexte oder UI-Geometrie. WMEE verwendet eigene Texte, Komponenten,
Sicherheitsregeln und visuelle Sprache. Es wurde kein Login verwendet.

## Capability- und Abnahmematrix

| ID | Fähigkeit | Objektive Abnahme |
|---|---|---|
| `M110-01` | Quick Create | Enter oder Plus erzeugt genau eine Project-Task Revision 1 mit Actor als Default-Assignee; kein Datum/Body/Checklist/Label |
| `M110-02` | Full Create | Titel, `task-rich-text.v1`, Datum, 0–50 interne Assignees, 0–100 geordnete Checklistitems und 0–15 task-eigene Labels werden atomar gespeichert |
| `M110-03` | Sichere Beschreibung | App- und DB-Allowlist lehnen HTML, Script, unbekannte Nodes/Marks/Attrs, Übergröße, Tiefe und zu viele Nodes ab; Rendering ohne Raw HTML |
| `M110-04` | Edit/CAS | Full Edit ersetzt Details/Assignees/Labels/Checkliste atomar und verlangt die aktuelle Taskrevision; Stale bleibt ohne Teilstand |
| `M110-05` | Checklist | Einzelner Item-Toggle verlangt Taskrevision, erhöht sie einmal und aktualisiert Taskaktivität; fremde Item-ID ist `not found` |
| `M110-06` | Completion | `open → done → open`; `completed_at` ist genau zum Zustand kohärent; unchecked Items blockieren nicht |
| `M110-07` | Archive | `active → archived` ist einwegig; danach kein Edit/Toggle/Complete/Reopen; Defaultliste blendet archiviert aus |
| `M110-08` | Labels | Full Create/Edit speichert 0–15 farbige, innerhalb der Aufgabe kanonisch eindeutige Labels; Erasure entfernt sie mit der Aufgabe |
| `M110-09` | Rollen/Privacy | Viewer liest; interner Editor/Admin mutiert; External, Worker, Fremdtenant und widerrufene Membership bleiben in SQL, DTO/RSC/HTML und Actions fail-closed |
| `M110-10` | Activity | Jede wirksame Mutation schreibt genau ein allowlistetes Project-Event und ein erlaubtes Audit; Payloads sind PII-/Freitext-frei |
| `M110-11` | Erasure/Races | Project→Task→Kind-Lockordnung; Erasuregraph/Recency/Replay enthalten Tasks; Create/Edit/Toggle/Archive gegen Erasure erzeugen keinen Teilstand |
| `M110-12` | UI/A11y | Keyboardpfad, Fokus-/Fehlervertrag, WCAG A/AA-Axe, 320/375-px-Reflow, Reduced Motion und unabhängige fokussierte E2E-Fälle sind grün |

## Geschlossener Datenvertrag

### `project_task`

- Tenant-/Project-Schlüssel, `revision >= 1`, Titel 1–200 Zeichen
- `body_version = task-rich-text.v1`, `body` als validiertes JSONB; Quick
  Create verwendet das kanonische leere v1-Dokument
- `due_at timestamptz NULL`
- `status in (open, done)` und kohärentes `completed_at`
- `archived_at` einwegig; `created_by`/`updated_by` nur als interne Actor-UUID
- `created_at`, `updated_at`; Project-Cascade nur für kontrollierte Erasure

### Kindrelationen

- `project_task_assignee`: eindeutige aktive interne Workspace-Membership,
  maximal 50; Membership-FK `RESTRICT`
- `project_task_checklist_item`: UUID, eindeutige Position 0–99, Text 1–500,
  `is_done`; maximal 100
- `project_task_label`: task-owned Child, Name 1–40, Farbe aus geschlossener
  Palette, lückenlose Position und innerhalb der Aufgabe kanonisch eindeutiger
  Name; maximal 15

Alle vier Tabellen besitzen `UNIQUE(workspace_id,id)`, Workspace-FK,
zusammengesetzte Tenant-FKs, FORCE RLS, genau eine permissive Tenant-Policy und
restriktive interne Actor-Policies.

## Commands

Version: `project-task-command.v1`.

- `quick_create(projectId,title)`
- `create(projectId,title,body,dueDate,assigneeMembershipIds,checklist,labels)`
- `update(projectId,taskId,expectedRevision,...)`
- `toggle_checklist_item(projectId,taskId,itemId,expectedRevision,done)`
- `complete(projectId,taskId,expectedRevision)`
- `reopen(projectId,taskId,expectedRevision)`
- `archive(projectId,taskId,expectedRevision,archiveConfirmation)`

Unknown/Duplicate/File-Felder, fremde React-Felder, falsche Versionen, UUIDs,
Revisionen, Mengen, Duplikate und nicht kanonische Datumswerte werden vor dem
Service abgelehnt.

## Zustandsmaschinen

```text
active/open  → active/done → active/open
active/*     → archived/*
archived/*   → ∅
```

Task-eigene Labels besitzen keinen eigenen Archivzustand: Full Edit ersetzt
sie nur solange die Aufgabe aktiv ist; Task-Archive friert sie ein und der
kontrollierte Erasure-Pfad löscht sie mit der Aufgabe.

## Rich-Text-Vertrag

- Action-/App-Hülle exakt
  `{schemaVersion:"task-rich-text.v1",doc:{type:"doc",content:[...]}}`
- die Datenbank speichert Version und `doc` getrennt als
  `body_version = task-rich-text.v1` plus Root exakt
  `{type:"doc",content:[...]}`
- erlaubte Nodes: `paragraph`, `heading(2..3)`, `bulletList`, `orderedList`,
  `listItem`, `hardBreak`, `text`
- erlaubte Marks: `bold`, `italic`
- keine freien Attribute; `heading.level` und `orderedList.start` sind eng
  typisiert
- höchstens 32 KiB UTF-8, 500 Nodes, Tiefe 8, 10.000 Textzeichen
- JSON wird strukturell gerendert; kein HTML-Parser und kein Raw-HTML-Sink

## Rollen- und Datenvertrag

Die getrennten Berechtigungsaktionen sind `task.read`, `task.write` und
`project.activity.read`; alle drei sind `internalOnly`.

| Actor | Liste/Detail/Activity | Mutationen | Task-eigene Labels im Edit |
|---|---:|---:|---:|
| interner Viewer | ja | nein | nein |
| interner Editor | ja | ja | ja |
| interner Admin | ja | ja | ja |
| `external_only` | nein | nein | nein |
| fremder/revoked Actor | nein | nein | nein |
| Worker/Auth/System | nein | nein | nein |

Events/Audits enthalten nur IDs, Revision, `kind`, `changedKeys` und Counts.
Title, Body, Due-Date, Labeltext, Checklisttext, E-Mail und Name sind verboten.

## UI-Vertrag

- Eigener Abschnitt `Aufgaben` in der internen Projektakte, vor dem
  Angebotsbereich; die External-Audience verzweigt vorher.
- Quick Create bleibt immer sichtbar für Mutierende und funktioniert mit
  Tastatur/Enter.
- Full Create/Edit nutzt einen klar beschrifteten Dialog, Fokusfang,
  Rückkehrfokus, serverautoritatives Feedback und echte Tiptap-Controls.
- Taskzeilen zeigen Status, Datum, Assignees, Labels und Checklistfortschritt;
  kein Farbsignal ohne Text/Icon.
- Viewer erhält denselben Inhalt ohne deaktivierte Fakebuttons.
- Activity zeigt eine feste deutsche Ereignisbezeichnung, Zeitpunkt und keine
  rohe Payload.

## Nichtziele

- freistehende, Kontakt-, Commercial- oder persönliche Tasks
- Teams und Teamleitervererbung
- zentrale Workspace-Labeltaxonomie sowie Templates/relative Fristen
- globale Taskqueue, Filter, Suche, Gruppierung, Kanban und Saved Views
- Kommentare, Mentions, Benachrichtigungs-/Digest-Mails, Automationen/REST
- External-Task-Sicht oder -Mutation
- Kalender, Mobile/PWA/Offline und WhatsApp-/KI-Erstellung
- Hard Delete außerhalb DSGVO-Erasure
- private Reonic-UI, Texte, Interna oder Daten

## Gate 2

Commit erst nach vollständigem Check, Build, DB-/Rollen-/Erasuretests,
Chromium-E2E, unabhängigen Security-/Migration-/UI-Reviews und geschlossenem
P0–P2-Stand. Push/Preview folgt ausschließlich einem separat nachgewiesenen
geschützten Deploypfad.
