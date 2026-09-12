# F7-10 kWp/kWh-Rollups im Workbook (F7.6-Schluss)

## Stand
- Modulkatalog F7.6 verlangt im Workbook „kWp/kWh-Rollups";
  `workbook-service.ts` markierte sie als offen („keine erfundene Physik
  (kWp/kWh offen)").
- F7-09 liefert den reinen Projektor `deriveCertifiedCapacities` über dem
  versiegelten Snapshot; das Workbook liest denselben Snapshot
  (hash-geprüft, Current Revision).

## Ziel
- `getInstallationWorkbook` hängt `capacities` an (gleicher Scope wie
  F7-09: sichtbare `required`/`additional`-Katalogpositionen; Custom und
  unpassende Technische Daten zählen nicht, sondern setzen
  Uncertified-Flags).
- Das Workbook-Panel zeigt „Anlagenleistung (versiegelt)": Module kWp,
  Speicher kWh, Wechselrichter kW, Wallbox kW + Hinweis bei
  nicht zertifizierten Positionen.
- Keine neuen Spalten/Migrationen/Permissions; keine Einkaufspreise,
  keine Roh-`technicalData` an den Client (nur Aggregate).

## Nachweis
- DB: Custom-`other`-Graph (F806-Fixture) → Zähler 0, keine Flags, kein
  Absturz (ehrliches Nullverhalten statt erfundener Physik).
- E2E über echte versiegelte M2-01-Katalogkette (26 × 400 W, 8000 Wh):
  Installation per Service anlegen + Variante binden, Projektseite neu
  laden → „10,4 kWp" und „8 kWh" im Workbook sichtbar.
- Keine geratene Dachbindung: kWp pro Dach ist NICHT enthalten (Snapshot
  trägt keine Dachzuordnung; eigenes Dachmodell wäre Bauarbeit jenseits
  dieses Slices).
