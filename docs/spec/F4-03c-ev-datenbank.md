# F4-03c — Kuratierte EV-Verbrauchsdatenbank

Status: **SPECIFIED (RED, Tests geskippt)** · Lane: `codex/muse-fleet-3e-f4spec` · Stand 2026-09-20 (Spec + RED-Test `tests/unit/f403c-ev-database.red.test.ts`, `describe.skip` bis zur Implementierung)

## Ziel und Abgrenzung

F4-03b stellt den Deferral explizit: „Kuratierte EV-DB (Fahrzeugmodell → Verbrauch): nur mit lizenzierter Quelle (WLTP-/ADAC-Extrakt), kein Scraping; eigener Folgeslice" (`F4-03b-ev-wallbox.md:139-140`). Dieser Slice löst ihn ein: eine versionierte, kuratierte EV-Datenbank (Modell → kWh/km) auf Basis eines **lizenzierten Extrakts**, mit Quellen-Pflicht je Eintrag, Import-/Kurator-Pipeline und Segment-Fallback auf die 03b-Faktoren. Keine neue Lane-Freigabe nötig (Folgeslice zu F4-03b).

Additiv, keine Migration: DB-CHECK bindet nur Top-Level-Keys (03b-Prinzip); Änderung rein in Zod-Schemas (`contract.ts`, Fetch-`consumptionSchema`) plus neuem Resolver. Legacy ohne DB-Referenz rechnet byte-identisch weiter (03b-Faktor bzw. 0.2, SHA unverändert).

## DB-Schema (Contract `ev-database.v1`)

`contracts/ev-database.v1.schema.json` (Kopf wie `ev-profile.v1.schema.json`); Beispiel `contracts/examples/ev-database.v1.json` (3 Platzhalter-Zeilen, als PLATZHALTER markiert — **keine echten Fahrzeugdaten**):

```text
contractVersion: "ev-database.v1"   # const
databaseVersion: wmee-ev-database.v<N>   # Pin, wandert in Quell-SHA
license: { kind: "licensed_extract", extractId }   # Lizenz-Gate: Pflicht
entries[]: { entryId, modelName (≤120), kwhPerKm (0..1 excl. 0),
             segment (kompakt|mittel|gross), source { kind, ref } }
```

- `entryId` ist der stabile DB-Schlüssel; das Profil referenziert ihn via neuem optionalem `consumption.evDatabaseEntryId` (KnownOrUnknown, strict-kompatibel).
- `source.kind ∈ {wltp, adac, hersteller}`, als `EV_DATABASE_SOURCE_KINDS` in `contract.ts` gepinnt (Zod-Seite spiegelt den JSON-Contract); `source.ref` ist der Beleg (Extrakt-Zeile, Datenblatt-ID, Prüfbericht-Nr.). Eintrag ohne Quelle wird am Import abgewiesen.
- `databaseVersion` wird Teil der EV-Quell-Provenienz (`sourceId`, `sourceRevision`, `sourceSha256` über km, entryId, kWh/km, Quelle, DB-Version, Pattern, Wallbox, Annahmenversion).

## Import-/Kurator-Pipeline

1. **Lizenz-Gate:** Der Import akzeptiert nur Payloads mit `license.kind = "licensed_extract"` und belegter `extractId` (`EV_DATABASE_LICENSED_EXTRACT_ONLY = true` in `fetch-compose-v2`). Unlizenziertes Material (inkl. Scrape-Verdacht ohne Beleg) wird fail-closed abgewiesen — kein stilles Überspringen einzelner Zeilen.
2. **Validierung:** JSON-Contract (`ev-database.v1`) + Quellen-Pflicht + Plausibilitätsbereich kWh/km; Verstoß bricht den Gesamtimport ab (kein Teilbestand).
3. **Kuration:** Manueller Freigabe-Schritt (Reviewer + Datum) vor Versionierung; jede freigegebene Version erhält eine neue `databaseVersion`, alte Versionen bleiben für Reproduzierbarkeit referenzierbar.
4. **Pin:** `PLANNING_ASSUMPTIONS_V2.load.evDatabaseVersion` pinnt die aktive DB-Version; Rechenläufe zitieren sie in der Provenienz.

## Segment-Fallback (03b-Faktoren bleiben Default)

Auflösungspriorität für `kwhPerKm` (`resolveEvKwhPerKm` in `load-shapes-v2`):

```text
1. evDatabaseEntryId belegt + Eintrag in gepinnter DB-Version gefunden → DB-Wert
2. sonst Segment belegt → 03b-Faktor (klein 0.15 / mittel 0.18 / gross 0.22)
3. sonst → 0.2 (gepinnter Pauschal-Default)
```

Unbekannte `entryId` fällt explizit auf Stufe 2/3 zurück und wird in der Provenienz als `evDatabaseMiss` sichtbar (kein stiller Default, kein Abort). `evVehicleModel` (03b-Freitext) löst weiterhin keinen Faktor aus.

## Segmentbenennung: kompakt-vs-klein-Drift (Entscheidung)

**Befund:** Der ev-profile-Contract nennt das kleine Segment `kompakt` (`ev-profile.v1.schema.json:14`), die 03b-Spec-Prose nennt es `klein` (`F4-03b-ev-wallbox.md:36,63`), der 03b-RED-Test nutzt englische Schlüssel `small/medium/large` (`f403b-ev-wallbox.red.test.ts:121-125`).

**Entscheidung:** Der DB-Contract übernimmt das ev-profile-Enum **`kompakt | mittel | gross`**; `klein` ist die deutsche Prose-Alias für `kompakt`. Begründung: Maschinen-Artefakte (Contracts) schlagen Prose — der DB-Contract wird gegen `ev-profile.v1` konsumiert (Segment-Join), ein drittes Label würde jede Auflösung mit einer Mapping-Tabelle belasten. Die 03b-Faktoren bleiben semantisch unverändert, nur das Label des kleinen Segments ist normiert (`klein` = `kompakt`). Die englischen Resolver-Schlüssel (`small/medium/large`) bleiben Implementierungsdetail des 03b-Resolvers und sind vom DB-Contract entkoppelt.

## Validierung (fail-closed)

- `evDatabaseEntryId` ohne EV-km → verweigern (kein wirkungsloses Feld, analog 03b-`wallboxMaxKw`-Regel).
- DB-Eintrag ohne `source.kind/ref` → Import bricht ab (Quellen-Pflicht).
- Extrakt ohne `license.extractId` oder `kind ≠ licensed_extract` → Import bricht ab (Lizenz-Gate).
- 03b-Regeln (Widerspruch km vs. `known_absent`, Pattern-Pflicht, Wallbox-Bereich) gelten unverändert.

## Berechnung (versioniert)

- `annualKwh = evKm × resolveEvKwhPerKm(entryId?, Segment)`; Wallbox-Kappung und Pattern-Form unverändert aus 03b.
- Neue Annahme `wmee-ev-database.v1` (BELEGT ab erstem lizenzierten Extrakt, davor existiert keine DB-Version): DB-Werte sind kein ESTIMATE, sondern belegte Extrakt-Werte; Fallback-Stufen 2/3 bleiben ESTIMATE.
- Heutiger Pfad (wird ersetzt, nicht umgangen): `engine.ts:161` (`evKmPerYear × 0.2`), gespeist aus `prepare.ts:139-144`, Schema `contract.ts:239`, Annahmen `planning-assumptions-v2.ts:54`, Intake `rechner-profile.ts:234-236,270`.

## Intake

- Editor: optionale Modellauswahl aus der gepinnten DB-Version (zeigt Modell + Quelle + kWh/km) schreibt `evDatabaseEntryId` als known-Profil; Freitext bleibt `evVehicleModel` (quellenlos, löst nichts aus).
- Rechner-Intake: DB-Referenz nur aus Kurator-Bestand (keine freie Modelleingabe mit DB-Wirkung).

## Anzeige

Keine neuen Blöcke: Provenienz nennt DB-Version + entryId + Quelle (oder `evDatabaseMiss` + Fallback-Stufe). Editor: Modell-Picker mit Quellenangabe.

## ROT-Beleg (RED-Test vor dem Skip, 2026-09-20)

`npx tsx scripts/run-tests.mts tests/unit/f403c-ev-database.red.test.ts` → 5 failed, 1 passed (Pin grün):

```text
× akzeptiert evDatabaseEntryId als consumption-Referenz (Schema-Validierung)
  AssertionError: expected false to be true // Object.is equality
× pinnt die DB-Version in den Planungsannahmen
  AssertionError: expected undefined to be 'wmee-ev-database.v1'
× verlangt eine belegte Quelle je DB-Eintrag (wltp/adac/hersteller)
  AssertionError: expected undefined to deeply equal [ 'wltp', …(2) ]
× gatet den DB-Import auf lizenzierte Extrakte (kein Scraping)
  AssertionError: expected undefined to be true // Object.is equality
✓ behält den pauschalen Default 0.2 als Fallback
× löst Modell->Verbrauch mit Segment-Fallback auf
  AssertionError: expected 'undefined' to be 'function' // Object.is equality
```

## Akzeptanz

- Unit: Contract-Validierung (gültig/unvollständig/unlizenziert), Quellen-Pflicht-Matrix (3 Kinds + fehlend), Resolver-Priorität (DB > Segment > 0.2), `evDatabaseMiss`-Provenienz, Nullreihe.
- Compose-Unit: DB-Pfad in SHA sichtbar (DB-Version + entryId), Legacy-Pfad byte-identisch.
- Actions-Unit: `evDatabaseEntryId`-ohne-km-Verweigerung.
- E2E: Editor-Picker schreibt DB-Referenz als known-Profil; Kette bis currentV2 mit DB-Wert, Monatstabelle sichtbar, Axe sauber.
- Gates: lint/typecheck/test/build + CI grün; RED-Skip in dieser Spec auflösen (Follow-up entfernt `describe.skip`).

## Bewusst offen

- WP-Herstellerkurven (F5.4, eigene Datenquelle).
- Lastverschiebung statt Kappung (F4.4), bidirektionales Laden.
- DB-Aktualisierungsrhythmus und Lizenzgeber-Auswahl (s. OFFENE-PUNKTE).

## Provenienz-Block (Datei:Zeile-Belege)

- Deferral: `docs/spec/F4-03b-ev-wallbox.md:139-140`; Segmentfaktoren: `docs/spec/F4-03b-ev-wallbox.md:36,63-70`; Strict-Prinzip: `docs/spec/F4-03b-ev-wallbox.md:41`.
- Contract-Enum kompakt: `contracts/ev-profile.v1.schema.json:14`; 03b-RED-Schlüssel small/medium/large: `tests/unit/f403b-ev-wallbox.red.test.ts:121-125`.
- evKm-Pfad: `lib/integrations/calculation/contract.ts:239` (Schema), `lib/integrations/calculation/prepare.ts:139-144` (Effective), `lib/integrations/calculation/engine.ts:24,161` (0.2-Pauschale), `lib/integrations/calculation/planning-assumptions-v2.ts:27-28,54` (Midpoint + Default), `lib/integrations/calculation/rechner-profile.ts:234-236,270` (Intake + EV-Präsenz).
- Strict-Schema: `lib/integrations/calculation/contract.ts:228` (`z.strictObject` consumption); Resolver-Heimat: `lib/integrations/calculation/load-shapes-v2.ts:213` (`buildEvPatternSourceV2`).

## OFFENE-PUNKTE

1. Lizenzgeber für den ersten Extrakt (WLTP-Datenbank vs. ADAC-Extrakt vs. Hersteller-Sammelabfrage) — unbelegt, Entscheidung vor Implementierung nötig.
2. DB-Aktualisierungsrhythmus und Versions-Lebensdauer (alte Versionen referenzierbar halten: wie lange?) — unbelegt.
3. Ob `evDatabaseEntryId` zusätzlich maschinell aus `evVehicleModel`-Freitext vorgeschlagen werden darf (Fuzzy-Match mit Kurator-Bestätigung) — unbelegt, Default: nein.
