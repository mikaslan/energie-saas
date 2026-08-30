# ADR 0009: Angebotsvarianten und revisionsgebundene Snapshot-BOM

- Status: akzeptiert (Gate 1 am 2026-08-30; technisches Gate 2 GO am 2026-08-30)
- Datum: 2026-08-29
- Bezug: `docs/spec/M2-01-angebotsvarianten-snapshot-bom.md`

## Kontext

M1-08 liefert eine aktuelle Projektauflösung mit exakten eigenen
Katalogrevisionen und kopierten EK/VK-Preisen. Sie besitzt aber bewusst keine
Angebotssektionen, Positionstypen, Rabatte, Steuerbehandlung, Varianten oder
Kundenpreissumme. Ein Offer darf diese Auflösung daher weder als veränderliche
Live-BOM verwenden noch den unverifizierten Rechner-`market_estimate`
übernehmen.

Öffentliche Quellen belegen Angebote mit unabhängigen Varianten, einer
Stückliste und mehrstufigen Rabatten. Exakte private Implementierungsdetails,
insbesondere Rundung, Nummernformat und Steuerlogik, sind nicht rechtmäßig
beobachtet. Die eigene Lösung muss diese Unknowns gekapselt entscheiden, ohne
sie als exakte Reonic-Semantik auszugeben.

Spätere PDF-, Signatur-, Rechnungs- und Nachtragsketten benötigen schon heute
stabile Identitäten und reproduzierbare kommerzielle Stände. Gleichzeitig ist
ein Draft noch kein WORM-Beleg und muss in den bestehenden Erasurepfad passen.

## Entscheidung

Ein Project erhält im v1 höchstens ein Offer. Offer-Anlage und der Übergang
`request/open → offer/open` erfolgen atomar. Die Anlagenart wird aus dem
belastbaren Board-Scope kopiert und danach nicht geändert. M2-01 realisiert
nur den bestehenden PV-Wohngebäude-Rechnerpfad und verlangt zusätzlich eine
strukturierte, mit Actor und DB-Zeit gespeicherte Bestätigung
`priceAudience=b2c`; weder Wohngebäude noch Website werden als B2C inferiert.
Der einzelne Katalog-VK gilt nach Gate 1 nur hierfür als B2C-Listenpreis.
Strukturierte Klima-Produkte, B2B und unklare Preiszielgruppen folgen nach
eigenen Qualifikations- und Katalogverträgen.

Der Board-Backfill betrifft ausschließlich nicht archivierte Default-Boards mit
`scope='residential'` und ohne aktive Offer-Spalte. Custom-, Commercial- und
archivierte Boards werden nicht verändert; null oder mehrere Offer-Spalten im
Zielboard bleiben sichtbare Konfigurationsblocker.

Eine workspace-/jahresbezogene Nummernserie vergibt unter Row Lock eine
dauerhafte Angebotsnummer. Der eigene Default `ANG-{YYYY}-{sequence:6}` ist
versioniert und darf später über eine Einstellungen-Capability konfiguriert
werden. Das Jahr stammt aus der DB-Transaktionszeit in `Europe/Berlin`. Es
gibt keine `max + 1`-Vergabe und keine Wiederverwendung.

Offer und Variant werden getrennt:

- `offer` hält Projektbindung, Nummer, Draft-Status, Anlagenart,
  Forecast-Wert, die strukturierte unveränderliche B2C-Bestätigung und einen datensparsamen Kunden-/
  Anlagenstandortkontext;
- `offer_variant` hält stabile Variantenidentität und Ordinalzahl;
- `offer_variant_revision` hält jeden vollständigen kommerziellen Stand
  append-only;
- Sektions- und Zeilenrows spiegeln jede Revision relational, während der
  versiegelte vollständige Snapshot die Preiswahrheit bleibt.

Deferred Constraint-Trigger erzwingen vollständige, geordnete und hashgleiche
Sektions-/Zeilenmirrors, einen gültigen `current_revision`-Zeiger sowie die
relationale Bindung von Quellkette, B2C-Entscheidung und Erstellungsprovenienz.
Es gibt keine nur konzeptionelle Übereinstimmung zwischen JSON und Rows.

Der kopierte Kontext ist geschlossen: Contact liefert nur Displayname,
primäre E-Mail oder null und E.164-Telefon oder null; Site liefert nur
Adressrevision, formatierte Anlagenadresse, Straße, Hausnummer, PLZ, Ort und
Land. Alle Texte werden NFC-normalisiert und getrimmt. Rohtelefon,
Marketing-Consent, Geokoordinaten/-provider, Fingerprints, Akquisitionsdaten,
Kontakt-/Rechnungsadresse und Rechnerpayload werden nicht kopiert. Die
Rechner→Requirement→Calculation→Resolution-Kette bleibt eine private
ID-/Revisions-/Hashbindung; Actions liefern keine Hashes an.

Katalogbasierte Zeilen kopieren Produktdarstellung, Technik, Assets, EK/VK und
Provenienz aus genau einer aktuellen Projektauflösung. Freie Zeilen sind
ausdrücklich als `custom` gekennzeichnet. Spätere Katalogstände erzeugen nur
einen abgeleiteten Outdated-Zustand. Ein bewusster Aktualisierungspfad erzeugt
eine neue Variante aus der aktuellen Auflösung und erhält den alten Stand.

Die initiale Variante heißt `Basis`. Ihre BOM folgt einer festen Seed-Regel:
nichtleere Komponentenkategorien werden in kanonischer Reihenfolge zu
Sektionen, alle 1–500 Resolution-Zeilen starten vollständig als `required`,
sichtbar und rabattfrei, Mengen
werden auf Tausendstel skaliert. Die im Create-Command ausdrücklich gewählte
Steuerbehandlung wird auf jede Seed-Zeile kopiert; 0 % verlangt die
strukturierte Bestätigung.

Ein manueller Preisoverride ersetzt niemals seine Herkunft. Originaler
Katalogpreis und -quelle bleiben erhalten; der effektive Wert trägt
`manual_override`, Grundcode, Actor und DB-Zeit. Freie Zeilen tragen `custom`
ohne erfundene Katalogquelle.

Der Geldvertrag verwendet nichtnegative Centwerte bis
`9_000_000_000_000_000`, positive `quantity_milli` bis `100_000_000`,
Basispunkte, BigInt-Zwischenwerte und half-up-Rundung. Die feste Reihenfolge lautet Zeile,
Sektion, Variante, Custom Deal Value und danach Steuer. Stufenbedingte
Differenzen werden deterministisch per Largest Remainder verteilt. Required
und Additional zählen zum Basispreis; Optional wird mit eigenen Netto-/Steuer-/
Bruttototals separat berechnet; Hidden
ist ein unabhängiges Boolean und ändert die Mathematik nicht. Die Spec pinnt
Rundungszeitpunkte, proportionale Zeilenallokation einschließlich Custom Deal
Value, Restcent-Tie-Breaker und Steuer je finaler Zeile.

Die v1-Steuerwahl ist ausdrücklich `standard_19` oder
`zero_operator_confirmed`; nichts wird still vorbelegt. Es gibt keine automatische
steuerrechtliche Ableitung. Weitere
Steuersachverhalte bleiben der fachlich geprüften Rechnungsregelengine
vorbehalten. Create, Steueränderung und neue Basis protokollieren Auswahl,
Actor und DB-Zeit; 0 % verlangt jeweils eine frische commandgebundene
Bestätigung und wird nie geerbt. Nur das Duplizieren kopiert die bestehende
Steuerprovenienz unverändert.

Rechte werden auf die vorhandenen Fähigkeiten abgebildet:

- `project.read` für Readmodelle;
- `project.write + phase.convert + price.edit` für Anlage;
- `project.write` für Struktur und Varianten;
- `price.edit` für Verkaufspreise, jede Steuerwahl/-änderung und jede neue
  Basis aus aktueller Resolution;
- `discount.apply` für Rabatte/Festpreis;
- `price.read_purchase` für EK, Einkaufsprovenienz, Marge und private Hashes.

Die bestehende Rechtewahrheit bleibt erhalten: Admin impliziert Capabilities,
Workspace-Feature-Flags bleiben jedoch auch für Admin bindend. Eine Änderung
dieser Semantik wäre ein eigener systemweiter Slice.

External bleibt ohne Assignment-Modell fail-closed. Server-Actions sind nur
untrusted Adapter; `modules/offers` reautorisiert und besitzt die
Transaktionslogik. Ein schmaler server-only Katalogexport stellt den
Projektauflösungssnapshot bereit, ohne Modulgrenzen zu durchbrechen.

Der Create-Command wird vollständig kanonisiert und gehasht. Nur derselbe
Digest ist ein Replay; abweichende Resolution, Forecast-, Scope- oder
Preiszielgruppen-/Steuerdaten sind ein Conflict. Actions senden neben IDs und
erwarteten Revisionen ausschließlich erlaubte Forecast-, B2C- und
Steuer-/Bestätigungsfelder, aber niemals Hashes; der Service lädt private
Hashbindungen selbst.
Variantenänderungen werden als ein expliziter
gebündelter Save gegen `expectedRevision` geschrieben, nicht als parallele
Autosaves.

Ein Offer ist auf zwölf Varianten und jede Revision auf 500 Zeilen begrenzt.
Ein neues fachinhaltsfreies 15-Minuten-DB-Fenster zählt alle authentifizierten
Offer-Mutationsversuche bis 120 je Actor/Workspace und 1200 je Workspace;
Better-Auth-Speicher wird nicht wiederverwendet. Eine separate
Quoten-Transaktion committet das fachinhaltsfreie Admission-Ergebnis vor der
Domain-Transaktion, sodass erwartete Denials, Validation, Replay, Conflict und
Domain-Rollback die Zähler nicht zurückrollen. `retryAfter` ist der UTC-
Zeitpunkt des festen Fensterendes. Die Quoten-Transaktion nimmt Locks in der
Reihenfolge Workspace→Actor und liest erst danach einmal `clock_timestamp()`;
dieses `database_now` bindet Zähler, `retryAfter` und
`date_bin('15 minutes', database_now, UTC-Epoch)` an dieselbe globale
UTC-Viertelstunde. Revisionen werden niemals still gelöscht.

Die Sperrreihenfolge ist global: Offer-Mutationen nehmen
`Project → Offer → Variant → Revision/Mirrors`; Create nimmt
`Project → OfferNumberSeries`. Erasure erhält ihre reale M1-Reihenfolge
`Contact → ContactLegalHold → Project → Site → CalculationJob →`
`CalculationRevision → SiteEnergyProfile → ProjectRequirement →`
`CalculatorSnapshot → InboundReceipt` und hängt danach die Offer-Unterfolge
an. Kein Erstlauf oder Replay nimmt diese Locks rückwärts.

## Konsequenzen

- Ein späterer Katalogpreis kann keinen bestehenden Kundenentwurf verändern.
- Varianten sind unabhängig reproduzierbar und für spätere PDF-/Signaturhashes
  vorbereitet.
- Jede Revision kostet zusätzliche Rows und Snapshot-Speicher; die fachliche
  Nachvollziehbarkeit wird bewusst höher gewichtet als In-place-Updates.
- Geldwerte sind über UI, DB und PDF reproduzierbar, auch bei gemischter Steuer
  und Centdifferenzen.
- Die v1-Steuergrenze ist absichtlich enger als eine vollständige deutsche
  Rechnungslogik.
- Der privilegierte DSGVO-Erasuregraph löscht den Draft-Aggregat und kopierte
  PII, während Project/Site/Contact wie bisher pseudonymisierte Tombstones
  bleiben und die Angebotsnummer verbraucht bleibt. Offer-/Variant-/Revision-
  Zeitpunkte gehören ausdrücklich zu `latest_activity`; jede Offer-Mutation
  aktualisiert zusätzlich Offer/Project mit DB-Zeit. Issued/signed benötigt
  später ein getrenntes Artefakt- und Retention-Modell.
- F2.1 bis F2.4 werden nur teilweise erfüllt; PDF, Signatur, Financing und
  Direct-Offer werden nicht als vorhanden dargestellt.

## Sicherheitsfolgen

- Browserwerte sind niemals kommerzielle Wahrheit.
- Snapshot- und Hashvalidierung erfolgen bei jedem Read und jeder Mutation.
- EK-enthaltende Vollhashes werden ebenso wie EK und Provenienz serverseitig
  aus unberechtigten DTOs entfernt.
- Events und Audits enthalten keine Geldbeträge, freien Kundentexte oder
  Einkaufsquellen.
- Alle neuen Relationen folgen den bestehenden Tenant-, Composite-FK-, RLS-,
  ACL- und append-only-Invarianten.
- PDF-Rendering wird nicht über eine beliebige URL vorbereitet; der spätere
  Worker muss eine beanspruchte Revision mit deaktiviertem externem Netzwerk
  rendern.

## Verworfen

### Projektauflösung direkt als BOM verwenden

Verworfen. Sie besitzt nicht die kommerzielle Semantik einer Angebotsposition
und darf im bestehenden Erasuregraph verschwinden.

### Nur die aktuelle Katalogrevision referenzieren

Verworfen. Preise, Texte und Technik würden still driften und spätere
Signatur-/Rechnungssnapshots wären nicht reproduzierbar.

### Draft-BOM in-place aktualisieren

Verworfen. Es zerstört Nebenläufigkeits-, Audit- und späteren Fork-Nachweis.

### Clientseitige Preisberechnung speichern

Verworfen. FormData und Clientzustand sind untrusted und können Rechte,
Rundung oder Preisquellen umgehen.

### Floats für Menge, Rabatt oder Steuer

Verworfen. Binäre Rundungsfehler sind für Geld- und Dokumentgrenzen nicht
akzeptabel.

### Automatische 0-%-Steuer aus Adresse oder Produkttyp

Verworfen. Die erforderliche rechtliche Evidenz ist im aktuellen Datenmodell
nicht vorhanden.

### PDF und Signatur im selben Slice

Verworfen. Worker-Chromium, Object Lock, Attestierung, Rechtsdaten und
Retention sind eigenständige, noch nicht verifizierte Grenzen.

## Freigabe

Mikail hat Gate 1 am 30. August 2026 freigegeben; die ADR ist angenommen. Der
finale technische Gate-2-Nachweis ist ebenfalls grün: 87/87 Testdateien mit
856 bestandenen und einem ausdrücklich opt-in übersprungenen Test, 88/88
Rollen- plus 5/5 PostgreSQL-18-Proben und 16/16 Chromium-E2E (15 funktional/A11y
plus 1 Visual-Capture mit 26/26 Kandidaten), grüne Build-,
Lint-, TypeScript-, Dependency-Cruiser-, Diff- und `db:generate`-Prüfungen
sowie keine offenen Produkt-P0–P2.

Die formale visuelle Abnahme `M201-VISUAL-01` ist kein stiller Bestandteil
dieser technischen Freigabe. Sie bleibt bis zu Mikails ausdrücklicher
Screenshot-Baseline-Freigabe `INCONCLUSIVE`.
