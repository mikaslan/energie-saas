# F5-04 Raummodell (SPEC-ONLY, keine Migration)

Ziel: Gebäude-Raummodell für die Heizlast-Schätzung —
Geschosse, Räume, Wände, Dach, Material. Rein spezifizierend:
keine Migration, keine Implementierung auf diesem Branch.
Vertrag: `contracts/room-model.v1.schema.json` (F5-Vertrag,
gleicher Branch); Enum-Werte sind vertragsgleich.

STOPP-Regel: Alle Tabellen unten sind SPEC-ONLY. Wer daraus
einen Migrationsbedarf ableitet, STOPPT und holt Freigabe —
kein `db:generate`, kein Drift auf diesem Branch.

## §1 Tabellen-Shape SPEC-ONLY

Kette: Building → Story → Room → Wall/Floor/Roof/Heating
+ Material (Seed + Custom):

- `building`: Gebäudehülle je Site (Baujahr, Bauweise).
- `story`: Geschoss je Building, `kind` keller/zwischen/dach;
  höchstens 1 Keller, höchstens 1 Dach, n Zwischen.
- `room`: Raum je Story (Typ, Solltemp, Luftwechsel, Fläche).
- `wall`: Wand je Room (`towards`, Fläche, U-Wert);
  Fenster/Türen sind Wand-Properties, keine eigenen Tabellen.
- `floor`: Boden/Kellerdecke je Room (Aufbau, U-Wert).
- `roof`: Dachfläche je Building/Dach-Story (Fläche, Gauben).
- `heating`: Heizfläche je Room (Typ, Leistung).
- `material`: U-Wert-Quellen — TABULA-DE-Seed (versioniert)
  plus Custom-Material je Workspace (eingefroren, §5).

RLS wie Site-Aggregate: `UNIQUE(workspace_id,id)`,
zusammengesetzte Tenant-FKs, FORCE RLS + genau eine
permissive `tenant_isolation`-Policy, Runtime ohne DELETE.
jsonb nur Intake-Staging: Produktwahrheit relational
(M1-08-Linien-Muster); jsonb transportiert, begründet nichts.

## §2 Towards (text + 5-Werte-CHECK)

Hauskonvention wie `heatingType` (`lib/db/schema/energy.ts`):
text-Spalte + DB-CHECK `IN (...)`, Zod-`z.enum` symmetrisch.
Fünf Werte, geschlossen, vertragsgleich (`room-model.v1`):

`aussenluft`, `beheizt`, `unbeheizt`, `fremdgebaeude`, `erdreich`

Exportname (einzufordern): `WALL_TOWARDS_VALUES`.
Unbekannte Werte → Schema-Reject, fail-closed.

## §3 Raumtyp-Map (ESTIMATE bis Norm-Review)

DIN-Beiblatt-Tabelle Typ → Solltemp/Luftwechsel. Alle Werte
ESTIMATE bis Norm-Review (DIN EN 12831 Beiblatt); je Raum
überschreibbar (`targetTempC`/`airChangesPerHour` belegen
die Map-Vorgabe, ersetzen sie bei Bedarf):

| Typ | Solltemp °C | n (1/h) |
|---|---|---|
| wohnen | 20 | 0,5 |
| schlafen | 20 | 0,5 |
| kueche | 20 | 0,5 |
| bad | 24 | 0,5 |
| wc | 20 | 0,5 |
| flur | 15 | 0,5 |
| buero | 20 | 0,5 |
| kellerraum | 15 | 0,5 |
| abstellraum | 15 | 0,5 |
| sonstig | 20 | 0,5 |

Exportname (einzufordern): `ROOM_TYPE_DEFAULTS_V1`.

## §4 Gauben-Regel

- Σ Gaubenfläche ≤ Dachfläche (je Dach).
- Keine Überlappung (Gauben paarweise disjunkt).
- Pflichtfelder je Gaube: `dormerId`, `areaM2`, Lage
  (für die Überlappungsprüfung).
- Status `roof.validation`: `unchecked`/`valid`/`invalid`.
- Fail-closed: `invalid` → keine Heizlast aus diesem Stand.

Exportname (einzufordern): `validateDormersV1`.

## §5 Material-Snapshot

- Echter Snapshot pro Planung wie Offer-BOM/M1-08-Auflösung:
  kopierte U-Werte + Materialrevision + SHA, unveränderlich.
- Custom eingefroren: Custom-U-Werte werden beim Snapshot
  kopiert; spätere Katalogänderung propagiert nicht still.
- Update-Button = explizites Re-Snapshot mit Diff (alt vs. neu,
  bestätigungspflichtig, keine stille Propagation).
- Stale-Negativbild (M1-08-Präzedenz): alte Planung bleibt
  erhalten und wird als veraltet abgeleitet.
- TABULA-DE-Seed versioniert, ESTIMATE, mit Quellen-Spalte
  (Quelle: TABULA-DE-Typologie, Version + SHA gepinnt).

Exportname (einzufordern): `ROOM_MODEL_TABULA_SEED_SHA256`
(64-stellig hex). Baujahres-U-Lookup liest Seed-Revision.

## §6 roomwise-Trennung

- Getrennte Modelle: F1-19-`roomwise` (`rooms[]` im
  Energieprofil: Name/Fläche/Nutzung/Heizkörper) bleibt
  Intake/Qualifizierung; F5-04 ist eigenes Planungsmodell
  für die Heizlast. Kein Modell schreibt ins andere.
- Prefill-Import: Name/Fläche/Nutzung aus `roomwise` als
  expliziter Einmal-Import (kein Live-Link); Nutzung gibt
  den Raumtyp-Vorschlag + Typ-Defaults aus §3.
- Keine Rückschreibung ins Energieprofil.

## ROT-Beleg (RED-Test 5/5, danach geskippt)

`tests/unit/f504-raummodell.red.test.ts`, NUR existierende
Imports, Lauf 2026-09-20, Runner-Exit 1:

```text
FAIL ... > exportiert die 5 Towards-Werte für den Wand-CHECK
FAIL ... > exportiert die Raumtyp-Map mit Solltemp/Luftwechsel (ESTIMATE)
FAIL ... > stellt das Raummodell-Modul mit Snapshot-Semantik bereit
FAIL ... > pinnt den versionierten TABULA-DE-Seed per SHA-256
FAIL ... > exportiert die Gauben-Validierung (Summe/Überlappung/Pflicht)
Test Files  1 failed (1)
     Tests  5 failed (5)
```

Danach `describe.skip` mit Spec-Ref. Das Follow-up (Modul
`room-model-v1` + Migration nach Freigabe) entfernt das Skip.
