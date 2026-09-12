# F7-09 Zertifizierte Anlagenkennzahlen im Angebotsdetail

## Stand
- Das Angebotsdetail zeigt Preise, Varianten, Freigabe und Schaltplan, aber
  keine einzige Anlagenkennzahl (0 Treffer fuer kWp/Anlagenleistung/Module).
- Ein deutsches PV-Angebot ohne kWp-Angabe ist keine Reonic-Paritaet.
- Der Rechner liefert nur eine unverifizierte Schaetzung
  (`calculatorEstimate`, Label „Unverifizierter Richtwert“).

## Ziel
- Das Angebotsdetail zeigt einen Block „Anlagenleistung (versiegelt)“:
  - Module: Stueckzahl und kWp (Summe Nennleistung, 3 Nachkommastellen).
  - Speicher: Stueckzahl und kWh (Summe nutzbare Kapazitaet).
  - Wechselrichter: Stueckzahl und kW AC (Summe Nenn-AC-Leistung).
  - Wallbox: Stueckzahl und kW Ladeleistung (Summe max. Ladeleistung).
- Ehrlichkeitsregel: Nur sichtbare, kundenwirksame Positionen
  (`required`/`additional`, nicht `isHidden`, nicht `optional`) zaehlen.
  Custom-Positionen und Katalogpositionen mit unpassenden Technischen Daten
  zaehlen NICHT mit; gibt es solche in einer Kapazitaetskategorie, zeigt die
  UI „zzgl. nicht zertifizierter Positionen“.

## Datenquelle (kein Raten, kein ESTIMATE)
- Versiegelter Varianten-Snapshot: Katalogpositionen betten
  `product.technicalData` ein (`module.v1.nominalPowerWatts`,
  `battery.v1.usableCapacityWh`, `inverter.v1.nominalAcPowerWatts`,
  `wallbox.v1.maxChargingPowerWatts`).
- Der Projektor ist eine reine Funktion ueber dem Snapshot:
  Summen, keine Simulation. kWh/Jahr-Ertrag ist explizit NICHT enthalten
  (er waere eine Simulation und gehoert nicht in diesen Slice).
- Mengen sind `quantityMilli`; Stueck-/Set-Einheiten muessen glatt durch
  1000 teilbar sein, sonst fail-closed (`TypeError`).

## Abgrenzung
- Client-Grenze: `productViewSchema` (page.tsx) streicht Roh-`technicalData`
  bewusst („technische Rohdaten nicht durchgereicht“). Der Projektor laeuft
  deshalb serverseitig in `projectOfferDetailView`; an den Client gehen nur
  Aggregate (Zahlen + Flags), keine Rohdaten, keine Hashes, keine EK-Preise.
- Keine neuen Spalten, keine Migration, keine neuen Berechtigungen.
- v1-Port/fail-closed beweist keine Paritaet: Der Block muss mit echten
  versiegelten Snapshots (DB-Test im m201-Muster) und im Browser (E2E ueber
  die M2-01-Fixture: 26 × 400 W = 10,4 kWp, 8000 Wh = 8 kWh) nachgewiesen
  werden.
