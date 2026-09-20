# F3-06a Sonnenstands-Anzeige (Stufe-0, migrationslos)

## Stand
- Modulkatalog F3.6 (Verschattung): Sonnenbahn mit Datum/Uhrzeit,
  Verlust, Heatmap, Score, Snapshots. Davon existiert: shading-Enum
  je Dachfläche (calculation/contract), v1-Faktoren, NOAA-Sonnenkern
  `solarQuarterGeometryUtc` (solar-geometry-v2, getestet, fail-closed).
- Stufe-0: Nur Anzeige des Sonnenstands je Projektstandort. Kein
  Player, kein Verlust, keine Heatmap, kein Score, keine Snapshots,
  keine Persistenz (Folge-Capabilities). 0 Migrationen.

## Umfang
- Contract `lib/integrations/planning/solar-display` (client-sicher,
  reines zod + pure Ableitung):
  `planningSolarDisplayV1Schema` (schemaVersion-Literal
  `planning-solar-display.v1`, latitude -90..90 finit,
  longitude -180..180 finit, instantMsUtc finit-ganzzahlig > 0;
  strict) + `resolveSolarDisplay(input)` → { elevationDeg,
  azimuthDegNorth, airMass, sunUp } (rundet nicht, wirft nie —
  Schema prüft vorher; Kern wirft F401... bei Rest-Fällen).
- UI `planning-solar-section` (Projektseite, eigene Sektion):
  datetime-local-Eingabe (Default: jetzt), Readout Höhe/Azimut +
  Aussage Sonne auf/unter; Koordinaten aus Projekt-Site (lat/lng);
  Site ohne Koordinaten → Hinweistext statt Readout.
- Rechte/Modi: Viewer liest, External fail-closed (nichts);
  Quick-Modus blendet aus (F3-01); 2D/3D zeigen.

## ESTIMATE (reversibel)
- SOLAR_DISPLAY_NO_DST_LABEL: Eingabe ist UTC-Label ohne Zonen-
  Umrechnung; Upgrade: Zeitzonen-Label je Standort.
- SOLAR_DISPLAY_SITE_COORDS_ONLY: nur Site-Koordinaten, kein
  manuelles Koordinaten-Override; Upgrade: Override-Felder.

## Tests
- Contract: Version-Literal, Range-Rejects (lat/lng/NaN/Infinity/
  Extra-Keys), sunUp-Ableitung, bekannte Position (Berlin,
  2026-06-21 12:00 UTC: Höhe 55..65°, Azimut 150..200°).
- E2E (F306-E2E): Sektion sichtbar, Zeitpunkt wählen →
  Readout ändert sich, fehlende Koordinaten → Hinweis,
  Quick blendet aus, Viewer liest, External nichts.
