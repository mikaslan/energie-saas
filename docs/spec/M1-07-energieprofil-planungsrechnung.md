# M1-07 — Revisionsgebundenes Energieprofil und Planungsrechnung v1

Status: **SPECIFIED · REVIEWED/VERIFIED (lokale Umsetzung)**

Scope: Geschützter Browserpfad
`bestätigter Planungsstandort → Rechner-Eingaben prüfen → Profil speichern → getrennt bestätigen → automatische serverseitige Planungsrechnung → Reload`

Vorgänger: M1-04 bewahrt den Rechner-Payload als unverifizierte Intake-Evidenz,
M1-05 macht den Lead bearbeitbar und M1-06 bindet eine hausgenaue Adresse samt
bestätigtem Pin an eine Adressrevision.

## Fähigkeit und Nutzerergebnis

Ein Editor oder Admin kann die Eingaben eines Rechner-Leads in der bestehenden
Projektakte prüfen und als versioniertes Energieprofil des Standorts speichern.
Speichern und fachliches Bestätigen bleiben zwei bewusste Aktionen. Die
Bestätigung attestiert nur, dass ein Bearbeiter die sichtbaren Eingaben geprüft
hat; sie ist keine Mess-, Dach- oder Physikzertifizierung.

Nach der Bestätigung startet für das aktuelle Projekt genau ein idempotenter,
serverseitiger Rechenlauf. Er bindet sich an die exakten Adress-, Pin-, Profil-
und Projektanforderungsrevisionen sowie an Vertrag, Engine, Annahmen und die
verwendeten Wetterdaten. Das Ergebnis ist dadurch reproduzierbar und nach einem
Reload noch nachvollziehbar. Ändert sich eine Abhängigkeit, bleibt der alte Lauf
unverändert und wird sichtbar als veraltet abgeleitet.

Der Nutzer erhält eine **hausbezogene, serverseitig reproduzierbare
Planungsschätzung**. M1-07 behauptet weder vollständige F4-Parität noch eine
zertifizierte, normkonforme oder angebotsreife Berechnung. Produkte, Vault,
Speicher-SKUs, Katalogpreise, BOM und Angebot folgen erst auf dieser Grundlage.

## Einordnung gegen F1 und F4

- F1.3 ist die harte Voraussetzung: nur `selected + house`, ohne offenen
  Adress-Follow-up und mit einem für die aktuelle Adressrevision bestätigten Pin.
- M1-07 liefert einen echten Teilslice von F1.4: Verbrauch, Strompreis,
  Eskalation, Gebäudeangaben, Dachflächen, Zusatzlasten und bekannte
  Bestandsanlagen aus dem Rechnerpfad.
- Zielprodukte bleiben getrennt am Project. Die vorhandene
  `project-requirements.rechner.v1`-Revision ist die aktuelle schmale Quelle;
  Solar/Heizung sowie Purchase/Lease/Financing werden nicht erfunden.
- M1-07 liefert einen ersten reproduzierbaren Stundenlauf, aber **nicht** F4.1:
  der bestehende Rechnerkern rechnet 8.760 Stunden, während F4 ein
  15-Minuten-Raster, Muneer/PVGIS-Referenzvalidierung und weitere
  Wirtschaftlichkeitsfunktionen verlangt.
- Ein vollständiger F4-Lauf bleibt hinter dem geplanten
  `SimulationEngine`-/pvlib-Sidecar und einem fachlichen Referenzgate.

## Produktentscheidungen

### Drei getrennte Wahrheiten

1. `calculator_snapshot` bleibt unverändert
   `client_reported_unverified`. HMAC und Body-Hash belegen nur Herkunft und
   Transportintegrität.
2. `site_energy_profile` enthält ausschließlich die aktuelle normalisierte
   operative Eingabe samt Revisionszähler. Separat gebundene
   Bestätigungsfelder attestieren die menschliche Prüfung der exakten Profil-
   und Adressrevision.
3. `project_calculation_revision` ist ein neuer Serverlauf aus exakt gebundenen
   Eingabe- und Provider-Snapshots. Er übernimmt niemals das Client-Ergebnis.

Keiner dieser Zustände wird durch Umbenennen oder Kopieren in den nächsten
Vertrauensgrad erhoben.

### Site-Fakten gegen Projektabsicht

An die Site gehören:

- Gebäudetyp, Baujahr und beheizte Fläche;
- Dachflächen mit Geometrie- und Herkunftsangaben;
- Haushaltsverbrauch, Lastprofilkennung und Zusatzlasten;
- Strompreis und Eskalation als bekannte Standort-/Verbrauchseingaben mit
  Herkunft;
- bekannte Bestands-PV, Bestandsspeicher, Wallbox und EV.

An das Project gehören:

- gewünschte Zielprodukte und Kapazitäten;
- Systemverlust, Speicherwirkungsgrad/-entladetiefe, Degradation,
  Betrachtungshorizont und Inbetriebnahmedatum als projektbezogene,
  versioniert aufgelöste Rechenannahmen;
- Kauf, Leasing oder Finanzierung;
- später Katalogauflösung, Variante, BOM und Angebot.

Ein Kundenwunsch ist keine Auslegungsempfehlung. Insbesondere wird
`targetStorageKwh` nie still durch einen errechneten Wert ersetzt.

### Unbekannt bleibt unbekannt

Der Rechner fragt nicht alle F1.4-Felder ab. Eine nicht erfasste Bestands-
Wallbox, EV-Eigenschaft, Heizungsziel, Zahlart oder Lastprofilquelle wird als
`unknown` dargestellt. Sie wird nicht zu `false`, `0`, `none` oder einem
Default umgedeutet. `known` bezeichnet niemals einen Engine-Default. Ein
Default darf erst im projektbezogenen Berechnungsrequest als
`versioned_default` erscheinen und trägt dort Wert, stabilen Defaultschlüssel
und `defaultsVersion`; andernfalls bleibt das Profilfeld `unknown`.

Ein Profil darf weiterhin unbekannte Werte speichern, aber nicht jeder solche
Wert ist als Engineinput auflösbar. Für einen Rechenlauf müssen die
Verschattung jedes berechneten Dachs und im Bestandszweig die Existenz des
Bestandsspeichers ausdrücklich bekannt sein. `known_absent` bedeutet dort
reproduzierbar 0 kWh; `unknown` blockiert den Request. Weder 10 % pauschaler
Verschattungsabschlag noch 0 kWh Bestandsspeicher werden still erfunden.

### Genauigkeitslabel

Die UI verwendet exakt diese abgestuften Aussagen:

- **Importiert – ungeprüft** für den Rechner-Snapshot;
- **Eingaben durch Bearbeiter bestätigt** für eine aktuelle Profilrevision;
- **Serverseitig neu berechnete Schätzung** für einen erfolgreichen M1-07-Lauf;
- **Referenzvalidiert** erst nach fachlich freigegebenen Golden Cases;
- **Angebotsreif** erst nach Katalog-/Preisprovenienz, Haftungsgate und
  kommerziellem Snapshot.

Softwarestatus `VERIFIED` bedeutet nur, dass der implementierte Vertrag und
seine Sicherheits-/Funktionsgates nachgewiesen sind. Er bedeutet nicht, dass
die physikalische Genauigkeit fachlich zertifiziert wurde.

## Vertrauensgrenzen

1. Rechner-Payload, Browserfelder, FormData, IDs und erwartete Revisionen sind
   untrusted.
2. Die Anwendung liest nur Eingaben aus dem Rechner-Snapshot. Importierte
   Ergebnis-, Unsicherheits- und Marktpreisfelder gehen nicht in den
   Serverlauf ein.
3. Die Projektaktion authentifiziert, autorisiert und prüft Workspace,
   Project, Site, aktuelle Adresse, Pin, Snapshot und Requirement erneut.
4. `external_only` bleibt bis zur echten Projektzuweisung fail-closed.
5. PVGIS ist ein externer, nicht autoritativer Datenanbieter. Seine
   normalisierte Antwort wird vor der Berechnung validiert und als
   unveränderlicher Provider-Snapshot mit Parametern, Version und Hash gebunden.
6. Netzwerkzugriffe laufen nie in einer offenen Datenbanktransaktion.
7. Engine- und Provider-Rohdaten werden nie an den Browser oder in Logs,
   Events und Audits geschrieben.
8. Wirtschaftlichkeitswerte des heutigen Rechnerkerns mit
   `market_estimate` werden in M1-07 weder persistiert noch angezeigt.

## Kanonischer Berechnungsvertrag

Die einzige interne und cross-runtime-fähige Grenze heißt
`planning-calculation.v1`.

- Das autoritative Laufzeitschema liegt unter
  `lib/integrations/calculation/`; TypeScript-Typen werden ausschließlich
  daraus inferiert.
- Das daraus deterministisch erzeugte JSON-Schema liegt unter `contracts/`.
- Contract-Test, Serveradapter, Fixtures und der spätere Worker prüfen gegen
  dasselbe Artefakt; handkopierte DTOs sind unzulässig.
- Stabil zuordenbare `roofId` ersetzen positionsbasierte Dach-/Wetterpaare.
- Datumswerte sind ISO-Daten beziehungsweise UTC-Zeitpunkte; es gibt keinen
  impliziten `new Date()`-Default im Enginevertrag.
- JSON enthält weder `Date`, `Uint8Array`, `NaN` noch `Infinity`.

Der Vertrag umfasst:

```text
PlanningCalculationRequestV1
  contractVersion + canonicalizationVersion
  asOfDate + commissioningDate
  bindings
    workspace/project/site IDs
    addressRevision + pinConfirmedAddressRevision
    profile ID + revision + confirmed revision/address revision
    requirement ID + revision
  site/location
  energyProfile
  projectRequirements
  effectiveConsumption
    profile_value or versioned_default per engine-consumed field
  effectiveStorageRequest
    branch-specific planned_total_capacity or additional_capacity
  resolvedAssumptions
    rechner_input with sourceField or versioned_default with key/version
  yieldSnapshots[roofId]
    PVGIS-Parameter/Version/DB/Wetterjahr
    annual + 12 monthly + 8.760 hourly values
    temperature series
    rawResponseSha256 + fetchedAt

PlanningCalculationResultV1
  contractVersion + canonicalizationVersion + roundingVersion
  modelId + modelVersion + sourceRevision
  inputSha256 + resultSha256
  quality = server_reproduced_estimate
  temporalResolution = hourly_8760
  branch = new_installation
    system size + planned storage + annual/monthly energy result
  branch = existing_installation
    existing/added capacity + baseline + planned + delta
  warnings with stable codes
```

Der Input-Hash wird als SHA-256 über UTF-8 und den versionierten
`planning-jcs.v1`-Canonicalizer gebildet. Dieser implementiert RFC 8785/JCS,
sortiert zusätzlich die semantisch mengenartigen Dach-/Yield-Arrays nach
`roofId` und schließt ausschließlich Provider-`fetchedAt` aus; IDs,
Revisionen, Provider-Rohhashes, Serien, Rezepte und Defaultreferenzen bleiben
gebunden. Der fachliche Result-Hash nutzt denselben Canonicalizer über das
Resultat ohne sein eigenes `resultSha256`; Resultate enthalten keine Run-ID
oder Zeitstempel. Feste Cross-Runtime-Fixtures pinnen beide Digests.

`projectRequirements` entspricht byteformtreu der persistierten
`project-requirements.rechner.v1`-Payload (`schemaVersion`, `source`, `branch`,
`requestedProducts`); ihre Revision steht ausschließlich in `bindings`.
Neubau verlangt bekannte Abwesenheit einer Bestands-PV, Bestand eine bekannte
positive PV. `targetStorageKwh` bedeutet im Neubau die geplante Gesamtkapazität,
im Bestandszweig die Zusatzkapazität und wird durch
`effectiveStorageRequest.meaning` ausdrücklich gebunden.

Resultate erfüllen innerhalb der gepinnten Rundungstoleranz
Energieerhaltung, konsistente Eigenverbrauchs-/Autarkieraten, geordnete Monate
1–12, Monats-/Jahressummen und im Bestandszweig ein rechnerisch passendes
Baseline→Planned-Delta. Der Speicher wird über ein zyklisch stationäres
Planungsjahr gerechnet: Der deterministisch kleinste zulässige Fixpunkt setzt
den Ladezustand zu Jahresbeginn und derselbe Ladezustand muss nach Stunde 8.760
wieder erreicht sein. `storageLossKwh` enthält deshalb ausschließlich reale
Umwandlungsverluste des gepinnten Speicherwirkungsgrads und niemals einen am
Jahresende verbleibenden Ladezustand. `storageFullCycles` ist an entladene
Speicherenergie und nutzbare Kapazität (`Kapazität × Entladetiefe`) gebunden.
Direktverbrauch wird aus den nicht negativen Stundenflüssen aggregiert und
nicht als Differenz zweier bereits gerundeter Jahressummen rekonstruiert; damit
bleibt auch der gültige 0,01-kWh/Jahr-Rand frei von negativem Rundungsnull.

Monatsgrenzen entladen den Speicher nicht künstlich. Deshalb darf der
Eigenverbrauch eines Monats Energie aus dem Vormonat enthalten und zusammen
mit der Einspeisung dessen lokale Erzeugung übersteigen. Streng bleiben die
Reihenfolge 1–12, alle Monats-/Jahressummen und
`feedInKwh <= generationKwh` je Monat; die vollständige Energieerhaltung wird
auf dem zyklisch geschlossenen Jahresintervall geprüft. Vergütete/unvergütete
Einspeisung, Investition, Cashflow und Amortisation sind bewusst kein Teil des
M1-07-Energievertrags.

Wallbox-Nutzung wirkt bereits über die bestätigten EV-km/Jahr und das
Ladezeitprofil auf den Verbrauch; der reine Produktwunsch erzeugt daher keine
zweite Last und keine Warnung. Bidirektionales Laden und Backup-Reserve sind in
diesem Slice dagegen noch keine physikalischen Modellfunktionen. Werden sie
angefragt, bleiben `fromVehicleKwh = 0` und die Energiewerte unverändert; die
stabilen Warncodes `bidirectional_charging_not_modeled` beziehungsweise
`backup_power_not_modeled` machen diese Grenze im Resultat ausdrücklich
sichtbar.

Vor der Finalisierung wird nicht nur das Resultat isoliert validiert. Die
paarweise Contractprüfung bindet Modell-ID/-Version/-Source, `inputSha256` und
Branch sowie abgeleitete oder bekannte PV-Leistung, geplante, zusätzliche und
bekannte Bestands-Speicherkapazitäten an den exakten Request. Speicherverlust
und volle Zyklen müssen zu Wirkungsgrad, Entladetiefe, Kapazität und
`fromStorageKwh` passen; ohne Speicher bleibt der stationäre Fluss null. Die
Warnmenge ist ebenfalls exakt gebunden: F4-Status, Provider-Schätzung,
versionierte Profildefaults, Bestandsgrenze sowie angefragte, noch nicht
modellierte Features dürfen weder fehlen noch grundlos erscheinen. Ein formal
valides Ergebnis mit umetikettierten Kapazitäten oder Energiequellen darf
deshalb nicht persistiert werden.

## Energieprofilvertrag v1

`site-energy-profile.v1` unterstützt in diesem Slice ausschließlich den realen
Rechnerpfad `inputMode = consumption`. Weitere Modi werden erst mit einem
neuen, vollständig implementierten Vertrag ergänzt.

Pflichtgruppen:

- `building`: Typ, Baujahr und beheizte Fläche jeweils als Wert oder `unknown`;
- `roofs`: 1–4 stabile Dach-IDs, Fläche, Azimut, Neigung, Typ, Verschattung und
  Herkunft;
- `consumption`: Haushaltsstrom, Herkunft, Strompreis, Eskalation,
  Lastprofilkennung, EV-km/Ladezeit, WP-, Kühl-, Heiz-AC- und Warmwasserstrom;
- `existingAssets`: PV, Speicher, Wallbox, EV mit expliziter
  `known | absent | unknown`-Semantik;
- `source`: Rechner-Snapshot-Schema/-Engine/-Revision sowie Feldprovenienz.

Projekt- und produktabhängige Annahmen gehören ausdrücklich **nicht** in die
geteilte Site-Wahrheit. Der Berechnungsrequest löst jeden vom Enginekern
benötigten Wert entweder aus einer bekannten, bestätigten Eingabe oder als
`versioned_default` mit Schlüssel und Version auf. Ein unbekannter, nicht
aufgelöster Engineinput blockiert den Lauf.

Numerische Null ist nur dort zulässig, wo sie fachlich wirklich „kein
Verbrauch/keine Kapazität“ bedeutet. Unbekannte optionale Werte sind `null` plus
expliziter Status, nicht eine magische Zahl.

## PVGIS-Providervertrag

M1-07 pinnt die dokumentierte JRC-Grenze, nicht einen unversionierten URL:

- Basis: `https://re.jrc.ec.europa.eu/api/v5_3`;
- Tools: `PVcalc` für den langjährigen Jahres-/Monatsertrag und `seriescalc`
  für den Stundengang;
- Methode: ausschließlich serverseitiges `GET`; kein Browser-AJAX;
- Beide Tools allowlisten `lat`, `lon`, `raddatabase=PVGIS-SARAH3`,
  `peakpower=1`, `loss=14`, `angle`, `aspect`, `pvtechchoice=crystSi`,
  `mountingplace=free`, `usehorizon=1` und `outputformat=json`.
  `seriescalc` pinnt zusätzlich `pvcalculation=1`, `trackingtype=0` sowie
  `startyear=endyear=2020`; weitere Queryparameter werden verworfen;
- Formjahr: exakt 2020 mit 8.784 UTC-Quellwerten und 8.784 erhaltenen
  Quellzeitstempeln. Normalisierung
  `pvgis_utc_to_europe_berlin_then_drop_feb_29.v1` ordnet zuerst auf die feste
  Zone `Europe/Berlin` um, behandelt die DST-Lücke/-Dopplung nach dem gepinnten
  Rechneralgorithmus und entfernt danach die lokalen Stunden des 29. Februar;
- `P` wird als W/kWp, Monats-/Jahresertrag als kWh/kWp und Temperatur als °C
  gespeichert. Die 8.760-Stundenform wird anschließend deterministisch auf das
  langjährige `PVcalc`-Jahresmittel skaliert;
- `loss=14` ist bereits im Providerertrag enthalten. Eine abweichende,
  versioniert aufgelöste Projektannahme wird genau einmal relativ zu diesen
  14 Prozent angewendet;
- Timeout, Antwortgröße, Ergebnislänge, Wertebereiche und maximale
  Parallelität werden hart begrenzt;
- Lat/Lon werden nach `pvgis-coordinate-rounding-3dp.v1` auf drei
  Dezimalstellen gerundet; der genaue bestätigte Site-Pin bleibt allein in der
  tenantgeschützten Bindung. Requestkoordinaten und Dachwinkel müssen semantisch
  zum Site-/Dachdatensatz passen;
- Antwortfelder werden anhand ihrer Datenbank-Zeitsemantik normalisiert. Die
  Original-UTC-Zeitstempel und die verwendete Strahlungsdatenbank bleiben im
  Snapshot erhalten. Temperaturreihen desselben Site-/Wetterjahrs müssen über
  alle Dachantworten identisch sein;
- Tests verwenden einen lokalen deterministischen Vertragsserver. Ein echter
  Live-Smoke und betriebliche Limits bleiben Pilot-Gates.

Offizielle Primärquellen:

- JRC, PVGIS 5.3 API/non-interactive service:
  <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en>
- JRC, Hourly radiation:
  <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/pvgis-5-tools/hourly-radiation_en>
- JRC, User Manual und Zeitsemantik:
  <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/pvgis-5-user-manual_en>
- JRC, Usage Conditions/Data Protection:
  <https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/general-information/usage-conditions-data-protection_en>

Die JRC-Seite beschreibt die PVGIS-Informationen als frei nutzbar ohne
Nutzungsbeschränkung. Anbieter, API-/Datenbankversion und Attribution bleiben
trotzdem sichtbar. Diese Feststellung ersetzt keine DPA-/Privacy-/Live-Prüfung
für den Pilotbetrieb.

## Rechner-V3-Grenze und Rechte

Read-only geprüfte Providerbasis:

- Repository `wmee-remake-magic`, Branch `rechner/v3`;
- HEAD `2b00f6b06fe253566a3dc755ecb5dc3a93789d69`;
- Pure-Kernel-Tree `src/lib/solar/**`:
  `6fde2334f1d30242441b9fe34ee63030cd9f8d2f`;
- die zwei Commits seit M1-04 verändern nur Wizard-/Fragen-/State-Code;
  Rechenkern und PVGIS-Proxy sind unverändert.

Der Kern besitzt reale 8.760-Stunden-, Speicher-, EV-, WP-, Neubau- und
Bestandsfunktionen. Er besitzt aber keinen versionierten Runtimevertrag und
keine von UI/Preismodell getrennte Deploymentgrenze. `energie-saas` importiert
deshalb niemals Wizard, Hooks, URL-State oder das gemischte Barrel direkt.

Im Rechner-Repository fehlt aktuell eine `LICENSE`/`COPYING`, das Paket ist
`private`. Mikails Anweisung ist die interne Arbeits- und Integrationsrichtung,
aber kein Ersatz für eine dauerhafte Owner-/Chain-of-title-Freigabe. Vor
Quellcode-Vendoring, Paketveröffentlichung, produktivem Artefaktbau oder
Weitergabe an Dritte wird diese Freigabe als Repository-Artefakt dokumentiert;
das Vorhandensein oder Fehlen einer Lizenzdatei allein beantwortet die
Rechtekette nicht.

Bis dahin gilt:

- eigener `CalculationPort` im SaaS;
- `sourceRevision` pinnt den wirklich ausgeführten Clean-Room-Engine-Blob
  `2095ec8462aa32f7b7c9e075997b420620bde5de`, nicht den Rechner-v3-HEAD;
- ein Contracttest vergleicht diesen Pin per echtem `git hash-object` mit
  `lib/integrations/calculation/engine.ts` und verhindert stillen Drift;
- keine Build-Abhängigkeit auf einen veränderlichen Geschwisterpfad;
- keine direkte Codekopie in M1-07 ohne dokumentierte Rechtequelle;
- ein lokaler Fixture-Adapter kann den Vertrag, Persistenz- und Browserpfad
  entwickeln, zählt aber nicht als fachlich VERIFIED;
- produktiv zählt nur ein unveränderliches privates Paket oder Container-
  Artefakt mit Commit-/Tree-/Image-Digest und denselben Golden Vectors.

## Zustandsmaschinen

### Profil

```text
imported_review_required
  -- save expectedRevision=N --> draft revision N+1
draft revision N+1
  -- confirm expected=N+1 --> confirmed revision N+1
confirmed revision N+1
  -- save changed values expected=N+1 --> draft revision N+2
old calculations --> stale (abgeleitet)
```

- Speichern ersetzt die operative Profilwahrheit in place, erhöht die Revision
  genau einmal und setzt deren Bestätigung zurück. Alte Drafts werden aus
  Datenminimierungsgründen nicht separat aufgehoben.
- Bestätigung aktualisiert nur die gebundenen Confirmation-Felder und ist
  idempotent; der Profilinhalt bleibt dabei unverändert.
- Eine Confirmation bindet die aktuelle Profilrevision, die beim Speichern
  geltende `site.address_revision` und die identische
  `pin_confirmed_address_revision`.
- Bestätigung einer veralteten Profil- oder Adressrevision endet ohne
  Mutation, Event oder Erfolgs-Audit.
- Historische bestätigte Eingaben bleiben nur dort erhalten, wo sie für einen
  tatsächlich ausgeführten Rechenlauf im projektbezogenen Input-Snapshot
  benötigt werden.

### Rechenlauf

```text
blocked_prerequisites
  → queued → leased/running → succeeded_current
                          ↘ retry_wait → queued
                          ↘ failed_final
succeeded_current → succeeded_stale (abgeleitet bei Revisionswechsel)
```

- Fachlich ist die Bestätigung der Trigger. Ein sichtbarer
  Geschäftsbutton „Berechnen“ ist nicht der Normalpfad.
- Die erste wirksame Confirmation erzeugt **in derselben Transaktion** eine
  dauerhafte Queue-Reservation. Ein identischer Confirmation-Replay liefert
  denselben Erfolg, erzeugt weder zweites Event/Audit noch zweiten Job und
  repariert eine historisch fehlende Reservation.
- Der vor Provider-I/O berechenbare `reservation_key` bindet Project, alle
  Revisions-/Confirmationwerte, Providerrezept, Engine und Defaults. Erst nach
  dem Providerabruf wird der semantische `input_sha256` einmalig gesetzt.
- Ein Retry verwendet den einmal gespeicherten Provider-/Input-Snapshot erneut;
  er ruft nicht still neu ab. Leases, `attempt_count`, Backoff und
  `next_attempt_at` begrenzen Wiederholungen; abgelaufene Leases sind
  übernehmbar.
- Der v1-Betriebsvertrag pinnt eine Lease auf 15 Minuten und höchstens zehn
  fachliche Attempts. Retry-Backoff beginnt bei 30 Sekunden, verdoppelt sich
  pro Attempt und ist einschließlich eines externen `Retry-After` auf eine
  Stunde begrenzt. Nur derselbe noch gültige Lease-Token darf einen Claim
  idempotent wiederholen; fremde oder abgelaufene Ownership schreibt nicht.
- Jeder Attempt besitzt einen eigenen pg-boss-Singleton-Key
  `<domainJobId>:<attempt>`. Ein Claim plant in derselben Transaktion den
  nächsten Recovery-Lauf am Lease-Ende. `retry_wait` verschiebt genau diesen
  noch nicht aktiven Lauf auf `next_attempt_at`; nach Erfolg wird ein späterer
  Recovery-Lauf beim terminalen Claim zum No-op.
- Pro Project ist höchstens ein aktiver Job zulässig. Actor- und
  Workspace-Quota, Cooldown sowie `Retry-After` begrenzen teure Abläufe;
  Providerstatus 429 und 529 sind retryable.
- Die Reservations-Policy
  `project-calculation-reservation-rate-limit.v1` gilt pro Workspace: Nach
  einer echten neuen Reservation wartet derselbe Actor 10 Sekunden; danach
  sind höchstens 30 neue Reservations dieses Actors und insgesamt höchstens
  300 neue Reservations des Workspace pro rollender Stunde zulässig. Es gibt
  keinen Zustandsfilter: `queued`, `running`, `retry_wait`, `succeeded` und
  `failed_final` zählen, weil bereits die Reservation externen Aufwand
  ausgelöst haben kann.
- Ein vorhandener exakter Reservation-Key wird vor dieser Policy erkannt und
  umgeht sie vollständig. Der Replay legt weder Job, Event noch Audit erneut
  an und erreicht bei einem weiterhin `queued` Job trotzdem den idempotenten
  Dispatch-Reparaturpfad.
- Nur für eine echte neue Reservation werden transaktionsgebundene PostgreSQL-
  Advisory-Locks zuerst workspaceweit und danach actorbezogen genommen. Das
  rollende Fenster wird nach beiden Locks ausschließlich mit
  `clock_timestamp()` der Datenbank aufgenommen. Eine Ablehnung liefert den
  stabilen, PII-freien Fehler `rate_limited` und die aufgerundeten ganzen
  `retryAfterSeconds`; Profilconfirmation, Job, Event und Erfolgs-Audit rollen
  gemeinsam zurück.
- Beendet sich ein Lauf, nachdem eine gebundene Revision gewechselt hat, darf
  er gespeichert werden, erscheint aber nie als aktuell.

## Additives Datenmodell

### `site_energy_profile`

Eine optionale 1:1-Zeile je Site hält die aktuelle operative Profilwahrheit,
ohne `site.ts` an den Intake-Schema-Barrel zu koppeln:

- `workspace_id`, `id`, `site_id`, positive `revision`;
- `schema_version = site-energy-profile.v1`, `input_mode`;
- `source_kind = rechner_snapshot | manual`, optional tenantgebundener
  `source_snapshot_id` und `source_project_id`;
- `address_revision`, `profile` JSONB, `profile_sha256`;
- nullable `confirmed_profile_revision`, `confirmed_address_revision`,
  `confirmed_by`, `confirmed_at`;
- `created_at`, `updated_at`;
- unique `(workspace_id, site_id)`; zusammengesetzte FKs zu Workspace, Site
  und bei Rechnerquelle zu Snapshot/Source-Project;
- unbestätigt bedeutet: alle Confirmation-Felder sind `null`;
- bestätigt bedeutet:
  `confirmed_profile_revision = revision = aktuelle Profilrevision` und
  `confirmed_address_revision = address_revision`;
- Speichern erhöht `revision`, ersetzt Profil/Hash/Quelle atomar und leert
  alle Confirmation-Felder;
- Confirm setzt nur die Confirmation-Felder und nie Profil, Quelle oder Hash;
- Runtime darf weder die Zeile löschen noch Revisions-/Confirmationregeln
  umgehen. Nur der in M1-07 getestete DSGVO-Erasurepfad darf sie entfernen.

### `project_calculation_job`

Die technische Queue ist von der fachlich unveränderlichen Erfolgsrevision
getrennt:

- `workspace_id`, `id`, `project_id`, `site_id`;
- exakte IDs/Revisionen von Adresse/Pin, Profil/Confirmation und Requirement;
- `reservation_key`, Providerrezept, Engine-/Source-/Defaultversion;
- `state`, `attempt_count`, `next_attempt_at`, Lease-Token/-Ablauf;
- nullable, aber nach erstem Setzen unveränderliche `input_sha256` und
  Input-/Provider-Snapshots;
- stabile technische Fehlerklasse und Retrybarkeit, aber nie Providerbody oder
  PII im Fehlerfeld;
- `created_by`, `created_at`, `started_at`, `finished_at` und optionaler
  `result_revision_id`;
- unique `(workspace_id, project_id, reservation_key)` und ein partieller
  Unique-Index für höchstens einen aktiven Job je Project.

Ein enger Trigger erlaubt nur die definierte Zustandsmaschine, Lease-/Retry-
Metadaten und das einmalige Setzen des finalen Inputs. Bindungen, Rezept,
Engine und einmal gesetzter Snapshot bleiben gesperrt.

### `project_calculation_revision`

Die Tabelle enthält ausschließlich erfolgreich validierte, fachlich immutable
Snapshots:

- `workspace_id`, `id`, `project_id`, `site_id`, positive `revision`;
- `job_id` sowie exakte IDs/Revisionen von Adresse/Pin,
  Profil/Confirmation und Requirement;
- `contract_version`, `model_id`, `model_version`, `source_revision`,
  `defaults_version`, `quality`, `validation_status`;
- `input_sha256`, `result_sha256`, geschlossener Input-/Provider-Snapshot und
  geschlossenes Result;
- `created_by`, `created_at`;
- unique `(workspace_id, project_id, revision)`, unique Jobbindung und
  idempotenter Schlüssel aus Project, Input-Hash und Engineversion.

Runtime-ACL und Trigger verbieten UPDATE/DELETE; der explizite
DSGVO-Erasurepfad erhält einen separat getesteten Principal/Vertrag.

### Beweisbarer Tenant-/Fachgraph

- `project` erhält `UNIQUE(workspace_id,id,site_id)`.
- `calculator_snapshot` bindet bereits
  `UNIQUE(workspace_id,id,project_id)`; zusätzlich beweist der Project-Site-FK
  des Profils, dass `source_project_id` zur gespeicherten Site gehört.
- `project_requirement` erhält
  `UNIQUE(workspace_id,id,project_id,revision)`.
- `site_energy_profile` erhält
  `UNIQUE(workspace_id,id,site_id)` sowie bedingte Checks: Rechnerquelle setzt
  Snapshot und Source-Project gemeinsam, manuelle Quelle setzt beide `NULL`.
- Job und Revision referenzieren Project+Site, Profilidentität+Site,
  Requirement-ID+Project+Revision und optional Snapshot+Source-Project jeweils
  zusammengesetzt. Mutable Profil-/Adressrevisionen sind bewusst gespeicherte
  Bindungswerte und Payload-Hashes, keine FK-Ziele.

Jede Tabelle erfüllt Workspace-FK, `UNIQUE(workspace_id,id)`, ausschließlich
zusammengesetzte Tenant-FKs, RLS/FORCE, exakt eine `tenant_isolation`-Policy,
Fixture- und ACL-Manifest. Die App-Runtime erhält nur die minimalen
SELECT/INSERT- beziehungsweise eng begrenzten UPDATE-Rechte; Auth/System
erhalten keinen neuen Fachzugriff. Der Worker erhält erst mit echter
Queue-Ausführung einen expliziten, getesteten Vertrag.

## Servicegrenzen

### Reads

`getProjectEnergyContext(tx, ctx, projectId)`:

- verlangt `project.read`;
- liefert minimierte Projekt-/Site-/Revisionsbindungen, Profilzustand,
  aktuellen beziehungsweise stale Rechenstatus und erlaubte UI-Fähigkeiten;
- zeigt dem Viewer fachliche Werte, aber keine Provider-Rohdaten oder
  Intake-Ergebnis-/Marktpreisdaten.

`getProjectEnergyProfileCandidate(tx, ctx, projectId)`:

- verlangt `project.write`, sperrt `external_only`;
- projiziert ausschließlich validierte `calculation.inputs` und Provenienz aus
  dem unterstützten Rechner-Snapshot;
- fehlende Felder bleiben unknown; Branch-Widersprüche oder unbekannte
  Versionen enden fail-closed.
- stammt der Rechner von einem regionalen oder inzwischen geänderten Standort,
  sind die Dachwerte nur Kandidaten. Jedes Dach muss am aktuellen Pin explizit
  erneut bestätigt oder neu erfasst werden; Herkunft `default` kann nicht als
  hausbezogene Dachwahrheit bestätigt werden.

### Mutationen

`saveProjectEnergyProfile(tx, ctx, input)`:

- validiert den kanonischen Profilvertrag;
- sperrt Project und Site, prüft Tenant, aktuelle Adresse/Pin und
  `expectedLatestRevision`;
- insertet beim ersten Mal oder ersetzt danach die operative Profilzeile,
  erhöht die Revision genau einmal und setzt die Bestätigung zurück;
- leitet Feldprovenienz serverseitig aus importiertem Kandidaten, Änderungen
  und expliziten Dach-Acknowledgements ab; der Browser darf keine
  Vertrauensklasse selbst setzen;
- emittiert `site.energy_profile_saved` und atomaren Erfolgs-Audit mit IDs und
  Revisionen.

`confirmProjectEnergyProfile(tx, ctx, input)`:

- sperrt Project, Site und die operative Profilzeile;
- prüft aktuellen Pin, Adresse, latest Revision und vollständigen
  Profilvertrag erneut;
- setzt idempotent die Confirmation-Bindungen für genau diese Profil- und
  Adressrevision;
- berechnet den stabilen Reservation-Key und legt atomar genau einen
  `project_calculation_job` im Zustand `queued` an;
- erkennt einen exakten Replay vor Quota/Cooldown; nur eine neue Reservation
  nimmt die workspace-/actorbezogenen Locks und verbraucht Policy-Kapazität;
- emittiert beim ersten wirksamen Confirm
  `site.energy_profile_confirmed` und Erfolgs-Audit ohne Werte; ein identischer
  Replay liefert dieselben IDs ohne zweites Event/Audit.

`claimProjectCalculationJob(tx, worker, jobId)`:

- beansprucht unter Workspace-/Workervertrag genau eine fällige Queuezeile;
- setzt eine begrenzte Lease und erhöht `attempt_count` atomar;
- liefert nur gepinnte Bindungen/Rezeptversionen und einen gegebenenfalls schon
  vorhandenen Input-Snapshot;
- beendet die DB-Transaktion vor jedem Netzwerk- oder Engineaufruf.

Die technische Queuezustellung erfolgt davor über den einzigen Runtime-
erreichbaren pg-boss-Einstieg
`pgboss.enqueue_project_calculation(workspace_id, job_id)`. Er ist
worker-owned, `SECURITY DEFINER`, auf `search_path=pg_catalog` geschlossen und
akzeptiert ausschließlich einen RLS-sichtbaren `queued`, `running` oder
`retry_wait` Job mit intakter 32-Byte-Reservation. Sein Payload ist exakt
`project-calculation-dispatch.v1` plus Workspace-/Job-ID; Profil, Adresse,
Providerdaten und Reservation-Key verlassen die Fachtabellen nicht. Runtime
besitzt keine pg-boss-Relationsrechte. Schema v38 und die vorab durch
`app_worker` erzeugte Queue `calculation.execute` werden bei Migration und
Ausführung fail-closed geprüft. Der Fresh-Bootstrap erzeugt für die
unveränderlichen Migrationen 0025/0026 den historischen Vertrag `exclusive`,
Retrylimit 0 und Notify aus. Migration 0029 hebt technische Vor-Claim-Retries
auf zehn Versuche mit 1–60 Sekunden Backoff; der normale Worker pinnt danach
genau diesen aktuellen Vertrag. Ein wiederholter Bootstrap erkennt 0029 und
stuft die Queue niemals zurück.

`executeProjectCalculation(port, provider, prepared)`:

1. verwendet den bereits gespeicherten Input-Snapshot oder holt PVGIS-Daten
   außerhalb einer DB-Transaktion mit harter Begrenzung;
2. normalisiert, validiert und setzt Input/Hash genau einmal; ein Race muss
   denselben Hash ergeben;
3. validiert Request und Response gegen denselben Vertrag;
4. berechnet deterministisch über den `CalculationPort`;
5. prüft vor der Mutation zusätzlich modellexakt gegen den gepinnten
   Clean-Room-v1-Kern; dadurch scheitern auch kohärent gemeinsam veränderte und
   neu gehashte Direct-/Storage-/Loss-/Cycle-Flüsse. Dieser zweite Lauf ist
   netzwerkfrei und durch den bereits validierten 8.760-Stunden-Vertrag hart
   begrenzt;
6. persistiert Resultrevision, Jobstatus, Domain-Event und Erfolgs-Audit
   atomar in einer frischen autorisierten Tenant-Transaktion;
7. prüft sämtliche Revisionen erneut; `current` bleibt eine Read-Ableitung und
   verwendet dieselbe modellexakte Integritätsgrenze.

Erwartete Fehler sind typisiert: `prerequisites_missing`, `unsupported_source`,
`invalid_profile`, `stale`, `provider_unavailable`,
`provider_invalid`, `rate_limited`, `engine_unavailable`, `engine_invalid`,
`retry_conflict`. Actions geben kleine deutsche UI-Zustände zurück;
unerwartete Fehler laufen über die generische Route-Boundary.

## UI und Barrierefreiheit

Die Fähigkeit lebt in der bestehenden Projektakte.

- Der Abschnitt „Energieprofil“ zeigt Quelle, Prüfstatus, Profilrevision und
  die wesentlichen Eingaben in Gruppen.
- Importierte Rechnerdaten sind sichtbar vorbefüllt, aber klar als ungeprüft
  markiert. Der importierte Ergebnis-/Preisblock wird nicht als Eingabe
  angeboten.
- `Profil speichern` und `Eingaben bestätigen` sind getrennte Controls.
- Nach Bestätigung erscheint der automatische Status
  `wird berechnet | aktuell | veraltet | fehlgeschlagen`.
- Aktuelle Ergebnisse zeigen mindestens Anlagengröße, Jahresertrag,
  Verbrauch, Eigenverbrauch, Einspeisung, Netzbezug, Autarkie,
  Eigenverbrauchsquote, Speicherverluste, Monatswerte, Annahmen, Quellen,
  Profil-/Adress-/Requirementrevision, Engineversion und Result-Hash.
- Keine Wirtschaftlichkeit oder Investition wird aus `market_estimate`
  angezeigt.
- Viewer sehen dieselben erlaubten Fachwerte read-only, aber keine Save-,
  Confirm- oder Retry-Controls.
- Blocker bleiben getrennt:
  `Adresse/Pin`, `Energieprofil`, `Berechnung`, `Katalogauflösung`.
- Fehler verwenden `role=alert`, Status `aria-live`; Fokus folgt dem ersten
  fehlerhaften Feld. Alle Controls sind per Tastatur erreichbar und mindestens
  44×44 px auf Touch.
- Mobile, Tablet, Desktop, Reduced Motion, Zoom und Axe serious/critical sind
  Bestandteil der Browserabnahme.

## Datenschutz, Events und Telemetrie

- Energieprofil und Rechensnapshots bleiben tenantgeschützte Fachdaten.
- Domain-Events und Audit enthalten nur Workspace-/Project-/Site-/Run-IDs,
  Revisionsnummern, Status und Qualitätsklassen.
- Verboten in Events/Audit/Logs: Adresse, Koordinaten, Verbrauch, Strompreis,
  Dachwerte, Bestandsanlage, Wetterreihen, Resultate und Provider-URLs.
- Error-Telemetrie entfernt FormData, Input-/Result-Snapshots und Providerbody.
- UI-Fehler enthalten stabile Codes und generische deutsche Texte, keine
  Rohwerte oder Stacktraces.
- M1-07 erweitert die bindende Retention-Registry: Leads ohne Vertrag werden
  nach 24 Monaten Inaktivität zur Löschprüfung fällig. Energieprofil, offene
  Jobs, Provider-/Input- und Result-Snapshots besitzen keine gesetzliche
  Aufbewahrung und werden im autorisierten Erasurelauf gelöscht, bevor der
  Contact pseudonymisiert wird.
- Gehört eine Site nur diesem Contact, werden ihre Profile und Planungsdaten
  vollständig entfernt und die Site wird adressseitig pseudonymisiert oder
  gelöscht. Bei einem zulässigen Shared-Site-Fall werden personenbezogene
  Bindungen getrennt geprüft; ein fremdes Project darf nie Daten des gelöschten
  Contacts behalten.
- Domain-Events/Audit bleiben wegen ihrer ID-only-Payload bestehen. Backups
  folgen der dokumentierten Restlaufzeit; die Wiederherstellungsprozedur führt
  die Erasure-Tombstone-Liste erneut aus, bevor ein Restore freigegeben wird.
- Der Erasure-Principal und seine DELETE-/Pseudonymisierungsrechte sind von
  App-Runtime und Worker getrennt. Ohne automatisierten Graph-, Restore- und
  24-Monats-Test bleibt M1-07 weder `VERIFIED` noch pilotfähig.
- Migration 0027 setzt diese Grenze als zwei `SECURITY DEFINER`-Routinen mit
  `search_path=pg_catalog` um. `app_erasure` ist `NOLOGIN`/`NOINHERIT`, besitzt
  keine Tabellenrechte und darf ausschließlich diese Routinen ausführen.
  Die jüngste Aktivität des vollständig gesperrten Graphen plus 24
  Kalendermonate wird ausschließlich mit DB-Zeit bewertet; aktiver Legal Hold,
  `won`-Vertrag, Row-Locks und ein noch gültiger Worker-Lease werden vor jeder
  Mutation und erneut beim Replay geprüft. Neue Restore-IDs führen fail-closed
  zu `erasure_graph_drift`; beide Tombstone-Hashes werden vor dem Replay
  verifiziert. Freigegebene Holds werden gelöscht, freie Acquisition-/URL-
  Felder eines erhaltenen ID-/Hash-Receipts pseudonymisiert. Der neunspaltige
  Tombstone enthält nur kanonische IDs, SHA-256-Werte, Grund und Zeiten, ist
  auch für den Owner WORM-geschützt und autorisiert die eng begrenzten
  DELETE-Triggerausnahmen.

## RED- und Abnahmematrix

### Contract und Mapping

- JSON-Schema wird deterministisch aus der kanonischen Runtimegrenze erzeugt;
  Drift macht den Test rot.
- Golden Fixture für Neubau, Bestand, ohne Speicher, Null-/Grenzwerte und
  unterschiedliche Provenienzklassen.
- Rechnerfeld → Site-Profil/Project-Requirement ist tabellarisch getestet;
  Client-Result und `market_estimate` tauchen nie im Serverrequest auf.
- Fehlende Wallbox/EV-/Zahlartdaten bleiben `unknown`.
- unbekannte Schema-/Engineversion, NaN/Infinity, Zusatzfelder, falsche
  Arraylängen und Branch-Widersprüche werden abgelehnt.
- Unbekannte Dachverschattung sowie unbekannter Bestandsspeicher im
  Bestandszweig werden vor der Engine fail-closed abgelehnt; explizit
  `known_absent` bleibt als 0-kWh-Baseline zulässig.
- Ein isoliert valides Resultat mit falschem Branch, Input-Hash, zentraler
  Kapazität oder unpassender Bidirektional-/Backupwarnung wird an der
  Request↔Result-Grenze abgelehnt.
- Ein mathematisch in sich konsistentes, aber gegenüber dem gepinnten Modell
  umverteiltes und neu gehashtes Resultat wird bei Finalisierung und Lesen
  durch den exakten deterministischen Modellvergleich abgelehnt.

### Datenbank und Services

- Fresh- und Upgrade-Migration aus M1-06.
- Workspace-FK, composite FK, RLS/FORCE/Policy, ACL und Fixtures für jede neue
  Tabelle.
- Editor/Admin success; Viewer, external-only, unauthenticated, fremder
  Tenant und fremdes Objekt fail-closed.
- Jede Rollen-/Objektablehnung folgt zusätzlich dem bestehenden Denial-
  Auditvertrag ohne Fachwerte.
- Save erzeugt eine neue Revision; stale Tab und paralleles Save erzeugen
  keinen Seiteneffekt.
- Confirmation ist getrennt, idempotent und nur für aktuelle Adresse/Pin/
  latest Profile möglich.
- Confirmation verändert keine Inhalte; neue Werte ersetzen die operative
  Wahrheit mit erhöhter Revision und setzen Confirmation zurück.
- Shared-Site-Semantik ist getestet: Profilrevision ist Site-Wahrheit;
  Project-Rechenläufe bleiben getrennt und werden nach Wechsel stale.
- Mutation, Event und Success-Audit rollen gemeinsam zurück.
- Events/Audit bleiben nach automatischer Suche nach PII-/Wertfragmenten leer.
- Retention-/Erasuretest entfernt Profile, Jobs und Calculation-Snapshots,
  pseudonymisiert den Contact und beweist Restore-Tombstone-Replay.

### Provider und Engine

- PVGIS-Requestparameter, Azimut, Rundung, Timeout, Größe, Rate-Limit,
  UTC→Europe/Berlin→Leap-Day-Normalisierung, PVcalc-Skalierung, Einheiten und
  falsche Providerantworten.
- Kein Provideraufruf vor erfolgreichem autorisierten DB-Preflight; keine
  offene Transaktion während des Requests.
- gleicher Input + gleiche Engine → identischer Result-Hash;
- Dach-/Wetterzuordnung erfolgt per `roofId`, nicht Arrayposition;
- Energieerhaltung, Wertebereiche, Rundung und Monats-/Jahressummen;
- Inputwechsel während des Laufs erzeugt nie fälschlich `current`;
- Doppeljob/Retry erzeugt keinen zweiten fachlichen Lauf;
- ein aktiver Lauf je Project, Actor-/Workspace-Quota, Cooldown, begrenzte
  Retries, Backoff und `Retry-After` sind nachgewiesen;
- Provider-/Engineausfall ist ehrlich retryable/final und entfernt den
  Profilstand nicht.

### Browser-Golden-Path

```text
regionaler Rechner-Lead
  → Hausadresse + aktueller Pin
  → Rechner-Eingaben prüfen
  → Profil speichern
  → getrennt bestätigen
  → automatische serverseitige Rechnung
  → Reload mit identischem aktuellem Resultat
```

Zusätzlich: stale/retry, Viewer, Fremdtenant, Shared Site, Mobile, Tablet,
Tastatur, Console-/Hydration-/Page-Errors und Axe serious/critical.

### Repository-Gates

- `app/` importiert nur öffentliche Modul-/Integrations-APIs, nie `lib/db`.
- RED→GREEN-Vertrags-, Mapping-, DB-, Migration-, Action-, Provider-, Engine-
  und Browsertests.
- `npm run lint`
- `npm run typecheck`
- `npm run depcruise`
- vollständiges `npm run test`
- `npm run db:roles:verify`
- `npm run build`
- mindestens zwei unabhängige Reviews ohne offene P0–P2-Befunde.

## Nichtziele

- keine vollständige F1.4-Unterstützung für property/roomwise/manual;
- kein 15-Minuten-F4-Lauf, pvlib/Muneer, Arbitrage, TOU, IRR, dynamischer Tarif,
  EEG-/Förderkaskade oder angebotsfähiger Cashflow;
- keine zertifizierte/normkonforme Aussage;
- kein LoD2-/Google-Solar-Live-Wiring oder Dachbestätigungsworkflow;
- keine Vault-/Speicher-SKU, Herstellerdaten, Datenblätter, EK/VK, Steuer,
  Marge, Katalogauflösung oder Produktkompatibilität;
- keine BOM, Variante, Angebot, PDF, Signatur oder Phasenkonvertierung;
- keine raumweise DIN-EN-12831-Heizlast;
- kein Preview-, Produktions- oder Live-Provider-Deploy.

## Bewusst offene Gates

1. Die Rechtefreigabe für Extraktion/Vendoring des Rechner-Kerns muss als
   dauerhaftes Repository-Artefakt vorliegen. Bis dahin kann der echte Adapter
   CONTRACTED/RED, aber nicht fachlich VERIFIED werden.
2. Fachlich freigegebene Referenzfälle und akzeptierte Abweichung gegen
   PVGIS/pvlib fehlen. Die UI bleibt deshalb bei „Planungsschätzung“.
3. PVGIS-Live-Smoke, DPA/Privacy, Attribution und verteiltes Rate-Limiting sind
   Pilot-Gates.
4. Vollständige Zielpakete samt Zahlart folgen mit Project-Requirement v2.
5. Welches konkrete Produkt „Vault“ bezeichnet und welche Produkt-/Preisquelle
   autoritativ ist, wird vor M1-08 geklärt; M1-07 blockiert daran nicht.
6. Worker-/Container-Ausführung ersetzt den synchronen lokalen Adapter vor
   Pilot, ohne den CalculationPort zu ändern.
