# ADR 0014: Projektzuweisung und zugewiesene externe Sicht

- Status: angenommen
- Datum: 2026-08-31
- Bezug: `docs/spec/M1-09-projektzuweisung.md`

## Kontext

Seit M1-02 existiert `external_only` als negative Sicherheitsmarkierung. Alle
Projekt-, Board-, Site-, Energie-, Katalog- und Offer-Pfade sperren solche
Memberships bewusst vollständig, weil bislang kein tenantgebundenes
Assignment-Modell existiert. Gleichzeitig verlangt F1 direkte
Projektverantwortung und eine auf zugewiesene Projekte begrenzte Sicht.

Die öffentliche Clean-Room-Evidenz bestätigt drei beobachtbare Ideen: eine
einzelne aktuelle Hauptverantwortung, weitere direkte Nutzer und
zuweisungsgebundene Sicht für eingeschränkte Nutzer. Teams und rollenabhängige
Bearbeitung sind breiter als der sichere erste WMEE-Slice.

Rechner-Intake wird actorlos angenommen. Eine automatische Hauptverantwortung
aus Admin, Ersteller oder Quelle abzuleiten wäre daher erfunden und könnte Leads
unbemerkt an die falsche Person öffnen.

## Entscheidung

M1-09 führt `project_assignment` als aktuellen, tenantgebundenen Satz direkter
Membership-Zuweisungen ein. Eine Zeile ist entweder `key_account` oder `user`.
Composite-FKs auf Project und Membership verhindern Cross-Tenant-Referenzen;
eine partielle Unique-Grenze erlaubt höchstens einen Key Account je Projekt.

`project.assignment_revision` serialisiert alle fachlichen Änderungen. Jeder
Command sperrt zuerst das Project, prüft die erwartete Revision, validiert die
Ziel-Membership und schreibt Assignment, neue Revision, Domain-Event und Audit
atomar. Die vorherige Hauptverantwortung bleibt bei einem Wechsel als direkte
`user`-Zuweisung bestehen und kann erst danach bewusst entfernt werden.

Neue Projekte dürfen Revision 0 und keine Zuweisung besitzen. `Nicht
zugewiesen` ist ein echter Zustand, keine Fehlkonfiguration. Auto-Routing bleibt
ein eigener Folgeentscheid.

Projektzuweisung erhält die getrennte Action `project.assign` und Capability
`assign_projects`. Editor benötigt das explizite Recht, Admin impliziert es.
Die Action ist `internalOnly`; ein `external_only`-Actor kann sie unabhängig von
seiner nominellen Rolle oder Capability nie ausführen.

Die externe Öffnung bleibt bewusst klein. Zusätzliche restriktive RLS-Policies
auf `project` erlauben `external_only` ausschließlich SELECT auf direkt
zugewiesene Projekte in `request/open`. Project-DML ist für diese Actors
DB-seitig gesperrt. `project_assignment` zeigt einem externen Actor höchstens
seine eigene Zeile und erlaubt keinerlei DML. Die vorhandene permissive
Tenant-Policy bleibt jeweils genau einmal bestehen; Actorregeln sind niemals
eine zweite permissive Policy.

Der App-Server verwendet für Externe einen eigenen SQL-/DTO-Pfad. Er lädt nur
Kontakt, formatierte Adresse, Bedarf und operative Blocker. Die interne
Projektakte wird vor Energie-, Katalog- oder Offer-Reads in eine Audience-Union
verzweigt. So hängt die Datensparsamkeit nicht von versteckten UI-Elementen ab.

Interne Viewer, Editor und Admin behalten ihre bisherige Workspace-Sicht.
Assignment ist für sie in M1-09 Verantwortungsinformation beziehungsweise ein
Filterattribut, keine zusätzliche Zugriffsschranke.

Membership-Löschung kaskadiert nicht still. Ein aktives Assignment blockiert
sie per FK, bis ein späterer Deprovisioning-Command die Verantwortungen bewusst
und auditiert löst. Project-Löschung kaskadiert Assignments, weil sie ohne
Project keinen fachlichen Zweck haben.

## Sicherheitsfolgen

- Ein zugewiesener External-Viewer erhält erstmals echte Kundendaten. Deshalb
  sind Project-RLS, Service-Branch, DTO-Allowlist und UI vier getrennte
  Schranken.
- Nicht vorhanden und nicht zugewiesen bleiben identisch `not found`; weder
  Assignment-Suche noch Fehlertexte werden zum Membership-/Project-Oracle.
- Offer-, Kalkulations-, Katalog- und Site-Mutationsservices behalten ihre
  bestehenden External-Sperren. M1-09 entfernt sie nicht global.
- Actor-GUCs bleiben Kontexttransport, keine Authentifizierung. Workspace-RLS,
  live Membership-Auflösung und DB-Principalgrenzen gelten weiter.
- Events und Audit enthalten nur sichere IDs, Commandtyp und Revision, nie
  E-Mail, Namen, Kontakt-, Adress- oder kommerzielle Daten.
- Worker erhält keine neuen Rechte.

## Konsequenzen

- Rechner-Leads können sichtbar einer verantwortlichen Person und weiteren
  Bearbeitern zugeordnet werden.
- Eingeschränkte Partner-/Mitarbeiterkonten erhalten eine echte, minimal
  begrenzte Request-Sicht statt vollständiger Sperre.
- Teams, Auto-Routing und externe Bearbeitung können additiv auf demselben
  Modell folgen, ohne die erste Grenze aufzuweichen.
- KAM als PDF-Absender, Portal-Kontakt und Reportingdimension bleibt bewusst
  unverdrahtet, bis die jeweiligen Slices eigene Snapshots und Tests besitzen.
- Membership-Offboarding braucht vor produktiver Self-Service-Verwaltung einen
  expliziten Assignment-Cleanup-Command.

## Verworfen

### `owner_user_id` direkt auf Project

Verworfen, weil zusätzliche Nutzer, Rollenwechsel und tenantgebundene
Membership-Identität fehlen würden. Ein globaler User-FK beweist keine
Mitgliedschaft im Projekt-Workspace.

### Externe Sicht nur in TypeScript filtern

Verworfen. Ein vergessener Service-Filter würde den gesamten Tenant öffnen.
Die RLS muss External-Zugriff einschränken und darf dabei nur restriktiv sein.

### Zweite permissive Assignment-Policy

Verworfen. PostgreSQL verknüpft permissive Policies mit OR; eine solche Policy
könnte die Tenantgrenze öffnen statt verengen.

### Teams bereits im ersten Slice

Verworfen. Teamleiter-/Mitgliedervererbung, Mehrfachteams und Deprovisioning
sind ein eigenes Autorisierungsmodell. Direkte Membership-Zuweisung ist der
kleinste reale End-to-End-Vertrag.

### External-Editor sofort schreiben lassen

Verworfen. Öffentliche Rollenbeschreibung reicht nicht als Feld-Allowlist für
unsere Projektakte. Ein eigener Schreibslice muss Commands, erlaubte Felder,
Conflicts und Events explizit festlegen.

### Membership-Löschung kaskadiert Assignments

Verworfen. Stiller Verlust der Hauptverantwortung würde Revision, Event und
Audit umgehen. Offboarding muss Verantwortungen zuerst sichtbar lösen.

### Bestehende KAM-Zuweisung beim Wechsel löschen

Verworfen. Der bisherige Bearbeiter würde ohne getrennte Entzugsentscheidung
sofort den Projektzugriff verlieren. Der Wechsel degradiert ihn zunächst zum
weiteren Nutzer.
