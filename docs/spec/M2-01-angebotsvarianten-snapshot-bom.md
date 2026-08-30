# M2-01 — Angebotsentwurf, Varianten und Snapshot-BOM v1

Status: **GATE 1 FREIGEGEBEN / IMPLEMENTIERT / GATE 2 IN PRÜFUNG**

Scope: Geschützter, operatorqualifizierter B2C-PV-Wohngebäude-Browserpfad
`aktuelle Anfrage → unverbindlicher Angebotsentwurf → erste Variante → Snapshot-BOM → Preis-/Rabatt-/Steuerentwurf → Variante duplizieren → Reload/Outdated-Nachweis`

Vorgänger: M1-08 liefert eine aktuelle, revisionsgebundene Projektauflösung
mit eigenen Katalogprodukten sowie eingefrorenen Netto-EK/VK-Preisen. Diese
Auflösung ist die einzige zulässige Quelle für katalogbasierte BOM-Zeilen.

Mikail hat Gate 1 am 30. August 2026 freigegeben. Die Spezifikation ist damit
der implementierte und zu verifizierende M2-01-Vertrag; sie behauptet weiterhin
keine abgeschlossene F2- oder Reonic-Gesamtparität.

## Fähigkeit und Nutzerergebnis

Ein berechtigter Editor kann eine offene Wohngebäude-Anfrage mit bestätigtem
Standort, aktueller Planung und aktueller Produktauflösung atomar in einen
unverbindlichen Angebotsentwurf überführen. Dabei entstehen eine unveränderliche
Angebotsnummer, ein Kunden-/Standortsnapshot und eine erste Variante mit einer
vom Katalog unabhängigen, revisionsgebundenen Stückliste.

Innerhalb des Entwurfs kann der Editor Varianten duplizieren, Stücklisten in
Sektionen ordnen, Mengen und Verkaufspreise mit den jeweiligen Einzelrechten
ändern sowie Zeilen-, Sektions- und Gesamtrabatte erfassen. Sämtliche Summen
werden serverseitig mit ganzzahliger Arithmetik neu berechnet. Jede fachliche
Änderung erzeugt eine neue unveränderliche Variantenrevision; Katalogänderungen
verändern bestehende Angebotsstände niemals still.

Viewer sehen den Angebotsentwurf schreibgeschützt. EK, Einkaufsprovenienz,
Marge und Hashes vollständiger interner Snapshots werden nur bei
`price.read_purchase` überhaupt in ein Readmodell aufgenommen.

## Einordnung gegen F2

| Capability | M2-01-Abdeckung | Grenze |
|---|---|---|
| F2.1 | Anfragekonvertierung, workspaceweite Nummer, Forecast getrennt vom Kundenpreis, feste Anlagenart | Direkte Offer-Anlage und Einstellungs-UI fürs Nummernformat folgen separat |
| F2.2 | n Draft-Varianten, erste Variante, vollständiges Duplizieren, unveränderliche Revisionen | Finanzierung, Planungslayout und signierter Fork folgen später |
| F2.3 | Sektionen, katalogbasierte und freie Zeilen, Menge, Einheit, EK/VK, Rabatt, Steuer, Typ, Sichtbarkeit, Reorder | Kundenseitige Auswahl optionaler Komponenten gehört zur Signaturstrecke |
| F2.4 | Rabattreihenfolge und Custom Deal Value als deterministischer Geldvertrag | Exakte private Reonic-Rundungsdetails sind UNKNOWN; die eigene freigegebene WMEE-Regel ist gekapselt |

M2-01 ist damit ein vertikaler Teil von F2.1 bis F2.4, nicht M2 als Ganzes.

## Quellen und Evidenzklassifikation

- **DOCUMENTED:** Die öffentliche Reonic-Dokumentation beschreibt das Erstellen
  eines Angebots aus einer Anfrage, mindestens eine Standardvariante,
  voneinander unabhängige Varianten und eine Stückliste mit Menge, Preis,
  Rabatt und Umsatzsteuer.
- **DOCUMENTED:** Öffentliche Reonic-Seiten beschreiben zusätzliche und
  optionale Komponenten sowie Zeilen-, Sektions- und globale Rabatte.
- **INFERRED / sekundär synthetisiert:** Der interne Modulkatalog
  `docs/blaupause/01-modulkatalog.md` bündelt F2.1 bis F2.4, ist aber keine
  Primärevidenz für Reonic-Verhalten oder WMEE-Bedarf.
- **DOCUMENTED:** Die Vault-Quellen verlangen einen zunächst unverbindlichen,
  menschlich zu prüfenden Angebotsentwurf aus Rechner- und Kundendaten und
  nennen die drei Ergebnisrichtungen „Sparsam“, „Empfohlen“ und „Maximal“.
  Frei benennbare Varianten sind dagegen eine eigene Produktentscheidung.
- **OBSERVED stakeholder statement:** Jamie-Transkripte enthalten Aussagen zum
  gewünschten Prozess und zur Reonic-Nutzung. Sie sind keine unabhängige
  Produktbeobachtung.
- **DOCUMENTED / sekundäres Archiv:** Historische Session-Markdowns bündeln
  frühere Agent-/Nutzerentscheidungen und Quellenhinweise. Sie sind weder eine
  Produktbeobachtung noch eine zweite Bestätigung.
- **DECIDED WMEE:** UI, Datenmodell, Rundung, Nummernstandard und
  Sicherheitsgrenzen sind nach Gate 1 eigene WMEE-Entscheidungen, sofern keine
  rechtmäßige Quelle eine exakte Reonic-Semantik belegt.
- **UNKNOWN:** Exakte private Reonic-Regeln für Nummernformat, Rundung,
  Steuersachverhalte, Rabattkompetenzen und Direktanlage bleiben unbelegt.

Das kanonische Quellenregister steht in `docs/parity/SOURCE-REGISTER.md`.
`CONTRIBUTING.md` bleibt die Clean-Room-Constitution. Es wird kein Reonic-
Login, keine interne API und kein fremder Katalog verwendet.

## Nicht-Ziele dieses Slices

- kein PDF-Render, Versand, öffentlicher Angebotslink oder E-Signatur;
- kein rechtsverbindliches `issued`, `accepted` oder `signed`;
- kein WORM-Artefakt und keine behauptete Object-Lock-Probe;
- keine Finanzierung, Leasing, Zahlungsabwicklung oder Rechnung;
- keine automatische 0-%-Steuerentscheidung aus Adresse, Produkttyp oder KI;
- keine direkte Angebotsanlage ohne bestehendes Projekt;
- kein Gewerbe-, B2B- oder unklarer Preiszielgruppen-Golden-Path, solange dafür
  Katalog-, Board- und Qualifikationsverträge fehlen;
- kein strukturiertes Klima-Angebot: M1-08 besitzt noch keine Typen für Außen-
  und Innengerät, Leitung und klimaspezifische Arbeit und `other` darf diese
  Lücke nicht als echte Produktklassifikation verdecken;
- keine 3D-/2D-Planung in der Variante;
- keine realen WMEE-SKUs, Preise oder „40 Pakete“ ohne autoritative Datenquelle;
- kein vollständiges Redesign der bestehenden Anwendung;
- keine Zukunftsbuttons, die eine dieser Fähigkeiten nur vortäuschen.

## Golden-Path-Vorbedingungen

Die Konvertierung ist nur zulässig, wenn serverseitig innerhalb derselben
Tenant-Transaktion erneut bestätigt wird:

1. Actor, Membership und Workspace sind DB-verifiziert.
2. `project.write`, `phase.convert` und `price.edit` sind erlaubt;
   `external_only` bleibt ohne Assignment-Modell fail-closed. `price.edit`
   autorisiert in M2-01 auch jede Auswahl oder Änderung der Steuerbehandlung,
   weil sie den Kundenpreis verändert.
3. Das Projekt gehört zum Workspace, ist `request/open` und liegt auf einer
   aktiven `lead`-Spalte des default Wohngebäude-Boards.
4. Dedupe-, Adress- und Pin-Blocker sind geschlossen.
5. Requirement und Calculation sind aktuell und erfolgreich.
6. Die aktuelle Projektauflösung ist `current`, vollständig und verweist auf
   aktive, preislich vollständige Produktrevisionen.
7. Für das Projekt existiert noch kein anderes Offer.
8. `project.source_key = 'wmee-rechner-v3'`, ein gebundener Inbound-Receipt mit
   `privacy_purpose = 'offer_request'` und die vollständige Rechner→Requirement→
   Calculation→Resolution-Bindung sind vorhanden. Der Operator bestätigt im
   Create-Command ausdrücklich `priceAudience = b2c`; `residential` allein
   gilt nicht als B2C-Nachweis. B2B oder unklar blockiert.

Ein ausgeblendeter oder deaktivierter Button ersetzt keine dieser Prüfungen.

## Nutzerjourney

1. Der Editor öffnet die bestehende Projektakte und sieht eine echte
   Bereitschaftszusammenfassung oder konkrete Blocker mit Rücksprungzielen.
2. „Angebotsentwurf erstellen“ zeigt Kunde, Anlagenstandort,
   Planungsrevision, Produktauflösung, feste Anlagenart `residential`, die
   ausdrücklich zu bestätigende Preiszielgruppe `b2c`, optionalen
   Forecast-Wert und die ausdrücklich zu wählende initiale Steuerbehandlung.
   Bei 0 % ist die strukturierte Operatorbestätigung Teil desselben Commands.
   Es werden keine Preise oder Hashes vom Browser als Wahrheit übernommen.
3. Eine Transaktion sperrt Projekt und Nummernserie, erzeugt Offer, erste
   Variante und BOM-Revision, setzt `project.phase = offer`, verschiebt das
   Projekt auf die eindeutige Offer-Spalte und schreibt Event/Audit.
4. Nach Revalidierung erfolgt ein Redirect auf
   `/w/{workspaceId}/angebote/{offerId}` außerhalb des Fehler-`try/catch`.
5. Der Editor sieht Variantennavigation, BOM-Editor und Preiszusammenfassung.
6. Eine Variante kann vollständig dupliziert und anschließend unabhängig
   geändert werden. Speichern verlangt `expectedRevision`.
7. Nach Reload sind Reihenfolge, Summen, Snapshots und aktive Variante gleich.
8. Eine spätere Katalog-/Projektauflösung ändert den Entwurf nicht. Stattdessen
   erscheint ein Outdated-Hinweis. Eine neue Basisvariante kann ausdrücklich
   aus der dann aktuellen Projektauflösung angelegt werden; der alte Stand
   bleibt erhalten.
9. Viewer sehen denselben fachlichen Stand ohne Editieraktionen und ohne
   EK-/Margendaten.

## Produktentscheidungen

### Ein Offer pro Project im ersten Vertrag

`offer` besitzt eine workspacegebundene Unique-Bindung an `project`.
Varianten tragen die fachlichen Alternativen. Mehrere unabhängige Offers pro
Projekt und direkte Offer-Anlage bleiben UNKNOWN und werden nicht vorweggenommen.

### B2C-Wohngebäude aus dem Rechner zuerst

Der aktuelle Rechner-/Request-Pfad besitzt ausschließlich ein belastbares
default Board mit Scope `residential`. M2-01 kopiert diesen Scope bei Anlage
unveränderlich ins Offer. Zusätzlich wird `priceAudience = b2c` nur nach einer
strukturierten Operatorbestätigung samt Actor und DB-Zeitpunkt gespeichert.
Die vollständige Entscheidung liegt unveränderlich als
`offer.price_audience_decision`; jede Variantenrevision muss im deferred
DB-Validator exakt dieselbe Entscheidung tragen. Sie wird bei einer neuen Basis
weder aus dem aktuellen Operator noch aus einer beliebigen Variante neu
abgeleitet.
Weder `residential` noch der Website-Kanal werden als B2C-Nachweis inferiert.
Das Datenmodell reserviert `commercial` und weitere Preiszielgruppen, der
Service lehnt diese Pfade aber bis zu einer echten Qualifikations- und
Katalogquelle ab. Der vorhandene einzelne Katalog-VK wird in diesem Slice nur
als eigener B2C-Listenpreis verwendet; diese Festlegung wurde in Gate 1
freigegeben.

Der untrusted Create-Input pinnt dafür exakt
`priceAudience: "b2c"` und
`priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true }`.
Actor und Zeitpunkt stammen ausschließlich aus Tenant-Kontext und DB-Uhr;
andere Werte, fehlende Bestätigung oder ein clientgesendeter Actor/Zeitpunkt
werden abgelehnt.

### Angebotsnummer

Eine workspaceweite `offer_number_series` wird in derselben Transaktion per
Row Lock fortgeschrieben. Keine `max(number) + 1`-Logik. Der v1-Standard ist
`ANG-{YYYY}-{sequence:6}`; gespeicherte Nummern werden nie geändert oder
wiederverwendet. Prefix und Padding liegen im Serienvertrag, eine Admin-UI
gehört nicht in M2-01. Das ist eine **DECIDED WMEE**-Regel, nicht als
exaktes Reonic-Format behauptet.

`created_at` ist DB-`timestamptz`; das Serienjahr wird einmalig aus der
DB-Transaktionszeit in `Europe/Berlin` abgeleitet und zusammen mit der Nummer
gespeichert. Browserzeit und Prozesslocale sind dafür ohne Bedeutung.

### Forecast und Kundenpreis

`forecast_value_net_cents` ist ein optionaler CRM-Wert am Offer. Er wird nie
aus dem BOM-Total abgeleitet und fließt in keine Kundenpreissumme ein. Die
Preiszusammenfassung bezeichnet ihn klar als Vertriebsprognose.

### Datensparsamer Kunden- und Anlagenstandort-Snapshot

Der Service liest Contact und Site ausschließlich innerhalb der gesperrten
Tenant-Transaktion aus der Datenbank. Der Browser sendet weder Kundendaten noch
Adressfelder. Neben den relationalen Bindungen `contact_id` und `site_id`
enthält das Offer genau diese kanonische Kopie:

```text
contactContext = {
  displayName: contact.display_name,
  emailPrimary: contact.email_primary | null,
  phoneE164: contact.phone_e164 | null
}
installationSiteContext = {
  addressRevision: site.address_revision,
  formattedAddress: site.formatted_address,
  street: site.street,
  houseNumber: site.house_number,
  postalCode: site.postal_code,
  city: site.city,
  country: site.country
}
```

Jeder Text wird in Unicode NFC normalisiert und außen getrimmt. Erforderliche
Felder müssen danach nichtleer sein; die beiden optionalen Kontaktfelder
bleiben entweder ein gültiger kanonischer Wert oder `null` und werden nicht aus
Leerstrings erzeugt. `emailPrimary` muss weiterhin zur DB-seitig gespeicherten
normalisierten E-Mail passen, `phoneE164` zum E.164-Vertrag. Die Site muss
`selected`, hausgenau, pinbestätigt und auf genau derselben `addressRevision`
bestätigt sein. Contact muss `deleted_at IS NULL` sein und die
workspacegebundene Project→Contact→Site-Kette exakt übereinstimmen; andernfalls
blockiert Create.

Nicht kopiert werden `phone_raw`, `email_normalized`, Marketing-Consent,
Kontakt-/Rechnungsadresse, Site-Label, Koordinaten, Geocoderquelle/-Place-ID,
Adressfingerprint, UTM-/Referrer-Daten, Rechner-Rohpayload und sonstige CRM-
Felder. Die Adresse ist ausschließlich der Anlagenstandort; das aktuelle Modell
kennt keine davon getrennte Kontakt- oder Rechnungsadresse. PDF/Issuance bleibt
gesperrt, bis Rechnungsadress- und Empfängervertrag separat entschieden sind.

Die vollständige Rechner→Requirement→Calculation→Resolution-Kette wird nicht
als Kundensnapshot kopiert. Das Offer speichert nur die notwendigen
workspacegebundenen IDs, Revisionen und privaten Integritätshashes als
Quellbindungen. Actions akzeptieren dafür ausschließlich IDs und erwartete
Revisionen; der Service lädt und verifiziert alle Hashes selbst. Private
Vollhashes verlassen niemals das berechtigte interne Readmodell.

### Snapshot statt Live-Referenz

Eine Angebotszeile kopiert bei Anlage mindestens:

- stabile eigene Zeilen-ID und Position;
- Katalogkomponenten-ID und exakte Revision, sofern katalogbasiert;
- interne SKU, Name, Hersteller, Modell, Einheit und technische Darstellung;
- Netto-EK/VK und Preisprovenienz zum Kopierzeitpunkt;
- Assetreferenzen und zulässige technische Provenienz;
- Quellauflösungs-ID/-Revision und Quellhash intern;
- Menge, Typ, Sichtbarkeit, Steuersachverhalt und Rabattfelder.

Die Referenz ist Herkunft, niemals spätere Preiswahrheit. Eine freie
Angebotszeile trägt `source = custom`, Klartextdaten und eigene Preise, aber
keine erfundene Katalogprovenienz.

Jeder effektive Preis besitzt zusätzlich eine wahrheitsgemäße Offer-
Preisprovenienz:

- `catalog_seed`: unveränderlicher kopierter Katalogpreis samt Originalquelle;
- `manual_override`: Originalwert bleibt erhalten, der neue effektive Wert
  bindet Grundcode, Actor und DB-Zeitpunkt;
- `custom`: freie Zeile mit erfassendem Actor und DB-Zeitpunkt, ausdrücklich
  ohne Katalogbehauptung.

EK-Overrides verwenden dieselbe Struktur und bleiben innerhalb der
`price.read_purchase`-Grenze. Preisprovenienz wird nie durch einen alten
Katalogbeleg falsch etikettiert.

### Stabile Variante, unveränderliche Revisionen

`offer_variant` trägt stabile Identität, workspace-/offerweit eindeutige
Ordinalzahl und `current_revision`. `offer_variant_revision` enthält einen
vollständigen, kanonisierten Snapshot mit Sektionen, Zeilen und berechneten
Summen. Jede relevante Änderung schreibt `N+1`; bestehende Revisionen sind
Runtime-append-only.

Relationale Sektions- und Zeilenmirrors werden ebenfalls je Revision kopiert.
Sie erzwingen Tenant-FKs, Katalogherkunft und sortierbare Abfragen, sind aber
keine zweite Preiswahrheit neben dem versiegelten Snapshot.

Die erste Variante heißt `Basis`. Namen wie „Sparsam“, „Empfohlen“ und
„Maximal“ sind erlaubt, werden ohne echte Paketquelle aber nicht automatisch
erzeugt.

### Deterministisches Seeding aus M1-08

Die erste Revision wird vollständig serverseitig aus der aktuellen Resolution
erzeugt:

- eine Sektion je tatsächlich vorhandener Komponentenkategorie in der festen
  Reihenfolge `module`, `inverter`, `battery`, `wallbox`, `heat_pump`,
  `mounting`, `other`;
- Sektionsposition nach dieser Reihenfolge, Sektionsrabatt 0;
- Zeilenposition nach der unveränderlichen Resolution-Position;
- `positionType = required`, `isHidden = false`, Zeilenrabatt 0;
- `quantityMilli = resolution.quantity * 1000`;
- katalogbasierter VK/EK samt `catalog_seed`-Provenienz;
- die im Create-Command ausdrücklich gewählte Steuerbehandlung auf jeder
  Seed-Zeile;
- globaler Rabatt 0 und kein Custom Deal Value.

Eine fehlende oder unbekannte Kategorie, ein nicht safe multiplizierbarer Wert
oder eine unvollständige Steuerbestätigung blockiert die gesamte Transaktion.

### Positionstyp und Sichtbarkeit

`positionType` ist ausschließlich das 3er-Enum:

- `required`: Teil des Basispreises und als erforderlich gekennzeichnet;
- `additional`: Teil des Basispreises, aber als Zusatzleistung gekennzeichnet;
- `optional`: separat summiert und nicht in den Basispreis eingerechnet.

`isHidden` ist ein davon unabhängiges Boolean. Es verändert weder
Basis-/Optional-Zuordnung noch Mathematik; die spätere Kundendarstellung
unterdrückt die Zeile. Im internen Editor bleibt sie sichtbar. Damit bleiben
beispielsweise `required + hidden` im Basispreis und `optional + hidden` in der
separaten Optionalsumme.

Diese Semantik ist als **DECIDED WMEE** freigegeben und durch Contract-Tests
gepinnt.

## Geld-, Rabatt- und Steuervertrag

### Einheiten

- Währung: ausschließlich `EUR`.
- Preisbasis: netto.
- Geldinputs: ganzzahlige, nichtnegative Centbeträge
  `0..9_000_000_000_000_000`; negative Gutschrift-/Abzugspositionen sind in
  v1 nicht zulässig und benötigen später einen eigenen Allokationsvertrag.
- Rabatte und Steuerraten: ganzzahlige Basispunkte, `0..10000`.
- Menge: positive sichere Ganzzahl `quantity_milli` im Bereich
  `1..100_000_000`, also Tausendstel einer Einheit; eine M1-08-Menge
  `1..100_000` wird als `quantity * 1000` übernommen.
- Für `piece` und `set` muss `quantity_milli` ohne Rest durch 1000 teilbar
  sein; nur `meter` darf in v1 Tausendstel nutzen.
- Zwischenrechnungen: `BigInt`; jeder persistierte Zeilen-, Sektions-, Basis-,
  Optional-, Steuer- und Bruttocentwert muss wieder im Bereich
  `0..9_000_000_000_000_000` liegen. Overflow oder ein unsicheres Ergebnis
  verwirft den gesamten Command.
- Rundung: kaufmännisch half-up; keine Binär-Floats.

### Reihenfolge

Für die im Basispreis enthaltenen Zeilen gilt exakt:

```text
unit net × quantity
  → line discount
  → section discount
  → variant/global discount
  → custom deal net target
  → tax per final line
  → gross total
```

Der ungerabattierte Zeilenwert wird genau einmal als
`roundHalfUp(unitNetCents * quantityMilli / 1000)` berechnet. Danach wird der
Zeilenrabatt je Zeile als
`roundHalfUp(lineBase * (10000 - lineBps) / 10000)` angewendet.

Für jede Sektionsgruppe wird aus ihrer Summe `S` und dem BPS-Satz ein exakter
Zielwert `T = roundHalfUp(S * (10000 - bps) / 10000)` berechnet. Dasselbe gilt
anschließend für die Basispreisgruppe beim globalen Rabatt. `T` wird nach den
aktuellen nichtnegativen Zeilennettowerten `w_i` proportional verteilt:

1. `floor(T * w_i / S)` je Zeile;
2. verbleibende Cent in absteigender Reihenfolge des Rests
   `(T * w_i) mod S`;
3. stabiler Tie-Breaker `section.position`, `line.position`, stabile
   `lineDomainId`.

Bei `S = 0` sind alle Zielzeilen 0. Dieselbe Allokation wird für den festen
Custom Deal Value verwendet, wobei dessen Wert direkt `T` ist. Damit ist auch
bei gemischten Steuersätzen eindeutig, auf welche finale Zeile jeder Cent
entfällt. Steuer wird erst danach je finaler Zeile als
`roundHalfUp(finalLineNet * taxRateBps / 10000)` berechnet; Netto, Steuer und
Brutto sind jeweils die Summen ihrer Zeilen.

Der Snapshot speichert die beiden Preisgruppen getrennt als
`basisNetCents`, `basisTaxCents`, `basisGrossCents` sowie
`optionalNetCents`, `optionalTaxCents`, `optionalGrossCents`. Keine
Kundengesamtsumme darf Optionals still in den Basispreis einrechnen.

Der Custom Deal Value ist optional, nicht negativ und darf den Nettostand nach
dem globalen Rabatt nicht erhöhen. Der gesamte Rabattpfad ist bei null
gedeckelt. Optionale Zeilen werden separat mit derselben Zeilen-/Sektionslogik
berechnet, erhalten aber weder globalen Basisrabatt noch Custom Deal Value.

EK-Zeilenwerte verwenden dieselbe Mengenrundung, aber keine Verkaufsrabatte.
Marge ist finaler Verkaufsnettowert minus EK-Zeilenwert und wird nur im
privaten Readmodell berechnet.

### Steuer v1

M2-01 erzeugt nur einen Preisentwurf, keine steuerlich festgeschriebene
Rechnung. Zulässig sind zunächst:

- `standard_19` = 1900 Basispunkte;
- `zero_operator_confirmed` = 0 Basispunkte mit strukturierter expliziter
  Bestätigung, Actor und DB-Zeitpunkt.

Der untrusted Command enthält `taxTreatment` mit exakt einem dieser Werte. Nur
bei `zero_operator_confirmed` ist zusätzlich
`zeroConfirmation: { code: "zero_tax_draft_operator_confirmed", confirmed: true }`
Pflicht; bei `standard_19` muss `zeroConfirmation` fehlen. Actor und Zeitpunkt
werden in beiden Fällen serverseitig ergänzt und niemals vom Client akzeptiert.

Keine Behandlung wird still vorbelegt. Der Operator wählt den Entwurfsstand
ausdrücklich; 0 % verlangt zusätzlich die strukturierte Bestätigung. 0 % wird
niemals aus Adresse, Gebäudetyp, Produkttyp oder Rechnerdaten automatisch
inferiert. Weitere Sachverhalte wie §13b oder Kleinunternehmer gehören zur
steuerfachlich geprüften M3-Regelengine. Die v1-Auswahl ist eine gekapselte
**DECIDED WMEE**, keine Rechtsberatung.

Die Autorisierungsabbildung ist bewusst eng: Jede initiale Steuerwahl, jede
spätere Steueränderung und jede neue Basisvariante aus einer Resolution verlangt
`project.write + price.edit`; Create verlangt zusätzlich `phase.convert`.
`standard_19` und `zero_operator_confirmed` werden jeweils mit auswählendem
Actor und DB-Zeitpunkt in der neuen Revision protokolliert. Für
`zero_operator_confirmed` ist bei Create, jeder Steueränderung und jeder neuen
Basisvariante eine frische, an genau diesen Command gebundene Bestätigung
Pflicht; eine alte Bestätigung oder der Steuerstand einer anderen Variante wird
nicht übernommen. `createVariantFromCurrentResolution` besitzt deshalb einen
expliziten Steuerinput. Nur `duplicateOfferVariant` kopiert den bestehenden
vollständigen Snapshot unverändert und trifft keine neue Steuerentscheidung.

### Serverautoritativ

Der Browser darf bearbeitbare Werte und eine unverbindliche Live-Vorschau
anzeigen. Der Server lädt die vorherige Revision, wendet nur erlaubte Commands
an und berechnet jede Zahl neu. Vom Client gesendete Totals, Margen,
Katalogsnapshots, Quellen oder Hashes werden abgelehnt.

## Vorgesehenes Datenmodell

```text
project (request/open)
  └─ 1 offer (draft)
       ├─ 1 offer_number_series binding
       ├─ immutable b2c qualification + minimized contact/site snapshot
       ├─ n offer_variant
       │    └─ n offer_variant_revision (append-only)
       │         ├─ n offer_variant_section (revision mirror)
       │         └─ n offer_bom_line (revision mirror)
       └─ private source bindings, not copied calculator payloads
```

Die Umsetzung verwendet zwei additive Forward-only-Migrationen nach `0030`:
`0031_schema_metadata_baseline.sql` gleicht den zuvor fehlenden reproduzierbaren
Drizzle-Metadatenstand ab; `0032_m2_01_offer_schema.sql` führt den Offer-
Aggregatezustand ein. Ältere Migrationen bleiben unverändert.

Jede neue Tenant-Tabelle erhält `workspace_id NOT NULL`,
`UNIQUE(workspace_id,id)`, ausschließlich zusammengesetzte Tenant-FKs, RLS
`ENABLE` + `FORCE` und genau eine permissive `tenant_isolation`. Append-only-
Revisionen erhalten Update-/Delete-/Truncate-Schutz und schmale Runtime-ACLs.

Deferred Constraint-Trigger prüfen vor Commit den in v1 definierten,
kanonisierten Snapshot-Body samt Inhalts-Hash sowie seine relational
projizierten Sektions-/Zeilenmirrors auf Vollständigkeit, Reihenfolge und
Gleichheit. Der `offer_variant.current_revision`-Zeiger muss auf exakt die
höchste zugehörige vollständige Revision zeigen. Keine Transaktion darf einen
halben Mirrorstand committen. Zusätzlich binden die Trigger die von ihnen
projizierten Revisions-, Quell-, B2C- und Zeitfelder an ihre relationalen
Wahrheiten.

Diese DB-Grenze ist bewusst kein zweiter vollständiger JSON-Schema-Interpreter:
Die vollständige Command- und Snapshot-Semantik validiert der Offer-Service vor
jedem Write. Die Datenbank bindet den kanonischen Body, dessen Hash und die
relationalen Spiegel/Projektionen. Damit wird weder behauptet noch vorausgesetzt,
dass die DB allein jede denkbare, in sich konsistente semantische Manipulation
des JSON-Vertrags erkennt.

Der bestehende DSGVO-Erasuregraph wird ausdrücklich erweitert; ein Cascade mit
dem Project wird nicht behauptet, weil Project, Site und Contact derzeit
pseudonymisiert erhalten bleiben. Für M2-01 gilt:

- ausschließlich Draft-Offer-Aggregate des betroffenen Contacts werden durch
  die privilegierte Erasure-Routine unter derselben Graph-/Lock-/Tombstone-
  Semantik gelöscht;
- die verbrauchte Angebotsnummer bleibt verbraucht, die Nummernserie bleibt;
- normale Runtime-DELETEs bleiben verboten;
- Offer, Varianten und Revisionen werden in Graphbildung und deterministischer
  Lockreihenfolge vollständig aufgenommen. `latest_activity` vereinigt
  mindestens Offer-`created_at/updated_at` und Variant-/Revision-`created_at`;
  jede erfolgreiche Offer-Mutation aktualisiert zusätzlich Offer und Project
  mit demselben DB-Zeitpunkt. Ein alter Kontakt mit frischer Offer-Revision ist
  damit ausdrücklich `erasure_not_eligible`;
- der pseudonymisierte Project-Tombstone darf nach der Löschung `phase=offer`
  und seine Offer-Spalte behalten, erscheint aber ohne Offer nicht im aktiven
  Offer-Readmodell;
- alte Tombstones müssen nach Migration weiterhin idempotent replayen;
- ein zukünftiges `issued`-/`signed`-Artefakt braucht eine eigene Retention-
  und Pseudonymisierungsentscheidung und blockiert bis dahin Issuance.

## Board- und Phasenentscheidung

Die bestehende default Wohngebäude-Boardstruktur erhält additiv eine aktive
`offer`-Spalte, falls noch keine existiert; vorhandene Konfiguration wird nie
überschrieben oder dupliziert. Die Konvertierung verlangt genau eine aktive
Offer-Zielspalte und liefert bei null oder mehreren Kandidaten einen sichtbaren
Konfigurationsblocker. Die Anfrageansicht zeigt nur `lead`-Spalten, die
Angebotsansicht nur `offer`-Spalten. Bei Anlage werden Offer, Projektphase und
Zielspalte atomar geschrieben.

Die Migration backfillt nur nicht archivierte Default-Boards mit
`scope='residential'` und null aktiven Offer-Spalten. Custom-, Commercial- und
archivierte Boards bleiben bytegenau unverändert. Sie ersetzt die vorhandene
Workspace-Provisionierungsfunktion additiv, damit neue Workspaces auf ihrem
Default-Wohngebäude-Board ebenfalls eine Offer-Spalte erhalten. Der Request-Readservice
filtert explizit auf `column_type='lead'`; das neue Offer-Readmodell auf
`column_type='offer'`. Es gibt bewusst keinen Unique-Index auf den Typ – null
oder mehrere aktive Offer-Spalten bleiben ein getesteter Konfigurationsfehler.

```text
project request/open + lead column
  -- createOfferFromRequest -->
project offer/open + offer column + offer draft + variant revision 1
```

M2-01 implementiert keinen Rückwärtsübergang und keinen Won/Lost-Übergang.

## Aktionen und Modulgrenzen

Vorgesehene schmale Server-Actions:

- `createOfferFromRequest`;
- `duplicateOfferVariant`;
- `reviseOfferVariant`;
- `createVariantFromCurrentResolution`.

Alle Inputs sind strikt geschlossen. Sie enthalten keine clientgesendeten
Hashes: Neben IDs und erwarteten Revisionen sind nur die je Action ausdrücklich
erlaubten Forecast-, B2C-, Steuer-, Bestätigungs- oder Patchfelder zulässig.
Unbekannte und doppelte FormData-Felder sowie File-Werte werden abgelehnt;
ausschließlich bekannte `$ACTION_`-Frameworkfelder dürfen zusätzlich
vorkommen. Jede Action
reauthentifiziert, prüft Workspace, Capability, Objektbesitz und Revision und
ruft ausschließlich den öffentlichen Vertrag von `modules/offers` auf.

Der Edit-Contract sendet nur einen kompakten Patch bearbeitbarer Felder,
niemals den vollständigen Snapshot, Technik, Provenienz oder Totals. V1-Grenzen
sind höchstens 25 Sektionen, 500 Zeilen, 500 Patch-Operationen pro Save,
120 Zeichen für Namen und 1000 Zeichen für Beschreibungen. Das bestehende
Server-Action-Limit von 1 MB wird nicht erhöht.

Ein Offer besitzt höchstens zwölf Varianten. Revisionen werden nicht heimlich
gelöscht oder nach einer Lebenszeit gekappt; ihr Wachstum wird stattdessen an
der Mutationsgrenze begrenzt. Nach erfolgreicher Authentifizierung und
Membership-Prüfung gilt für alle vier Offer-Mutations-Actions ein DB-uhr-
gebundener 15-Minuten-Festzeitraum: höchstens 120 Versuche je Actor und
Workspace sowie 1200 autorisierte Versuche je Workspace. Eine separate,
fachinhaltsfreie Quoten-Transaktion reauthentifiziert und lädt Membership. Sie
nimmt Advisory Locks immer `Workspace → Actor`, liest danach exakt einmal
`clock_timestamp()` als `database_now` und reserviert zuerst den Actor-Zähler;
dieser zählt daher auch Denied. Nach der groben, Action-spezifischen
Capability-Prüfung reserviert sie den Workspace-Zähler. Ihr typisiertes
Admission-Ergebnis wird committet, bevor
Denied nach außen gemappt oder die getrennte Domain-Transaktion beginnt. Erst
die Domain-Transaktion parst den vollständigen Fachcommand erneut, prüft
Ressourcenbesitz und feingranulare Rechte und mutiert den Aggregatezustand.
Dadurch bleiben Zähler auch bei Validation, Resource-/Detail-Denied, Replay,
Conflict oder Domain-Rollback persistent; ein unberechtigter Actor kann die
Workspacequote nicht leeren. Unauthenticated und vom Framework vor der Action
abgewiesene Requests werden nicht gezählt. Eine erschöpfte Quote inkrementiert
nicht und liefert `unavailable` mit `retryAfter` als RFC-3339-UTC-String mit
`Z`, exakt `window_start + 15 Minuten`, ohne Domainwrite, Event oder Audit mit
Fachinhalt. Derselbe erst nach den Locks gelesene `database_now` wird für beide
Zählertimestamps, `retryAfter` und das global an UTC-Viertelstunden
ausgerichtete Fenster verwendet:
`date_bin('15 minutes', database_now, '1970-01-01 00:00:00+00')`;
es ist kein pro Schlüssel gleitendes Fenster. Das vorhandene Better-Auth-Limit
wird dafür nicht zweckentfremdet. Grenz-, Race-, Rollback- und
Fensterwechseltests bei `xx:14:59.999999`/`xx:15:00.000000` sowie „Transaktion
startet vor, erhält den Lock aber nach der Grenze“ pinnen Actor- und
Workspacezählung für Denied, Validation, Replay, Conflict sowie exakt
119/120/121 und 1199/1200/1201.

`modules/offers` erhält den zum Kopieren nötigen Katalogstand über einen
expliziten `import "server-only"`-Export aus `modules/catalog`. Dieser Export
autorisiert selbst Project, Workspace und Kopierzweck und gibt keinen
allgemeinen Full-Snapshot-Read frei. Direkte Imports von Katalog-Interna oder
DB-Tabellen sowie eine Serialisierung in App-/Client-Schichten bleiben
verboten.

Private Angebotsdaten bleiben zunächst ungecacht. Nach erfolgreicher Mutation
werden konkrete Pfade vor einem Redirect revalidiert:

- Create: `/w/{workspaceId}/anfragen`,
  `/w/{workspaceId}/anfragen/{projectId}` und
  `/w/{workspaceId}/angebote`;
- Duplicate/Revision/neue Basis: Offer-Detail und Offer-Liste.

Der Create-Redirect öffnet die initiale `?variante={variantId}`. `redirect()`
liegt nach Transaktion und Revalidation außerhalb von `try/catch`. Bei
Validation, Denied oder Conflict gibt es weder Revalidation noch Redirect.

## Rechte- und Sichtbarkeitsvertrag

| Aktion/Sicht | Erforderlich | Zusätzliche Grenze |
|---|---|---|
| Offer lesen | `project.read` | gleicher Workspace; External ohne Assignment abgewiesen |
| Offer aus Request erstellen | `project.write` + `phase.convert` + `price.edit` | B2C-/Steuerbestätigung und alle Golden-Path-Vorbedingungen |
| Variante duplizieren/Struktur ändern | `project.write` | `expectedRevision` |
| Verkaufspreis ändern | `project.write` + `price.edit` | serverseitige Neuberechnung |
| Steuer wählen/ändern oder neue Basis seeden | `project.write` + `price.edit` | explizite Behandlung; frische 0-%-Bestätigung |
| Rabatt/Custom Deal Value | `project.write` + `discount.apply` | gültige Stufe und Grenzen |
| EK/Marge lesen | `project.read` + `price.read_purchase` | private DTO-Form |
| EK einer freien Zeile ändern | `project.write` + `price.edit` + `price.read_purchase` | kein blindes Überschreiben |

Die bestehende Runtime-Wahrheit bleibt unverändert: Admin impliziert alle
Capabilities, Workspace-Feature-Flags schlagen aber weiterhin auch Admin.
Editor benötigt die jeweilige Capability; Viewer ist read-only. Eine andere
Admin-Semantik wäre ein eigener systemweiter Rechte-Slice. UI-Gates dienen nur
der Bedienung; die Serviceprüfung ist die Sicherheitsgrenze.

## Nebenläufigkeit und Idempotenz

- Konvertierung sperrt zuerst Project, danach die workspace-/jahresbezogene
  Nummernserie. Die aktuelle immutable Projektauflösung wird anschließend
  innerhalb derselben Transaktion verifiziert.
- `UNIQUE(workspace_id, project_id)` verhindert doppelte Offers.
- Der vollständige kanonische Create-Command einschließlich Project,
  Resolution-/Requirement-/Calculation-Bindung, Forecast, Anlagenart,
  operatorbestätigter B2C-Preiszielgruppe, Steuerwahl und Bestätigung erhält
  einen serverseitig reproduzierten Digest. Der Action-Input enthält keine
  Hashes: Neben IDs und erwarteten Revisionen sind ausschließlich Forecast,
  die exakt erlaubte B2C-Bestätigung, Steuerwahl und gegebenenfalls die
  0-%-Bestätigung zulässig. Bindungshashes lädt der Service intern.
  Nur ein semantisch gleicher Digest darf das bestehende Offer als Replay
  zurückgeben; jede abweichende seed-relevante Eingabe liefert `conflict`.
- Die globale Sperrreihenfolge jeder Offer-Mutation lautet
  `Project → Offer → Variant → Revision/Mirrors`; nicht benötigte Stufen werden
  ausgelassen, nie umgekehrt. Create sperrt `Project → OfferNumberSeries` und
  fügt danach den noch nicht existierenden Aggregatezustand ein. Die Erasure
  erhält die reale vorhandene Reihenfolge
  `Contact → ContactLegalHold → Project → Site → CalculationJob →`
  `CalculationRevision → SiteEnergyProfile → ProjectRequirement →`
  `CalculatorSnapshot → InboundReceipt` und hängt erst danach
  `Offer → Variant → Revision/Mirrors` an. Erstlauf und Tombstone-Replay nutzen
  dieselbe Ordnung. `expectedRevision` muss der aktuellen Revision entsprechen.
  Race-/Deadlock-Tests kreuzen Save, Duplicate, neue Basis und Erasure.
- Variant-Ordinal wird unter Offer-Lock vergeben; Duplikate sind dadurch
  race-safe.
- Kein Partial State: Phase, Spalte, Offer, Variante, Revision, Event und Audit
  committen gemeinsam oder gar nicht.

## Events und Audit

Vorgesehene Domain Events:

- `project.phase_changed`;
- `offer.created`;
- `offer.variant_created`;
- `offer.variant_duplicated`;
- `offer.variant_revised`.

Payloads enthalten nur workspacegebundene IDs, alte/neue Revision,
Änderungsklassen und Zustände. Keine Preise, freien Texte, Kundensnapshots,
Einkaufsquellen oder vollständigen Snapshot-Hashes. Der erlaubte Audit-Eintrag
wird in derselben TenantTx geschrieben; Denials erst nach Rollback an der
Boundary.

## Oberfläche und Zustände

### Informationsarchitektur

- `/w/[workspaceId]/angebote`: geschützte Offer-Liste/Boardansicht;
- `/w/[workspaceId]/angebote/[offerId]`: Editor beziehungsweise Read-only-View;
- die Projektakte enthält die readiness-gegatete Konvertierungsaktion;
- Brotkrumen führen zu Anfragen, Offer-Liste und Project, ohne den Nutzer in
  eine nicht mehr gültige Request-Route zu schicken.

Die aktive Variante liegt als validierter `?variante={variantId}`-Parameter in
der URL. Damit öffnet ein interner Link reproduzierbar denselben Stand und der
Variantenwechsel kann als normaler Link mit Server-Render funktionieren. Eine
ungültige oder fremde Variant-ID fällt auf die serverseitig bestimmte erste
Variante zurück, ohne Objektdetails preiszugeben.

Pages bleiben Server Components. Nur Variantenauswahl, Reorder, Form-State und
lokale Preisvorschau werden kleine Client Islands. Die Page verwendet
`PageProps<"/w/[workspaceId]/angebote/[offerId]">`, awaitet `params` und
`searchParams` und akzeptiert `variante` nur als genau einen UUID-String. Die
Server-Page liest den Parameter; `useSearchParams` ist dafür nicht nötig.
Server-only Services formen minimale serialisierbare DTOs.

Der Editor hält genau einen lokalen Draft der aktiven Variante. Es gibt einen
expliziten gebündelten Save-Command, höchstens eine Mutation in flight und
keine Fire-and-forget-Autosaves. Während `pending` ist das gesamte
Mutations-UI gesperrt. Success rebaset Draft und `expectedRevision` auf die
neue Serverrevision; Conflict revalidiert nicht und erhält die Eingaben. Ein
sichtbarer `dirty`-Status verhindert stillen Verlust: Variantenwechsel ist
erst nach Save oder bewusstem Discard möglich. Dieselbe Save-/Discard-/Bleiben-
Abfrage schützt Breadcrumbs, Zurücknavigation, Reload/Tab-Schließen,
Logout/Login-Redirect sowie Duplizieren und „neue Basis“, solange ein lokaler
Draft existiert. `beforeunload` ist nur das letzte Browser-Fallback; interne
Übergänge verwenden einen eigenen tastatur- und screenreaderbedienbaren Dialog.
Interne `<Link>`-Navigation wird vor Ausführung über `onNavigate` gegatet;
History/Back erhält einen eigenen Browservertrag. Der Logout-Guard läuft vor
dem bestehenden `signOut()` und vor jedem `window.location.replace`. Eine
während eines dirty Save eintretende `unauthenticated`-Antwort bleibt ein
typisierter State ohne Auto-Redirect und erhält den Draft, bis der Nutzer
bewusst zur Anmeldung wechselt.

Der Dirty-Dialog besitzt `role="dialog"`, `aria-modal="true"`, zugänglichen
Namen und Beschreibung, Fokusbindung und Fokus-Rückgabe zum auslösenden
Element. Anfangsfokus liegt auf der sicheren Aktion „Bleiben“; Escape bedeutet
ebenfalls Bleiben. „Speichern und fortfahren“ navigiert nur nach erfolgreichem
Save. Validation, Conflict, Unavailable oder Unauthenticated brechen die
Navigation ab, erhalten den Draft und fokussieren die zugehörige
Fehlerzusammenfassung; „Verwerfen“ braucht eine bewusste Aktivierung.

### Desktop

- dreigeteilte Arbeitsfläche aus kompakter Variantenleiste, zentraler
  BOM-Fläche und fester Preiszusammenfassung;
- Kopf mit Angebotsnummer, Draft-Badge, Kunde, Standort und Outdated-Status;
- gut sichtbare, per Tastatur erreichbare Variantenlinks;
- zentrale BOM-Sektionen und Zeilen;
- Preiszusammenfassung rechts mit netto, Steuer, brutto, optionalem Umfang und
  – nur berechtigt – EK/Marge;
- Aktionen nahe am bearbeiteten Objekt, nicht in einer überladenen globalen
  Toolbar.

### 375-px-Mobile

- Kopf bricht ohne horizontales Seiten-Scrolling um; die Variantenauswahl wird
  ein beschriftetes natives Select mit explizitem „Variante öffnen“-Button
  statt eines unerwarteten Kontextwechsels beim bloßen Auswählen;
- BOM-Zeilen werden zu beschrifteten Karten statt abgeschnittener Tabelle;
- Reorder besitzt sichtbare „hoch/runter“-Buttons; Drag ist nur Enhancement;
- Preiszusammenfassung als aufklappbarer Bereich und kompakte Sticky-Leiste,
  die keine Eingabe, Fehlermeldung oder Browser-Safe-Area verdeckt;
- alle primären Touchziele mindestens 44 × 44 CSS-Pixel.

### Pflichtzustände

- Loading: dimensionsstabile Skeletons für Kopf, Varianten, BOM und Summary.
- Empty: noch kein Offer sowie leere Sektion/freie Variante mit echter Aktion.
- Blocked: strukturierte fehlende Voraussetzungen mit Rücksprungziel.
- Denied: keine Existenz-, Preis- oder Tenant-Leaks.
- Not found: workspacegebundenes `notFound()`.
- Outdated: persistente Warnung; Snapshot bleibt unverändert.
- Conflict: aktuelle Revision anzeigen, Eingaben erhalten und bewusst neu
  laden/erneut anwenden lassen.
- Dirty: sichtbarer Ungespeichert-Hinweis; Save, bewusstes Discard oder Bleiben
  sind per Tastatur und Fokusmanagement erreichbar.
- Pending: genau eine Action läuft; alle Mutationscontrols sind gesperrt,
  Leseinhalt und Status bleiben verfügbar.
- Unavailable: die Offer-Mutationsquote ist erschöpft; `retryAfter` wird als
  RFC-3339-UTC-Zeitpunkt des DB-Fensterendes übertragen und als verständliche
  Wartezeit angezeigt, der lokale Draft bleibt erhalten und ein erneuter Save
  ist erst nach Ablauf wieder möglich. Keine automatische Retry-Schleife.
- Unauthenticated: erwarteter Action-State beziehungsweise Login-Redirect,
  ohne Fachdaten in der Rückgabe.
- Validation error: Feldbezug, Fehlerzusammenfassung, Fokus auf ersten Fehler.
- Unexpected error: segmentbezogenes `error.tsx` mit Next-16-`retry()`.
- Success: knappe `aria-live`-Rückmeldung und sichtbare neue Revision.
- Read-only: Werte bleiben vollständig lesbar, Schreibcontrols fehlen
  strukturell statt nur disabled zu sein.

Fokusindikatoren, Skip-Link zum Hauptinhalt, logische Tab-Reihenfolge,
semantische Tabellen-/Listenrollen, Fehlerverknüpfung, Reduced Motion,
200-%-Textzoom sowie 320-CSS-px-/400-%-Reflow und Kontrast nach WCAG 2.2 AA
sind Abnahmebestandteil. Verbindliche Layoutbreiten sind zusätzlich
375, 390, 768, 1024, 1440 und 1920 CSS-Pixel. Nach Reorder bleibt Fokus auf
derselben Zeile und ein
`role=status` nennt die neue Position. Die fokussierbare
Fehlerzusammenfassung beziehungsweise das erste ungültige Feld erhält nach
Fehler den Fokus. Desktop- und Mobile-Form dürfen nie zugleich interaktiv im
Accessibility Tree liegen.

Die visuelle Sprache ist eine **eigene freigegebene** WMEE-Grünrichtung aus
dem lokalen Claude-Design-Zweitblick; die Vault enthält keine authentischen
Farb-, Typografie- oder Tokenwerte. Es werden kein Reonic-Layout, keine Texte
und keine Assets übernommen.

Der erste Token-Einsatz bleibt auf die neuen Offer-Routen begrenzt. Verifizierte
M1-Oberflächen werden in diesem Slice nicht global rethemed. Ein dunklerer
`brand-ink`-Token wird für Text auf hellen Grünflächen getrennt vom primären
Action-Grün geführt und mit Axe plus Kontrastmessung geprüft; Farbe allein
trägt keinen Status.

Die folgende eigene WMEE-Tokenmenge ist für
`[data-wmee-scope="offer"]` verbindlich. Sie ist der konkrete Output des
lokalen Claude-Code-Design-Zweitblicks (`opus`, maximales verfügbares Effort)
und keine Reonic-Quelle:

| Gruppe | Scoped Token | Wert / Vertrag |
|---|---|---|
| Brand | `--offer-brand-600` / `--offer-brand-hover` / `--offer-brand-ink` | `#0F7550` / `#0B5E40` / `#0A4A33`; Weiß auf Brand beziehungsweise Ink auf hellen Grünflächen |
| Foreground | `--offer-fg` / `--offer-fg-muted` / `--offer-fg-subtle` / `--offer-fg-inverse` | `#0B1B15` / `#47564F` / `#5E6E66` / `#FFFFFF` |
| Background | `--offer-canvas` / `--offer-surface-1..4` | `#F4F7F5` / `#FFFFFF` / `#F7FAF8` / `#EEF3F0` / `#FFFFFF` mit `--offer-shadow-3` |
| Controls | `--offer-border` / `--offer-border-strong` / `--offer-accent` | `#D3DDD8` dekorativ / `#6E7F77` für Controls / `#0E6E7A` |
| Interaction | `--offer-hover` / `--offer-focus` / `--offer-selected` | `#E6F3EC` / `#0B3B29` als 2-px-Ring plus kontrastierender Surface-Offset / `#DCEFE5` |
| Success | `--offer-success` / `--offer-success-bg` | `#0B5A32` / `#E8F5EC` |
| Warning | `--offer-warning` / `--offer-warning-bg` | `#6B4708` / `#FFF4D6` |
| Error | `--offer-error` / `--offer-error-bg` | `#8C1D1D` / `#FDECEC` |
| Info | `--offer-info` / `--offer-info-bg` | `#123F73` / `#EAF2FB` |
| Overlay | `--offer-overlay` | `rgba(5, 20, 14, 0.62)`; Dialogfläche bleibt `surface-1` |
| Chart | `--offer-chart-1..6` | `#0F7550`, `#0E6E7A`, `#5B3F91`, `#85400D`, `#862653`, `#425466`; zusätzlich Form/Muster, nie nur Farbe |
| Typografie | `--offer-font-sans`; `--offer-text-0..6`; `--offer-leading-*` | `var(--font-geist-sans), Inter, system-ui, sans-serif`; `0.75/0.875/1/1.125/1.375/1.75/2.25rem`; Fließtext mindestens `1rem/1.5`, Gewichte `400/500/600/700` |
| Spacing | `--offer-space-0..10` | 4-px-Raster: `0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4rem`; Touchhöhe mindestens `2.75rem` |
| Radius | `--offer-radius-1..pill` | `2px`, `6px`, `10px`, `14px`, `999px` |
| Shadow | `--offer-shadow-1..4` | `0 1px 2px rgb(11 27 21 / .08)`; `0 4px 12px rgb(11 27 21 / .10)`; `0 12px 30px rgb(11 27 21 / .14)`; `0 24px 60px rgb(5 20 14 / .22)` |
| Z-Index | `--offer-z-base/rail/sticky/popover/dialog/toast/critical` | `0/10/20/30/40/50/60`; keine ungeplanten Zwischenwerte |
| Motion | `--offer-duration-1..4` / `--offer-ease` | `80/140/220/320ms`; `cubic-bezier(.2,.8,.2,1)`; bei Reduced Motion `0.01ms` und keine räumliche Animation |
| Breakpoints | `--offer-bp-stress/mobile/mobile-wide/tablet/workspace/wide/xwide` | `320/375/390/768/1024/1440/1920px`; Testvertrag, keine stillschweigende Umdefinition globaler Tailwind-Breakpoints |

Statusflächen verwenden stets Icon, Überschrift und Text zusätzlich zur Farbe.
Während `pending` werden nur Mutationscontrols deaktiviert; gespeicherter
Leseinhalt erhält keine pauschale Opazitätsreduktion. Sticky-Flächen besitzen
eine Viewport-bezogene Maximalhöhe, eigenen Scrollbereich und respektieren
`env(safe-area-inset-bottom)`.

### Visuelles Baseline-Gate

Vor dem CSS-Freeze dokumentiert der Slice seine vollständigen, scoped Tokens
für Brand, Foreground, Background, Surface 1–4, Border, Accent, Hover, Focus,
Selected, Success, Warning, Error, Info, Overlay, Chartpalette, Typografie,
Spacing, Radius, Shadow, Z-Index, Motion und Breakpoints. Werte stammen aus der
eigenen WMEE-Richtung und werden nicht aus Reonic übernommen.

Der gepinnte Chromium-Lauf erzeugt Screenshot-Kandidaten bei 375, 390, 768,
1024, 1440 und 1920 CSS-Pixeln; 320 Pixel bleibt ein zusätzlicher
Reflow-Stresstest. Ausschließlich synthetische stabile Fixtures werden
verwendet. Angebotsnummern, Personen-, Kontakt-/Adressdaten, Zeitpunkte, IDs
und andere dynamische Felder werden mit layoutstabilen Masken normalisiert;
Animationen und Caret sind deaktiviert, Fonts und Browserrevision gepinnt.

Die Capture-Matrix ist geschlossen. Alle Screenshots laufen mit
`deviceScaleFactor: 1`, hellem Farbschema, `reducedMotion: reduce` und
`fullPage: true`; die Viewports lauten exakt `375×812`, `390×844`, `768×1024`,
`1024×900`, `1440×1000` und `1920×1080`. Ein Editor erfasst bei jeder dieser
sechs Größen (a) Offer-Liste/Board, (b) readiness-grüne Projektakte mit CTA und
(c) befüllten Offer-Editor. Zusätzlich entstehen bei `390×844` und
`1440×1000` je ein Editor-Capture für Dirty-Dialog, Conflict und Unavailable
sowie ein Viewer-Capture für Read-only. Die stabilen Namen kodieren Route,
Rolle, Zustand und Viewport; ein fehlender Matrixeintrag lässt den Test
scheitern statt still weniger Baselines zu akzeptieren.

Mikail muss die erste visuelle Baseline ausdrücklich freigeben. Bis dahin ist
`M201-VISUAL-01` **INCONCLUSIVE**, niemals PASS. Nach Freigabe laufen
Visual-Regression-Tests gegen die versionierten Screenshots mit
`threshold: 0.2` und `maxDiffPixelRatio: 0.001`; Baselines werden in normalen
Testläufen nie automatisch aktualisiert. Jede beabsichtigte Änderung erzeugt
neue Review-Kandidaten und benötigt erneute visuelle Freigabe.

## Vertrags- und Test-IDs

| ID | Nachweis |
|---|---|
| `M201-CONTRACT-01` | geschlossene Command-/Snapshot-Schemas, exakte Contact-/Site-Allowlist, Canonicalizer und Golden Hash |
| `M201-MONEY-01` | Reihenfolge, Rundung, Allocation, optionale Zeilen und Total-Cap |
| `M201-MONEY-02` | Property-/Overflow-/Mixed-Tax-Tests ohne Float-Arithmetik |
| `M201-DB-01` | Fresh-/Upgrade-Migration, RLS, Composite-FKs, ACL, DB-append-only und Mirror-Vollständigkeit |
| `M201-DB-02` | Nummern-, Convert-, Duplicate-, Save- und Quota-Races samt Rollback |
| `M201-SVC-01` | Vorbedingungen, Replay/Conflict, Phase/Board/Event/Audit atomar |
| `M201-ACTION-01` | FormData-Allowlist, Files/Duplikate, Auth/Error-Mapping, Pfade, Revalidation vor Redirect |
| `M201-RBAC-01` | Viewer/Editor/Preis-/Steuerrechte/External/Fremdtenant und EK-/Hashredaktion |
| `M201-PRIVACY-01` | Draft-Erasure, alte Tombstone-Replays, PII-Freiheit und gesperrter Runtime-Delete |
| `M201-E2E-01` | Request → Offer → Duplicate → BOM edit → Reload |
| `M201-E2E-02` | Katalogdrift → Outdated → neue Basisvariante, alter Snapshot unverändert |
| `M201-A11Y-01` | Keyboard-Reorder, Fokus, Axe, 320/375/390/768/1024/1440/1920, 200 %/400 %, Reduced Motion |
| `M201-VISUAL-01` | freigegebene maskierte Screenshot-Baselines und Visual Regression bei 375/390/768/1024/1440/1920; ohne Freigabe INCONCLUSIVE |

## Abnahmekriterien für M2-01

1. Der Golden Path ist mit synthetischen deutschen Testdaten im Browser real.
2. Ein Doppelklick erzeugt höchstens ein Offer und eine Angebotsnummer.
3. Jede relevante Variantenänderung erzeugt exakt eine neue Revision.
4. Duplizieren kopiert BOM, Reihenfolge, Preise und Rabatte; spätere Änderungen
   wirken nur auf das Duplikat.
5. Revision 1 heißt `Basis`, enthält alle 1–500 Resolution-Zeilen ohne Kürzung
   als `required` und entsteht nur mit expliziter gültiger B2C- und Steuerwahl;
   250/251/500 sowie 501 werden an der jeweiligen Grenze getestet.
6. Der gespeicherte Serverbetrag ist unabhängig von Client-Totals und stimmt
   bei halben Cent, gemischter Steuer, Optional, Hidden und Custom Target 0 mit
   Golden-/Property-Tests überein.
7. Preisoverride und freie Zeile zeigen ihre tatsächliche Offer-Provenienz,
   während der ursprüngliche Katalogstand unverändert erhalten bleibt.
8. Katalog- und Projektauflösungsdrift verändert keine bestehende BOM-Zeile.
9. Missing/extra/reordered/tampered Mirrorrows und ein falscher
   `current_revision`-Pointer können nicht committen.
10. Viewer- und External-Payloads enthalten weder EK/Marge noch private Hashes;
    Admin impliziert wie im bestehenden Runtimevertrag Capabilities, ein
    deaktiviertes Feature bleibt trotzdem bindend.
11. Cross-Tenant-Reads/-Writes scheitern in Service und direktem SQL.
12. Direkte Action-Tests beweisen Feld-/File-Grenzen, minimale Returns, exakte
    Revalidation und Redirect-Reihenfolge.
13. Draft-Erasure entfernt alle kopierten Offer-PII, verbietet Runtime-DELETE,
    lässt alte Tombstones idempotent replayen und weist einen alten Kontakt mit
    frischer Offer-Revision als `erasure_not_eligible` ab.
14. `db:generate` ist nach Metadatenabgleich clean; Migration läuft fresh und
    als Upgrade ab `0030`; ältere Migrationen bleiben byteidentisch.
15. Build, Check, vollständige Tests, Rollenproben und Browser-E2E sind grün.
16. Unabhängige Code-, Security-, Tenant-, Money- und Accessibility-Reviews
    haben keine offenen P0–P2-Befunde.
17. Zwölf Varianten sind zulässig, die dreizehnte wird atomar abgewiesen;
    Actor-/Workspace-Quoten sind an beiden Grenzwerten race-sicher.
18. Custom-, Commercial- und archivierte Boards bleiben beim Backfill
    unverändert.
19. Vollständige Offer-Tokens sind dokumentiert; maskierte Screenshot-
    Kandidaten liegen für 375/390/768/1024/1440/1920 vor. Ohne Mikails
    Baseline-Freigabe bleibt Visual **INCONCLUSIVE** und Gate 2 offen.
20. Spec, ADR, Paritätsregister und Vault-Abnahme sind aktualisiert.

## Offene Fragen und spätere Gates

- Reale WMEE-SKUs, EK/VK, Leistungspreise und Paketdefinitionen fehlen.
- Strukturierte Klima-Produkte und Klima-BOM fehlen und werden nicht über
  `other` simuliert.
- M2-01 ist ausschließlich operatorqualifiziertes B2C. B2B-/unklare
  Preiszielgruppen und getrennte Preislisten fehlen; der einzelne Katalog-VK
  benötigt als B2C-Listenpreis Gate-1-/Owner-Zustimmung.
- Der technische Steuerzugriff ist auf `price.edit` festgelegt; die
  steuerfachliche Zulässigkeit der Fälle braucht Steuerberater-/Owner-Freigabe
  vor Pilot beziehungsweise Issuance.
- Gewerbe-Board und Direct-Offer sind noch nicht qualifiziert.
- Nummernformat-Konfiguration ist funktional vorgesehen, aber nicht als
  aktuelle Reonic-Semantik beobachtet.
- PDF benötigt eigenen Worker-/Chromium-/Storage-/SSRF-Slice.
- Signatur benötigt unveränderliches Artefakt, Token-/Attestierungsvertrag,
  Object Lock und rechtliche Freigabe.
- DSGVO-Retention für issued/signed und späteren Nachtrag bleibt vor Pilot zu
  entscheiden.

Keine dieser Fragen wird durch Fake-Daten oder eine versteckte Defaultannahme
„gelöst“.

## Gate 1

Am 30. August 2026 freigegeben. Die Implementierung begann vertrags- und
RED-Test-getrieben. Gate 2 verlangt reale Gesamt-, Browser- und
Accessibility-Evidenz. Die visuelle Regression bleibt unabhängig davon
`INCONCLUSIVE`, bis Mikail die maskierte Screenshot-Baseline ausdrücklich
gesehen und freigegeben hat.
