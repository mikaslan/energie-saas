# F4-03 — Wärmepumpe: COP-Kennlinie, Bivalenzpunkt, WW-Split

Status: **SPECIFIED** · Lane: `codex/m1-wave-02` · Stand 2026-09-10

## Ziel und Abgrenzung

`heatPumpKwhPerYear` ist heute eine elektrische Pauschale: Heizgradstunden
verteilen Strom, die Temperaturabhängigkeit der Arbeitszahl steckt
unbelegt im Jahreswert (vgl. `degree-day-load-v2.ts`: „Konstant-COP-Annahme",
„Warmwasser-Anteil läuft mit"). Katalog F4.3 verlangt Wärmepumpe mit
**COP und Bivalenzpunkt**. Dieser Slice macht den Pfad durchgängig:
thermischer Bedarf → COP(T)-Kennlinie → Strom-Slots, mit Bivalenz-Heizstab
und Warmwasser-Split. Keine neue Lane-Freigabe nötig (Gesamtauftrag
2026-09-10).

## Evidenz und Näherungsstatus

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F4.3 „Wärmepumpe
  (COP, Bivalenzpunkt)". Katalog F5.4: Bivalenzpunkt-Default −6 °C
  (dort WP-Dimensionierung nach VDI 4645; hier als Rechen-Default
  übernommen und als ESTIMATE markiert).
- Keine Reonic-COP-Referenzkurve belegt: Die Kennlinie ist eine
  **reversible ESTIMATE-Näherung** (Version `wmee-heat-pump-cop.v1`),
  keine behauptete Reonic-Parität. Alle ESTIMATE-Parameter stecken in
  der Quell-SHA (kein stiller Wechsel) und sind hier dokumentiert.

## Datenmodell (additiv, keine Migration)

`consumption.*` (alle optional, strictObject-kompatibel):

```text
heatPumpThermalKwhPerYear: KnownOrUnknown  # thermischer Jahresbedarf (Heizen + WW), kWh
heatPumpCopNominal: KnownOrUnknown         # Skalenfaktor, COP(7 °C) = Wert, Bereich 1..8
heatPumpBivalenceTempC: KnownOrUnknown     # unterhalb Heizstab (COP=1), Bereich -25..15 °C
heatPumpHotWaterShare: KnownOrUnknown      # WW-Anteil am thermischen Bedarf, 0..1
```

- DB-CHECK bindet nur Top-Level-Keys → keine Migration; Änderung rein in
  Zod-Schemas (`contract.ts`, Fetch-`consumptionSchema`).
- Legacy `heatPumpKwhPerYear` (elektrisch, gradverteilt) bleibt bestehen:
  Bestand ohne Thermalwerte rechnet byte-identisch weiter (SHA unverändert).

## Validierung (fail-closed, keine stillen Defaults)

- Thermisch UND legacy-elektrisch beide belegt → Save/Compose verweigern
  (Widerspruch, keine stille Präzedenz).
- Thermal bekannt → COP-Pfad; fehlende COP/Bivalenz/WW-Anteile fallen auf
  versionierte ESTIMATE-Defaults (nominal 4,0 / −6 °C / 0,0) — Defaults
  stehen in Quell-SHA und Provenienz, gelten als belegte Näherung, nicht
  als Kundenwert.
- WW-Anteil außerhalb [0,1], COP außerhalb [1,8], Bivalenz außerhalb
  [−25,15] °C → verweigern. Thermal = 0 → Nullreihe (wie Gradquelle).

## Berechnung (v2, versioniert)

Neue Quelle `wmee-heat-pump-cop.v1` (Kind wie Gradquelle, ersetzt sie bei
belegtem Thermalbedarf):

```text
Heizanteil_h = thermal × (1 − ww) × grad_h / Σgrad        # 15-°C-Grenze wie bisher
WWanteil_h   = thermal × ww / 8760                        # konstant pro Stunde [ESTIMATE]
T_h < Bivalenz → el_h = Heizanteil_h + WWanteil_h         # Heizstab, COP = 1
sonst         → el_h = Heizanteil_h / COP(T_h) + WWanteil_h / (0,8 × COP(T_h))
```

- `[ESTIMATE]` Referenzkennlinie `copRef(T)`, stückweise linear durch
  (−7 °C → 2,2), (2 °C → 3,1), (7 °C → 4,0), (20 °C → 5,2); außerhalb
  geklemmt. `COP(T) = copNominal × copRef(T) / copRef(7)`.
- `[ESTIMATE]` WW läuft mit 0,8-fachem COP (höhere Vorlauftemperatur).
- `[ESTIMATE]` WW thermisch konstant über alle Stunden (kein belegtes
  Zapfprofil; flache Viertel wie übrige Formen).
- Viertel flach in der Stunde (Last hat keine Solargestalt).
- Energie: Σ el < Σ thermal (COP-Effekt nachweisbar); kein
  Exaktheits-Anspruch gegen thermal (by design, Test prüft Relation +
  Bivalenz-Schalter).
- Provenienz: `sourceId`, `sourceRevision`, `sourceSha256` über
  (thermal, copNominal, Bivalenz, ww-Anteil, Kennlinienversion).
- Direkt-elektrisches `hotWaterKwhPerYear` (z. B. Durchlauferhitzer) bleibt
  eigene Quelle; Doppelzählung mit WW-Split dokumentiert der Editor
  (Hinweistext, keine stille Verrechnung).

## Anzeige

Keine neuen Blöcke: Jahres-/Monatswerte zeigen Kettenergebnisse;
Provenienz nennt die COP-Quelle. Editor: vier optionale WP-Felder beim
Wärmepumpen-Eintrag plus Widerspruchshinweis (thermal vs. elektrisch).

## Akzeptanz

- Unit: Kennlinien-Interpolation (Stützstellen exakt), Bivalenz-Schalter
  (unterhalb COP=1), WW-Split (Anteile, 0,8-Faktor), Relation
  Σ el < Σ thermal, Nullreihe, Fail-closed-Matrix.
- Compose-Unit: Thermal→COP-Pfad, Legacy-Pfad byte-identisch,
  Widerspruch beider Pfade fail-closed, Defaults in SHA sichtbar.
- Actions-Unit: Bereichs-/Widerspruchsvalidierung.
- E2E: Editor speichert Thermalwerte als known-Profil; Kette bis
  currentV2 mit WP-Anteil (annual enthält WP-Strom < Thermalwert),
  Monatstabelle sichtbar, Axe sauber.
- Gates: lint/typecheck/test/build + CI grün; Planning-Artefakt-Regen
  (Zod-Nummerierung) + SHA-Pin wie F4.2.

## Bewusst offen

- Kuratierte EV-/WP-Hersteller-DB (Katalog F4.3/F5.4, eigene Datenquelle).
- Heizlast nach DIN EN 12831 / U-Werte (M5-Produkt, nicht F4-Näherung).
- Dynamische Stromtarife/WP-Sperrzeiten (F4.4).
- Exakte Reonic-COP-Kurve (externer Beleg fehlt; ESTIMATE bleibt).
