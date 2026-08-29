# M1-08 — Revisionsgebundener Produktkatalog und Projektauflösung v1

Status: **REVIEWED/VERIFIED (lokal)**

Scope: Geschützter Browserpfad
`aktuelle Planungsschätzung → eigenes Produkt anlegen → Preisprovenienz erfassen → Produkt aktivieren → Projektprodukte auswählen → unveränderliche Auflösung bestätigen → Reload/Stale-Nachweis`

Vorgänger: M1-04 bewahrt Rechnerwünsche ohne SKU oder Preis, M1-06 bindet den
Planungsstandort und M1-07 liefert eine aktuelle, serverseitig reproduzierbare
Planungsschätzung. M2 baut aus dieser Grundlage erst Angebot, Variante und BOM.

## Fähigkeit und Nutzerergebnis

Ein Workspace führt einen leeren, eigenen Komponentenkatalog. Berechtigte
Nutzer können Produkte mit stabiler interner SKU, festem Komponententyp,
versionierten technischen Daten und nachvollziehbaren Netto-EUR-Preisen
pflegen. Jede inhaltliche oder preisliche Änderung erzeugt eine neue,
unveränderliche Revision. Produkte werden archiviert statt gelöscht.

Ein Projekt-Editor kann ausschließlich aktive, angebotsvorbereitete
Produktrevisionen auswählen. Die Bestätigung erzeugt eine unveränderliche
Projektauflösungsrevision, die Produktwerte und Preise kopiert und sich exakt
an die aktuelle Requirement- und Calculation-Revision bindet. Nach Katalog-,
Requirement- oder Calculation-Änderungen bleibt die alte Auflösung erhalten
und wird als veraltet abgeleitet. Es gibt keine stille Propagation.

M1-08 macht eine Planung **produkt- und preisbezogen vorbereitet**, aber noch
nicht angebotsreif. Steuer, Rabatt, Sektionen, optionale Positionen, Varianten,
PDF, Signatur und Vertragsfestschreibung gehören zu M2.

## Einordnung gegen F16 und F2

- F16.1 wird als eigener Workspace-Katalog ohne kopierten Seed-Bestand gebaut.
- Die v1-Typen sind `module`, `inverter`, `battery`, `wallbox`, `heat_pump`,
  `mounting` und `other`.
- M1-08a umfasst manuelle Pflege, Revisionen, Preise, Aktivierung,
  Archivierung und Projektauflösung.
- CSV mit Zeilenfehlerbericht folgt als M1-08b durch denselben Service- und
  Revisionspfad. XLSX bleibt bis zu einer eigenen Lizenz-/Parserentscheidung
  außerhalb des Vertrags.
- Bilder und Datenblätter sind als unveränderliche, gehashte Assetreferenzen
  im Vertrag vorgesehen. Die echte Upload-Grenze bleibt bis zur
  Object-Storage-Provisionierung blockiert; fehlende Assets werden nicht
  erfunden.
- F2.2/F2.3 beginnen erst mit Offer, Variant und BOMLine. Die
  Projektauflösung ist kein Kundenpreisblatt und keine Vertragsposition.

## Clean-Room- und Quellenentscheidung

Der Katalog startet leer. Es werden weder Reonic-Komponentendaten noch
Reonic-Texte, Bilder, Datenblätter, Preise oder Bestände übernommen.
Zulässige Quellen sind eigene Workspace-Daten, Herstellerunterlagen mit
geklärtem Nutzungsrecht, autorisierte Lieferantenunterlagen und später
kundenbereitgestellte Importdateien.

„Vault“ ist derzeit kein definierter Hersteller, kein Modell und keine SKU.
Ohne autoritative Produktidentität, technische Quelle und EK-/VK-Quelle wird
kein solcher Datensatz angelegt. Der generische Typ `battery` deckt die
technische Produktklasse ab, ohne „Vault“ umzudeuten.

## Produktentscheidungen

### Stabile Identität, unveränderliche Revisionen

`catalog_component` trägt ausschließlich die stabile Identität und den
Lebenszyklus. `workspace_id`, `id`, normalisierte interne SKU und
`component_type` sind nach Anlage unveränderlich. Der aktuelle Inhalt ist die
höchste Revision aus `catalog_component_revision`.

Jede Änderung an Name, Marke, Modell, Einheit, Kernaussagen, technischen
Daten, Preis, Preisquelle oder Assetreferenz erzeugt Revision `N+1`. Eine
veröffentlichte Revision kann weder geändert noch durch Runtime gelöscht
werden. Gleichzeitige Änderungen verwenden `expectedRevision` und sperren die
Komponentenidentität, bevor die nächste Revision vergeben wird.

### Lebenszyklus

```text
draft ───────────────→ archived
  │                       │
  └→ active ──────────────┘
       │
       └─ Inhalts-/Preisrevision N+1 → draft
archived ── bewusste Reaktivierung → draft
```

- `draft` darf unvollständige Preise oder noch nicht freigegebene Daten tragen.
- `active` verlangt eine vollständige, valide aktuelle Revision mit EK, VK und
  Quellen-/Rechteprovenienz.
- `archived` bleibt historisch lesbar, ist aber für neue
  Projektauflösungen gesperrt.
- Reaktivierung führt bewusst zunächst zu `draft`; ein separates Aktivieren
  prüft die dann aktuelle Revision erneut.
- Ein noch nicht freigegebener Draft darf direkt archiviert werden. Änderungen
  an einem aktiven Produkt erzeugen dagegen stets Revision `N+1` und setzen es
  automatisch auf `draft`; es gibt dafür keine status-only Aktion.
- Hard-Delete ist kein Nutzerpfad.

Diese Zustände sind eine eigene WMEE-Produktentscheidung und keine Behauptung
über ungesehene Reonic-Interna.

### Geld und Steuer

- Preise sind ganzzahlige Centbeträge, niemals Fließkommazahlen.
- Währung ist in v1 ausschließlich `EUR`, Preisbasis ausschließlich `net`.
- EK und VK können im Draft gemeinsam fehlen; sobald ein Preisstand gesetzt
  wird, müssen beide Werte samt Provenienz vorhanden sein.
- Negative Preise sind unzulässig. VK muss nicht künstlich größer als EK sein;
  eine negative Marge bleibt sichtbar statt durch eine stille Regel verändert
  zu werden.
- Umsatzsteuer ist kunden-, projekt- und leistungsabhängig. Der Katalog
  speichert deshalb keinen festen 0-/19-Prozent-Steuersatz. Die Steuerklasse
  wird erst an der BOM-/Angebotsgrenze aufgelöst.

### EK-Vertraulichkeit

`purchasePriceNetCents`, Beschaffungsquelle und Marge verlassen den Server nur,
wenn `price.read_purchase` erlaubt ist. `price.edit` allein berechtigt nicht zu
einer allgemeinen Katalogausgabe mit EK. Preisänderungen verlangen sowohl
`catalog.manage` als auch `price.edit`; der Server kann den bisherigen
Preisstand beim Ändern technischer Daten intern kopieren, ohne ihn dem Client
offenzulegen.

Auch die Hashes des vollständigen, EK- und Beschaffungsprovenienz enthaltenden
Komponenten- beziehungsweise Auflösungssnapshots sind Teil dieser Grenze. Sie
werden in redigierten Readmodellen strukturell weggelassen, damit sie nicht als
Offline-Orakel für erratbare Preisstände dienen; `price.read_purchase`-Views
behalten die vollständigen Hashbindungen.

Viewer dürfen aktive und archivierte Produktstammdaten sowie VK lesen.
`external_only` erhält bis zu einem echten Assignment-/Lieferantenmodell keinen
Zugriff auf workspaceweite Stammdaten.

### Technische Daten v1

Alle technischen Daten sind strikt diskriminiert und versioniert. Häufig
gefilterte Werte werden zusätzlich als echte Spalten projiziert.

- `module.v1`: Nennleistung in Watt.
- `inverter.v1`: AC-Nennleistung, Phasenanzahl und MPP-Tracker.
- `battery.v1`: nominale und nutzbare Kapazität in Wh, Dauerleistung,
  Roundtrip-Wirkungsgrad in Basispunkten und bekannte Backup-Fähigkeit.
- `wallbox.v1`: maximale Ladeleistung, Phasenanzahl, Anschlussart und bekannte
  Bidirektional-Fähigkeit.
- `heat_pump.v1`: Nennheizleistung und SCOP in Hundertsteln.
- `mounting.v1`: eigenes Montagesystem und zulässige Dacharten.
- `other.v1`: begrenzte, strukturierte Name/Wert-Merkmale; unbekannte
  technische Schema-IDs werden abgelehnt.

`unknown` wird nicht zu `false` oder `0`. Fähigkeitsfelder wie Backup und
bidirektionales Laden sind `known_supported | known_unsupported | unknown`.

M1-07 liefert Leistungs- und Energiewerte in kWp/kWh mit bis zu sechs
Nachkommastellen, M1-08 speichert dagegen sichere ganzzahlige W/Wh. Die
einzige Konvertierungsregel ist deshalb deterministisch `Math.round(kilo *
1000)`, also das nächste volle Watt bzw. die nächste volle Wattstunde. Eine
anschließende Produktabweichung bleibt als strukturierte Bestätigung sichtbar.

### Projektauflösung statt BOM

Eine Projektauflösung enthält eine geordnete Auswahl aktiver Produkte und
positive ganzzahlige Mengen. Der Client sendet nur Produkt-IDs, erwartete
Revisionen, Mengen und exakt die angezeigten Bestätigungscodes. Name, SKU,
technische Daten, Assets, Preise und Provenienz werden serverseitig aus der
gesperrten aktuellen Revision kopiert.

Die Auflösung bindet:

- Workspace, Project und Site;
- aktuelle `project_requirement`-ID und Revision;
- aktuelle `project_calculation_revision`-ID und Revision;
- Calculation-Input-/Result-Hash sowie unveränderten Qualitätsstatus;
- jede Produkt-ID, Produktrevision, deren Content-Hash und kopierten Inhalt;
- Mengen, abgeleitete Ziel-/Auswahlkapazitäten und strukturierte Warnungen;
- bestätigenden Actor und DB-Zeitpunkt.

Für eine Neuanlage mit positiver PV-Leistung werden mindestens ein Modul und
ein Wechselrichter verlangt. Bei positiver Ziel-Speicherkapazität wird
mindestens ein Speicher verlangt. Bei angefragter Wallbox wird mindestens eine
Wallbox verlangt. Bestandsprojekte verlangen in v1 keine neue PV-Komponente,
weil M1-07 dort ausschließlich den Speicherzubau modelliert.

Abweichungen zwischen berechneter PV-Leistung und ausgewählter Modulleistung
sowie zwischen Ziel- und ausgewählter nutzbarer Speicherkapazität werden nach
der gepinnten W/Wh-Konvertierung exakt als strukturierte Codes abgeleitet. Sie dürfen nur nach einer
expliziten, exakt passenden Bestätigung gespeichert werden. Backup,
Bidirektionalität und allgemeine Produktkompatibilität bleiben in v1
operator-bestätigte, **nicht technisch verifizierte** Grenzen.

Die M1-07-Berechnung nutzt weiterhin generische, versionierte Annahmen. Eine
Katalogauflösung etikettiert sie niemals rückwirkend als SKU-spezifische
Simulation.

## Vertrauensgrenzen

1. Browserfelder, FormData, IDs, Revisionen, Mengen, SKU und Quelltexte sind
   untrusted.
2. Workspace und Actor stammen ausschließlich aus der autorisierten
   Session-/Membership-Grenze.
3. Katalog- und Projektservices prüfen ihre Rechte selbst; UI-Rendergates sind
   keine Sicherheitsgrenze.
4. Produkttexte werden als Klartextdaten gespeichert, nie als HTML oder
   ausführbare Anweisung interpretiert.
5. Assetkeys werden nur akzeptiert, wenn Workspace, Produkt, SHA-256 und
   erlaubter MIME-Typ im serverseitigen Vertrag zusammenpassen.
6. Preise und freie Quellenreferenzen erscheinen nie in Events, Audits oder
   Logs. Dort stehen nur IDs, Revisionen, Status, Feldklassen und Hashes.
7. `app_auth`, `app_worker` und `app_system` erhalten keine Katalogrechte.
8. Projektbezogene Auflösungen werden beim Löschen des Projects mitgelöscht;
   workspaceweite Produktstammdaten bleiben bestehen.

## Kanonische Verträge

Die autoritativen Laufzeitschemas liegen unter
`lib/integrations/catalog/contract.ts`. JSON-Schemas unter `contracts/` werden
daraus deterministisch erzeugt und im Contract-Test bytegenau geprüft.

### `catalog-component-revision.v1`

```text
schemaVersion + canonicalizationVersion
identity
  workspaceId + componentId + revision
  internalSku + componentType
presentation
  displayName + manufacturer + model + unit + keyPoints
  image/datasheet as nullable immutable asset refs
technicalData
  strict discriminated v1 payload
commercial
  null, or EUR/net EK+VK with separate source provenance
technicalProvenance
  sourceKind + reference + observedOn + rightsBasis
snapshotSha256
```

Der Komponentenhash verwendet den versionierten Canonicalizer über den
Vertrag ohne `snapshotSha256`. Arrays bleiben geordnet; Objektschlüssel werden
rekursiv nach Unicode-Codeunits sortiert. Zahlen sind sichere Ganzzahlen.

### `project-catalog-resolution.v1`

```text
schemaVersion + canonicalizationVersion
bindings
  workspace/project/site
  requirement id/revision
  calculation id/revision + input/result SHA
  calculation quality/validation status
lines[]
  position + quantity
  catalog component id/revision/hash
  full copied component snapshot
coverage
  requested/selected PV watts and storage Wh
  required/selected wallbox
  exact acknowledgement codes
warnings[]
totals
  EUR/net purchase + sales cents
confirmedBy + confirmedAt
resolutionSha256
```

Lesepfade validieren gespeicherte Verträge und Hashes erneut. Ungültige oder
neu gehashte, semantisch widersprüchliche Snapshots werden fail-closed nicht
als aktuelle Auflösung ausgegeben.

## Datenmodell

### `catalog_component`

- stabile UUID, `workspace_id`, normalisierte `internal_sku`, fester
  `component_type`, `status`, servereigene Zeitstempel;
- `UNIQUE (workspace_id, id)` und case-insensitive eindeutige SKU je Workspace;
- häufige Filterspalten `nominal_power_watts` und `usable_capacity_wh` aus der
  aktuellen Revision;
- Workspace-FK, FORCE RLS, genau eine permissive `tenant_isolation`-Policy;
- kein DELETE-Recht für Runtime.

### `catalog_component_revision`

- UUID, Workspace/Component, positive fortlaufende Revision;
- Vertrag, Content-SHA, Actor und Erstellzeit;
- `UNIQUE (workspace_id, component_id, revision)`;
- zusammengesetzte Workspace-/Component-/Membership-FKs;
- INSERT/SELECT für Runtime, kein UPDATE/DELETE; Trigger blockiert zusätzlich
  UPDATE/DELETE/TRUNCATE.

### `project_catalog_resolution`

- UUID, Workspace/Project/Site, positive fortlaufende Revision;
- Requirement- und Calculation-Bindungen, Vertrag und SHA;
- `UNIQUE (workspace_id, project_id, revision)`;
- zusammengesetzte FKs auf Project, Requirement, Calculation und Membership;
- `ON DELETE CASCADE` von Project, Requirement und Calculation: Der bestehende
  DSGVO-Pfad pseudonymisiert das Project, löscht aber dessen Requirement- und
  Calculation-Revisionen. Jede dieser drei autorisierten Kanten entfernt die
  projektbezogene Auflösung; Runtime besitzt selbst kein DELETE-/UPDATE-Recht;
- FORCE RLS und immutable UPDATE-/TRUNCATE-Guard.

### `project_catalog_resolution_line`

- schmale relationale Referenz je kopierter Snapshotzeile mit Position, Menge,
  Component-ID, exakter Katalogrevision und Snapshot-Hash;
- der vollständige kopierte Vertragsinhalt bleibt ausschließlich im
  unveränderlichen Resolution-Snapshot; die Line ist Index/FK, keine zweite
  Produkt- oder Preiswahrheit;
- zusammengesetzter FK einschließlich Workspace, Revision und Hash auf die
  Katalogrevision sowie Cascade von der Resolution;
- ermöglicht einen indexierten Produktrevision→aktuelle Projekte-Rückweg für
  sichtbares Stale, ohne JSON-Vollscan;
- FORCE RLS, immutable UPDATE-/TRUNCATE-Guard und kein Runtime-DELETE.

Die erfolgreiche Insert-Transaktion setzt
`project.catalog_resolution_status = resolved`. Neue Calculation-Revisionen,
neue referenzierte Produktrevisionen oder Archivierung setzen betroffene
Projects atomar auf `pending`; der historische Snapshot bleibt unverändert.

## Öffentliche Modulgrenzen

`modules/catalog` exportiert ausschließlich:

- `listCatalogComponents`, `getCatalogComponent`;
- `createCatalogComponent`, `reviseCatalogComponentDetails`,
  `reviseCatalogComponentPricing`;
- `activateCatalogComponent`, `archiveCatalogComponent`,
  `returnCatalogComponentToDraft`;
- `getProjectCatalogResolutionContext`, `resolveProjectCatalog`.

Services nehmen `TenantTx + ServiceCtx`, validieren vor SQL, sperren in der
festen Reihenfolge `catalog_component`-IDs aufsteigend vor `project` und
emittieren Mutation, Event und Erfolgs-Audit atomar.

## Rechte

| Operation | Action/Regel |
|---|---|
| Katalog lesen | neue `catalog.read`, Viewer+ |
| EK/Marge im Read-DTO | `price.read_purchase` |
| Produktidentität/Details/Status ändern | `catalog.manage` |
| Preisrevision schreiben | `catalog.manage` **und** `price.edit` |
| Projektauflösung lesen | `project.read` |
| Projektauflösung bestätigen | `project.write` |
| jeder Katalog-/Projektpfad | `external_only` fail-closed |

## Browseroberflächen

- `/w/{workspaceId}/katalog`: leere, geladene, gefilterte und read-only Liste;
  Anlage eines Drafts nur mit Katalogrecht.
- `/w/{workspaceId}/katalog/{componentId}`: Revision, Provenienz, Status,
  technische Daten, Preisfläche nur für Berechtigte, Aktivieren/Archivieren.
- `/w/{workspaceId}/anfragen/{projectId}/produkte`: aktuelle
  Planung/Requirements, aktive Produkte, Mengen, Coverage, explizite
  Bestätigungen sowie current/stale/blocked/read-only Zustände.
- Projektakte und Board zeigen `Produkte offen`, solange keine aktuelle
  Auflösung besteht.

Alle Aktionen haben echte Endzustände, Reload-Nachweis, Tastaturbedienung,
320-px-Breite, 200-%-Textzoom und Reduced-Motion-Unterstützung.

## Concurrency und Idempotenz

- SKU wird vor Insert normalisiert und DB-eindeutig erzwungen.
- Revisionserzeugung sperrt die Komponentenidentität und prüft
  `expectedRevision`.
- Projektauflösung sperrt alle gewählten Produkte in sortierter Reihenfolge,
  danach Project, Requirement und aktuelle Calculation-Bindung.
- Wartende Komponentenlocks und Revision-Snapshotreads sind getrennte
  READ-COMMITTED-Statements; nach dem Lock wird immer frisch gelesen.
- Requirement-/Calculation-Insert, Profilbestätigung und erfolgreiche
  Calculation-Finalisierung verwenden dieselbe Project-vor-Job-Reihenfolge.
  Der Worker erhält dafür nur den eng begrenzten, tenantgeprüften
  `lock_project_calculation_finalization`-Definer und kein Project-UPDATE.
- Zwei identische Tabs mit derselben erwarteten Projektauflösungsrevision
  erzeugen höchstens eine neue Revision; der zweite erhält `stale`.
- Ein Fehler rollt Produkt-/Projektzeile, Revision, Event und Audit gemeinsam
  zurück.

## Verifikation und Abnahme

- Runtime-/JSON-Schema-Drift, geschlossene Objekte, alle Typzweige, Hashing und
  Cross-Runtime-Fixtures.
- Fresh- und Upgrade-Migration; RLS/FORCE, zusammengesetzte FKs, WORM-/ACL-
  Vertrag und Tenant-Fixtures.
- Rollenmatrix einschließlich serverseitiger EK-Redaktion und
  `external_only`.
- SKU-/Revision-/Resolve-Races, stale Requirement/Calculation/Catalog,
  archivierte Quellen und atomarer Rollback.
- Direkte SQL-Manipulation an Revisionen und Auflösungen.
- Projekt-Erasure mit kaskadierter Entfernung der Auflösung, ohne Löschung des
  Workspace-Katalogs.
- Browser-Golden-Path mit Anlage, Preis, Aktivierung, Projektauflösung,
  Reload, Produktrevision→stale, Viewer/Fremdtenant, Mobile und Axe.
- `npm run lint`, `npm run typecheck`, `npm run depcruise`, vollständiges
  `npm run test`, `npm run db:roles:verify`, `npm run build` und unabhängiges
  Review ohne offene P0–P2-Befunde.

Lokale Abnahme am 29. August 2026: 69 Testdateien mit 661/661 Tests,
75 strikte Rollenprüfungen plus 5 PostgreSQL-18-Regressionsprüfungen,
Production-Build und 7/7 isolierte Chromium-E2E sind grün. Der Browserlauf
führt Anlage, Preisrevision, Aktivierung, Projektbestätigung,
Produktrevision→Stale, unveränderten historischen Snapshot sowie die
Viewer-EK-/Full-Hash-Redaktion über echte Server Actions aus. Das generierte
Katalogschema ist bytegenau auf
`00fe8d765d635f6a53962a841a3bcba51e9588ed8d111aca5e1179b00493fd9c`
gepinnt. Unabhängige DB-, Privilegien-, UI- und Redaktionsreviews haben alle
gefundenen P0–P2-Befunde geschlossen.

## Nichtziele

- kein Reonic-Seed-Katalog und keine reale „Vault“-SKU ohne Quelle;
- kein automatisches Matching oder behauptete Herstellerkompatibilität;
- keine SKU-spezifische Neuberechnung des M1-07-Ergebnisses;
- keine Offer-/Variant-/BOM-/Rabatt-/Steuer-/PDF-/Signaturfunktion;
- kein DATANORM, IDS-Connect, Live-Großhandelspreis oder Bestellung;
- kein XLSX-Parser;
- kein öffentlicher Preview-, Produktions- oder Provider-Deploy.

## Bewusst offene externe Gates

1. Autoritative Identität, technische Daten und Preisquelle des vom
   Auftraggeber genannten „Vault“-Produkts.
2. Rechtmäßig nutzbare Produkt-/Preisliste des Pilotsortiments.
3. Provisionierter Object Storage samt echter Upload-/Read-/Retention-Probe.
4. Herstellerübergreifende Kompatibilitätsregeln für Wechselrichter,
   Speicher, Backup und bidirektionales Laden.
5. Entscheidung und Lizenzprüfung für XLSX, falls CSV im Pilot nicht reicht.
