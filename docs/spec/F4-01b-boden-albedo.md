# F4-01b — Boden-Albedo als Profileingabe

Status: **SPECIFIED** · Lane: `codex/m1-wave-02` · Stand 2026-09-10

## Ziel

Die Muneer-Transposition rechnete mit fixture-gepinnter Albedo 0.2 ohne
Profileingabe (`muneer-weights-v2.ts`: „kein Profil-/Katalogfeld
vorhanden"). Dieser Slice macht sie belegbar (Reonic: Standortparameter
mit Default).

## Datenmodell (additiv, keine Migration)

`consumption.groundAlbedo`: KnownOrUnknown 0..1, optional. Unbelegt =
0.2 (bisheriger Pin, byte-identisch). Keine Migration (Top-Level-CHECK
unberührt).

## Berechnung

- `MuneerWeightsSurface.albedo?` (Default `MUNEER_WEIGHTS_ALBEDO` = 0.2);
  außerhalb [0,1] fail-closed im Builder.
- Fetch liest Albedo aus Consumption (unbekannt → 0.2), trägt sie je Dach
  in Fläche + Dach-Provenienz (`ComposedRoofProvenanceV2.albedo`).
- Physik: Reflexionsanteil linear in ρ; Fetch skaliert weiter auf die
  PVcalc-Jahresreferenz — Albedo formt die unterjährige Verteilung
  (Nachweis: Summen gleich, Shape-Differenz > 0), kein absoluter
  Mehrertrag gegen die Referenz.

## Anzeige

Kein neuer Block (Hinweis-Kette unverändert); Editor: optionales Feld
„Boden-Albedo (0–1, leer = 0,2)".

## Akzeptanz

- Unit: Sweep 0/0.2/0.5/1 monoton auf geneigter Fläche, explizit 0.2 ==
  Default, außerhalb [0,1] fail-closed.
- Compose: Profil 0.5 vs. Default — gleiche Jahressumme, Shape-Differenz,
  Provenienz 0.2/0.5, Lastseite unberührt.
- Actions: Save + Bereichsbrüche; E2E: Editor-Save als known-Profil.
- Gates: lint/typecheck/test/build + CI grün; v1-Artefakt-Regen + SHA-Pin.

## Bewusst offen

- Dachseitige Albedo (physikalisch standortweit; ein Wert genügt).
- Schnee-/Saison-Albedo (kein belegtes Bedarfsprofil).
