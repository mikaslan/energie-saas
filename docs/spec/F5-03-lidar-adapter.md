# F5-03 LiDAR-Adapter (Scan-Import, spezifiziert)

Ziel: Raum-für-Raum-Scan per Apple RoomPlan (iPhone 12 Pro+,
iPad Pro 2020+) als strukturierter Gebäude-Input — spezifiziert,
nicht gebaut. Katalog F5.2. Status SPECIFIED (max, siehe §7).
Kein nativer Code in diesem Slice.

## SPECIFIED

### §1 Adapter-Shape

- Zwei Datensätze: `scan-session` (ein Raumgang: Geräte-Provenance,
  Session-Zeit, Tracking-Protokoll) und `scan-result` (das
  Raummodell: Raum-Polygone, Wandflächen, Öffnungen
  Tür/Fenster mit Maßen).
- Provenance: `lidar_scan` (Scan-Herkunft, am Scan-Datensatz —
  keine Energieprofil-Provenance, kein F1-Eingriff).
- Fail-closed: ohne vollständiges Raum-Polygon kein `scan-result`;
  halb vermessene Räume werden verworfen, nicht geraten.

### §2 Device-Gate

- Primär: nativer Capability-Check auf dem Gerät (RoomPlan- und
  LiDAR-Verfügbarkeit aus dem realen Geräte-Contract).
- Modelllisten (iPhone 12 Pro+, iPad Pro 2020+) sind Doku-Stand
  und veralten — nie Gate-Logik.
- VERBOTEN: UA-Parsing/Browsermock als 1:1-Ersatz für den
  Capability-Check (`userAgent`, `navigator.platform` u. Ä.
  kommen im Gate nicht vor). Web ohne natives Gate heißt
  „nicht prüfbar", nie „fähig".

### §3 Session/Stitching/Tracking

- Koordinatensystem: je `scan-session` ein lokales
  Raum-Koordinatensystem (Meter, Ursprung am Session-Start);
  ein globales Gebäude-System gibt es in diesem Slice nicht.
- Stitching: Räume werden ausschließlich über Türdurchgänge
  verkettet (gemeinsame Öffnungs-Geometrie); ohne passenden
  Durchgang bleibt der Raum einzeln stehen (kein Zwangs-Fit).
- Tracking-Warnungs-Typen: `tracking_lost` (Neustart der
  Session), `low_confidence` (Fläche markieren, nicht
  verwerfen), `drift_suspected` (Stitching für diesen Raum
  sperren). Warnungen gehören ins Session-Protokoll.

### §4 Android-Parität

- Android (ohne RoomPlan): manuelle Erfassung, die
  identische `scan-result`-Datensätze erzeugt — Ziel-Shape
  ist das F5.3-Modell, nicht der F1-Energieprofil-Shape.
- Der F1-19-roomwise-Shape (`energyRoomSchema`,
  `lib/integrations/calculation/contract.ts:189-197`:
  Name/Fläche/Nutzung/Heizkörper) bleibt F1-Profil und wird
  NICHT als LiDAR-Ziel umgedeutet; ein Mapping Scan→roomwise
  wird in diesem Slice nicht behauptet.

### §5 Portal-Tracing

- Manuelles Nachzeichnen im Portal ist ein eigener
  Editor-Folgeslice (eigene Spec, eigener Bau) — nicht an den
  Scan-Import gekoppelt, kein Scan-Import-Flag schaltet ihn
  frei, kein Tracing-Stand blockiert den Import.

### §6 Offline-Hypothese (ESTIMATE)

- Hypothese: Erfassung offline auf dem Gerät, Verarbeitung
  (Stitching, Validierung) online im Backend.
- Das ist eine Schätzung, kein Contract: Erst ein Live-Beleg
  (echter Gerätescan → Session-Upload → `scan-result`)
  hebt sie über ESTIMATE hinaus.

### §7 Roadmap-Park

- SPECIFIED ist das Maximum dieses Slice. Der native Bau
  (RoomPlan-Anbindung, Capability-Gate, Upload-Pipeline)
  beginnt erst nach dem Plattform-Entscheid
  Q-M5-LIDAR-PLATTFORM — bis dahin keine nativen Dateien,
  keine Migrationen, keine Energieprofil-Eingriffe.

## CONTRACTED

- NEU: diese Spec + `tests/unit/f503-lidar.red.test.ts`
  (5 RED-Tests: scan-session-Contract, scan-result-Shape,
  Capability-Gate-Export, UA-Parsing-Verbot, Tracing-Marker).
- EDIT: keine. Keine Migration (STOPP-Regel eingehalten).
- RED-Beleg (Branch `codex/muse-fleet-3d-f5`, vor `describe.skip`):

```text
FAIL scan-session-Contract-Modul existiert (scan-session/scan-result)
FAIL scan-result-Modul existiert (Provenance lidar_scan, Polygone/Wandflächen/Öffnungen)
FAIL Device-Gate exportiert isLidarCapable (nativer Capability-Check)
FAIL Device-Gate enthält kein UA-Parsing (Verbot aus Spec §2)
FAIL Portal-Tracing-Slice-Marker existiert (eigener Editor-Folgeslice)
Test Files  1 failed (1)
     Tests  5 failed (5)
```

- Skip-Begründung: SPECIFIED ohne Implementierung — die Suite
  bleibt bis Q-M5-LIDAR-PLATTFORM + nativem Bau geskippt und
  wird dann aktiviert (grün nach Skip: 5 skipped).
