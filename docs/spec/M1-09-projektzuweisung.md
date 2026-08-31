# M1-09 — Projektverantwortung und zugewiesene Request-Sicht

- Status: REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO · COMMITTED/INTEGRATED (`e631814`)
- Datum: 2026-08-31
- F-Bezug: F1.1, F1.2 und F1.5 (PARTIAL)
- Architektur: ADR 0014

## Nutzerergebnis

Ein interner berechtigter Nutzer kann an einer bestehenden Anfrage genau eine
aktuelle Hauptverantwortung und weitere direkt zugewiesene Workspace-Mitglieder
pflegen. Neue Rechner-Anfragen dürfen weiterhin ehrlich unzugewiesen eingehen.

Ein Mitglied mit der negativen Sicherheitsmarkierung `external_only` sieht im
ersten Vertrag ausschließlich ihm direkt zugewiesene, offene Request-Karten und
eine minimierte read-only Projektansicht. Nicht zugewiesene, fremde, bereits in
Offer/Installation überführte oder geschlossene Projekte bleiben ohne
Objekt-Oracle unsichtbar. Externe Mutationen und kommerzielle Daten werden durch
M1-09 nicht geöffnet.

Damit wird die seit M1-02 bewusst fail-closed gehaltene Assignment-Lücke erstmals
fachlich und technisch geschlossen, ohne Teams, Auto-Routing oder spätere
Angebots-/Installationsrechte vorzutäuschen.

## Clean-Room-Evidenz

Öffentliche, am 31. August 2026 ohne Account gelesene Reonic-Dokumentation belegt
die beobachtbare Funktionsidee:

- [Project assignments: Key Account, users, teams](https://docs.reonic.com/docs/en/settings-company-project-assignments):
  Projektzuweisung umfasst eine Hauptverantwortung, weitere Nutzer und Teams;
  Zuweisung beeinflusst Sichtbarkeit.
- [Overview of lead characteristics](https://docs.reonic.com/docs/en/leads-overview-lead-characteristics):
  mehrere direkte Nutzer, genau eine aktuelle Hauptverantwortung und
  zuweisungsgebundene Sicht für eingeschränkte Nutzer.
- [Users, roles, licenses, and teams](https://docs.reonic.com/docs/en/settings-company-user-teams):
  Projektzuweisung ist ein getrenntes Einzelrecht und eingeschränkte Nutzer
  sehen nur zugewiesene Projekte.

Diese Quellen belegen keine private Implementierung, kein Datenmodell, keine
exakten Fehlermeldungen und kein UI-Layout. M1-09 verwendet eigene WMEE-Begriffe,
ein eigenes zugängliches Layout und eigene Sicherheitsentscheidungen. Private
Reonic-Zugänge, Screenshots, Texte, Code und Daten bleiben ausgeschlossen.

## Capability- und Abnahmematrix

| ID | Fähigkeit | Objektive Abnahme |
|---|---|---|
| `M109-01` | Unzugewiesener Intake | Bestehende Rechner-/manuelle Projekte starten mit `assignment_revision = 0` und ohne erfundenen Owner |
| `M109-02` | Hauptverantwortung | Pro Projekt existiert höchstens eine direkte Zuweisung vom Typ `key_account`; neue Hauptverantwortung degradiert die vorherige atomar zum weiteren Nutzer |
| `M109-03` | Weitere Nutzer | Bis zu 50 direkte Memberships desselben Workspace sind eindeutig zuweisbar und einzeln entfernbar |
| `M109-04` | Getrenntes Recht | Nur interner Editor mit `assign_projects = true` oder interner Admin darf Zuweisungen ändern; Viewer und jedes `external_only` bleiben gesperrt |
| `M109-05` | Zugewiesenes Board | `external_only` sieht ausschließlich direkt zugewiesene offene Request-Karten; interne Rollen behalten die bisherige Gesamtsicht |
| `M109-06` | Minimiertes Detail | Zugewiesene Externe sehen nur den fest erlaubten Request-/Kontakt-/Adress-/Bedarfsstand; keine Koordinaten, Kalkulationswerte, Provenienz, Katalog-, Angebots- oder Preisdaten |
| `M109-07` | Sofortiger Entzug | Entfernen der letzten direkten Zuweisung sperrt alle folgenden Transaktionen; Membership-Entfernung bleibt bis vorheriger Zuweisungsbereinigung fail-closed |
| `M109-08` | Konfliktfestigkeit | Jede Mutation verlangt `expectedAssignmentRevision`; Parallel- oder Stale-Aufrufe erzeugen keinen Teilstand |
| `M109-09` | Nachweis | Composite-FKs, FORCE RLS, restriktive Actor-Policies, Rollen-, Race-, Route-, E2E- und A11y-Tests sind grün; Event/Audit bleiben PII-frei |

## Eigene Produktentscheidungen

### `0..1` statt erfundener Standardverantwortung

Die öffentliche Produktbeschreibung nennt genau eine Hauptverantwortung. Der
WMEE-Rechner-Intake besitzt jedoch bewusst keinen handelnden Portalnutzer und
keine freigegebene Routingregel. Deshalb gilt:

- eine operativ bearbeitete Anfrage kann genau eine Hauptverantwortung haben;
- ein neuer Intake darf zunächst keine haben;
- das Portal zeigt diesen Zustand ausdrücklich als `Nicht zugewiesen`;
- keine Admin-, Ersteller- oder Default-Membership wird still eingesetzt.

Auto-Zuweisung nach Quelle, Region oder Funnel ist ein eigener späterer Vertrag.

### Alte Hauptverantwortung bleibt direkte Zuweisung

Beim Wechsel von A zu B wird B `key_account` und A atomar zu `user`. Damit geht
der bisherige Bearbeiter nicht überraschend aus der Sichtbarkeit. Soll A auch
die direkte Zuweisung verlieren, ist danach eine getrennte bewusste Entfernung
mit der neuen Revision nötig. Das macht Wechsel und Entzug im Audit unterscheidbar.

### Externe Sicht zunächst read-only und Request-only

Öffentliche Evidenz beschreibt rollenabhängige Bearbeitung. M1-09 öffnet aus
Sicherheitsgründen nur die kleinste belegbare Sicht:

- direkte Zuweisung, keine Team-Vererbung;
- nur `phase = request` und `outcome = open`;
- nur Lesen, unabhängig davon, ob die Membership technisch Rolle Editor oder
  Admin trägt;
- kein Zugriff auf Offer, PDF, Kalkulationseditor, Katalogauflösung,
  Preis-/EK-Werte oder interne Aktivitäten.

Externe Schreibrechte werden erst mit eigenen Commands, Felder-Allowlist,
Rollenmatrix und Tests geöffnet. Das ist eine bewusste lokale Teilfähigkeit,
keine Behauptung vollständiger Reonic-Semantik.

## Datenmodell

### `project.assignment_revision`

- `integer not null default 0`;
- Check `assignment_revision >= 0`;
- wird unter Project-Row-Lock bei jeder wirksamen Assignment-Mutation exakt um
  eins erhöht;
- dient ausschließlich Optimistic Concurrency und ist keine Eventhistorie.

### `project_assignment`

| Feld | Vertrag |
|---|---|
| `id` | stabile UUID |
| `workspace_id` | Pflicht, Tenantwurzel |
| `project_id` | Pflicht, Composite-FK `(workspace_id, project_id)` |
| `membership_id` | Pflicht, Composite-FK `(workspace_id, membership_id)` |
| `assignment_role` | geschlossen: `key_account` oder `user` |
| `created_at` | DB-Zeit |
| `updated_at` | DB-Zeit; nur Rollenwechsel ändert die bestehende Zeile |

Invarianten:

- `UNIQUE (workspace_id, id)`;
- `UNIQUE (workspace_id, project_id, membership_id)`;
- partiell eindeutig genau eine Zeile `assignment_role = 'key_account'` je
  Workspace/Project;
- maximal 50 Zeilen je Projekt, serverseitig unter Project-Lock geprüft;
- Project-Löschung kaskadiert Assignment-Zeilen;
- Membership-Löschung ist `RESTRICT/NO ACTION`. Ein späterer
  Deprovisioning-Command muss Zuweisungen zuerst sichtbar und auditiert lösen;
  es gibt keinen stillen KAM-Verlust.

`membership` besitzt keinen Aktivstatus. `Aktiv` bedeutet in M1-09: Die
tenantgebundene Membership-Zeile existiert zum Zeitpunkt der Mutation und bleibt
bis zur Commit-Grenze FK-gesichert.

## Command-Vertrag

Alle Commands sind strikte diskriminierte Unions, akzeptieren nur UUIDs und
positive beziehungsweise nullte sichere Integer. Freitext, E-Mail, Rolle,
Workspace oder Actor kommen nie aus dem Client.

```ts
type ProjectAssignmentCommand =
  | {
      kind: "set_key_account";
      projectId: string;
      membershipId: string;
      expectedAssignmentRevision: number;
    }
  | {
      kind: "clear_key_account";
      projectId: string;
      expectedAssignmentRevision: number;
    }
  | {
      kind: "add_user";
      projectId: string;
      membershipId: string;
      expectedAssignmentRevision: number;
    }
  | {
      kind: "remove_user";
      projectId: string;
      membershipId: string;
      expectedAssignmentRevision: number;
    };
```

Mutation:

1. `project.assign` und interne Membership prüfen;
2. Project im Actor-Workspace `FOR UPDATE` laden;
3. `assignment_revision` exakt vergleichen;
4. Ziel-Membership tenantgebunden laden; fremd/nicht vorhanden liefert denselben
   generischen Target-Fehler;
5. Zustand deterministisch ändern, Limit und Einzigartigkeit prüfen;
6. Project-Revision erhöhen;
7. PII-freies Domain-Event und Audit in derselben Transaktion schreiben.

`remove_user` darf eine aktuelle Hauptverantwortung nicht implizit löschen.
`clear_key_account` degradiert sie zu `user`; eine vollständige Entfernung ist
ein zweiter ausdrücklicher Command. Ein bereits erfüllter identischer Command
mit aktueller Revision ist ein dokumentierter No-op; ein veralteter Command ist
immer Conflict und mutiert nichts.

## Rechte

Neue Capability und Action:

```text
Capability: assign_projects
Action:     project.assign
Minimum:    editor
Zusatz:     assign_projects = true, außer Admin-Implikation
Grenze:     internalOnly
```

| Akteur | Projektlisten/-detail | Assignment lesen | Assignment ändern | Sonstige Projektmutation |
|---|---|---|---|---|
| interner Viewer | alle bisherigen Requests read-only | aktuellen Stand | nein | nein |
| interner Editor ohne Recht | bisherige Rechte | aktuellen Stand | nein | bisherige Rechte |
| interner Editor mit Recht | bisherige Rechte | Stand + Membership-Suche | ja | bisherige Rechte |
| interner Admin | bisherige Rechte | Stand + Membership-Suche | ja | bisherige Rechte |
| `external_only`, direkt zugewiesen | nur eigene offene Requests, minimiert | keine Personenliste | nein | nein |
| `external_only`, nicht zugewiesen | nichts | nichts | nein | nein |
| `app_worker` | nichts zusätzlich | nichts | nein | nein |

Die Membership-Suche akzeptiert eine normalisierte Suchfolge von 2 bis 100
Zeichen, sucht case-insensitiv nach Workspace-Mitglieds-E-Mail, liefert maximal
20 Treffer und gibt niemals fremde Workspace-Identitäten zurück. Ohne
`project.assign` wird sie nicht ausgeführt.

## RLS- und Datenbankgrenze

Jede neue Tenant-Tabelle erhält genau eine permissive `tenant_isolation`-Policy,
FORCE RLS, Workspace-FK und vollständige `WITH CHECK`-Grenzen.

Zusätzlich erhält `project` befehlsspezifische **restriktive** Actor-Policies:

- Actor ohne `external_only` sowie enge actorlose Systempfade bleiben wie bisher
  tenantgebunden sichtbar;
- `external_only` darf bei SELECT nur offene Request-Projekte sehen, für die
  seine aktuelle Membership direkt in `project_assignment` steht;
- INSERT/UPDATE/DELETE auf Project ist für `external_only` DB-seitig gesperrt.

`project_assignment` erhält ebenfalls restriktive Policies:

- intern: tenantgebundener Read;
- extern: höchstens die eigene direkte Assignment-Zeile;
- externe INSERT/UPDATE/DELETE immer false;
- Worker erhält weder DML- noch Funktionsrechte.

Die SQL-Helfer für Actor-Membership und `external_only` müssen die TypeScript-
Semantik exakt spiegeln: fehlendes Flag oder ausschließlich der boolesche Wert
`false` bedeutet intern; jeder andere vorhandene Wert ist fail-closed extern.
Ein fehlender Actor ist nur auf bereits dokumentierten System-/Testpfaden kein
External-Akteur. Ein GUC authentifiziert niemanden; die normale Tenant- und
Principal-Grenze bleibt zusätzlich erforderlich.

## Readmodelle

### Intern

Bestehende Board- und Projekt-DTOs bleiben kompatibel und erhalten nur:

- `assignmentRevision`;
- `keyAccount: { membershipId, label } | null`;
- weitere aktuell zugewiesene Nutzer für die Projektakte;
- `canAssign` und nur dann Suchergebnisse.

`label` wird intern aus der Workspace-Membership und der kanonischen
`user_identity.email` abgeleitet. E-Mail-Adressen gehen weder in URL noch Event,
Audit oder Logs.

### Zugewiesen extern

Ein eigener SQL- und DTO-Pfad lädt ausschließlich:

- Project-ID, Projektname, Phase, Outcome, Erstellzeit und Spaltenname;
- Kontakt-Anzeigename, primäre E-Mail und Telefon;
- formatierte Projektadresse ohne Lat/Lng, Geocode-Quelle oder technische
  Revisionsdetails;
- angefragte Produktgruppe, Speicherziel, Wallbox, bidirektionales Laden und
  Ersatzstrom;
- verständliche operative Blocker ohne interne Hashes oder Ursachenpayloads.

Ausgeschlossen sind Calculator-Resultate, Investitions-/Amortisationswerte,
Energieprofil, präzise Koordinaten, technische Provenienz, Katalogauflösung,
Offer-Bereitschaft, Offer/PDF/Issuance, EK/VK, interne Actor-/Membershiplisten
und alle Mutationscontrols.

Der App-Server entscheidet anhand einer vom Service gelieferten diskriminierten
Audience-Union, bevor weitere Energie-, Katalog- oder Offer-Queries laufen. Das
Client-UI ist niemals Sicherheitsgrenze.

## Oberfläche und Barrierefreiheit

### Intern

- Board-Karte zeigt Hauptverantwortung oder `Nicht zugewiesen`.
- Projektakte enthält eine Landmark-Sektion `Projektverantwortung`.
- aktueller Stand ist auch für Viewer lesbar;
- berechtigte Nutzer suchen Memberships serverseitig, setzen/wechseln/entfernen
  KAM und weitere Nutzer über native Formulare;
- jeder Button hat eindeutigen Accessible Name, mindestens 44 px Zielgröße,
  Pending-Sperre, Fokusführung und eine verlinkte Fehlerzusammenfassung;
- Conflict behält keine falsche lokale Erfolgssicht und fordert Reload.

### Zugewiesen extern

- eigener klarer Hinweis `Zugewiesene Anfrage · Nur Lesezugriff`;
- keine Katalog-, Offer-, Energieprofil- oder Assignment-Navigation;
- 404 für nicht vorhandene und nicht zugewiesene IDs;
- Desktop, 375 px, 320-px-Reflow, 200 % Zoom, Tastatur und Axe.

## Nebenläufigkeit und Entzug

- globale Lock-Reihenfolge für den Command: Project vor Assignment-Zeilen;
- Membership wird nicht vor einem Membership-DML-Workspace-Lock exklusiv
  gesperrt; der Composite-FK entscheidet einen parallelen Deprovisioning-Race;
- zwei Commands mit derselben erwarteten Revision können nicht beide wirken;
- Key-Account-Wechsel, Rollendowngrade und neue Revision sind eine Transaktion;
- nach Commit einer Assignment-Entfernung liefert jede neue autorisierte
  Transaktion 404 beziehungsweise keine Board-Karte;
- ein bereits laufender Read darf seinen konsistenten READ-COMMITTED-Statement-
  Snapshot beenden; es gibt keine falsche Zusage eines Mid-Response-Kills;
- Membership-Entzug selbst sperrt den nächsten `withSessionTenant`-Start bereits
  unabhängig von Assignment.

## Events, Audit und Datenschutz

Erlaubte Eventtypen:

- `project.assignment_key_account_changed`;
- `project.assignment_user_added`;
- `project.assignment_user_removed`.

Payload-Allowlist: `projectId`, neue `assignmentRevision`, Commandtyp,
Ziel-`membershipId` und bei KAM-Wechsel optional vorherige Membership-ID. Keine
E-Mail, Namen, Kontakt-/Adressdaten, Rollenpayloads, Capabilities oder freien
Notizen.

Audit verwendet dieselbe ID-Allowlist und den verifizierten Actor. Assignment-
Zeilen gehören als interne Arbeitszuordnung zum Project-Lebenszyklus. Eine
Project-Löschung darf sie kaskadieren; die append-only Event-/Auditbelege bleiben
nach dem bestehenden Pseudonymisierungskonzept nur mit IDs erhalten.

## RED- und Abnahmetests

### Contract und Permissions

- geschlossene Command-Union, UUID/Revision/Search-Grenzen;
- `project.assign` für Viewer, Editor ohne Recht und alle External denied;
- Admin-Implikation ohne Capability; malformed `external_only` fail-closed;
- Actions leiten Workspace/Actor/Rolle niemals aus FormData ab.

### Datenbank und Migration

- Fresh sowie Upgrade von 0035; späterer Merge berücksichtigt die parallel
  reservierte M1-08b-Migration 0036;
- Composite-FKs, Workspace-FK, Unique/Partial-Unique, Check und Limit;
- FORCE RLS, genau eine permissive Policy, restriktive Actor-Policies;
- Cross-Tenant-Assignment, fremde Membership und External-DML gesperrt;
- Membership-DELETE mit aktiver Assignment-Zeile fail-closed;
- Project-DELETE räumt Assignment-Zeilen auf;
- Runtime- und Worker-ACL exakt.

### Service und Races

- unassigned 0 → KAM A rev1 → KAM B rev2, A bleibt user;
- Add/Remove user, Duplicate/No-op, aktueller KAM nicht implizit entfernbar;
- 50er-Grenze, fremde/nicht vorhandene Ziel-ID gleiche Fehlerklasse;
- zwei parallele expected-Revision-Commands: genau einer wirkt;
- Revocation-Race und Membership-Delete-Race ohne Teilstand;
- Event/Audit exakt einmal und ohne PII.

### Readmodelle und Browser

- interne Gesamtsicht unverändert;
- External A sieht nur direkt A zugewiesene offene Requests;
- External B, Fremdtenant und zufällige UUID sehen nichts unterscheidbar;
- Phasewechsel oder Schließen entfernt Karte und Detail aus der externen Sicht;
- externer HTML-/RSC-Payload enthält keine Kalkulation, Preise, Koordinaten,
  technischen Revisionen, Membershiplisten oder versteckte Controls;
- Assignment-Suche und -Form bei Keyboard/Reflow/Axe;
- Reload nach jeder Mutation und sofortiger Entzug in neuer Session/Request.

### Repository-Gates

- Lint, Next-Typegen/Typecheck, Dependency-Cruiser und Build;
- vollständige Vitest-Suite;
- Tenant-Isolation, DB-Rollenvertrag und PG18-Proben;
- Chromium-Golden-Path, Mobile/Reflow und A11y;
- unabhängiges Code- und Security-Review; P0–P2 geschlossen.

## Nichtziele

- Teams, Teamleitervererbung, Bereichs-Toggles oder Teamkalender;
- automatische Zuweisung nach Quelle, Region, Broker oder Funnel;
- Benachrichtigungen, E-Mail-Absender, Reporting/KPI-Aggregation;
- externe Schreibrechte, Mobile-App-Sicht oder Aufgaben;
- Contact-Ownership über mehrere Projekte hinweg;
- Offer-, PDF-, Signatur-, Installation-, Rechnungs- oder Kundenportalzugriff;
- workspaceübergreifende Partnerweitergabe;
- Kopie privater Reonic-UI, Texte oder interner Regeln.

## Gate 1

Der Nutzer hat im laufenden Gesamtziel Gate 1 und alle weiteren
Implementierungs- und Commitgates allgemein freigegeben. Die isolierte Abnahme
und das gemeinsame M1-08b→M1-09-Integrationsgate sind grün; Feature-Commit
`af8f297` ist in Integrationscommit `e631814` enthalten. Push und Deploy wurden
für diesen Stand noch nicht ausgeführt.
