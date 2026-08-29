# ADR 0008: Katalogrevisionen und projektbezogene Produktauflösungen

- Status: angenommen
- Datum: 2026-08-29
- Bezug: `docs/spec/M1-08-produktkatalog-projektaufloesung.md`

## Kontext

Der Rechner liefert Produktwünsche und unverifizierte Marktwerte, aber keine
vertrauenswürdigen SKU, Preise oder Herstellerdaten. M1-07 erzeugt eine
reproduzierbare Planungsschätzung mit generischen Annahmen. Angebote benötigen
dagegen eigene Workspace-Produkte und eine kommerzielle Kopiergrenze, an der
spätere Änderungen historische Kundenstände nicht verändern.

Der volle Modulkatalog nennt einen großen Komponentenbestand. Die M1-Roadmap
entscheidet bewusst anders: leerer Workspace-Katalog, manuelle Pflege des
Pilotsortiments und CSV als späterer Massenweg. Reonic-Daten dürfen aus Clean-
Room- und Datenbankrechtgründen nicht übernommen werden.

## Entscheidung

Produktidentität und Produktinhalt werden getrennt. `catalog_component` hält
Workspace, stabile interne SKU, unveränderlichen Typ und Lebenszyklus.
`catalog_component_revision` hält jeden inhaltlichen Stand append-only mit
kanonischem SHA-256. Die höchste Revision ist der aktuelle Stand; es gibt
keinen zweiten veränderlichen Produktpayload.

Drafts dürfen noch ohne Preis sein. Aktivierung verlangt eine vollständige
Revision mit Netto-EUR-EK/VK sowie technischer und kommerzieller
Quellen-/Rechteprovenienz. Preisänderungen sind normale neue Revisionen.
Umsatzsteuer wird nicht im Katalog festgeschrieben, weil sie erst aus Kunde,
Projekt und Leistungszusammenhang folgt.

Der Komponententyp ist nach Anlage unveränderlich. Technische Daten verwenden
strikte, versionierte Typverträge. Häufig gefilterte Nennleistung und nutzbare
Speicherkapazität werden zusätzlich relational projiziert; der kanonische
Payload bleibt die Revision.

Eine bestätigte Produktauswahl wird als immutable
`project_catalog_resolution` gespeichert. Sie bindet Requirement und aktuelle
Calculation, kopiert Produktinhalt und Preise und bewahrt den Herkunftslink zur
exakten Katalogrevision. Sie ist eine Angebotsvorbereitung, keine BOM.

Eine neue referenzierte Produktrevision, Archivierung oder neue Calculation
setzt den operativen Project-Status auf `pending`, verändert aber keinen
Snapshot. Ein erneutes Bestätigen erzeugt eine neue Projektauflösungsrevision.
Der Lesepfad prüft Vertrag, Hash und aktuelle Bindungen erneut und leitet
`current` oder einen strukturierten Stale-Grund ab.

Die M1-07-Planung bleibt generisch. Produktwahl und Preis-Snapshot erhöhen
weder den fachlichen Qualitätsstatus der Simulation noch behaupten sie
Kompatibilität. Abweichende Modul-/Speicherkapazitäten sowie nicht modellierte
Backup-/Bidirektional-Grenzen brauchen sichtbare, strukturierte Bestätigung.
Die Grenze konvertiert die auf sechs Nachkommastellen kanonisierten kWp/kWh
deterministisch auf das nächste volle W/Wh; dadurch wird reguläre
Planungspräzision nicht fälschlich als Integritätsfehler abgewiesen.

EK, Beschaffungsquelle und Marge werden bereits im serverseitigen Readmodell
weggelassen, wenn `price.read_purchase` fehlt. Events und Audits enthalten
keine Beträge oder freien Quellenangaben. Dieselbe Readmodellgrenze lässt dann
auch die Hashes der vollständigen Komponenten- und Auflösungssnapshots weg:
Diese Hashes binden intern auch EK-Provenienz und wären sonst ein
Offline-Prüforakel. Rollen mit `price.read_purchase` erhalten die vollständigen
Hashbindungen weiterhin.

Projektauflösungen hängen mit `ON DELETE CASCADE` an Project, Requirement und
Calculation. Das ist für den bestehenden Erasurepfad wesentlich: Er
pseudonymisiert das Project, löscht aber Requirement und Calculation. Runtime
besitzt trotzdem kein direktes DELETE- oder UPDATE-Recht. Workspaceweite
Katalogprodukte sind keine Kontaktdaten und bleiben bei einer Lead-Löschung
erhalten.

Eine schmale immutable `project_catalog_resolution_line` spiegelt nur
Component-ID, exakte Revision, Hash, Position und Menge aus dem vollständigen
Resolution-Snapshot. Sie ist bewusst keine zweite Produkt-/Preiswahrheit,
sondern erzwingt relationale Herkunfts-FKs und stellt den indexierten
Produktrevision→Projekt-Rückweg für Stale-Ableitung bereit.

Für Parallelität gilt Project vor Calculation-Job. Requirement- und
Calculation-Insert sperren das Project vor der Stale-Ableitung. Weil der
Worker kein Project-UPDATE-Recht erhält, nimmt erfolgreiche Finalisierung den
Project-Lock vor dem Job über eine einzelne tenantgeprüfte SECURITY-DEFINER-
Funktion. Der Worker darf Calculation-Revisionen nicht direkt einfügen und
die Ergebnisbindung des Jobs nicht direkt aktualisieren. Eine zweite schmale
SECURITY-DEFINER-Funktion kapselt Revision-Insert und Job-CAS, prüft Tenant,
Lease, Attempt und Ablauf erneut und hält dabei zwingend Project vor Job. Für
die übrigen Worker-Übergänge bleiben nur explizite Jobspalten beschreibbar;
alle anderen Funktionen bleiben für den Worker gesperrt.

## Konsequenzen

- Der erste Katalog startet leer und kann ohne Fremdsystem betrieben werden.
- Preise, technische Daten und Assets haben eine prüfbare historische Quelle.
- Eine Preisänderung verändert nie eine bestehende Projektauflösung oder
  spätere BOM-Zeile.
- Katalogreads können VK und Technik liefern, ohne EK versehentlich in einen
  Clientpayload aufzunehmen.
- Requirement-, Calculation- und Katalogdrift sind sichtbar und
  konfliktfest.
- M2 kann BOM-Zeilen aus demselben Snapshotmuster erzeugen, ohne das
  Katalogmodell umzubauen.
- CSV muss denselben Revisionsservice verwenden; ein zweiter Import-
  Wahrheitsweg ist unzulässig.
- Reale „Vault“-Produkte bleiben bis zur Quellenklärung ungefüllt.

## Verworfen

### Katalogwerte nur veränderlich in einer Tabelle speichern

Verworfen, weil historische Angebote dann entweder still driften oder bei
jeder Änderung eine nachträgliche Rekonstruktion benötigen.

### Projektauflösung nur als Referenzen speichern

Verworfen. Ein Herkunftslink ist keine kommerzielle Wahrheit. Name, Technik,
Assets und Preise müssen an der Grenze kopiert werden.

### Sofort Offer und BOM bauen

Verworfen für M1-08. Varianten, Rabatte, Steuern, Positionstypen und
Vertragsfestschreibung sind ein eigener M2-Slice und würden die
Kataloginvarianten verdecken.

### Medusa, ERP oder Großhandelsfeed als Katalogkern

Verworfen. Sie duplizieren Tenant-/Rechte-/Eventgrenzen oder schaffen externe
Abhängigkeit, obwohl F16.1 minimal mit dem bestehenden Stack lösbar ist.

### Rechner-Marktpreis als Startpreis übernehmen

Verworfen. `market_estimate` ist unverifizierte Intake-Evidenz und besitzt
keine SKU-, Leistungs- oder Preisprovenienz.
