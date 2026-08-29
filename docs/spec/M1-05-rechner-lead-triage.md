# M1-05 — Rechner-Lead → vertriebliche Triage

Status: **REVIEWED/VERIFIED (lokal)**

Scope: Geschützter Browserpfad
`Login/OTP → Workspace → Rechner-Anfrage → Request-Kanban → Projektakte → Triage`

Vorgänger: M1-04 erzeugt atomar
`Contact → Site → Project(request/open) → CalculatorSnapshot → Requirements`.

## Ziel

Eine signierte Rechner-V3-Anfrage wird für einen berechtigten Workspace-Nutzer
erstmals als echte, persistierte Vertriebsarbeit sichtbar. Der Nutzer öffnet
einen geschützten Weblink, meldet sich per E-Mail-OTP an, sieht jede neue
Anfrage genau einmal in der physischen Eingangsspalte, öffnet die Projektakte
und verschiebt die Karte dauerhaft durch die Request-Triage.

Eine hausgenaue, ausgewählte Rechner-Adresse kann ein Editor in der
Projektakte bewusst als Planungs-Pin bestätigen. Eine regionale Schätzung oder
eine nicht hausgenaue Adresse kann niemals bestätigt werden. Die Korrektur
einer ungenauen Adresse folgt in M1-06.

Dieser Slice erzeugt ausdrücklich **keinen** Katalogartikel, keine BOM, kein
Angebot und keine kommerzielle Preiswahrheit. Rechnerwerte bleiben
`client_reported_unverified` und `market_estimate`.

## Abgrenzung und eigene Produktentscheidung

Die drei initialen Spalten sind eine eigene WMEE-Arbeitskonfiguration und
keine Behauptung über Reonic-Defaults:

1. `Eingang`
2. `In Prüfung`
3. `Qualifiziert`

Alle drei tragen den fachlichen Typ `lead`. Die spätere Admin-Konfiguration
von Boards, Spalten, Farben und Conversion-Ratios ist nicht Teil dieses
Slices. Ebenso offen bleiben Zuweisungen, Aufgaben, Kalender, E-Mail,
Lead-Score, Lost-/Won-Gründe und Offer-Boards.

Ein Spaltenwechsel ist nur vertriebliche Triage. Er verändert weder
`project.phase` noch `project.outcome`. `won`, `lost` und
`cannot_fulfill` bleiben bewusste, getrennte Zustandsübergänge.

## Kanonisches Datenmodell

### `kanban_board`

- `id uuid primary key default random`
- `workspace_id uuid not null`
- `name text not null`
- `scope text not null` mit `residential | commercial`
- `is_default boolean not null default false`
- `archived_at timestamptz null`
- `created_at`, `updated_at`
- `UNIQUE (workspace_id, id)`
- höchstens ein aktives Default-Board pro `(workspace_id, scope)`
- Workspace-FK, RLS `ENABLE/FORCE`, genau eine permissive
  `tenant_isolation`-Policy

### `kanban_column`

- `id uuid primary key default random`
- `workspace_id uuid not null`
- `board_id uuid not null`
- `name text not null`
- `column_type text not null` mit `lead | offer | won | lost`
- `position integer not null`, positiv
- `color text not null` als fest validierter semantischer Token
- `is_intake boolean not null default false`
- `archived_at timestamptz null`
- `created_at`, `updated_at`
- `UNIQUE (workspace_id, id)`
- `UNIQUE (workspace_id, board_id, id)` als zusammengesetztes FK-Ziel
- zusammengesetzter FK `(workspace_id, board_id)`
- aktive Position pro Board eindeutig
- höchstens eine aktive Intake-Spalte pro Board
- RLS `ENABLE/FORCE`, genau eine permissive `tenant_isolation`-Policy

### `project`

Additiv:

- `kanban_board_id uuid not null`
- `kanban_column_id uuid not null`
- zusammengesetzter FK `(workspace_id, kanban_board_id)`
- zusammengesetzter FK
  `(workspace_id, kanban_board_id, kanban_column_id)`
- stabiler Board-Index
  `(workspace_id, kanban_column_id, created_at, id)`

Die Migration legt für jeden vorhandenen Workspace das Residential-Board
`Anfragen` mit den drei Spalten an und ordnet vorhandene Projects `Eingang`
zu. Vor dem Backfill bricht sie laut ab, falls der bekannte lokale Bestand
nicht ausschließlich `request/open` ist; sie darf andere Phasen nicht still
in eine Lead-Spalte umdeuten.

Ein gehärteter Workspace-Provisioning-Trigger legt dieselbe Konfiguration für
neu angelegte Workspaces an. Die Funktion ist `SECURITY DEFINER`, besitzt einen
festen `search_path`, ist nicht öffentlich ausführbar und wird im exakten
DB-Rollenvertrag inventarisiert. Dadurch benötigt die Web-Runtime keine
Board-Schreibrechte für den Rechner-Intake.

## Rechner-Intake nach M1-05

Vor dem Project-Insert löst M1-04 innerhalb derselben Tenant-Transaktion das
aktive Residential-Default-Board und dessen aktive Intake-Spalte auf. Fehlt
oder widerspricht diese Konfiguration, rollt die vollständige Aufnahme
fail-closed zurück.

Neue Projects erhalten Board und Spalte direkt beim Insert. Exact Replay
liefert dieselbe Receipt und erzeugt weder ein zweites Project noch eine
zweite Karte.

## Öffentliche Modulgrenzen

### `modules/boards`

`getDefaultRequestBoard(tx, ctx)`:

- verlangt `project.read`;
- sperrt `external_only` vollständig, solange kein Assignment-Modell existiert;
- liefert ausschließlich ein minimales, serialisierbares Board-DTO;
- sortiert Spalten nach `position`, Karten stabil nach
  `created_at DESC, id DESC`;
- liefert keine rohen DB-Zeilen und keinen vollständigen Rechner-Snapshot.

`moveProjectCard(tx, ctx, input)`:

- verlangt `project.write`;
- sperrt `external_only` vollständig;
- sperrt die Project-Zeile;
- prüft `expectedColumnId` als Optimistic-Concurrency-Gate;
- akzeptiert nur eine aktive `lead`-Zielspalte desselben Boards;
- akzeptiert nur Projects in `request/open`;
- ändert ausschließlich `kanban_column_id` und `updated_at`;
- emittiert `project.kanban_moved` und schreibt den Erfolgs-Audit atomar;
- verändert niemals Phase, Outcome, Pin oder Katalogstatus.

### `modules/projects`

`getProjectTriageDetail(tx, ctx, projectId)`:

- verlangt `project.read` und sperrt `external_only`;
- liefert ein minimales DTO aus Project, Contact, Site, Intake-Provenienz,
  Rechnerkennzahlen und aktueller Requirement-Revision;
- markiert Dedupe-, Adress-, Pin- und Katalogblocker explizit;
- gibt Marktökonomie nur als separate Schätzung mit der festen Kennzeichnung
  `Unverifizierter Richtwert – kein Angebotspreis` aus.

`confirmProjectSitePin(tx, ctx, input)`:

- verlangt `project.write` und sperrt `external_only`;
- sperrt Project und Site;
- liest Site und Project erneut aus dem verifizierten Workspace;
- erlaubt Bestätigung nur bei `address_mode=selected`,
  `geocode_precision=house`, `address_follow_up_required=false`, vorhandenen
  vollständigen Adressfeldern und gültigen Koordinaten;
- setzt ausschließlich `site.pin_confirmed=true`; der Änderungszeitpunkt bleibt
  über das atomare append-only Event und den Erfolgs-Audit nachvollziehbar;
- ist bei bereits bestätigtem Pin idempotent ohne zweites Event;
- emittiert einmal `site.pin_confirmed` und schreibt den Erfolgs-Audit atomar.

Services schreiben bei Ablehnung keinen Audit in die abgebrochene
Transaktion. Die bestehende autorisierte Aufrufgrenze schreibt den
PII-freien Denial-Audit erst nach dem Rollback mit verifiziertem Actor.

## Autorisierte Read-Grenze

`lib/action.ts` erhält neben `authorizedAction` eine gemeinsame
`authorizedQuery`-Grenze. Beide benutzen dieselbe Session→Identity→Membership-
Auflösung und denselben fail-closed Permission-/Denial-Audit-Vertrag.

URL-Parameter sind ausschließlich untrusted Identifier. Jede Seite und jede
Server Action validiert Workspace-, Project-, Board- und Column-IDs vor dem
Öffnen einer Tenant-Transaktion. Jede Server Action authentifiziert und
autorisiert erneut, da sie direkt per POST erreichbar ist.

## Geschützter Browserpfad

### Anmeldung

- `/login` bietet E-Mail und sechsstelligen OTP als zweistufiges Formular.
- Der vorhandene Better-Auth-`emailOTP`-Provider bleibt kanonisch; kein zweites
  Auth-System entsteht.
- Fehlerzustände sind generisch und verraten nicht, ob eine E-Mail existiert.
- `next` wird serverseitig auf einen internen absoluten Pfad begrenzt; keine
  offenen Redirects.
- Geschützte Workspace-Routen leiten ohne Session nach `/login` zurück.
- Eine Session ohne Membership erhält keine Workspace-Daten.

### Routen

- `/w/[workspaceId]/anfragen` — echtes Request-Kanban
- `/w/[workspaceId]/anfragen/[projectId]` — echte Triage-Projektakte

Die UI ist deutsch. `params` und `searchParams` werden gemäß Next 16 als
Promises behandelt. Daten kommen in Server Components über die autorisierte
Read-Grenze; nur Drag-and-drop, Formularstatus und Login sind Client-Islands.

## Visuelle Richtung

Die Oberfläche ist eigenständig, leise, dicht und für tägliche
Vertriebsarbeit optimiert:

- neutrale helle Flächen, klare 1px-Grenzen, sparsame Schatten nur für
  Overlays und gezogene Karten;
- genau eine WMEE-Akzentfarbe für primäre Aktion, Fokus und aktive Navigation;
- Statusfarben sind feste semantische Tokens und werden stets mit Text/Icon
  kombiniert;
- 8px-Grundraster, kompakte Karten, gut lesbare deutsche Beschriftungen und
  tabellarische Ziffern für kWh/kWp/Euro;
- Karte: Kundenname → Ort/PLZ → Bedarf-Chips → Alter/Warnungen;
- Projektakte: Identität → Adresse/Qualität → Bedarf → Rechner-Schätzung →
  technische Provenienz;
- der Rechner-Hinweis steht sichtbar oberhalb der Zahlen, nie nur in Tooltip,
  Kleingedrucktem oder wegklickbarem Banner;
- Viewer sehen keine deaktivierten Scheinaktionen, sondern einen klaren
  `Nur Lesezugriff`-Status.

Desktop zeigt drei Spalten mit fixierten Überschriften. Mobil wird das Board
zu Statusfilter plus einer vertikalen Liste; Drag-and-drop ist dort nicht die
primäre Bedienung. Die Projektakte ist deep-linkbar und mobil eine Vollseite.

Es gibt keine Navigation oder deaktivierte Buttons für noch nicht gebaute
Katalog-, Angebots-, PDF- oder Installationsfunktionen.

## Barrierefreiheit und Interaktion

- WCAG 2.2 AA, sichtbarer Fokus, 44px Touch-Ziele bei mobilen Hauptaktionen;
- semantische Überschriften, Landmarks und aussagekräftige Form-Labels;
- kein Status ausschließlich durch Farbe;
- Drag-and-drop ist optional;
- jede Karte besitzt eine gleichwertig sichtbare Aktion `Verschieben` mit
  Zielspaltenauswahl, die per Tastatur und ohne Pointer funktioniert;
- Move-Erfolg und -Fehler werden in einer `aria-live`-Region angekündigt;
- keine Bewegung bei `prefers-reduced-motion`;
- OTP nutzt `autocomplete=email` beziehungsweise `autocomplete=one-time-code`;
- Loading-, Empty-, Denied-, Not-found-, Conflict- und Unexpected-Error-Zustand
  sind echte, automatisiert geprüfte UI-Zustände;
- keine Hydration- oder Console-Fehler.

## Datenschutz und Datenminimierung

Board-DTO:

- Project-ID, Name, Erstellzeit, Quellklassifizierung;
- Anzeigename und nur der für die Triage nötige Standorttext;
- Adress-/Dedupe-/Pin-/Katalogflags;
- angefragte Produktkategorien und Speicherkapazität;
- keine E-Mail, kein Telefon, keine Koordinaten, kein Roh-Snapshot und keine
  Rechnerpreise.

Detail-DTO enthält Kontaktfelder und Adresse nur, weil die berechtigte
Projektakte sie tatsächlich darstellt. Client-Islands erhalten dennoch nur
die für ihre konkrete Interaktion nötigen IDs und Texte.

Events/Audits enthalten ausschließlich IDs und technische Klassifizierungen,
nie Name, E-Mail, Telefon, Anschrift, Koordinaten oder Rechnerwerte.

## DB-Rollen und RLS

- `app_runtime`: `SELECT` auf Board/Column sowie bestehende notwendige
  Project-/Intake-Tabellen; `UPDATE` auf Project und Site; keine Board-DDL oder
  Board-Konfiguration.
- `app_system`, `app_auth`, `app_worker`: kein neuer fachlicher Tabellenzugriff.
- Provisioning erfolgt ausschließlich über den gehärteten Workspace-Trigger.
- beide neuen Tabellen und die neue Funktion werden im exakten Relations-,
  RLS-, Policy-, Function- und ACL-Inventar aufgenommen.

## Abnahmekriterien

### Datenbank und Services

- Fresh-Migration und Upgrade ab M1-04 sind grün; bestehende Projects bleiben
  erhalten und landen genau einmal in `Eingang`.
- Neue Workspaces erhalten genau ein Residential-Default-Board und genau eine
  Intake-Spalte, auch bei paralleler Anlage.
- Rechner-Intake erzeugt eine Karte in `Eingang`; Exact Replay keine zweite.
- Cross-Tenant-Board-/Column-FKs scheitern auf DB-Ebene.
- Viewer liest Board und Detail, kann aber weder verschieben noch Pin
  bestätigen.
- Editor-Move persistiert; stale Expected-Column, fremdes Board, archivierte
  oder Nicht-Lead-Spalte bleiben ohne Seiteneffekt.
- Move verändert Phase und Outcome nicht.
- Pin-Bestätigung gelingt nur hausgenau; regional/provisorisch scheitert ohne
  Seiteneffekt; Wiederholung ist idempotent.
- Mutation, Event und Erfolgs-Audit rollen gemeinsam zurück.
- `external_only` ist bis zum Assignment-Slice fail-closed.
- generische Tenant-, RLS-, Policy- und DB-Rollen-Inventare sind vollständig.

### Browser

- Signed Fixture → Login/OTP → Karte sichtbar → Projekt öffnen → hausgenauen
  Pin bestätigen → Karte per Tastatur verschieben → Reload zeigt Persistenz.
- Viewer sieht dieselben erlaubten Daten, aber keine Move-/Pin-Aktion.
- fremder Workspace und fremdes Project liefern keine Daten.
- Desktop, Tablet und Mobile sind geprüft; Drag-and-drop und Formularpfad
  erreichen denselben Service.
- leere Spalten, Denied, 404 und Konflikt sind im echten Browserpfad sichtbar
  und verständlich; Loading- und unerwartete Error-Boundaries werden zusätzlich
  in fokussierten UI-Render-Tests ohne interne Fehlerlecks geprüft.
- keine Console-, Hydration- oder schwerwiegenden Axe-Verstöße.

### Repository-Gates

- Modulgrenzen: `app/` importiert nur öffentliche Modul-APIs und nie `lib/db`.
- `npm run lint`
- `npm run typecheck`
- `npm run depcruise`
- fokussierte RED→GREEN-Tests und vollständiges `npm run test`
- `npm run db:roles:verify`
- `npm run build`
- unabhängiger Review ohne offene P0–P2-Befunde

## Bewusst offen nach M1-05

1. Korrektur/Neugeocoding ungenauer Adressen und Karten-Pin-Editor.
2. Freigegebene Workspace-Katalogrevisionen mit Preisprovenienz.
3. Auflösung der Rechner-Requirements gegen echte Produkte.
4. Angebotsreife und anschließend drei Quick-Offer-Varianten mit Snapshot-BOM.
5. Zuweisungen und damit eine echte `external_only`-Sicht.
6. Admin-Oberfläche für zusätzliche Boards, Spalten und Reihenfolge.
7. Provider-Wiring erst nach veröffentlichtem Datenschutzhinweis und echten
   Secrets.

Für M1-05 ist kein zusätzliches CRM, kein Kauf-Plugin und kein externer
Produktkatalog nötig.
