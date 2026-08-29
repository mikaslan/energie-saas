# M1-06 — Planungsstandort und Adresskorrektur

Status: **REVIEWED / VERIFIED (lokal)**

Scope: Geschützter Browserpfad
`regionaler Rechner-Lead → Projektakte → Adresssuche → Pin prüfen → Adresse speichern → Pin getrennt bestätigen`

Vorgänger: M1-05 macht Rechner-Anfragen im Request-Board und in der
Projektakte sichtbar. Hausgenaue Rechner-Adressen lassen sich bereits bewusst
bestätigen; regionale Schätzungen bleiben korrekt gesperrt.

## Fähigkeit und Nutzerergebnis

Ein Editor oder Admin kann eine regionale Rechner-Schätzung in der bestehenden
Projektakte in einen hausgenauen operativen Planungsstandort überführen. Die
Adressauswahl wird serverseitig gegen Geoapify aufgelöst. Der Nutzer sieht die
strukturierte Adresse und die Koordinaten zusätzlich zur Karte, kann den Pin in
einem eng begrenzten Radius korrigieren und speichert die Änderung zunächst
ausdrücklich **unbestätigt**. Erst eine zweite bewusste Aktion bestätigt den
aktuellen Pin.

Nach Reload zeigen Projektakte und Request-Board denselben persistierten
Stand. Der Adressblocker ist nach der Korrektur entfernt; der Pin-Blocker erst
nach der getrennten Bestätigung.

Diese Fähigkeit vervollständigt den ersten lokalen Teil von F1.3 und den
Golden-Path-Schritt `Kontakt → Standort/Adresskorrektur`. Sie erzeugt weder
Katalogwahrheit noch Kalkulation, BOM, Angebot, PDF oder Phase-Conversion.

## Evidenz und Produktentscheidungen

- Blaupause und Parity-Status verlangen einen projektbezogenen Standort, der
  von der Kontaktadresse abweichen kann, sowie eine bewusste Pin-Bestätigung.
- M1-05 nennt Adresskorrektur/Neugeocoding ausdrücklich als nächsten offenen
  Schritt.
- Rechner-V3 darf regionale Koordinaten liefern. Diese sind nur ein
  Richtwert, nie eine bestätigte Kundenadresse.
- Geoapify ist die dokumentierte Geocoding-Entscheidung; MapLibre mit
  OpenFreeMap ist für Dev/Preview bereits vorgesehen. Es wird kein externes CRM
  und kein Kauf-Plugin benötigt.
- Der Geoapify-Vertrag folgt der offiziellen Address-Autocomplete- und
  Place-Details-Dokumentation. Ein `place_id` ist nur eine Providerreferenz;
  seine Daten werden beim Speichern serverseitig erneut aufgelöst.

Eigene, offen benannte Produktentscheidung für diesen Slice:

- Ein korrigierter Pin darf höchstens 150 Meter vom serverseitig aufgelösten
  Hauspunkt entfernt liegen. Das deckt Wohngebäude und Grundstückskorrekturen
  ab, verhindert aber eine Adressauswahl als freie Koordinateneingabe. Eine
  spätere Flurstücks-/Großprojektlogik benötigt eine eigene Fähigkeit.
- Eine Kollision mit einer anderen Site desselben Kontakts und desselben
  Adressfingerprints wird fail-closed gemeldet. M1-06 führt weder Sites
  zusammen noch bindet Receipt/Project auf eine andere Site um.

## Vertrauensgrenzen

1. Der Rechner-HMAC beweist nur den Absender, nicht die sachliche Adresse.
2. Browserfelder, URL-Parameter, `placeId`, Revision und Koordinaten sind
   untrusted.
3. Geoapify ist ein externer, nicht autoritativer Vorschlagsdienst. Nur ein
   vollständiger deutscher Hausadress-Datensatz wird als Kandidat angeboten.
4. Der Server bestimmt und normalisiert Straße, Hausnummer, PLZ, Ort, Land,
   Anzeigeadresse, Provider, Genauigkeit und Fingerprint.
5. Der Browser darf nur den Kandidaten wählen und eine Pinposition innerhalb
   des festen Radius vorschlagen.
6. Suche, Auswahl, Geocoding und Drag-and-drop bestätigen den Pin niemals
   automatisch.
7. Jede Mutation authentifiziert, autorisiert und prüft Project/Site im
   verifizierten Workspace erneut. Seiten-Rendering ist kein Security-Gate.

## Kanonischer Adressvertrag

Der eine interne Zod-Vertrag unter `lib/integrations/geocoding/` definiert die
normalisierte Providergrenze. Provider-Rohantworten bleiben privat im Adapter.
Browserroute, UI, Service und Tests importieren daraus Typen oder prüfen gegen
dasselbe Schema; es gibt keine handkopierte zweite DTO-Definition.

Ein öffentliches Kandidatenobjekt enthält ausschließlich:

- opaque `placeId`;
- `provider = "geoapify"`;
- `formattedAddress`;
- `street`, `houseNumber`, `postalCode`, `city`, `countryCode = "DE"`;
- `latitude`, `longitude`;
- `precision = "house"`.

Nur Kandidaten mit allen Pflichtteilen, deutscher 5-stelliger PLZ, endlichen
Koordinaten und deutscher Länderkennung passieren. Provider-Rankings können
intern zur Sortierung verwendet werden, sind aber keine Freigabeentscheidung.

### Suchressource

`POST /api/workspaces/{workspaceId}/projects/{projectId}/address-candidates`

Body: `{ "query": "…" }`. Obwohl die Operation nicht mutiert, wird die
Suchadresse bewusst nicht in eine URL geschrieben: Pfade und Querystrings
landen häufig in Access-Logs, Browserhistorie und Tracing. Die interne
Subresource liefert nur eine ephemere Kandidatenliste und setzt keinen Zustand.

- Resource-Namen bleiben plural und ohne Verb.
- `query` wird NFKC-normalisiert, getrimmt und auf 5–160 Unicode-Codepoints
  begrenzt.
- nur `application/json`; Requestbody maximal 2 KiB und ohne Zusatzfelder;
- `Origin` muss bei Browserrequests zum effektiven Host passen;
- maximal fünf hausgenaue DE-Ergebnisse;
- keine Cache-Freigabe und `Cache-Control: private, no-store`;
- nur `project.write`; `external_only` bleibt bis zum Assignment-Slice
  fail-closed;
- Projectexistenz wird vor dem Provideraufruf tenantgebunden geprüft;
- pro Actor/Workspace sind 20 gültige Suchrequests in einem festen
  60-Sekunden-Fenster erlaubt. `Retry-After` ist die aufgerundete Zahl der
  Sekunden bis zum Fensterende. Verteiltes Rate-Limiting bleibt Pilot-Gate.

Antworten:

- `200` mit dem kanonischen Ergebnisvertrag;
- `400` ungültige IDs oder Query;
- `401` ohne Session;
- `403` ohne Schreibrecht;
- `404` bei nicht sichtbarem Project;
- `429` lokales oder Provider-Limit mit `Retry-After`;
- `502` ungültige/fehlgeschlagene Providerantwort;
- `503` Timeout oder nicht konfigurierter Provider.

Fehler tragen nur stabile Codes und generische deutsche Meldungen. API-Key,
vollständige Provider-URL, Query, Adresse, Koordinaten, Stacktrace und rohe
Providerantwort werden nie zurückgegeben oder protokolliert.

### Provideradapter

- Suche: Geoapify `/v1/geocode/autocomplete`, `lang=de`, `format=json`,
  `limit=5`, `filter=countrycode:de`.
- Speicherung: erneute Auflösung des `placeId` über
  `/v2/place-details?features=details&lang=de`.
- Timeout 3,5 Sekunden; Antwort maximal 256 KiB; harte Ergebnisgrenze.
- Defaultbasis ist `https://api.geoapify.com`.
- Ein Basis-URL-Override ist nur außerhalb Production und nur für einen
  lokalen deterministischen Vertragsserver erlaubt.
- `GEOAPIFY_API_KEY` bleibt ausschließlich serverseitig und darf nie ein
  `NEXT_PUBLIC_*`-Wert werden.

## Zustandsmaschine und Concurrency

Zulässiger M1-06-Übergang:

```text
regional_estimate + follow_up=true + pin=false + address_revision=N
  -- save exact address (expected=N) -->
selected + house + follow_up=false + pin=false + address_revision=N+1
  -- confirm pin (expected=N+1) -->
selected + house + follow_up=false + pin=true
  + pin_confirmed_address_revision=N+1
```

Regeln:

- M1-06 korrigiert nur `regional_estimate` mit offenem Follow-up und noch
  unbestätigtem Pin. Das Ändern bereits ausgewählter Adressen ist nicht Teil
  dieses Slices.
- Project und Site werden für beide Mutationen gemeinsam gesperrt.
- `expectedAddressRevision` ist Pflicht. Ein zweiter Tab erhält einen
  verständlichen Conflict und verändert nichts.
- Adressspeichern erhöht die Revision genau einmal, setzt
  `pin_confirmed=false`, leert `pin_confirmed_address_revision` und aktualisiert
  `updated_at`.
- Wiederholtes Bestätigen derselben aktuellen Revision ist idempotent und
  erzeugt kein zweites Event.
- Der Bestätigungsservice prüft die erwartete aktuelle Revision sowie alle
  Hausadress-Invarianten erneut.
- Eine Fingerprint-Kollision mit einer anderen Contact-Site endet ohne
  Mutation, Event oder Erfolgs-Audit.
- Zeigt mehr als ein Project auf dieselbe Site, endet die In-place-Korrektur
  als `shared_site` ohne Seiteneffekt.
- Der historische generische `createSite`-Referenzservice erzeugt ab M1-06 nur
  unbestätigte Legacy-Sites. Service und Action akzeptieren keinen
  `pinConfirmed`-Clientwert mehr; Bestätigung läuft ausschließlich über die
  projektgebundene revisionsgeprüfte Fachaktion.

## Additives Datenmodell

`site` erhält:

- `address_revision integer not null default 1`, positiv;
- `pin_confirmed_address_revision integer null`;
- `pin_adjusted boolean not null default false`;
- `geocode_place_id text null` als opaque Providerreferenz;
- `updated_at timestamptz not null default now()`.

Der bestehende `pin_confirmed`-Bool bleibt für die schmale, bereits verwendete
Lesesicht erhalten. Ein DB-Constraint koppelt ihn jedoch an die aktuelle
Revision:

- unbestätigt bedeutet `pin_confirmed_address_revision is null`;
- bestätigt bedeutet `pin_confirmed_address_revision = address_revision` und zugleich
  `selected + house + follow_up=false + vollständige Adresse + Koordinaten`.

Der Adressform-Constraint akzeptiert für ausgewählte Intake-Adressen weiter
`photon` und neu ehrlich `geoapify`. Der bestehende Rechnervertrag
`rechner-intake.v1` bleibt unverändert; seine `photon`-Werte werden nicht
umetikettiert.

Die Migration ist forward-only und additiv. Sie befüllt vorhandene gültige,
bestätigte ausgewählte Sites mit Revision 1. Nicht beweisbar bestätigte
Legacy-Sites werden fail-safe entbestätigt, bevor der neue Constraint aktiv
wird. Fresh- und Upgradepfad werden real getestet; alte Migrationen werden
nicht verändert.

## Receipt-/Site-Semantik

M1-06 mutiert dieselbe Site-Identität. `inbound_receipt.site_id` und
`project.site_id` bleiben daher unverändert und konsistent. Die Receipt-Kante
bezeichnet den durch den Intake erzeugten operativen Standort, keinen
unveränderlichen Adresssnapshot. Der signierte Body-Hash bleibt unverändert;
der CalculatorSnapshot und Requirements werden nie überschrieben.

Die Entscheidung und ihre Grenzen sind in ADR 0006 festgehalten. Eine spätere
immutable Adresshistorie, ein Site-Merge oder Rebinding benötigt eine eigene
Retention-, Datenschutz- und Graphentscheidung.

## Servicegrenzen

`getProjectAddressCorrectionContext(tx, ctx, projectId)`:

- verlangt `project.write`, sperrt `external_only`;
- liefert nur Project-/Site-ID, aktuelle Revision und Editierbarkeit;
- liefert keine Kontakt- oder Rechnerdaten.

Provideraufrufe besitzen eine feste Zwei-Phasen-Grenze:

1. Eine kurze autorisierte Tenant-Transaktion prüft Project, Schreibrecht,
   Editierbarkeit und erwartete Revision.
2. Erst danach läuft der Provideraufruf ohne offene DB-Transaktion.
3. Eine neue autorisierte Mutation sperrt und prüft sämtliche Invarianten
   erneut. Der Preflight ist ausdrücklich keine Schreibfreigabe.

`correctProjectSiteAddress(tx, ctx, input)`:

- erhält ausschließlich serverseitig aufgelöste, kanonische Providerdaten plus
  vorgeschlagene Pinposition und erwartete Revision;
- sperrt Project und Site und prüft Zustand, Tenant, Revision und 150-m-Radius;
- erzeugt den versionierten Fingerprint mit demselben kanonischen Baustein wie
  der Rechner-Intake;
- prüft Kollision vor Update;
- sperrt den Contact zur Serialisierung paralleler Fingerprint-Entscheidungen
  und mappt eine verbleibende constraint-spezifische `23505` nach Rollback auf
  den stabilen Fehler `collision`;
- verlangt genau ein referenzierendes Project für die zu mutierende Site;
- ändert nur operative Site-Adressfelder und Revisions-/Pinstatus;
- emittiert `site.address_corrected` und schreibt einen atomaren Erfolgs-Audit.

`confirmProjectSitePin(tx, ctx, input)` wird erweitert:

- `expectedAddressRevision` ist Pflicht;
- nur die aktuelle Hausadressrevision kann bestätigt werden;
- Event/Audit enthalten nur Site-/Project-ID und Revisionsnummer.

Erwartete Fehler sind typisierte Zustände: `not_editable`, `stale`,
`collision`, `shared_site`, `pin_out_of_range`, `not_confirmable`. Die Server Actions geben
nur kleine UI-Zustände zurück; unerwartete Fehler werden geworfen und von der
Route-Boundary generisch behandelt.

## UI und Barrierefreiheit

Die Korrektur lebt ausschließlich in der bestehenden Projektakte, nicht im
historischen `/sites`-Referenzgerüst.

- Viewer sehen Adresse, Qualität, Revision und Pinstatus nur lesend; sie sehen
  keine Suche oder Mutationscontrols.
- Editor/Admin sehen bei regionalem, editierbarem Zustand
  `Hausadresse nachtragen`.
- Das Suchfeld besitzt Label, Hilfetext, Pending-/Empty-/Fehlerzustand und eine
  tastaturbedienbare Combobox/Listbox (Arrow, Enter, Escape, Tab).
- Nach Auswahl werden alle strukturierten Felder und Koordinaten textuell
  angezeigt. Die Karte ist niemals die einzige Informationsquelle.
- MapLibre zeigt einen verschiebbaren Marker sowie gleichwertige
  Nudge-Buttons für Tastatur/Touch. Hauptziele sind mindestens 44×44 px.
- Eine sichtbare Attribution nennt Geoapify/OSM und den Kartenanbieter.
- `Adresse übernehmen` und `Planungs-Pin bestätigen` bleiben zwei getrennte
  Aktionen und Zustände.
- Pending-/Erfolgstexte nutzen `aria-live`; Fehler `role=alert`; Fokus landet
  nach Auswahl, Erfolg oder Konflikt deterministisch am relevanten Status.
- Mobile 390×844 und Tablet 820×1180 haben keinen horizontalen Overflow und
  keine Karten-Scrollfalle; Reduced Motion wird respektiert.

## Datenschutz und Betrieb

- Suchabfragen und Adressen werden nicht in Events, Auditdetails, Sentry oder
  Serverlogs geschrieben.
- Events/Audits enthalten nur IDs, technische Zustandsklasse und Revision.
- Route und Providerantworten werden nicht geteilt gecacht.
- Geoapify-Wiring für Pilot/Production bleibt bis API-Key, AVV/DPA,
  Datenschutzhinweis, erlaubtem Key-Origin/IP und einem separaten Live-Smoke ein
  externes Gate. Der lokale Slice verwendet einen deterministischen
  Vertragsserver.
- OpenFreeMap reicht für Dev/Preview. Stadia Starter wird erst ab Pilot nötig.

## Abnahmekriterien

### Vertrag, Datenbank und Services

- Kanonischer Adaptervertrag weist zusätzliche Felder, nicht-DE-, unvollständige
  und übergroße Antworten zurück.
- Timeout, 429, Providerfehler und fehlende Konfiguration sind stabile,
  secret-sichere Fehlerklassen.
- Fresh-Migration und Upgrade ab M1-05 sind grün; alte Migrationen bleiben
  byte-identisch.
- DB verhindert stale Bestätigungsrevisionen und bestätigte regionale/
  unvollständige Sites.
- Nur der schmale regionale Zustand lässt sich korrigieren.
- Viewer, `external_only`, fremder Workspace und Fremdproject scheitern ohne
  Datenänderung.
- Stale Revision, Fingerprint-Kollision und Pin außerhalb 150 m verändern
  weder Site noch Receipt, Project, Snapshot, Requirements, Phase, Outcome,
  Boardspalte, Event oder Audit.
- Shared-Site-Graphen werden als `shared_site` ohne Mutation abgelehnt.
- Die Distanz wird reproduzierbar per Haversine mit mittlerem Erdradius
  6.371.008,8 m berechnet; 150,000 m ist inklusive, darüber wird abgelehnt.
  `pin_adjusted=true` gilt bei mehr als 0,5 m Abstand vom Providerpunkt.
- Parallele Korrekturen auf denselben Contact/Fingerprint haben genau einen
  Gewinner; der Verlierer erhält `collision` statt eines rohen SQL-Fehlers.
- Erfolgreiches Speichern erhöht exakt eine Revision und lässt den Pin offen.
- Separate Bestätigung bindet den Pin atomar an genau diese Revision und ist
  bei Wiederholung idempotent.

### Browser

- Echter signierter regionaler Intake → OTP → Board → Projektakte → Suche über
  lokalen Provider-Vertragsserver → Kandidat → Pointer- und
  Tastaturkorrektur → Speichern → Reload → getrennt bestätigen → Reload.
- Nach Speichern ist nur der Adressblocker entfernt; nach Bestätigen zusätzlich
  der Pin-Blocker.
- Viewer besitzt keine Mutationscontrols; direkte Mutation wird zusätzlich
  service-/actionsseitig abgelehnt.
- Keine Treffer, ungültige Query, Timeout, 429, Providerfehler, stale Tab,
  Sessionverlust, 404 und Fremdproject zeigen verständliche, PII-freie Zustände.
- Desktop, Tablet und Mobile; keine Console-/Hydration-/Page-Errors; keine
  ernsthaften oder kritischen Axe-Verstöße in Ausgangs-, Such-, Auswahl-,
  Fehler-, Persistenz- und Viewerzustand.
- Board und Projektakte besitzen nicht-PII-haltige routenspezifische
  Dokumenttitel; unerwartete Server-Component-Fehler lassen sich über Next 16
  `retry()` wirklich neu laden.

### Repository-Gates

- `app/` importiert nur öffentliche Modul- und Integrations-APIs, nie `lib/db`.
- RED→GREEN-Vertrags-, DB-, Service-, Migration-, Action- und Browsertests.
- `npm run lint`
- `npm run typecheck`
- `npm run depcruise`
- vollständiges `npm run test`
- `npm run db:roles:verify`
- `npm run build`
- unabhängiger Review ohne offene P0–P2-Befunde.

## Verifikationsstand

- Der vollständige regionale Golden Path läuft in echtem Chromium: signierter
  Rechner-Intake, OTP, Board, Projektakte, lokale Adresssuche, Kandidat,
  Pointer- und Tastaturkorrektur, Speichern, Reload, getrennte
  Pin-Bestätigung, zweiter Reload und konsistenter Board-Stand.
- Der lokale Geoapify-Vertragsserver belegt dabei exakt eine Suche und eine
  frische Detailauflösung beim Speichern; es findet kein externer Request statt.
- Viewer-, Fremdmandanten-, Mobile-, Tablet- und Accessibility-Pfade bleiben
  Teil derselben fünf grünen Browser-E2E-Tests.
- Vertrags-, Migrations-, DB-, Service-, Action-, Route-, UI- und
  Telemetrie-Scrubbing-Tests sind grün; Lint, Typecheck, Dependency-Cruiser,
  DB-Rollenproben und der Next-Produktionsbuild sind grün.
- Zwei unabhängige Abschlussreviews melden keine offenen P0–P2-Befunde.
- Geoapify-Key/DPA/Live-Smoke, verteiltes Rate-Limiting und das
  Migrations-Lockfenster bei größerem Bestand bleiben ausdrücklich Pilot-Gates,
  nicht stillschweigend als produktionsverifiziert behauptete Fähigkeiten.

## Bewusst offen nach M1-06

1. Korrektur bereits ausgewählter Adressen, Site-Merge/Rebinding und immutable
   Adresshistorie.
2. Verteiltes Rate-Limiting und echter Geoapify-Live-Smoke vor Pilot.
3. Verifizierte Planungs-/Energieprofilrevision aus Rechnerdaten.
4. Freigegebene Workspace-Katalogrevisionen mit Preisprovenienz.
5. Requirement-Auflösung gegen echte Produkte und Snapshot-BOM.
6. Angebotsreife und drei Quick-Offer-Varianten.
